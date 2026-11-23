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

export type ClientMessage =
    | {type: 'open'; token: string; after_seq?: number}
    | {type: 'intent'; intent: WorkbookIntent; if_match: string | null; traceparent?: string};

export type ServerMessage =
    | {type: 'state'; state: WorkbookRoomState}
    | {type: 'ack'; receipt: WorkbookReceipt}
    | {type: 'error'; command_id: string; code: string; retryable: boolean};

export function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function position(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
