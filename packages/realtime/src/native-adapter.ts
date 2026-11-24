import {CanceledError, CellValueType, CommandType, type ICommandService, type IExecutionOptions} from '@univerjs/core';
import {InsertRowMutation, SetRangeValuesMutation} from '@univerjs/sheets';
import {SetCellEditVisibleOperation, type IEditorBridgeService, type IEditorBridgeServiceVisibleParam} from '@univerjs/sheets-ui';
import type {CellContent, Command, WorkbookV2} from '@vaulter/sheets-runtime/browser';
import {WorkbookRoomClient, type PendingIntent} from './client.ts';
import {position, record, type WorkbookIntent, type WorkbookRoomDelta, type WorkbookRoomState} from './protocol.ts';

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

    async function applyIncremental(prev: WorkbookRoomState, next: WorkbookRoomState, delta?: WorkbookRoomDelta): Promise<boolean> {
        const flags = {fromCollab: true, onlyLocal: true};
        const prevNative = prev.workbook.native as Record<string, unknown>;
        const nextNative = next.workbook.native as Record<string, unknown>;
        if (JSON.stringify(prevNative.sheetOrder ?? []) !== JSON.stringify(nextNative.sheetOrder ?? [])
            || JSON.stringify(prevNative.resources ?? []) !== JSON.stringify(nextNative.resources ?? [])) {
            return false;
        }
        const styles = (nextNative.styles ?? {}) as Record<string, unknown>;
        const resolveCell = (cell: unknown, extraStyles?: Record<string, unknown>) => {
            if (cell === null) return null;
            if (!record(cell)) return null;
            const resolved: Record<string, unknown> = {p: null, s: null, v: null, t: null, f: null, si: null, ...cell};
            if (typeof cell.s === 'string') {
                const styleObj = extraStyles?.[cell.s] ?? styles[cell.s];
                if (styleObj !== undefined) resolved.s = styleObj;
            }
            return resolved;
        };
        if (delta && delta.updates.length > 0) {
            for (const update of delta.updates) {
                if (update.workbook || !update.delta) return false;
                if (update.delta.sheet_order !== undefined || update.delta.resources !== undefined) return false;
                for (const cmd of update.commands) {
                    if (cmd.kind === 'insert_row_before') {
                        await view.commands.executeCommand(InsertRowMutation.id, {
                            unitId: view.unitId,
                            subUnitId: cmd.sheet_id,
                            range: {startRow: cmd.row - 1, endRow: cmd.row + cmd.count - 2, startColumn: 0, endColumn: 0},
                        }, flags);
                    }
                }
                if (update.delta.sheets) {
                    for (const [sheetId, sheetDelta] of Object.entries(update.delta.sheets)) {
                        if (sheetDelta.full_sheet || sheetDelta.row_data !== undefined || sheetDelta.column_data !== undefined || sheetDelta.merge_data !== undefined) {
                            return false;
                        }
                        if (sheetDelta.cells) {
                            const cellValue: Record<number, Record<number, object | null>> = {};
                            for (const [rKey, rowPatch] of Object.entries(sheetDelta.cells)) {
                                const r = Number(rKey);
                                for (const [cKey, cell] of Object.entries(rowPatch)) {
                                    (cellValue[r] ??= {})[Number(cKey)] = resolveCell(cell, update.delta.styles);
                                }
                            }
                            if (Object.keys(cellValue).length > 0) {
                                await view.commands.executeCommand(SetRangeValuesMutation.id, {
                                    unitId: view.unitId, subUnitId: sheetId, cellValue, isOverrideStyle: true,
                                }, flags);
                            }
                        }
                    }
                }
            }
            return true;
        }
        const prevSheets = (prevNative.sheets ?? {}) as Record<string, Record<string, unknown>>;
        const nextSheets = (nextNative.sheets ?? {}) as Record<string, Record<string, unknown>>;
        for (const sheetId of (nextNative.sheetOrder ?? []) as string[]) {
            const pSheet = prevSheets[sheetId];
            const nSheet = nextSheets[sheetId];
            if (!pSheet || !nSheet) return false;
            if (JSON.stringify(pSheet.rowData ?? {}) !== JSON.stringify(nSheet.rowData ?? {})
                || JSON.stringify(pSheet.columnData ?? {}) !== JSON.stringify(nSheet.columnData ?? {})
                || JSON.stringify(pSheet.mergeData ?? []) !== JSON.stringify(nSheet.mergeData ?? [])) {
                return false;
            }
            const pCells = (pSheet.cellData ?? {}) as Record<string, Record<string, unknown>>;
            const nCells = (nSheet.cellData ?? {}) as Record<string, Record<string, unknown>>;
            const cellValue: Record<number, Record<number, object | null>> = {};
            for (const [rKey, rowObj] of Object.entries(nCells)) {
                const r = Number(rKey);
                for (const [cKey, cell] of Object.entries(rowObj ?? {})) {
                    if (JSON.stringify(pCells[rKey]?.[cKey]) !== JSON.stringify(cell)) {
                        (cellValue[r] ??= {})[Number(cKey)] = resolveCell(cell);
                    }
                }
            }
            for (const [rKey, rowObj] of Object.entries(pCells)) {
                const r = Number(rKey);
                for (const cKey of Object.keys(rowObj ?? {})) {
                    if (!nCells[rKey] || !(cKey in nCells[rKey])) {
                        (cellValue[r] ??= {})[Number(cKey)] = null;
                    }
                }
            }
            if (Object.keys(cellValue).length > 0) {
                await view.commands.executeCommand(SetRangeValuesMutation.id, {
                    unitId: view.unitId, subUnitId: sheetId, cellValue, isOverrideStyle: true,
                }, flags);
            }
        }
        return true;
    }

    function render(state: WorkbookRoomState, pending: readonly PendingIntent[], delta?: WorkbookRoomDelta): void {
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
            const canApplyPointwise = Boolean(last && changed && effects !== null && !previewedInsertion);
            if (!canApplyPointwise || !(await applyIncremental(last!, state, delta))) {
                await view.replace(state.workbook, {fromCollab: true});
            }
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
