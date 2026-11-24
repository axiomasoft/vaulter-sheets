import type {Command} from '@vaulter/sheets-runtime/browser';
import {
    WEBSOCKET_SUBPROTOCOL, applyRoomDelta, record, type ClientMessage, type ServerMessage,
    type WorkbookIntent, type WorkbookPresence, type WorkbookPresenceSelection, type WorkbookReceipt, type WorkbookRoomDelta, type WorkbookRoomSession, type WorkbookRoomState,
} from './protocol.ts';

export type {WorkbookIntent, WorkbookPresence, WorkbookPresenceSelection, WorkbookReceipt, WorkbookRoomDelta, WorkbookRoomSession, WorkbookRoomState} from './protocol.ts';

export interface PendingIntent {intent: WorkbookIntent; if_match: string | null}

interface Options {
    session: () => Promise<WorkbookRoomSession>;
    onState: (state: WorkbookRoomState, pending: readonly PendingIntent[], delta?: WorkbookRoomDelta) => void;
    onReceipt?: (receipt: WorkbookReceipt) => void;
    onConflict?: (intent: WorkbookIntent, code: string) => void;
    onConnection?: (state: 'connected' | 'reconnecting' | 'closed') => void;
    onAwareness?: (peers: readonly WorkbookPresence[]) => void;
    traceparent?: () => string | undefined;
}

/** Reconnects with the original intent and command id until PHP reports a terminal result. */
export class WorkbookRoomClient {
    #socket: WebSocket | undefined;
    #state: WorkbookRoomState | undefined;
    #session: WorkbookRoomSession | undefined;
    #pending: PendingIntent[] = [];
    #sent: string | undefined;
    #acknowledged = new Map<string, number>();
    #ready = false;
    #closed = false;
    #connecting = false;
    #retry: ReturnType<typeof setTimeout> | undefined;
    #delay = 200;
    #localPresence: {client_id: string; user?: WorkbookPresence['user']; selection?: WorkbookPresenceSelection | null} | undefined;

    private readonly options: Options;

    constructor(options: Options) { this.options = options; }

    connect(): void {
        if (this.#closed || this.#connecting || this.#socket) return;
        clearTimeout(this.#retry);
        this.#connecting = true;
        void this.open();
    }

    get state(): WorkbookRoomState | undefined { return this.#state; }

    submit(commands: Command[], policy: WorkbookIntent['policy'], id = crypto.randomUUID()): string {
        if (this.#closed || this.#session?.mode !== 'write' || !this.#state) throw new Error('A writable workbook session is required');
        if (!/^[A-Za-z0-9._-]{1,255}$/.test(id) || this.#pending.length >= 64 || this.#pending.some(item => item.intent.command_id === id)) {
            throw new Error('Invalid or duplicate pending intent');
        }
        if (policy !== 'revalidate_by_id' && this.#pending.some(({intent}) => intent.commands.some(command => command.kind === 'insert_row_before'))) {
            throw new Error('Wait for the pending row insertion before submitting a positional edit');
        }
        this.#pending.push({
            intent: {command_id: id, expected_generation: this.#state.generation, policy, commands: structuredClone(commands)},
            if_match: policy === 'revalidate_by_id' ? null : this.#state.etag,
        });
        this.render();
        this.flush();
        return id;
    }

    updateAwareness(presence: {client_id?: string; user?: WorkbookPresence['user']; selection?: WorkbookPresenceSelection | null}): void {
        if (this.#closed) return;
        const clientId = presence.client_id ?? this.#localPresence?.client_id ?? crypto.randomUUID();
        this.#localPresence = {client_id: clientId, user: presence.user, selection: presence.selection};
        if (this.#ready) {
            this.send({type: 'awareness', ...this.#localPresence});
        }
    }

    close(): void {
        this.#closed = true;
        clearTimeout(this.#retry);
        this.#localPresence = undefined;
        this.#socket?.close();
        this.options.onAwareness?.([]);
        this.options.onConnection?.('closed');
    }

    private async open(): Promise<void> {
        try {
            const session = await this.options.session();
            if (this.#closed) return;
            this.#session = session;
            const socket = this.#socket = new WebSocket(session.endpoint, WEBSOCKET_SUBPROTOCOL);
            const after = this.#state?.generation === session.generation ? this.#state.seq : undefined;
            socket.addEventListener('open', () => this.send({type: 'open', token: session.token, after_seq: after}));
            socket.addEventListener('message', ({data}) => this.receive(data));
            socket.addEventListener('close', () => {
                this.#socket = undefined;
                this.#sent = undefined;
                this.#ready = false;
                this.retry();
            });
        } catch {
            this.retry();
        } finally {
            this.#connecting = false;
        }
    }

    private receive(data: unknown): void {
        if (this.#closed || typeof data !== 'string') return;
        let value: unknown;
        try { value = JSON.parse(data); } catch { this.#socket?.close(1007); return; }
        if (!record(value)) return;
        const message = value as unknown as ServerMessage;
        let lastDelta: WorkbookRoomDelta | undefined;
        if (message.type === 'state') {
            let nextState: WorkbookRoomState;
            if (message.delta) {
                if (!this.#state || this.#state.generation !== message.delta.generation || this.#state.seq !== message.delta.from_seq) {
                    this.#socket?.close();
                    return;
                }
                nextState = applyRoomDelta(this.#state, message.delta);
                lastDelta = message.delta;
            } else {
                nextState = message.state;
            }
            if (nextState.generation !== this.#session?.generation) { this.#socket?.close(4409); return; }
            if (this.#state && this.#state.generation !== nextState.generation) {
                for (const {intent} of this.#pending.splice(0)) this.options.onConflict?.(intent, 'generation_changed');
                this.#acknowledged.clear();
            }
            if (this.#session.mode === 'read' && this.#pending.length) {
                for (const {intent} of this.#pending.splice(0)) this.options.onConflict?.(intent, 'room_read_only');
                this.#acknowledged.clear();
            }
            this.#state = nextState;
            this.#pending = this.#pending.filter(({intent}) => {
                const seq = this.#acknowledged.get(intent.command_id);
                if (seq === undefined || seq > nextState.seq) return true;
                this.#acknowledged.delete(intent.command_id);
                return false;
            });
            if (!this.#ready) {
                this.options.onConnection?.('connected');
                if (this.#localPresence) this.send({type: 'awareness', ...this.#localPresence});
            }
            this.#ready = true;
            this.#delay = 200;
        } else if (message.type === 'awareness') {
            this.options.onAwareness?.(Array.isArray(message.peers) ? message.peers : []);
            return;
        } else if (message.type === 'ack' && message.receipt.command_id === this.#sent) {
            const {command_id, seq} = message.receipt;
            this.#sent = undefined;
            if (this.#state && this.#state.seq >= seq) this.#pending = this.#pending.filter(item => item.intent.command_id !== command_id);
            else this.#acknowledged.set(command_id, seq);
            this.options.onReceipt?.(message.receipt);
        } else if (message.type === 'error' && message.command_id === this.#sent) {
            this.#sent = undefined;
            if (message.retryable) { this.#socket?.close(); return; }
            const intent = this.#pending.find(item => item.intent.command_id === message.command_id);
            this.#pending = this.#pending.filter(item => item !== intent);
            if (intent) this.options.onConflict?.(intent.intent, message.code);
        } else {
            return;
        }
        this.render(lastDelta);
        this.flush();
    }

    private retry(): void {
        if (this.#closed) return;
        this.options.onConnection?.('reconnecting');
        this.#retry = setTimeout(() => this.connect(), this.#delay);
        this.#delay = Math.min(this.#delay * 2, 5000);
    }

    private flush(): void {
        if (!this.#ready || this.#sent || this.#acknowledged.size) return;
        const next = this.#pending[0];
        if (!next) return;
        this.#sent = next.intent.command_id;
        this.send({type: 'intent', ...next, traceparent: this.options.traceparent?.()});
    }

    private send(message: ClientMessage): void {
        if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
    }

    private render(delta?: WorkbookRoomDelta): void {
        if (this.#state) this.options.onState(this.#state, this.#pending, delta);
    }
}
