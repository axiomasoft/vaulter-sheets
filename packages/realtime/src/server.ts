import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {WebSocket, WebSocketServer} from 'ws';
import {PROTOCOL, WEBSOCKET_SUBPROTOCOL, position, record, type ServerMessage, type WorkbookDeltaPayload, type WorkbookDeltaUpdate, type WorkbookReceipt, type WorkbookRoomMarker, type WorkbookRoomState} from './protocol.ts';
import {applyDeltaPayload, replay} from './replay.ts';

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 24 * 1024 * 1024;
const OWNER_RENEW_MS = 5_000; // The PHP owner lease lasts 15 seconds.
const LEASE_SAFETY_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 10_000;
const HISTORY_LIMIT = 64;
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
interface Peer {socket: WebSocket; token: string; seq: number; opening: boolean}
interface RoomLease {fence: number; headSeq: number; expiresAt: number}
interface Room {
    peers: Set<Peer>;
    work: Promise<void>;
    queued: number;
    state?: WorkbookRoomState;
    history: Map<number, WorkbookDeltaUpdate>;
    lease?: RoomLease;
    refreshInFlight?: Promise<void>;
    idleStreak: number;
    nextPollAt: number;
}

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

    const baseRefreshMs = options.refreshMs ?? 5_000;
    const maxIdleRefreshMs = options.refreshMs !== undefined ? Math.max(options.refreshMs * 4, 2_000) : 30_000;

    function leaseExpiry(raw: unknown): number {
        if (typeof raw === 'string') {
            const parsed = Date.parse(raw);
            if (Number.isFinite(parsed)) return Math.max(Date.now(), parsed - LEASE_SAFETY_MS);
        }
        return Date.now() + DEFAULT_LEASE_TTL_MS;
    }

    async function append(room: Room, roomId: string, token: string, fence: number, body: Record<string, unknown>, traceparent?: string): Promise<unknown> {
        const renew = () => call('renew', roomId, token, {owner_fence: fence}).then(data => {
            if (room.lease && room.lease.fence === fence) {
                room.lease.expiresAt = record(data) && data.owner_expires_at !== undefined
                    ? leaseExpiry(data.owner_expires_at)
                    : Date.now() + DEFAULT_LEASE_TTL_MS;
            }
        });
        let renewing: Promise<void> | undefined;
        const heartbeat = setInterval(() => {
            // PHP checks the fence when it publishes, including after a failed renewal.
            renewing ??= renew().catch(() => {}).then(() => { renewing = undefined; });
        }, OWNER_RENEW_MS);
        heartbeat.unref();
        try {
            return await call('append', roomId, token, {...body, owner_fence: fence}, traceparent);
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

    function recordHistory(room: Room, update: WorkbookDeltaUpdate): void {
        room.history.set(update.seq, update);
        while (room.history.size > HISTORY_LIMIT) {
            const oldest = room.history.keys().next().value;
            if (oldest === undefined) break;
            room.history.delete(oldest);
        }
    }

    function deltaSlice(room: Room, fromSeq: number): WorkbookDeltaUpdate[] | null {
        if (!room.state || fromSeq < 0 || fromSeq > room.state.seq) return null;
        if (fromSeq === room.state.seq) return [];
        const updates: WorkbookDeltaUpdate[] = [];
        for (let seq = fromSeq + 1; seq <= room.state.seq; seq++) {
            const entry = room.history.get(seq);
            if (!entry) return null;
            updates.push(entry);
        }
        return updates;
    }

    function sendPeerState(room: Room, peer: Peer, fromSeq: number | null = null): void {
        if (!room.state || peer.socket.readyState !== WebSocket.OPEN) return;
        const baseSeq = fromSeq ?? peer.seq;
        if (baseSeq >= 0 && baseSeq <= room.state.seq) {
            const updates = deltaSlice(room, baseSeq);
            if (updates !== null) {
                const insertions = updates.flatMap(u => u.commands.filter((c): c is Extract<typeof c, {kind: 'insert_row_before'}> => c.kind === 'insert_row_before')
                    .map(c => ({sheet_id: c.sheet_id, row: c.row, count: c.count})));
                peer.seq = room.state.seq;
                send(peer, {
                    type: 'state',
                    delta: {
                        generation: room.state.generation,
                        from_seq: baseSeq,
                        seq: room.state.seq,
                        etag: room.state.etag,
                        marker: room.state.marker,
                        insertions,
                        updates,
                    },
                });
                return;
            }
        }
        peer.seq = room.state.seq;
        send(peer, {type: 'state', state: room.state});
    }

    function fanOut(room: Room): void {
        if (!room.state) return;
        for (const peer of room.peers) {
            if (!peer.token || peer.opening || peer.socket.readyState !== WebSocket.OPEN) continue;
            if (peer.seq === room.state.seq) continue;
            sendPeerState(room, peer);
        }
    }

    function extractTailUpdates(log: unknown): WorkbookDeltaUpdate[] {
        if (!record(log) || !Array.isArray(log.tail)) return [];
        const updates: WorkbookDeltaUpdate[] = [];
        for (const item of log.tail) {
            if (!record(item) || !position(item.seq) || typeof item.update_id !== 'string' || typeof item.payload !== 'string') continue;
            try {
                const decoded = JSON.parse(Buffer.from(item.payload, 'base64').toString('utf8')) as unknown;
                if (!record(decoded) || !Array.isArray(decoded.commands)) continue;
                if (record(decoded.delta)) {
                    updates.push({
                        seq: item.seq,
                        update_id: item.update_id,
                        commands: decoded.commands as WorkbookDeltaUpdate['commands'],
                        delta: decoded.delta as WorkbookDeltaPayload,
                    });
                } else if (record(decoded.workbook)) {
                    updates.push({
                        seq: item.seq,
                        update_id: item.update_id,
                        commands: decoded.commands as WorkbookDeltaUpdate['commands'],
                        workbook: decoded.workbook as unknown as WorkbookDeltaUpdate['workbook'],
                    });
                }
            } catch { /* ignore malformed tail entry; replay() validates */ }
        }
        return updates;
    }

    async function syncRoom(roomId: string, room: Room, token: string, forceFull = false): Promise<void> {
        if (room.refreshInFlight) {
            await room.refreshInFlight;
            return;
        }
        const run = (async () => {
            const needFull = forceFull || !room.state;
            const log = await call('read', roomId, token, {
                after_seq: needFull ? null : room.state!.seq,
                include_state: needFull,
            });
            if (record(log) && log.unchanged === true) {
                room.idleStreak++;
                const delay = Math.min(maxIdleRefreshMs, baseRefreshMs * (2 ** Math.min(room.idleStreak, 4)));
                room.nextPollAt = Date.now() + delay;
                return;
            }
            let nextState: WorkbookRoomState;
            try {
                nextState = replay(log, needFull ? undefined : room.state);
            } catch {
                if (needFull) throw new OwnerProblem(503, 'room_unavailable');
                const fullLog = await call('read', roomId, token, {after_seq: null, include_state: true});
                nextState = replay(fullLog);
                room.history.clear();
            }
            if (room.state && nextState.generation !== room.state.generation) {
                room.history.clear();
                room.lease = undefined;
            } else if (room.state && nextState.seq < room.state.seq) {
                throw new OwnerProblem(409, 'generation_changed');
            }
            for (const entry of extractTailUpdates(log)) recordHistory(room, entry);
            room.state = nextState;
            room.idleStreak = 0;
            room.nextPollAt = Date.now() + baseRefreshMs;
            fanOut(room);
        })();
        room.refreshInFlight = run;
        try {
            await run;
        } finally {
            if (room.refreshInFlight === run) room.refreshInFlight = undefined;
        }
    }

    async function pollRoom(roomId: string, room: Room): Promise<void> {
        const candidates = Array.from(room.peers).filter(p => p.token && !p.opening && p.socket.readyState === WebSocket.OPEN);
        if (candidates.length === 0) return;
        for (const peer of candidates) {
            try {
                await syncRoom(roomId, room, peer.token);
                return;
            } catch (cause) {
                if (cause instanceof OwnerProblem && (cause.status === 401 || cause.status === 403 || cause.status === 404)) {
                    error(peer, cause);
                    continue;
                }
                for (const p of candidates) error(p, cause);
                return;
            }
        }
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
        const room = rooms.get(roomId) ?? {peers: new Set<Peer>(), work: Promise.resolve(), queued: 0, history: new Map<number, WorkbookDeltaUpdate>(), idleStreak: 0, nextPollAt: Date.now() + baseRefreshMs};
        rooms.set(roomId, room);
        const peer: Peer = {socket, token: '', seq: -1, opening: true};
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
                void syncRoom(roomId, room, peer.token).then(() => {
                    if (socket.readyState !== WebSocket.OPEN) return;
                    sendPeerState(room, peer, resume);
                    peer.opening = false;
                    clearTimeout(timer);
                }, cause => error(peer, cause));
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
                    let usedCachedLease = false;
                    let lease = room.lease;
                    if (lease && Date.now() < lease.expiresAt) {
                        usedCachedLease = true;
                    } else {
                        const acquired = await call('acquire', roomId, peer.token);
                        if (!record(acquired) || !position(acquired.owner_fence) || !position(acquired.head_seq)) throw new Error('Invalid room lease');
                        lease = {fence: acquired.owner_fence, headSeq: acquired.head_seq, expiresAt: leaseExpiry(acquired.owner_expires_at)};
                        room.lease = lease;
                    }
                    let receipt: unknown;
                    try {
                        receipt = await append(room, roomId, peer.token, lease.fence, {base_seq: lease.headSeq, intent, if_match: tag}, traceparent);
                    } catch (cause) {
                        if (usedCachedLease && cause instanceof OwnerProblem && (cause.code === 'stale_owner' || cause.code === 'base_moved')) {
                            room.lease = undefined;
                            const reacquired = await call('acquire', roomId, peer.token);
                            if (!record(reacquired) || !position(reacquired.owner_fence) || !position(reacquired.head_seq)) throw new Error('Invalid room lease');
                            lease = {fence: reacquired.owner_fence, headSeq: reacquired.head_seq, expiresAt: leaseExpiry(reacquired.owner_expires_at)};
                            room.lease = lease;
                            receipt = await append(room, roomId, peer.token, lease.fence, {base_seq: lease.headSeq, intent, if_match: tag}, traceparent);
                        } else {
                            if (cause instanceof OwnerProblem && TERMINAL_ROOM_CODES.has(cause.code)) room.lease = undefined;
                            throw cause;
                        }
                    }
                    if (!record(receipt) || receipt.state !== 'committed' || receipt.command_id !== commandId || !position(receipt.seq)) throw new Error('Invalid workbook receipt');
                    if (room.lease && room.lease.fence === lease.fence) room.lease.headSeq = receipt.seq;
                    send(peer, {type: 'ack', receipt: receipt as unknown as WorkbookReceipt});

                    const update = record(receipt.update) ? receipt.update : null;
                    if (update && room.state && receipt.seq === room.state.seq + 1
                        && record(receipt.marker) && receipt.marker.generation === room.state.generation
                        && typeof receipt.etag === 'string' && Array.isArray(update.commands) && record(update.delta) && typeof update.update_id === 'string') {
                        const deltaEntry: WorkbookDeltaUpdate = {
                            seq: receipt.seq,
                            update_id: update.update_id,
                            commands: update.commands as WorkbookDeltaUpdate['commands'],
                            delta: update.delta as WorkbookDeltaPayload,
                        };
                        recordHistory(room, deltaEntry);
                        const insertions = Array.isArray(receipt.insertions)
                            ? receipt.insertions as NonNullable<WorkbookRoomState['insertions']>
                            : deltaEntry.commands.filter((c): c is Extract<typeof c, {kind: 'insert_row_before'}> => c.kind === 'insert_row_before')
                                .map(c => ({sheet_id: c.sheet_id, row: c.row, count: c.count}));
                        room.state = {
                            generation: room.state.generation,
                            seq: receipt.seq,
                            etag: receipt.etag,
                            marker: receipt.marker as unknown as WorkbookRoomMarker,
                            workbook: applyDeltaPayload(room.state.workbook, deltaEntry.commands, deltaEntry.delta!),
                            insertions,
                        };
                        room.idleStreak = 0;
                        room.nextPollAt = Date.now() + baseRefreshMs;
                        fanOut(room);
                    } else {
                        await syncRoom(roomId, room, peer.token);
                    }
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
        const now = Date.now();
        for (const [id, room] of rooms) {
            if (!room.queued && !room.refreshInFlight && now >= room.nextPollAt) void pollRoom(id, room);
        }
    }, Math.min(baseRefreshMs, 1_000));
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
