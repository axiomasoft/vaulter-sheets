import {CanceledError, CellValueType, CommandType, type ICommandService, type IExecutionOptions} from '@univerjs/core';
import {InsertRowMutation, SetRangeValuesMutation} from '@univerjs/sheets';
import {SetCellEditVisibleOperation, type IEditorBridgeService, type IEditorBridgeServiceVisibleParam} from '@univerjs/sheets-ui';
import type {CellContent, Command, WorkbookV2} from '@vaulter/sheets-runtime/browser';
import {WorkbookRoomClient, type PendingIntent} from './client.ts';
import {position, record, type WorkbookIntent, type WorkbookRoomState} from './protocol.ts';

interface WorkbookView {
    unitId: string;
    commands: Pick<ICommandService, 'beforeCommandExecuted' | 'onCommandExecuted'> & {
        executeCommand(id: string, params: object, flags: IExecutionOptions): Promise<unknown>;
    };
    editor?: Pick<IEditorBridgeService, 'getEditLocation' | 'updateEditLocation' | 'refreshEditCellPosition'>
        & Partial<Pick<IEditorBridgeService, 'isVisible'>>;
    readCell(sheet: string, row: number, column: number): CellContent;
    /** Replace the working model in place so the active editor and selection can be updated. */
    replace(workbook: WorkbookV2, flags: IExecutionOptions): void | Promise<void>;
    onUnsupportedMutation?: (id: string) => void;
    onDraftConflict?: () => void;
    onRenderError?: (cause: unknown) => void;
}

function cellCommand(value: unknown, sheet: string, row: number, column: number, expected: CellContent): Command | null {
    if (value === null || (record(value) && (value.v === null && value.f == null))) {
        return {kind: 'set_values', sheet_id: sheet, row, column, values: [[null]], expected: [[expected]]};
    }
    if (!record(value) || Object.keys(value).some(key => !['v', 't', 'f'].includes(key))) return null;
    if (typeof value.f === 'string' && value.f.startsWith('=')) return {kind: 'set_formula', sheet_id: sheet, row, column, expected, formula: value.f};
    if (value.t !== CellValueType.BOOLEAN && typeof value.v === 'number' && Number.isFinite(value.v)) {
        return {kind: 'set_number', sheet_id: sheet, row, column, expected, value: value.v};
    }
    if (typeof value.v === 'string') return {kind: 'set_text', sheet_id: sheet, row, column, expected, value: value.v};
    return null;
}

function typedMutation(id: string, params: Record<string, unknown>, view: WorkbookView): {policy: WorkbookIntent['policy']; commands: Command[]} | null {
    const sheet = params.subUnitId;
    if (typeof sheet !== 'string') return null;
    if (id === InsertRowMutation.id && record(params.range) && position(params.range.startRow) && position(params.range.endRow)
        && params.range.endRow >= params.range.startRow) {
        return {policy: 'exact_base', commands: [{kind: 'insert_row_before', sheet_id: sheet,
            row: params.range.startRow + 1, count: params.range.endRow - params.range.startRow + 1}]};
    }
    if (id !== SetRangeValuesMutation.id || !record(params.cellValue)) return null;
    const commands: Command[] = [];
    for (const [y, cells] of Object.entries(params.cellValue)) {
        const row = Number(y);
        if (!position(row) || !record(cells)) return null;
        for (const [x, data] of Object.entries(cells)) {
            const column = Number(x);
            if (!position(column) || commands.length >= 64) return null;
            const command = cellCommand(data, sheet, row + 1, column + 1, view.readCell(sheet, row, column));
            if (!command) return null;
            commands.push(command);
        }
    }
    return commands.length ? {policy: 'rebase_cells', commands} : null;
}

type Insertion = NonNullable<WorkbookRoomState['insertions']>[number];

const cancelEdit = {
    visible: false,
    eventType: 4, // Univer's DeviceInputEventType.Keyboard
    keycode: 27, // Univer's KeyCode.ESC
} satisfies Omit<IEditorBridgeServiceVisibleParam, 'unitId'>;

export function shiftDraftRow(sheet: string, row: number, insertions: readonly Insertion[]): number {
    for (const insertion of insertions) if (insertion.sheet_id === sheet && row >= insertion.row - 1) row += insertion.count;
    return row;
}

async function preview(view: WorkbookView, command: Command): Promise<void> {
    if (command.kind === 'fill_formula') return;
    const flags = {fromCollab: true, onlyLocal: true};
    const scope = {unitId: view.unitId, subUnitId: command.sheet_id};
    const row = command.row - 1;
    if (command.kind === 'insert_row_before') {
        await view.commands.executeCommand(InsertRowMutation.id, {...scope, range: {
            startRow: row, endRow: row + command.count - 1, startColumn: 0, endColumn: 0,
        }}, flags);
        return;
    }
    const column = command.column - 1;
    let cellValue: Record<number, Record<number, object | null>>;
    if (command.kind === 'set_values') {
        cellValue = Object.fromEntries(command.values.map((line, y) => [row + y, Object.fromEntries(line.map((value, x) => [column + x,
            value === null ? {v: null, f: null} : 'number' in value ? {v: value.number, t: CellValueType.NUMBER, f: null} : {v: value.text, t: CellValueType.STRING, f: null},
        ]))]));
    } else {
        const value = command.kind === 'set_formula' ? {f: command.formula, v: null}
            : {v: command.value, t: command.kind === 'set_number' ? CellValueType.NUMBER : CellValueType.STRING, f: null};
        cellValue = {[row]: {[column]: value}};
    }
    await view.commands.executeCommand(SetRangeValuesMutation.id, {...scope, cellValue}, flags);
}

/** Bind the public Univer command hook and keep optimistic mutations separate from the confirmed workbook. */
export function connectNativeWorkbook(view: WorkbookView, options: Omit<ConstructorParameters<typeof WorkbookRoomClient>[0], 'onState'>) {
    let disposed = false;
    let last: WorkbookRoomState | undefined;
    let pendingView: readonly PendingIntent[] = [];
    let renderedPending: readonly PendingIntent[] | undefined;
    let previewedInsertion = false;
    let queued = Promise.resolve();
    const structures = new Map<string, Insertion[] | null>();
    const captured = new WeakMap<object, {basis: readonly PendingIntent[]; intent: ReturnType<typeof typedMutation>}>();

    function render(state: WorkbookRoomState, pending: readonly PendingIntent[]): void {
        const items = [...pending];
        pendingView = items;
        queued = queued.then(async () => {
            if (disposed) return;
            const changed = last && (last.seq !== state.seq || last.generation !== state.generation);
            const effects = !changed ? [] : last?.generation === state.generation ? state.insertions : null;
            const editor = view.editor;
            const location = editor?.isVisible?.().visible === false ? null : editor?.getEditLocation();
            const activeLocation = location?.unitId === view.unitId ? location : undefined;
            if (activeLocation && (effects === null || previewedInsertion)) {
                const cancelled = await view.commands.executeCommand(SetCellEditVisibleOperation.id,
                    {...cancelEdit, unitId: view.unitId}, {fromCollab: true, onlyLocal: true});
                view.onDraftConflict?.();
                if (cancelled !== true) throw new Error('Could not discard the conflicting workbook draft');
            }
            await view.replace(state.workbook, {fromCollab: true});
            if (activeLocation && effects && !previewedInsertion) {
                const row = shiftDraftRow(activeLocation.sheetId, activeLocation.row, effects);
                if (row !== activeLocation.row) {
                    editor?.updateEditLocation(row, activeLocation.column);
                    editor?.refreshEditCellPosition();
                }
            }
            if (changed && last) {
                structures.set(last.etag, []);
                for (const [tag, previous] of structures) {
                    structures.set(tag, previous === null || effects === null ? null : [...previous, ...effects]);
                }
                if (structures.size > 64) structures.delete(structures.keys().next().value!);
            }
            last = state;
            previewedInsertion = false;
            for (const {intent, if_match: tag} of items) {
                const crossed = tag === null || tag === state.etag ? [] : structures.get(tag);
                if (!crossed || (intent.policy === 'exact_base' && tag !== state.etag)) continue;
                for (const command of intent.commands) {
                    if (command.kind === 'insert_row_before') previewedInsertion = true;
                    if ('row' in command && crossed.length) {
                        if (command.kind === 'set_formula' || command.kind === 'set_values') continue;
                        const row = shiftDraftRow(command.sheet_id, command.row - 1, crossed) + 1;
                        await preview(view, {...command, row});
                    } else await preview(view, command);
                }
            }
            renderedPending = items;
        }).catch(cause => view.onRenderError?.(cause));
    }

    const client = new WorkbookRoomClient({...options, onState: render});
    const observes = (type: CommandType | undefined, flags?: IExecutionOptions) =>
        type === CommandType.MUTATION && !flags?.onlyLocal && !flags?.fromCollab;
    const before = view.commands.beforeCommandExecuted((command, flags) => {
        if (observes(command.type, flags) && record(command.params) && command.params.unitId === view.unitId) {
            // The displayed coordinates and the client's ETag must refer to the same render.
            if (renderedPending !== pendingView || last !== client.state) throw new CanceledError();
            if (previewedInsertion) {
                view.onUnsupportedMutation?.(command.id);
                throw new CanceledError();
            }
            captured.set(command.params, {basis: pendingView, intent: typedMutation(command.id, command.params, view)});
        }
    });
    const after = view.commands.onCommandExecuted((command, flags) => {
        if (!observes(command.type, flags) || !command.params) return;
        const capture = captured.get(command.params);
        if (!capture) return;
        captured.delete(command.params);
        const {basis, intent} = capture;
        if (intent && client.state && last === client.state && renderedPending === basis && pendingView === basis) {
            try { client.submit(intent.commands, intent.policy); return; } catch { /* restore the confirmed model below */ }
        }
        view.onUnsupportedMutation?.(command.id);
        if (client.state) render(client.state, pendingView);
    });
    client.connect();
    return {client, dispose: () => { disposed = true; before.dispose(); after.dispose(); client.close(); }};
}
