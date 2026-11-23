import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {WebSocket, WebSocketServer} from 'ws';
import {PROTOCOL, WEBSOCKET_SUBPROTOCOL, position, record, type ServerMessage, type WorkbookReceipt} from './protocol.ts';
import {replay} from './replay.ts';

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 24 * 1024 * 1024;
const OWNER_RENEW_MS = 5_000; // The PHP owner lease lasts 15 seconds.
const TERMINAL_ROOM_CODES = new Set(['generation_changed', 'room_not_active', 'stale_owner', 'owner_busy']);

class OwnerProblem extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

interface Options {ownerUrl: string; ownerToken: string; refreshMs?: number}
interface Peer {socket: WebSocket; token: string; seq: number; busy: boolean; opening: boolean}
interface Room {peers: Set<Peer>; work: Promise<void>; queued: number}

async function responseJson(response: Response): Promise<unknown> {
    if (!response.body) throw new Error('Empty response from PHP owner');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.length;
            if (size > RESPONSE_LIMIT) throw new Error('Oversized PHP owner response');
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createRealtimeServer(options: Options) {
    const endpoint = new URL(options.ownerUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || options.ownerToken.length < 32 || options.ownerToken.length > 4096) throw new Error('Invalid PHP owner configuration');
    const ownerId = randomUUID();
    const rooms = new Map<string, Room>();
    const sockets = new WebSocketServer({noServer: true, maxPayload: REQUEST_LIMIT, perMessageDeflate: false, handleProtocols: protocols => protocols.has(WEBSOCKET_SUBPROTOCOL) ? WEBSOCKET_SUBPROTOCOL : false});

    async function call(action: string, room = '', token = '', body: Record<string, unknown> = {}, traceparent?: string): Promise<unknown> {
        const headers: Record<string, string> = {'Content-Type': 'application/json', Accept: 'application/json', 'X-Vaulter-Sheets-Owner': options.ownerToken};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (traceparent) headers.traceparent = traceparent;
        const result = await fetch(`${endpoint.href.replace(/\/$/, '')}/${action}`, {
            method: 'POST', redirect: 'error', headers, body: JSON.stringify({room, owner_id: ownerId, ...body}),
            signal: AbortSignal.timeout(action === 'append' ? 30_000 : 4_000),
        });
        const data = await responseJson(result);
        if (!result.ok) throw new OwnerProblem(result.status, record(data) && typeof data.code === 'string' ? data.code : 'room_unavailable');
        return data;
    }

    async function append(room: string, token: string, fence: number, body: Record<string, unknown>, traceparent?: string): Promise<unknown> {
        const renew = () => call('renew', room, token, {owner_fence: fence});
        await renew();
        let renewing: Promise<void> | undefined;
        const heartbeat = setInterval(() => {
            // PHP checks the fence when it publishes, including after a failed renewal.
            renewing ??= renew().catch(() => {}).then(() => { renewing = undefined; });
        }, OWNER_RENEW_MS);
        heartbeat.unref();
        try {
            return await call('append', room, token, {...body, owner_fence: fence}, traceparent);
        } finally {
            clearInterval(heartbeat);
            await renewing;
        }
    }

    const server = createServer(async (request, response) => {
        const path = request.url;
        if (request.method !== 'GET' || (path !== '/livez' && path !== '/readyz')) {
            response.writeHead(404).end();
            return;
        }
        let ready = true;
        if (path === '/readyz') {
            try {
                const result = await call('ready');
                ready = record(result) && result.protocol === PROTOCOL;
            } catch {
                ready = false;
            }
        }
        response.writeHead(ready ? 200 : 503, {'Content-Type': 'application/json'}).end(JSON.stringify({ok: ready}));
    });

    function send(peer: Peer, message: ServerMessage): void {
        if (peer.socket.readyState !== WebSocket.OPEN) return;
        if (peer.socket.bufferedAmount > RESPONSE_LIMIT) {
            peer.socket.close(1013, 'Slow connection');
            return;
        }
        peer.socket.send(JSON.stringify(message));
    }

    function error(peer: Peer, cause: unknown, commandId?: string): void {
        const failure = cause instanceof OwnerProblem ? cause : new OwnerProblem(503, 'room_unavailable');
        if (TERMINAL_ROOM_CODES.has(failure.code)) {
            peer.socket.close(4409, failure.code);
        } else if (failure.code === 'incompatible_binding') {
            peer.socket.close(4412, failure.code);
        } else if (failure.status === 401 || failure.status === 404) {
            peer.socket.close(4403, 'Room access ended');
        } else if (commandId !== undefined) {
            send(peer, {type: 'error', command_id: commandId, code: failure.code, retryable: failure.status >= 500 || failure.code === 'base_moved'});
        } else {
            peer.socket.close(1013, 'Room unavailable');
        }
    }

    async function refresh(roomId: string, peer: Peer, resume: number | null = null): Promise<void> {
        const log = await call('read', roomId, peer.token, {
            after_seq: peer.seq < 0 ? resume : peer.seq,
            include_state: peer.opening,
        });
        if (record(log) && log.unchanged === true) return;
        const state = replay(log);
        if (state.seq < peer.seq) throw new OwnerProblem(409, 'generation_changed');
        if (state.seq !== peer.seq) {
            peer.seq = state.seq;
            send(peer, {type: 'state', state});
        }
    }

    function updatePeers(roomId: string, room: Room): Promise<unknown> {
        return Promise.allSettled(Array.from(room.peers, async peer => {
            if (!peer.token || peer.opening || peer.busy || peer.socket.readyState !== WebSocket.OPEN) return;
            peer.busy = true;
            try { await refresh(roomId, peer); } catch (cause) { error(peer, cause); }
            finally { peer.busy = false; }
        }));
    }

    server.on('upgrade', (request, socket, head) => {
        const match = /^\/v1\/rooms\/([A-Za-z0-9._-]{1,260})$/.exec(request.url ?? '');
        const requested = request.headers['sec-websocket-protocol'];
        if (!match || typeof requested !== 'string' || !requested.split(',').map(item => item.trim()).includes(WEBSOCKET_SUBPROTOCOL)
            || sockets.clients.size >= 1024 || (rooms.get(match[1])?.peers.size ?? 0) >= 32) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, ws => attach(match[1], ws));
    });

    function attach(roomId: string, socket: WebSocket): void {
        const room = rooms.get(roomId) ?? {peers: new Set<Peer>(), work: Promise.resolve(), queued: 0};
        rooms.set(roomId, room);
        const peer: Peer = {socket, token: '', seq: -1, busy: false, opening: true};
        room.peers.add(peer);
        const timer = setTimeout(() => socket.close(4403, 'Room credential required'), 5000);

        socket.on('error', () => socket.terminate());
        socket.on('close', () => {
            clearTimeout(timer);
            room.peers.delete(peer);
            if (!room.peers.size && !room.queued) rooms.delete(roomId);
        });
        socket.on('message', (data, binary) => {
            let message: unknown;
            try { if (!binary) message = JSON.parse(data.toString()); } catch { /* handled with other invalid messages */ }
            if (!record(message)) { socket.close(1007, 'Invalid room message'); return; }
            if (!peer.token) {
                if (message.type !== 'open' || typeof message.token !== 'string' || message.token.length > 8192) {
                    socket.close(4403, 'Invalid room credential');
                    return;
                }
                peer.token = message.token;
                const resume = position(message.after_seq) ? message.after_seq : null;
                void refresh(roomId, peer, resume).then(() => { peer.opening = false; clearTimeout(timer); }, cause => error(peer, cause));
                return;
            }
            const intent = message.intent;
            if (peer.opening || message.type !== 'intent' || !record(intent) || typeof intent.command_id !== 'string'
                || !/^[A-Za-z0-9._-]{1,255}$/.test(intent.command_id) || (message.if_match !== null && typeof message.if_match !== 'string')) {
                socket.close(1007, 'Invalid room intent');
                return;
            }
            const commandId = intent.command_id;
            if (room.queued >= 64) {
                send(peer, {type: 'error', command_id: commandId, code: 'room_busy', retryable: true});
                return;
            }
            const tag = message.if_match;
            const traceparent = typeof message.traceparent === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(message.traceparent) ? message.traceparent : undefined;
            room.queued++;
            room.work = room.work.then(async () => {
                try {
                    if (socket.readyState !== WebSocket.OPEN) return;
                    const lease = await call('acquire', roomId, peer.token);
                    if (!record(lease) || !position(lease.owner_fence) || !position(lease.head_seq)) throw new Error('Invalid room lease');
                    const receipt = await append(roomId, peer.token, lease.owner_fence, {base_seq: lease.head_seq, intent, if_match: tag}, traceparent);
                    if (!record(receipt) || receipt.state !== 'committed' || receipt.command_id !== commandId || !position(receipt.seq)) throw new Error('Invalid workbook receipt');
                    send(peer, {type: 'ack', receipt: receipt as unknown as WorkbookReceipt});
                    await updatePeers(roomId, room);
                } catch (cause) {
                    error(peer, cause, commandId);
                } finally {
                    room.queued--;
                    if (!room.peers.size && !room.queued) rooms.delete(roomId);
                }
            });
        });
    }

    const timer = setInterval(() => {
        for (const [id, room] of rooms) {
            if (!room.queued) void updatePeers(id, room);
        }
    }, options.refreshMs ?? 2000);
    timer.unref();
    server.on('close', () => { clearInterval(timer); sockets.close(); });
    return {server, close: () => { for (const socket of sockets.clients) socket.terminate(); server.close(); }};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const ownerUrl = process.env.SHEETS_REALTIME_OWNER_URL;
    const tokenFile = process.env.SHEETS_REALTIME_OWNER_TOKEN_FILE;
    const port = Number(process.env.PORT ?? 3101);
    if (!ownerUrl || !tokenFile || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid realtime configuration');
    const application = createRealtimeServer({ownerUrl, ownerToken: readFileSync(tokenFile, 'utf8').trim()});
    application.server.listen(port, '0.0.0.0');
    process.once('SIGTERM', application.close);
    process.once('SIGINT', application.close);
}
