/**
 * Univer 1.5.2 headless session. Target: packages/runtime/src/engine/univer.ts.
 * Method names are taken from the installed .d.ts files of the pinned packages
 * (FWorksheet.getRange/insertRowsBefore, FRange.setValue/setFormula/getFormula/getRawValue,
 * FFormula.executeCalculation/onCalculationResultApplied, FWorkbook.save) and from
 * plan/checks/sheets-headless/smoke.mjs, which calls them the same way.
 */
import {CellValueType, LocaleType, Univer, type IWorkbookData} from '@univerjs/core';
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
import {WireError, type CellContent, type CellReadback, type JsonObject, type Literal, sha256Canonical} from '../protocol.ts';

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
        const univer = new Univer({locale: LocaleType.EN_US, locales: {}});
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

    writeLiteral(sheetId: string, coord: CellCoord, literal: Literal): void {
        const range = this.cell(sheetId, coord);
        if (literal === null) range.setValue({v: null, f: null, si: null, p: null});
        else if ('number' in literal) range.setValue({v: literal.number, t: CellValueType.NUMBER, f: null, si: null, p: null});
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
        return {
            sheet_id: sheetId,
            a1: toA1(coord),
            row: coord.row,
            column: coord.column,
            formula: formula === '' ? null : formula,
            value: raw === undefined ? null : (raw as number | string | boolean | null),
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
