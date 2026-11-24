import {createRequire} from 'node:module';
import {toA1} from '../coordinates.ts';
import type {JsonObject, WorkbookV2} from '../protocol.ts';

export interface IronCalcDiscrepancy {
    sheet_id: string;
    a1: string;
    formula: string;
    univer_value: number | string | boolean | null;
    ironcalc_value: string;
    reason: 'value_mismatch' | 'error_mismatch';
}

export interface IronCalcVerificationResult {
    engine: '@ironcalc/nodejs';
    checked_formulas: number;
    matched: number;
    mismatched: number;
    skipped_unsupported: number;
    discrepancies: IronCalcDiscrepancy[];
}

interface IronCalcModel {
    addSheet(name: string): void;
    setUserInput(sheet: number, row: number, column: number, value: string): void;
    evaluate(): void;
    getFormattedCellValue(sheet: number, row: number, column: number): string;
}

interface IronCalcModule {
    Model: new (name: string, locale: string, tz: string) => IronCalcModel;
}

function loadIronCalc(): IronCalcModule {
    const require = createRequire(import.meta.url);
    return require('@ironcalc/nodejs') as IronCalcModule;
}

function valuesMatch(
    univerVal: number | string | boolean | null,
    ironFormatted: string,
    tolerance: number,
): boolean {
    if (univerVal === null || univerVal === '') {
        return ironFormatted === '';
    }
    if (typeof univerVal === 'boolean') {
        return (univerVal ? 'TRUE' : 'FALSE') === ironFormatted.toUpperCase();
    }
    if (typeof univerVal === 'number') {
        const icNum = Number(ironFormatted);
        if (!Number.isFinite(icNum)) return false;
        const scale = Math.max(1, Math.abs(univerVal), Math.abs(icNum));
        return Math.abs(univerVal - icNum) <= tolerance * scale;
    }
    return String(univerVal) === ironFormatted;
}

export async function verifyWorkbookWithIronCalc(
    workbook: WorkbookV2,
    options: {tolerance?: number} = {},
): Promise<IronCalcVerificationResult> {
    const tolerance = options.tolerance ?? 1e-9;
    const {Model} = loadIronCalc();
    const sheetOrder = Array.isArray(workbook.native.sheetOrder) ? workbook.native.sheetOrder as string[] : [];
    const sheets = (workbook.native.sheets && typeof workbook.native.sheets === 'object' && !Array.isArray(workbook.native.sheets))
        ? workbook.native.sheets as Record<string, JsonObject>
        : {};

    const firstSheetId = sheetOrder[0];
    const firstSheetName = firstSheetId && typeof sheets[firstSheetId]?.name === 'string'
        ? String(sheets[firstSheetId].name)
        : 'Sheet1';
    const model = new Model(firstSheetName, 'en', 'UTC');

    for (let i = 1; i < sheetOrder.length; i++) {
        const sid = sheetOrder[i];
        const sname = typeof sheets[sid]?.name === 'string' ? String(sheets[sid].name) : `Sheet${i + 1}`;
        model.addSheet(sname);
    }

    const formulaCells: {sheetIdx: number; sheetId: string; row: number; col: number; formula: string; univerVal: number | string | boolean | null}[] = [];

    for (let sheetIdx = 0; sheetIdx < sheetOrder.length; sheetIdx++) {
        const sheetId = sheetOrder[sheetIdx];
        const sheet = sheets[sheetId];
        if (!sheet || typeof sheet.cellData !== 'object' || sheet.cellData === null || Array.isArray(sheet.cellData)) continue;
        const cellData = sheet.cellData as Record<string, Record<string, JsonObject>>;
        for (const [rKey, rowObj] of Object.entries(cellData)) {
            const row = Number(rKey);
            if (!Number.isSafeInteger(row) || row < 0 || !rowObj || typeof rowObj !== 'object') continue;
            for (const [cKey, cell] of Object.entries(rowObj)) {
                const col = Number(cKey);
                if (!Number.isSafeInteger(col) || col < 0 || !cell || typeof cell !== 'object') continue;
                const formula = typeof cell.f === 'string' && cell.f.startsWith('=') ? cell.f : null;
                if (formula) {
                    model.setUserInput(sheetIdx, row + 1, col + 1, formula);
                    const rawV = cell.v;
                    const univerVal = rawV === undefined || rawV === null
                        ? null
                        : cell.t === 3
                            ? Boolean(rawV)
                            : (rawV as number | string | boolean);
                    formulaCells.push({sheetIdx, sheetId, row, col, formula, univerVal});
                } else if (cell.v !== undefined && cell.v !== null) {
                    if (cell.t === 3) {
                        model.setUserInput(sheetIdx, row + 1, col + 1, cell.v === 1 || cell.v === true ? 'TRUE' : 'FALSE');
                    } else {
                        model.setUserInput(sheetIdx, row + 1, col + 1, String(cell.v));
                    }
                }
            }
        }
    }

    model.evaluate();

    let matched = 0;
    let mismatched = 0;
    let skippedUnsupported = 0;
    const discrepancies: IronCalcDiscrepancy[] = [];

    for (const item of formulaCells) {
        const icVal = model.getFormattedCellValue(item.sheetIdx, item.row + 1, item.col + 1);
        if (icVal === '#NAME?' && String(item.univerVal ?? '') !== '#NAME?') {
            skippedUnsupported++;
            continue;
        }
        if (valuesMatch(item.univerVal, icVal, tolerance)) {
            matched++;
        } else {
            mismatched++;
            discrepancies.push({
                sheet_id: item.sheetId,
                a1: toA1({row: item.row + 1, column: item.col + 1}),
                formula: item.formula,
                univer_value: item.univerVal,
                ironcalc_value: icVal,
                reason: icVal.startsWith('#') ? 'error_mismatch' : 'value_mismatch',
            });
        }
    }

    return {
        engine: '@ironcalc/nodejs',
        checked_formulas: formulaCells.length,
        matched,
        mismatched,
        skipped_unsupported: skippedUnsupported,
        discrepancies,
    };
}
