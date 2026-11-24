/**
 * Univer 1.5.2 headless session. Target: packages/runtime/src/engine/univer.ts.
 * Method names are taken from the installed .d.ts files of the pinned packages
 * (FWorksheet.getRange/insertRowsBefore, FRange.setValue/setFormula/getFormula/getRawValue,
 * FFormula.executeCalculation/onCalculationResultApplied, FWorkbook.save) and from
 * plan/checks/sheets-headless/smoke.mjs, which calls them the same way.
 */
import {BorderStyleTypes, CellValueType, HorizontalAlign, LocaleType, Univer, VerticalAlign, WrapStrategy, type IStyleData, type IWorkbookData} from '@univerjs/core';
import {FUniver} from '@univerjs/core/facade';
import {UniverDocsPlugin} from '@univerjs/docs';
import {UniverFormulaEnginePlugin} from '@univerjs/engine-formula';
import type {FFormula} from '@univerjs/engine-formula/facade';
import {UniverRenderEnginePlugin} from '@univerjs/engine-render';
import {UniverSheetsPlugin} from '@univerjs/sheets';
import type {FRange, FWorkbook, FWorksheet} from '@univerjs/sheets/facade';
import {CalculationMode, UniverSheetsFormulaPlugin} from '@univerjs/sheets-formula';
import {UniverSheetsNumfmtPlugin} from '@univerjs/sheets-numfmt';
import {UniverSheetsConditionalFormattingPlugin} from '@univerjs/sheets-conditional-formatting';
import {UniverSheetsDataValidationPlugin} from '@univerjs/sheets-data-validation';
import {UniverSheetsFilterPlugin} from '@univerjs/sheets-filter';
import {UniverSheetsHyperLinkPlugin} from '@univerjs/sheets-hyper-link';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';
import {engineIndex, toA1, type CellCoord} from '../coordinates.ts';
import {WireError, type BorderSideSpec, type BorderStyleName, type CellContent, type CellReadback, type FormatSpec, type JsonObject, type Literal, sha256Canonical} from '../protocol.ts';

const PLUGINS = [
    UniverRenderEnginePlugin,
    UniverFormulaEnginePlugin,
    UniverDocsPlugin,
    UniverSheetsPlugin,
    UniverSheetsNumfmtPlugin,
    UniverSheetsConditionalFormattingPlugin,
    UniverSheetsDataValidationPlugin,
    UniverSheetsFilterPlugin,
    UniverSheetsHyperLinkPlugin,
] as const;

const VALID_LOCALES = new Set<string>(Object.values(LocaleType));

const BORDER_STYLE_MAP: Record<BorderStyleName, BorderStyleTypes> = {
    none: BorderStyleTypes.NONE,
    thin: BorderStyleTypes.THIN,
    medium: BorderStyleTypes.MEDIUM,
    thick: BorderStyleTypes.THICK,
    dashed: BorderStyleTypes.DASHED,
    dotted: BorderStyleTypes.DOTTED,
    double: BorderStyleTypes.DOUBLE,
};

function mergeCellStyle(existing: IStyleData | null | undefined, format: FormatSpec): IStyleData {
    const next: IStyleData = existing ? structuredClone(existing) : {};
    if (format.font) {
        if (format.font.bold !== undefined) {
            if (format.font.bold) next.bl = 1;
            else delete next.bl;
        }
        if (format.font.italic !== undefined) {
            if (format.font.italic) next.it = 1;
            else delete next.it;
        }
        if (format.font.size !== undefined) next.fs = format.font.size;
        if (format.font.color !== undefined) {
            if (format.font.color === null) delete next.cl;
            else next.cl = {rgb: format.font.color};
        }
    }
    if (format.fill !== undefined) {
        if (format.fill === null) delete next.bg;
        else next.bg = {rgb: format.fill};
    }
    if (format.borders) {
        const bd: NonNullable<IStyleData['bd']> = next.bd ? {...next.bd} : {};
        const applySide = (key: 't' | 'r' | 'b' | 'l', spec: BorderSideSpec | undefined): void => {
            if (spec === undefined) return;
            if (spec === null || spec.style === 'none') delete bd[key];
            else bd[key] = {s: BORDER_STYLE_MAP[spec.style], cl: {rgb: spec.color ?? '#000000'}};
        };
        if (format.borders.all !== undefined) {
            for (const side of ['t', 'r', 'b', 'l'] as const) applySide(side, format.borders.all);
        }
        applySide('t', format.borders.top);
        applySide('r', format.borders.right);
        applySide('b', format.borders.bottom);
        applySide('l', format.borders.left);
        if (Object.keys(bd).length === 0) delete next.bd;
        else next.bd = bd;
    }
    if (format.alignment) {
        if (format.alignment.horizontal !== undefined) {
            if (format.alignment.horizontal === null) delete next.ht;
            else next.ht = format.alignment.horizontal === 'left' ? HorizontalAlign.LEFT : format.alignment.horizontal === 'center' ? HorizontalAlign.CENTER : HorizontalAlign.RIGHT;
        }
        if (format.alignment.vertical !== undefined) {
            if (format.alignment.vertical === null) delete next.vt;
            else next.vt = format.alignment.vertical === 'top' ? VerticalAlign.TOP : format.alignment.vertical === 'middle' ? VerticalAlign.MIDDLE : VerticalAlign.BOTTOM;
        }
        if (format.alignment.wrap !== undefined) {
            if (format.alignment.wrap) next.tb = WrapStrategy.WRAP;
            else delete next.tb;
        }
    }
    if (format.numFmt !== undefined) {
        if (format.numFmt === null) delete next.n;
        else next.n = {pattern: format.numFmt};
    }
    return next;
}

export class UniverWorkbookSession {
    readonly #univer: Univer;
    readonly #formula: FFormula;
    readonly #book: FWorkbook;

    private constructor(univer: Univer, formula: FFormula, book: FWorkbook) {
        this.#univer = univer;
        this.#formula = formula;
        this.#book = book;
    }

    /** Opens a private copy of the serialized native snapshot; nothing else is shared with the caller. */
    static open(native: JsonObject): UniverWorkbookSession {
        let locale = LocaleType.EN_US;
        if (native.locale !== undefined) {
            if (typeof native.locale !== 'string' || !VALID_LOCALES.has(native.locale)) {
                throw new WireError('unsupported_content', `unsupported workbook locale ${String(native.locale)}`);
            }
            locale = native.locale as LocaleType;
        }
        const univer = new Univer({locale, locales: {}});
        for (const plugin of PLUGINS) univer.registerPlugin(plugin);
        univer.registerPlugin(UniverSheetsFormulaPlugin, {initialFormulaComputing: CalculationMode.FORCED});
        try {
            const api = FUniver.newAPI(univer);
            const book = api.createWorkbook(structuredClone(native) as unknown as Partial<IWorkbookData>);
            return new UniverWorkbookSession(univer, api.getFormula(), book);
        } catch (error) {
            setImmediate(() => univer.dispose());
            throw error;
        }
    }

    sheet(sheetId: string): FWorksheet {
        const sheet = this.#book.getSheetBySheetId(sheetId);
        if (sheet === null) throw new WireError('unknown_target', `sheet ${sheetId} does not exist`, {sheet_id: sheetId});
        return sheet;
    }

    /** Engine range for one cell. Coordinates are converted only through engineIndex(). */
    cell(sheetId: string, coord: CellCoord): FRange {
        const sheet = this.sheet(sheetId);
        if (coord.row > sheet.getMaxRows() || coord.column > sheet.getMaxColumns()) {
            throw new WireError('unknown_target', `${sheetId}!${toA1(coord)} is outside the sheet`, {sheet_id: sheetId, a1: toA1(coord)});
        }
        return sheet.getRange(engineIndex(coord.row), engineIndex(coord.column));
    }

    checkRowInsertion(sheetId: string, row: number, count: number, maxCells: number): void {
        const sheet = this.sheet(sheetId);
        const rows = sheet.getMaxRows();
        if (row > rows) throw new WireError('unknown_target', `row ${row} is outside sheet ${sheetId}`);
        // Univer copies styles across every column in each inserted row.
        if (count * sheet.getMaxColumns() > maxCells || !Number.isSafeInteger(rows + count)) {
            throw new WireError('limit_exceeded', `row insertion exceeds the sheet or ${maxCells}-cell limit`);
        }
    }

    insertRowsBefore(sheetId: string, row: number, count: number): void {
        this.sheet(sheetId).insertRowsBefore(engineIndex(row), count);
    }

    checkRowDeletion(sheetId: string, row: number, count: number): void {
        const sheet = this.sheet(sheetId);
        const rows = sheet.getMaxRows();
        if (row > rows || row + count - 1 > rows) throw new WireError('unknown_target', `rows ${row}:${row + count - 1} are outside sheet ${sheetId}`);
        if (rows - count < 1) throw new WireError('limit_exceeded', `cannot delete all rows from sheet ${sheetId}`);
    }

    deleteRows(sheetId: string, row: number, count: number): void {
        this.sheet(sheetId).deleteRows(engineIndex(row), count);
    }

    checkColumnInsertion(sheetId: string, column: number, count: number, maxCells: number): void {
        const sheet = this.sheet(sheetId);
        const cols = sheet.getMaxColumns();
        if (column > cols) throw new WireError('unknown_target', `column ${column} is outside sheet ${sheetId}`);
        if (count * sheet.getMaxRows() > maxCells || !Number.isSafeInteger(cols + count)) {
            throw new WireError('limit_exceeded', `column insertion exceeds the sheet or ${maxCells}-cell limit`);
        }
    }

    insertColumnsBefore(sheetId: string, column: number, count: number): void {
        this.sheet(sheetId).insertColumnsBefore(engineIndex(column), count);
    }

    checkColumnDeletion(sheetId: string, column: number, count: number): void {
        const sheet = this.sheet(sheetId);
        const cols = sheet.getMaxColumns();
        if (column > cols || column + count - 1 > cols) throw new WireError('unknown_target', `columns ${column}:${column + count - 1} are outside sheet ${sheetId}`);
        if (cols - count < 1) throw new WireError('limit_exceeded', `cannot delete all columns from sheet ${sheetId}`);
    }

    deleteColumns(sheetId: string, column: number, count: number): void {
        this.sheet(sheetId).deleteColumns(engineIndex(column), count);
    }

    addSheet(sheetId: string, name: string, index?: number, rowCount = 1000, columnCount = 26): void {
        if (this.#book.getSheetBySheetId(sheetId) !== null) {
            throw new WireError('precondition_failed', `sheet ${sheetId} already exists`, {sheet_id: sheetId});
        }
        const sheets = this.#book.getSheets();
        if (sheets.some(s => s.getSheetName() === name)) {
            throw new WireError('precondition_failed', `sheet name ${name} already exists`, {name});
        }
        const targetIndex = index ?? sheets.length;
        if (targetIndex < 0 || targetIndex > sheets.length) {
            throw new WireError('unknown_target', `sheet index ${targetIndex} is out of bounds`);
        }
        if (rowCount > 1_000_000 || columnCount > 18_278) {
            throw new WireError('limit_exceeded', 'sheet dimensions exceed limits');
        }
        this.#book.insertSheet(name, {index: targetIndex, sheet: {id: sheetId, name, rowCount, columnCount, cellData: {}}});
    }

    renameSheet(sheetId: string, name: string, expectedName?: string): boolean {
        const sheet = this.sheet(sheetId);
        const current = sheet.getSheetName();
        if (expectedName !== undefined && current !== expectedName) {
            throw new WireError('precondition_failed', `sheet ${sheetId} name changed`, {expected: expectedName, actual: current});
        }
        if (current === name) return false;
        if (this.#book.getSheets().some(s => s.getSheetId() !== sheetId && s.getSheetName() === name)) {
            throw new WireError('precondition_failed', `sheet name ${name} already exists`, {name});
        }
        sheet.setName(name);
        return true;
    }

    deleteSheet(sheetId: string): void {
        const sheet = this.sheet(sheetId);
        if (this.#book.getSheets().length <= 1) {
            throw new WireError('precondition_failed', 'cannot delete the last remaining sheet', {sheet_id: sheetId});
        }
        this.#book.deleteSheet(sheet);
    }

    private rangeRect(sheetId: string, startRow: number, startColumn: number, endRow: number, endColumn: number, maxCells?: number): FRange {
        const sheet = this.sheet(sheetId);
        if (endRow < startRow || endColumn < startColumn) {
            throw new WireError('invalid_message', 'range end must be >= start');
        }
        if (endRow > sheet.getMaxRows() || endColumn > sheet.getMaxColumns()) {
            throw new WireError('unknown_target', `${sheetId}!${toA1({row: startRow, column: startColumn})}:${toA1({row: endRow, column: endColumn})} is outside the sheet`);
        }
        if (maxCells !== undefined && (endRow - startRow + 1) * (endColumn - startColumn + 1) > maxCells) {
            throw new WireError('limit_exceeded', `range exceeds ${maxCells}-cell limit`);
        }
        return sheet.getRange(engineIndex(startRow), engineIndex(startColumn), endRow - startRow + 1, endColumn - startColumn + 1);
    }

    applyFormat(sheetId: string, startRow: number, startColumn: number, endRow: number, endColumn: number, format: FormatSpec, maxCells: number): boolean {
        this.rangeRect(sheetId, startRow, startColumn, endRow, endColumn, maxCells);
        const sheet = this.sheet(sheetId);
        let changed = false;
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startColumn; c <= endColumn; c++) {
                const cellRange = sheet.getRange(engineIndex(r), engineIndex(c));
                const existing = cellRange.getCellStyleData() as IStyleData | null | undefined;
                const next = mergeCellStyle(existing, format);
                if (sha256Canonical(existing ?? {}) !== sha256Canonical(next)) {
                    cellRange.setValues([[{s: next}]]);
                    changed = true;
                }
            }
        }
        return changed;
    }

    mergeCells(sheetId: string, startRow: number, startColumn: number, endRow: number, endColumn: number, strategy: 'default' | 'across' | 'vertically' = 'default', maxCells?: number): boolean {
        const range = this.rangeRect(sheetId, startRow, startColumn, endRow, endColumn, maxCells);
        if (startRow === endRow && startColumn === endColumn) return false;
        const r0 = engineIndex(startRow);
        const c0 = engineIndex(startColumn);
        const r1 = engineIndex(endRow);
        const c1 = engineIndex(endColumn);
        const existing = this.sheet(sheetId).getMergeData().map(m => m.getRange());
        if (strategy === 'default' && existing.some(m => m.startRow === r0 && m.startColumn === c0 && m.endRow === r1 && m.endColumn === c1)) {
            return false;
        }
        if (strategy === 'across') {
            if (startColumn === endColumn) return false;
            range.mergeAcross({defaultMerge: true, isForceMerge: true});
        } else if (strategy === 'vertically') {
            if (startRow === endRow) return false;
            range.mergeVertically({defaultMerge: true, isForceMerge: true});
        } else {
            range.merge({defaultMerge: true, isForceMerge: true});
        }
        return true;
    }

    unmergeCells(sheetId: string, startRow: number, startColumn: number, endRow: number, endColumn: number, maxCells?: number): boolean {
        const range = this.rangeRect(sheetId, startRow, startColumn, endRow, endColumn, maxCells);
        const r0 = engineIndex(startRow);
        const c0 = engineIndex(startColumn);
        const r1 = engineIndex(endRow);
        const c1 = engineIndex(endColumn);
        const intersects = this.sheet(sheetId).getMergeData().some(m => {
            const mr = m.getRange();
            return mr.startRow <= r1 && mr.endRow >= r0 && mr.startColumn <= c1 && mr.endColumn >= c0;
        });
        if (!intersects) return false;
        range.breakApart();
        return true;
    }

    setFreeze(sheetId: string, rowCount: number, columnCount: number): boolean {
        const sheet = this.sheet(sheetId);
        if (rowCount < 0 || columnCount < 0 || rowCount > sheet.getMaxRows() || columnCount > sheet.getMaxColumns()) {
            throw new WireError('unknown_target', `freeze (${rowCount}, ${columnCount}) is outside sheet ${sheetId}`);
        }
        const cur = sheet.getFreeze();
        const curRow = cur && cur.ySplit > 0 ? cur.ySplit : 0;
        const curCol = cur && cur.xSplit > 0 ? cur.xSplit : 0;
        if (curRow === rowCount && curCol === columnCount) return false;
        if (rowCount === 0 && columnCount === 0) sheet.cancelFreeze();
        else sheet.setFreeze({startRow: rowCount, startColumn: columnCount, ySplit: rowCount, xSplit: columnCount});
        return true;
    }

    content(sheetId: string, coord: CellCoord): CellContent {
        const range = this.cell(sheetId, coord);
        const formula = range.getFormula();
        if (formula !== '') return {formula};
        const raw = range.getRawValue();
        if (raw === null || raw === undefined) return null;
        if (range.getCellData()?.t === CellValueType.BOOLEAN) return {boolean: Boolean(raw)};
        if (typeof raw === 'number') return {number: raw};
        if (typeof raw === 'boolean') return {boolean: raw};
        return {text: String(raw)};
    }

    writeBoolean(sheetId: string, coord: CellCoord, value: boolean): void {
        this.cell(sheetId, coord).setValue({v: value ? 1 : 0, t: CellValueType.BOOLEAN, f: null, si: null, p: null});
    }

    writeLiteral(sheetId: string, coord: CellCoord, literal: Literal): void {
        const range = this.cell(sheetId, coord);
        if (literal === null) range.setValue({v: null, f: null, si: null, p: null});
        else if ('number' in literal) range.setValue({v: literal.number, t: CellValueType.NUMBER, f: null, si: null, p: null});
        else if ('boolean' in literal) range.setValue({v: literal.boolean ? 1 : 0, t: CellValueType.BOOLEAN, f: null, si: null, p: null});
        else range.setValue({v: literal.text, t: CellValueType.STRING, f: null, si: null, p: null});
    }

    writeFormula(sheetId: string, coord: CellCoord, formula: string): void {
        if (!formula.startsWith('=')) throw new WireError('invalid_message', 'formula must start with =');
        this.cell(sheetId, coord).setFormula(formula);
    }

    setNumberFormat(sheetId: string, coord: CellCoord, pattern: string): void {
        this.cell(sheetId, coord).setNumberFormat(pattern);
    }

    /**
     * Calculation barrier: subscribe first, then force a full recalculation, then wait.
     * A snapshot may carry stale cached values (999 in the corpus); they are never read
     * as results before this promise resolves.
     */
    async settle(timeoutMs: number): Promise<void> {
        const applied = this.#formula.onCalculationResultApplied(timeoutMs);
        this.#formula.executeCalculation();
        try {
            await applied;
        } catch (error) {
            throw new WireError('calculation_timeout', `calculation did not finish in ${timeoutMs} ms: ${String(error)}`);
        }
    }

    readback(sheetId: string, coord: CellCoord): CellReadback {
        const range = this.cell(sheetId, coord);
        const formula = range.getFormula();
        const raw = range.getRawValue();
        const isBool = range.getCellData()?.t === CellValueType.BOOLEAN || typeof raw === 'boolean';
        return {
            sheet_id: sheetId,
            a1: toA1(coord),
            row: coord.row,
            column: coord.column,
            formula: formula === '' ? null : formula,
            value: raw === undefined || raw === null ? null : isBool ? Boolean(raw) : (raw as number | string | boolean),
        };
    }

    /** Full native snapshot through the engine's own save(), normalized to plain JSON. */
    save(): JsonObject {
        const native = JSON.parse(JSON.stringify(this.#book.save())) as JsonObject;
        const styles = native.styles;
        if (styles && typeof styles === 'object' && !Array.isArray(styles)) {
            const ids = new Map(Object.entries(styles).map(([id, style]) => [id, `st_${sha256Canonical(style).slice(0, 12)}`]));
            native.styles = Object.fromEntries(Object.entries(styles).map(([id, style]) => [ids.get(id)!, style]));
            const rewrite = (value: unknown): void => {
                if (!value || typeof value !== 'object') return;
                for (const [key, item] of Object.entries(value)) {
                    if ((key === 's' || key === 'defaultStyle') && typeof item === 'string' && ids.has(item)) {
                        (value as Record<string, unknown>)[key] = ids.get(item);
                    } else {
                        rewrite(item);
                    }
                }
            };
            rewrite(native.sheets);
        }
        // xlsx/csv call save() directly, so the canonical (name, id) order lives here.
        if (Array.isArray(native.resources)) {
            const key = (value: unknown): string => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
                const record = value as Record<string, unknown>;
                const name = typeof record.name === 'string' ? record.name : '';
                const id = record.id == null ? '' : String(record.id);
                return `${name}\u0000${id}`;
            };
            native.resources.sort((left, right) => {
                const a = key(left);
                const b = key(right);
                return a < b ? -1 : a > b ? 1 : 0;
            });
        }
        return native;
    }

    dispose(): void {
        setImmediate(() => this.#univer.dispose());
    }
}
