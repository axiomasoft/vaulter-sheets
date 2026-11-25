import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, type IncomingMessage} from 'node:http';
import {BlockList, isIP} from 'node:net';
import {pathToFileURL} from 'node:url';
import {WebSocket, WebSocketServer} from 'ws';
import {PROTOCOL, WEBSOCKET_SUBPROTOCOL, position, record, type ServerMessage, type WorkbookDeltaPayload, type WorkbookDeltaUpdate, type WorkbookPresence, type WorkbookPresenceSelection, type WorkbookReceipt, type WorkbookRoomMarker, type WorkbookRoomState} from './protocol.ts';
import {applyDeltaPayload, replay} from './replay.ts';

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 24 * 1024 * 1024;
const OWNER_RENEW_MS = 5_000; // The PHP owner lease lasts 15 seconds.
const LEASE_SAFETY_MS = 5_000;
const DEFAULT_LEASE_TTL_MS = 10_000;
const HISTORY_LIMIT = 64;
const TERMINAL_ROOM_CODES = new Set(['generation_changed', 'room_not_active', 'stale_owner', 'owner_busy']);
/** The close of a peer whose room token expired; the code the collaboration hub uses, so a client renews its session. */
const TOKEN_EXPIRED = {code: 4001, reason: 'Room credential expired'} as const;
/** setTimeout() fires at once for a delay above 2^31 - 1 ms; a later expiry is re-armed from there. */
const MAX_TIMER_MS = 2_147_483_647;
/** How long a peer's token may go without an owner read made with it; bounds how long a revoked token keeps fan-out. */
const REVALIDATE_MS = 60_000;
/** The peers one room serves; only peers whose credential the owner accepted count. */
const ROOM_PEER_LIMIT = 32;
/** The intents a room holds for all its peers, and for one peer: the client sends one at a time, so one peer cannot fill the room's queue. */
const ROOM_QUEUE_LIMIT = 64;
const PEER_QUEUE_LIMIT = 4;
/** The sockets one process holds, peers still presenting their credential included. */
const SOCKET_LIMIT = 1024;
/**
 * Presence changes of a room are sent on at most once per this interval: every change is a list of every
 * other peer's presence for every peer (quadratic in the room), so a peer moving its selection, or sending
 * awareness messages as fast as it can, must not set the rate of that fan-out.
 */
const AWARENESS_INTERVAL_MS = 50;
/**
 * The sockets one client address may hold before the owner accepted their credential. Such a socket costs an
 * owner read and up to 5 s of a SOCKET_LIMIT slot, so without a per-address bound one client could fill the
 * process; admitted peers do not count, so a user with many tabs is not limited.
 */
export const DEFAULT_PENDING_PER_ADDRESS = 32;

class OwnerProblem extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

interface Options {
    ownerUrl: string;
    ownerToken: string;
    refreshMs?: number;
    revalidateMs?: number;
    /** See DEFAULT_PENDING_PER_ADDRESS. */
    pendingPerAddress?: number;
    /** Proxies (addresses or CIDR subnets) whose X-Forwarded-For names the client; others are the client. */
    trustedProxies?: readonly string[];
}

/** A BlockList of addresses and CIDR subnets (`10.0.0.0/8`, `fd00::/8`); throws on an entry that is neither. */
export function proxyList(entries: readonly string[]): BlockList {
    const list = new BlockList();
    for (const entry of entries) {
        const [address, prefix, extra] = entry.split('/');
        const family = isIP(address ?? '');
        const bits = prefix === undefined ? null : Number(prefix);
        if (family === 0 || extra !== undefined || (bits !== null && (!/^\d{1,3}$/.test(prefix!) || bits > (family === 4 ? 32 : 128)))) {
            throw new Error(`Invalid trusted proxy: ${entry}`);
        }
        const type = family === 4 ? 'ipv4' : 'ipv6';
        if (bits === null) list.addAddress(address!, type);
        else list.addSubnet(address!, bits, type);
    }
    return list;
}

function plainAddress(address: string): string {
    return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function trusted(proxies: BlockList, address: string): boolean {
    const family = isIP(address);
    return family !== 0 && proxies.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client address of an upgrade: the peer address, or, when that is a trusted proxy, the right-most
 * X-Forwarded-For entry that is not one (the left part of the header is whatever the client sent).
 */
export function clientAddress(request: IncomingMessage, proxies: BlockList): string {
    let address = plainAddress(request.socket.remoteAddress ?? '');
    if (!trusted(proxies, address)) return address;
    const header = request.headers['x-forwarded-for'];
    const hops = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(hop => plainAddress(hop.trim()));
    for (let i = hops.length - 1; i >= 0; i--) {
        if (isIP(hops[i]!) === 0) return address;
        address = hops[i]!;
        if (!trusted(proxies, address)) return address;
    }
    return address;
}
interface Peer {
    socket: WebSocket;
    token: string;
    seq: number;
    opening: boolean;
    presence?: WorkbookPresence;
    /** The presence `client_id` other peers see: the room's, one per socket, never the client's. */
    presenceId: string;
    /** The token's subject once the owner admitted the peer; its presence carries it as `user.id` / `user.type`. */
    principal?: {id: string; type: string} | null;
    expiry?: NodeJS.Timeout;
    checkedAt: number;
    /** This peer's intents in the room's queue. */
    queued: number;
}

/**
 * The `exp` claim (unix seconds) of a room JWT, read WITHOUT verifying the signature: the owner verifies
 * the token on every call, this only bounds how long fan-out may reach a peer between those calls.
 * A token without a readable `exp` gets null and relies on the owner's checks alone.
 */
export function tokenExpiry(token: string): number | null {
    const payload = token.split('.')[1];
    if (payload === undefined) return null;
    try {
        const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return record(claims) && Number.isSafeInteger(claims.exp) ? claims.exp as number : null;
    } catch {
        return null;
    }
}
/**
 * The subject (`sub`, `sub_type`) of a room JWT, read without verifying the signature: it is read once the owner
 * accepted the token, which verified it. Null when the token names no subject.
 */
export function tokenPrincipal(token: string): {id: string; type: string} | null {
    const payload = token.split('.')[1];
    if (payload === undefined) return null;
    try {
        const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!record(claims) || typeof claims.sub !== 'string' || claims.sub === '' || typeof claims.sub_type !== 'string' || claims.sub_type === '') return null;
        return {id: claims.sub, type: claims.sub_type};
    } catch {
        return null;
    }
}
interface RoomLease {fence: number; headSeq: number; expiresAt: number}
interface Room {
    peers: Set<Peer>;
    work: Promise<void>;
    queued: number;
    state?: WorkbookRoomState;
    history: Map<number, WorkbookDeltaUpdate>;
    lease?: RoomLease;
    refreshInFlight?: Promise<void>;
    /** A pollRoom() pass is running; its reads are sequential, so the timer must not start a second one between them. */
    polling?: boolean;
    /** A presence broadcast is scheduled (AWARENESS_INTERVAL_MS); later changes ride on it. */
    awarenessTimer?: NodeJS.Timeout;
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
    const pendingPerAddress = options.pendingPerAddress ?? DEFAULT_PENDING_PER_ADDRESS;
    if (!Number.isSafeInteger(pendingPerAddress) || pendingPerAddress < 1) throw new Error('Invalid pending connection limit');
    const proxies = proxyList(options.trustedProxies ?? []);
    /** Sockets per client address whose credential the owner has not accepted yet. */
    const pending = new Map<string, number>();
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
    const revalidateMs = options.revalidateMs ?? REVALIDATE_MS;
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

    /** The peers of a room the owner admitted: those its peer limit counts. */
    function admitted(room: Room | undefined): number {
        let count = 0;
        for (const peer of room?.peers ?? []) if (!peer.opening) count++;
        return count;
    }

    /** Send the room's presence on once the current interval ends; changes until then are sent together. */
    function scheduleAwareness(room: Room): void {
        if (room.awarenessTimer) return;
        room.awarenessTimer = setTimeout(() => {
            room.awarenessTimer = undefined;
            broadcastAwareness(room);
        }, AWARENESS_INTERVAL_MS);
        room.awarenessTimer.unref();
    }

    function broadcastAwareness(room: Room): void {
        for (const recipient of room.peers) {
            if (!recipient.token || recipient.opening || recipient.socket.readyState !== WebSocket.OPEN) continue;
            const peers: WorkbookPresence[] = [];
            for (const other of room.peers) {
                if (other === recipient || !other.presence || other.opening || other.socket.readyState !== WebSocket.OPEN) continue;
                peers.push(other.presence);
            }
            send(recipient, {type: 'awareness', peers});
        }
    }

    /**
     * A peer's presence as the room sends it on. Identity is the room's: `client_id` is the socket's own id and
     * `user.id` / `user.type` the subject of the token the owner accepted; a client's `user.id` is never passed on.
     * Name and colour are the client's, display only.
     */
    function parseAwareness(message: Record<string, unknown>, peer: Peer): WorkbookPresence | null {
        if (typeof message.client_id !== 'string' || message.client_id.length === 0 || message.client_id.length > 128) return null;
        const presence: WorkbookPresence = {client_id: peer.presenceId, updated_at: Date.now()};
        const user: NonNullable<WorkbookPresence['user']> = {};
        if (message.user !== undefined) {
            if (!record(message.user)) return null;
            if (message.user.id !== undefined && typeof message.user.id !== 'string' && typeof message.user.id !== 'number') return null;
            if (message.user.name !== undefined) {
                if (typeof message.user.name !== 'string' || message.user.name.length > 128) return null;
                user.name = message.user.name;
            }
            if (message.user.color !== undefined) {
                if (typeof message.user.color !== 'string' || message.user.color.length > 32) return null;
                user.color = message.user.color;
            }
        }
        if (peer.principal) {
            user.id = peer.principal.id;
            user.type = peer.principal.type;
        }
        if (Object.keys(user).length > 0) presence.user = user;
        if (message.selection !== undefined) {
            if (message.selection === null) {
                presence.selection = null;
            } else if (record(message.selection)
                && typeof message.selection.sheet_id === 'string' && message.selection.sheet_id.length > 0 && message.selection.sheet_id.length <= 128
                && position(message.selection.start_row) && message.selection.start_row > 0
                && position(message.selection.start_column) && message.selection.start_column > 0
                && position(message.selection.end_row) && message.selection.end_row >= message.selection.start_row
                && position(message.selection.end_column) && message.selection.end_column >= message.selection.start_column) {
                presence.selection = {
                    sheet_id: message.selection.sheet_id,
                    start_row: message.selection.start_row,
                    start_column: message.selection.start_column,
                    end_row: message.selection.end_row,
                    end_column: message.selection.end_column,
                } satisfies WorkbookPresenceSelection;
            } else {
                return null;
            }
        }
        return presence;
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

    /**
     * Refresh the room from the PHP owner with `token`. A caller that only needs fresh state joins a refresh
     * already in flight. A caller that needs `token` itself checked (`admit`: an opening peer, a poll that
     * revalidates a peer) must not: the owner checks the bearer of each read, so riding on another peer's
     * read would pass a token nobody verified. It waits for that read and makes its own.
     */
    async function syncRoom(roomId: string, room: Room, token: string, forceFull = false, admit = false): Promise<void> {
        while (room.refreshInFlight) {
            const pending = room.refreshInFlight;
            if (!admit) {
                await pending;
                return;
            }
            // Another peer's failure says nothing about this token; its own read below decides.
            await pending.catch(() => undefined);
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

    function stale(peer: Peer, now: number): boolean {
        return now - peer.checkedAt >= revalidateMs;
    }

    /**
     * Refresh the room, then re-check every peer whose token has gone `revalidateMs` without an owner read.
     * Each read is made with one peer's own token (the owner checks expiry, revocation and access on every
     * read) and counts only for that peer: a refresh another peer's token passed authorizes nobody else.
     * The stalest peer goes first, so the refresh itself rotates through the room.
     */
    async function pollRoom(roomId: string, room: Room): Promise<void> {
        const candidates = Array.from(room.peers)
            .filter(p => p.token && !p.opening && p.socket.readyState === WebSocket.OPEN)
            .sort((left, right) => left.checkedAt - right.checkedAt);
        room.polling = true;
        try {
            let refreshed = false;
            for (const peer of candidates) {
                if (peer.socket.readyState !== WebSocket.OPEN || (refreshed && !stale(peer, Date.now()))) continue;
                try {
                    await syncRoom(roomId, room, peer.token, false, true);
                    peer.checkedAt = Date.now();
                    refreshed = true;
                } catch (cause) {
                    if (cause instanceof OwnerProblem && (cause.status === 401 || cause.status === 403 || cause.status === 404)) {
                        error(peer, cause);
                        continue;
                    }
                    // After the refresh, a transient failure of one revalidation read leaves that peer stale
                    // for the next tick; it says nothing about the room or the other peers.
                    if (refreshed) continue;
                    for (const p of candidates) error(p, cause);
                    return;
                }
            }
        } finally {
            room.polling = false;
        }
    }

    server.on('upgrade', (request, socket, head) => {
        const match = /^\/v1\/rooms\/([A-Za-z0-9._-]{1,260})$/.exec(request.url ?? '');
        const requested = request.headers['sec-websocket-protocol'];
        if (!match || typeof requested !== 'string' || !requested.split(',').map(item => item.trim()).includes(WEBSOCKET_SUBPROTOCOL)
            || sockets.clients.size >= SOCKET_LIMIT || admitted(rooms.get(match[1])) >= ROOM_PEER_LIMIT) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        const address = clientAddress(request, proxies);
        if ((pending.get(address) ?? 0) >= pendingPerAddress) {
            socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
            return;
        }
        sockets.handleUpgrade(request, socket, head, ws => attach(match[1], ws, address));
    });

    /** Close the peer when its token expires, so no fan-out reaches it on a dead credential. */
    function armExpiry(peer: Peer): void {
        const exp = tokenExpiry(peer.token);
        if (exp === null) return;
        const fire = (): void => {
            const left = exp * 1000 - Date.now();
            if (left <= 0) {
                peer.socket.close(TOKEN_EXPIRED.code, TOKEN_EXPIRED.reason);
                return;
            }
            peer.expiry = setTimeout(fire, Math.min(left, MAX_TIMER_MS));
            peer.expiry.unref();
        };
        fire();
    }

    function attach(roomId: string, socket: WebSocket, address: string): void {
        const room = rooms.get(roomId) ?? {peers: new Set<Peer>(), work: Promise.resolve(), queued: 0, history: new Map<number, WorkbookDeltaUpdate>(), idleStreak: 0, nextPollAt: Date.now() + baseRefreshMs};
        rooms.set(roomId, room);
        const peer: Peer = {socket, token: '', seq: -1, opening: true, presenceId: randomUUID(), checkedAt: 0, queued: 0};
        room.peers.add(peer);
        const timer = setTimeout(() => socket.close(4403, 'Room credential required'), 5000);
        pending.set(address, (pending.get(address) ?? 0) + 1);
        let counted = true;
        const settle = (): void => {
            if (!counted) return;
            counted = false;
            const left = (pending.get(address) ?? 1) - 1;
            if (left > 0) pending.set(address, left);
            else pending.delete(address);
        };

        socket.on('error', () => socket.terminate());
        socket.on('close', () => {
            settle();
            clearTimeout(timer);
            clearTimeout(peer.expiry);
            const hadPresence = Boolean(peer.presence);
            room.peers.delete(peer);
            if (hadPresence) scheduleAwareness(room);
            if (!room.peers.size && !room.queued) {
                clearTimeout(room.awarenessTimer);
                rooms.delete(roomId);
            }
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
                armExpiry(peer);
                const resume = position(message.after_seq) ? message.after_seq : null;
                void syncRoom(roomId, room, peer.token, false, true).then(() => {
                    peer.checkedAt = Date.now();
                    if (socket.readyState !== WebSocket.OPEN) return;
                    // Peers that opened together are counted here, once each is admitted.
                    if (admitted(room) >= ROOM_PEER_LIMIT) {
                        socket.close(1013, 'Room full');
                        return;
                    }
                    sendPeerState(room, peer, resume);
                    peer.principal = tokenPrincipal(peer.token);
                    peer.opening = false;
                    settle();
                    clearTimeout(timer);
                    const activePeers = Array.from(room.peers)
                        .filter(other => other !== peer && other.presence && !other.opening && other.socket.readyState === WebSocket.OPEN)
                        .map(other => other.presence!);
                    if (activePeers.length > 0) send(peer, {type: 'awareness', peers: activePeers});
                }, cause => error(peer, cause));
                return;
            }
            if (!peer.opening && message.type === 'awareness') {
                const parsed = parseAwareness(message, peer);
                if (!parsed) {
                    socket.close(1007, 'Invalid awareness message');
                    return;
                }
                peer.presence = parsed;
                scheduleAwareness(room);
                return;
            }
            const intent = message.intent;
            if (peer.opening || message.type !== 'intent' || !record(intent) || typeof intent.command_id !== 'string'
                || !/^[A-Za-z0-9._-]{1,255}$/.test(intent.command_id) || (message.if_match !== null && typeof message.if_match !== 'string')) {
                socket.close(1007, 'Invalid room intent');
                return;
            }
            const commandId = intent.command_id;
            if (room.queued >= ROOM_QUEUE_LIMIT || peer.queued >= PEER_QUEUE_LIMIT) {
                send(peer, {type: 'error', command_id: commandId, code: 'room_busy', retryable: true});
                return;
            }
            const tag = message.if_match;
            const traceparent = typeof message.traceparent === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(message.traceparent) ? message.traceparent : undefined;
            room.queued++;
            peer.queued++;
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
                    peer.queued--;
                    if (!room.peers.size && !room.queued) rooms.delete(roomId);
                }
            });
        });
    }

    const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, room] of rooms) {
            if (room.queued || room.refreshInFlight || room.polling) continue;
            if (now >= room.nextPollAt || Array.from(room.peers).some(peer => !peer.opening && stale(peer, now))) void pollRoom(id, room);
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
    const pendingPerAddress = Number(process.env.SHEETS_REALTIME_PENDING_PER_ADDRESS ?? DEFAULT_PENDING_PER_ADDRESS);
    const trustedProxies = (process.env.SHEETS_REALTIME_TRUSTED_PROXIES ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '');
    if (!ownerUrl || !tokenFile || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid realtime configuration');
    const application = createRealtimeServer({ownerUrl, ownerToken: readFileSync(tokenFile, 'utf8').trim(), pendingPerAddress, trustedProxies});
    application.server.listen(port, '0.0.0.0');
    process.once('SIGTERM', application.close);
    process.once('SIGINT', application.close);
}
