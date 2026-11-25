import type {Command, WorkbookV2} from '@vaulter/sheets-runtime/browser';

export const PROTOCOL = 'univer-sheets/1';
export const WEBSOCKET_SUBPROTOCOL = 'univer-sheets.v1';

export interface WorkbookRoomSession {
    endpoint: string;
    token: string;
    generation: number;
    mode: 'read' | 'write';
}

export interface WorkbookRoomMarker {
    generation: number;
    position: number;
    sha256: string;
}

export interface WorkbookRoomState {
    generation: number;
    seq: number;
    etag: string;
    marker: WorkbookRoomMarker;
    workbook: WorkbookV2;
    insertions: Pick<Extract<Command, {kind: 'insert_row_before'}>, 'sheet_id' | 'row' | 'count'>[] | null;
}

export interface WorkbookIntent {
    command_id: string;
    expected_generation: number;
    policy: 'exact_base' | 'rebase_cells' | 'revalidate_by_id';
    commands: Command[];
}

export interface WorkbookReceipt {
    state: 'committed';
    command_id: string;
    receipt_id: string;
    marker: WorkbookRoomMarker;
    etag: string;
    seq: number;
}

export interface WorkbookDeltaSheet {
    full_sheet?: Record<string, unknown>;
    name?: string;
    row_count?: number;
    column_count?: number;
    row_data?: Record<string, unknown>;
    column_data?: Record<string, unknown>;
    merge_data?: unknown[];
    cells?: Record<string, Record<string, unknown | null>>;
}

export interface WorkbookDeltaPayload {
    tables?: WorkbookV2['tables'];
    sheet_order?: string[];
    resources?: unknown[];
    styles?: Record<string, unknown>;
    removed_styles?: string[];
    sheets?: Record<string, WorkbookDeltaSheet>;
}

export interface WorkbookDeltaUpdate {
    seq: number;
    update_id: string;
    commands: Command[];
    delta?: WorkbookDeltaPayload;
    workbook?: WorkbookV2;
}

export interface WorkbookRoomDelta {
    generation: number;
    from_seq: number;
    seq: number;
    etag: string;
    marker: WorkbookRoomMarker;
    insertions: NonNullable<WorkbookRoomState['insertions']>;
    updates: WorkbookDeltaUpdate[];
}

export interface WorkbookPresenceSelection {
    sheet_id: string;
    start_row: number;
    start_column: number;
    end_row: number;
    end_column: number;
}

export interface WorkbookPresence {
    client_id: string;
    /** `id` and `type` are the subject of the peer's verified room token, set by the room; name and colour are the peer's own. */
    user?: {id?: string | number; type?: string; name?: string; color?: string};
    selection?: WorkbookPresenceSelection | null;
    updated_at: number;
}

export type ClientMessage =
    | {type: 'open'; token: string; after_seq?: number}
    | {type: 'intent'; intent: WorkbookIntent; if_match: string | null; traceparent?: string}
    | {type: 'awareness'; client_id: string; user?: WorkbookPresence['user']; selection?: WorkbookPresenceSelection | null};

export type ServerMessage =
    | {type: 'state'; state: WorkbookRoomState; delta?: never}
    | {type: 'state'; delta: WorkbookRoomDelta; state?: never}
    | {type: 'ack'; receipt: WorkbookReceipt}
    | {type: 'error'; command_id: string; code: string; retryable: boolean}
    | {type: 'awareness'; peers: WorkbookPresence[]};

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shiftCellData(cellData: Record<string, Record<string, unknown>>, commands: readonly Command[], sheetId: string): void {
    for (const cmd of commands) {
        if (cmd.kind !== 'insert_row_before' || cmd.sheet_id !== sheetId) continue;
        const start = cmd.row - 1;
        const next: Record<string, Record<string, unknown>> = {};
        for (const [rKey, row] of Object.entries(cellData)) {
            const idx = Number(rKey);
            next[String(idx >= start ? idx + cmd.count : idx)] = row;
        }
        for (const key of Object.keys(cellData)) delete cellData[key];
        Object.assign(cellData, next);
    }
}

export function applyDeltaPayload(base: WorkbookV2, commands: readonly Command[], delta: WorkbookDeltaPayload): WorkbookV2 {
    const next = structuredClone(base);
    const native = next.native as Record<string, unknown>;
    if (delta.tables !== undefined) next.tables = structuredClone(delta.tables);
    if (delta.sheet_order !== undefined) native.sheetOrder = structuredClone(delta.sheet_order);
    if (delta.resources !== undefined) native.resources = structuredClone(delta.resources);
    const styles = (native.styles ??= {}) as Record<string, unknown>;
    if (Array.isArray(delta.removed_styles)) {
        for (const key of delta.removed_styles) delete styles[key];
    }
    if (record(delta.styles)) {
        for (const [key, style] of Object.entries(delta.styles)) styles[key] = structuredClone(style);
    }
    if (record(delta.sheets)) {
        const sheets = (native.sheets ??= {}) as Record<string, Record<string, unknown>>;
        for (const [sheetId, sheetDelta] of Object.entries(delta.sheets)) {
            if (!record(sheetDelta)) continue;
            if (record(sheetDelta.full_sheet)) {
                sheets[sheetId] = structuredClone(sheetDelta.full_sheet);
                continue;
            }
            const sheet = (sheets[sheetId] ??= {});
            if (typeof sheetDelta.name === 'string') sheet.name = sheetDelta.name;
            if (typeof sheetDelta.row_count === 'number') sheet.rowCount = sheetDelta.row_count;
            if (typeof sheetDelta.column_count === 'number') sheet.columnCount = sheetDelta.column_count;
            if (sheetDelta.row_data !== undefined) sheet.rowData = structuredClone(sheetDelta.row_data);
            if (sheetDelta.column_data !== undefined) sheet.columnData = structuredClone(sheetDelta.column_data);
            if (sheetDelta.merge_data !== undefined) sheet.mergeData = structuredClone(sheetDelta.merge_data);
            const cellData = (sheet.cellData ??= {}) as Record<string, Record<string, unknown>>;
            shiftCellData(cellData, commands, sheetId);
            if (record(sheetDelta.cells)) {
                for (const [rKey, rowPatch] of Object.entries(sheetDelta.cells)) {
                    if (!record(rowPatch)) continue;
                    const row = (cellData[rKey] ??= {});
                    for (const [cKey, cell] of Object.entries(rowPatch)) {
                        if (cell === null) delete row[cKey];
                        else row[cKey] = structuredClone(cell);
                    }
                    if (Object.keys(row).length === 0) delete cellData[rKey];
                }
            }
        }
    }
    return next;
}

export function applyRoomDelta(state: WorkbookRoomState, delta: WorkbookRoomDelta): WorkbookRoomState {
    if (state.generation !== delta.generation || state.seq !== delta.from_seq) {
        throw new Error('Incompatible workbook delta');
    }
    let current = state.workbook;
    let cursor = state.seq;
    for (const update of delta.updates) {
        if (update.seq !== cursor + 1) throw new Error('Journal gap');
        if (update.workbook) current = update.workbook;
        else if (update.delta) current = applyDeltaPayload(current, update.commands, update.delta);
        else throw new Error('Invalid workbook delta update');
        cursor++;
    }
    if (cursor !== delta.seq) throw new Error('Journal tail is incomplete');
    return {
        generation: delta.generation,
        seq: delta.seq,
        etag: delta.etag,
        marker: delta.marker,
        workbook: current,
        insertions: delta.insertions,
    };
}

export function position(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
