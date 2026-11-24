import {CanceledError, CellValueType, CommandType, type ICommandService, type IExecutionOptions} from '@univerjs/core';
import {
    AddWorksheetMergeMutation, InsertColMutation, InsertRowMutation, InsertSheetMutation,
    RemoveColMutation, RemoveNumfmtMutation, RemoveRowMutation, RemoveSheetMutation,
    RemoveWorksheetMergeMutation, SetFrozenMutation, SetNumfmtMutation, SetRangeValuesMutation,
    SetWorksheetNameMutation,
} from '@univerjs/sheets';
import {SetCellEditVisibleOperation, type IEditorBridgeService, type IEditorBridgeServiceVisibleParam} from '@univerjs/sheets-ui';
import type {CellContent, Command, WorkbookV2} from '@vaulter/sheets-runtime/browser';
type FormatSpec = Extract<Command, {kind: 'set_format'}>['format'];
import {WorkbookRoomClient, type PendingIntent, type WorkbookPresence, type WorkbookPresenceSelection} from './client.ts';
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
    if (value.t === CellValueType.BOOLEAN && (typeof value.v === 'boolean' || typeof value.v === 'number')) {
        return {kind: 'set_boolean', sheet_id: sheet, row, column, expected, value: Boolean(value.v)};
    }
    if (value.t !== CellValueType.BOOLEAN && typeof value.v === 'number' && Number.isFinite(value.v)) {
        return {kind: 'set_number', sheet_id: sheet, row, column, expected, value: value.v};
    }
    if (typeof value.v === 'string') return {kind: 'set_text', sheet_id: sheet, row, column, expected, value: value.v};
    return null;
}

function styleFormatSpec(s: unknown): FormatSpec | null {
    if (s === null) return {font: {bold: false, italic: false, color: null}, fill: null, borders: {all: null}, alignment: {horizontal: null, vertical: null, wrap: false}, numFmt: null};
    if (!record(s)) return null;
    const out: FormatSpec = {};
    const font: NonNullable<FormatSpec['font']> = {};
    if (s.bl !== undefined) font.bold = s.bl === 1;
    if (s.it !== undefined) font.italic = s.it === 1;
    if (typeof s.fs === 'number' && s.fs >= 1 && s.fs <= 409) font.size = s.fs;
    if ('cl' in s) {
        const rgb = record(s.cl) && typeof s.cl.rgb === 'string' ? s.cl.rgb : null;
        if (rgb && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(rgb)) font.color = rgb;
        else if (s.cl === null) font.color = null;
    }
    if (Object.keys(font).length > 0) out.font = font;
    if ('bg' in s) {
        const rgb = record(s.bg) && typeof s.bg.rgb === 'string' ? s.bg.rgb : null;
        if (rgb && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(rgb)) out.fill = rgb;
        else if (s.bg === null) out.fill = null;
    }
    if (s.ht !== undefined) {
        out.alignment = {...out.alignment, horizontal: s.ht === 1 ? 'left' : s.ht === 2 ? 'center' : s.ht === 3 ? 'right' : null};
    }
    if (s.vt !== undefined) {
        out.alignment = {...out.alignment, vertical: s.vt === 1 ? 'top' : s.vt === 2 ? 'middle' : s.vt === 3 ? 'bottom' : null};
    }
    if (s.tb !== undefined) {
        out.alignment = {...out.alignment, wrap: s.tb === 3};
    }
    if (record(s.n) && typeof s.n.pattern === 'string') out.numFmt = s.n.pattern;
    else if ('n' in s && s.n === null) out.numFmt = null;
    return Object.keys(out).length > 0 ? out : null;
}

function typedMutation(id: string, params: Record<string, unknown>, view: WorkbookView): {policy: WorkbookIntent['policy']; commands: Command[]} | null {
    if (id === InsertSheetMutation.id && record(params.sheet) && typeof params.sheet.id === 'string' && typeof params.sheet.name === 'string') {
        const cmd: Extract<Command, {kind: 'add_sheet'}> = {kind: 'add_sheet', sheet_id: params.sheet.id, name: params.sheet.name};
        if (position(params.index)) cmd.index = params.index;
        if (position(params.sheet.rowCount) && params.sheet.rowCount > 0) cmd.row_count = params.sheet.rowCount;
        if (position(params.sheet.columnCount) && params.sheet.columnCount > 0) cmd.column_count = params.sheet.columnCount;
        return {policy: 'exact_base', commands: [cmd]};
    }
    const sheet = params.subUnitId;
    if (typeof sheet !== 'string') return null;
    if (id === RemoveSheetMutation.id) return {policy: 'exact_base', commands: [{kind: 'delete_sheet', sheet_id: sheet}]};
    if (id === SetWorksheetNameMutation.id && typeof params.name === 'string') {
        return {policy: 'exact_base', commands: [{kind: 'rename_sheet', sheet_id: sheet, name: params.name, ...(typeof params.oldName === 'string' ? {expected_name: params.oldName} : {})}]};
    }
    if (id === InsertRowMutation.id && record(params.range) && position(params.range.startRow) && position(params.range.endRow) && params.range.endRow >= params.range.startRow) {
        return {policy: 'exact_base', commands: [{kind: 'insert_row_before', sheet_id: sheet, row: params.range.startRow + 1, count: params.range.endRow - params.range.startRow + 1}]};
    }
    if (id === RemoveRowMutation.id && record(params.range) && position(params.range.startRow) && position(params.range.endRow) && params.range.endRow >= params.range.startRow) {
        return {policy: 'exact_base', commands: [{kind: 'delete_row', sheet_id: sheet, row: params.range.startRow + 1, count: params.range.endRow - params.range.startRow + 1}]};
    }
    if (id === InsertColMutation.id && record(params.range) && position(params.range.startColumn) && position(params.range.endColumn) && params.range.endColumn >= params.range.startColumn) {
        return {policy: 'exact_base', commands: [{kind: 'insert_column_before', sheet_id: sheet, column: params.range.startColumn + 1, count: params.range.endColumn - params.range.startColumn + 1}]};
    }
    if (id === RemoveColMutation.id && record(params.range) && position(params.range.startColumn) && position(params.range.endColumn) && params.range.endColumn >= params.range.startColumn) {
        return {policy: 'exact_base', commands: [{kind: 'delete_column', sheet_id: sheet, column: params.range.startColumn + 1, count: params.range.endColumn - params.range.startColumn + 1}]};
    }
    if (id === SetFrozenMutation.id && typeof params.ySplit === 'number' && typeof params.xSplit === 'number') {
        return {policy: 'rebase_cells', commands: [{kind: 'set_freeze', sheet_id: sheet, row_count: Math.max(0, params.ySplit), column_count: Math.max(0, params.xSplit)}]};
    }
    if ((id === AddWorksheetMergeMutation.id || id === RemoveWorksheetMergeMutation.id) && Array.isArray(params.ranges)) {
        const commands: Command[] = [];
        for (const r of params.ranges) {
            if (!record(r) || !position(r.startRow) || !position(r.startColumn) || !position(r.endRow) || !position(r.endColumn)) continue;
            commands.push({
                kind: id === AddWorksheetMergeMutation.id ? 'merge_cells' : 'unmerge_cells',
                sheet_id: sheet, start_row: r.startRow + 1, start_column: r.startColumn + 1, end_row: r.endRow + 1, end_column: r.endColumn + 1,
            });
        }
        return commands.length ? {policy: 'rebase_cells', commands} : null;
    }
    if (id === SetNumfmtMutation.id && record(params.values) && record(params.refMap)) {
        const commands: Command[] = [];
        for (const [key, entry] of Object.entries(params.values)) {
            const ref = params.refMap[key];
            if (!record(entry) || !Array.isArray(entry.ranges) || !record(ref) || typeof ref.pattern !== 'string') continue;
            for (const r of entry.ranges) {
                if (!record(r) || !position(r.startRow) || !position(r.startColumn) || !position(r.endRow) || !position(r.endColumn)) continue;
                commands.push({kind: 'set_format', sheet_id: sheet, start_row: r.startRow + 1, start_column: r.startColumn + 1, end_row: r.endRow + 1, end_column: r.endColumn + 1, format: {numFmt: ref.pattern}});
            }
        }
        return commands.length ? {policy: 'rebase_cells', commands} : null;
    }
    if (id === RemoveNumfmtMutation.id && Array.isArray(params.ranges)) {
        const commands: Command[] = [];
        for (const r of params.ranges) {
            if (!record(r) || !position(r.startRow) || !position(r.startColumn) || !position(r.endRow) || !position(r.endColumn)) continue;
            commands.push({kind: 'set_format', sheet_id: sheet, start_row: r.startRow + 1, start_column: r.startColumn + 1, end_row: r.endRow + 1, end_column: r.endColumn + 1, format: {numFmt: null}});
        }
        return commands.length ? {policy: 'rebase_cells', commands} : null;
    }
    if (id !== SetRangeValuesMutation.id || !record(params.cellValue)) return null;
    const commands: Command[] = [];
    for (const [y, cells] of Object.entries(params.cellValue)) {
        const row = Number(y);
        if (!position(row) || !record(cells)) return null;
        for (const [x, data] of Object.entries(cells)) {
            const column = Number(x);
            if (!position(column) || commands.length >= 64) return null;
            if (record(data) && 's' in data && !('v' in data) && !('f' in data) && !('t' in data)) {
                const format = styleFormatSpec(data.s);
                if (!format) return null;
                commands.push({kind: 'set_format', sheet_id: sheet, start_row: row + 1, start_column: column + 1, end_row: row + 1, end_column: column + 1, format});
                continue;
            }
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
    if (command.kind !== 'set_number' && command.kind !== 'set_text' && command.kind !== 'set_boolean'
        && command.kind !== 'set_formula' && command.kind !== 'set_values' && command.kind !== 'insert_row_before') return;
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
            value === null ? {v: null, f: null}
                : 'number' in value ? {v: value.number, t: CellValueType.NUMBER, f: null}
                : 'boolean' in value ? {v: value.boolean ? 1 : 0, t: CellValueType.BOOLEAN, f: null}
                : {v: value.text, t: CellValueType.STRING, f: null},
        ]))]));
    } else {
        const value = command.kind === 'set_formula' ? {f: command.formula, v: null}
            : command.kind === 'set_boolean' ? {v: command.value ? 1 : 0, t: CellValueType.BOOLEAN, f: null}
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
    return {
        client,
        updateAwareness: (presence: {client_id?: string; user?: WorkbookPresence['user']; selection?: WorkbookPresenceSelection | null}) => {
            client.updateAwareness(presence);
        },
        dispose: () => { disposed = true; before.dispose(); after.dispose(); client.close(); },
    };
}
