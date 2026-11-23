import {createHash, randomUUID} from 'node:crypto';
import {UniverWorkbookSession} from '../engine/univer.ts';
import {WIRE_PROFILE} from '../profile.ts';
import {sha256Canonical, type JsonObject, type WorkbookV2} from '../protocol.ts';
import {
    ExchangeError,
    type CsvDialectReport,
    type ExchangeDiagnostic,
    type ExchangeLossEntry,
    type ExportResult,
    type ImportResult,
} from './types.ts';

const MAX_CSV_CELLS = 250_000;
const MAX_CSV_ROWS = 100_000;
const MAX_CSV_COLUMNS = 1_000;
const utf8Decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

interface ParsedCsvCell {
    raw: string;
    quoted: boolean;
}

function resolveCsvDialect(options: JsonObject, operation: 'import' | 'export'): CsvDialectReport {
    const encodingRaw = options.encoding === undefined ? 'utf-8' : options.encoding;
    if (typeof encodingRaw !== 'string' || encodingRaw.toLowerCase() !== 'utf-8') {
        throw new ExchangeError('unsupported_content', `CSV encoding ${String(encodingRaw)} is not supported (only utf-8)`, {reason: 'unsupported_encoding'});
    }
    const delimiterRaw = options.delimiter === undefined ? ',' : options.delimiter;
    if (typeof delimiterRaw !== 'string' || delimiterRaw.length !== 1 || delimiterRaw === '"' || delimiterRaw === '\n' || delimiterRaw === '\r') {
        throw new ExchangeError('invalid_message', 'CSV delimiter must be a single non-quote, non-newline character');
    }
    const quoteRaw = options.quote === undefined ? '"' : options.quote;
    if (typeof quoteRaw !== 'string' || quoteRaw.length !== 1 || quoteRaw === delimiterRaw || quoteRaw === '\n' || quoteRaw === '\r') {
        throw new ExchangeError('invalid_message', 'CSV quote must be a single character distinct from delimiter and newline');
    }
    const lineEndingRaw = options.line_ending === undefined ? '\n' : options.line_ending;
    if (lineEndingRaw !== '\n' && lineEndingRaw !== '\r\n') {
        throw new ExchangeError('invalid_message', 'CSV line_ending must be LF or CRLF');
    }
    if (operation === 'export' && options.formula_injection_defense === false) {
        throw new ExchangeError('unsupported_content', 'CSV formula injection defense cannot be disabled', {reason: 'formula_injection_defense_required'});
    }
    return {
        encoding: 'utf-8',
        delimiter: delimiterRaw,
        quote: quoteRaw,
        line_ending: lineEndingRaw,
        formula_injection_defense: true,
    };
}

function parseCsvRows(text: string, delimiter: string, quote: string): ParsedCsvCell[][] {
    const rows: ParsedCsvCell[][] = [];
    let row: ParsedCsvCell[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
        let cell = '';
        let quoted = false;
        if (text[i] === quote) {
            quoted = true;
            i++;
            while (i < len) {
                const ch = text[i];
                if (ch === quote) {
                    if (text[i + 1] === quote) {
                        cell += quote;
                        i += 2;
                    } else {
                        i++;
                        break;
                    }
                } else {
                    cell += ch;
                    i++;
                }
            }
            while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
                if (text[i] !== ' ' && text[i] !== '\t') {
                    throw new ExchangeError('unsupported_content', 'Malformed CSV closing quote', {reason: 'malformed_csv_quote'});
                }
                cell += text[i];
                i++;
            }
        } else {
            while (i < len && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') {
                if (text[i] === quote) {
                    throw new ExchangeError('unsupported_content', 'Unexpected quote inside unquoted CSV field', {reason: 'malformed_csv_quote'});
                }
                cell += text[i];
                i++;
            }
        }
        row.push({raw: cell, quoted});
        if (row.length > MAX_CSV_COLUMNS) {
            throw new ExchangeError('limit_exceeded', `CSV column count exceeds ${MAX_CSV_COLUMNS}`);
        }
        if (i < len && text[i] === delimiter) {
            i++;
            if (i === len) {
                row.push({raw: '', quoted: false});
            }
            continue;
        }
        if (i < len && text[i] === '\r') {
            i++;
        }
        if (i < len && text[i] === '\n') {
            i++;
        }
        rows.push(row);
        if (rows.length > MAX_CSV_ROWS) {
            throw new ExchangeError('limit_exceeded', `CSV row count exceeds ${MAX_CSV_ROWS}`);
        }
        row = [];
    }
    if (row.length > 0) {
        rows.push(row);
    }
    return rows;
}

function classifyCsvCell(
    cell: ParsedCsvCell,
    diagnostics: ExchangeDiagnostic[],
    coord: string,
): {t: number; v: string | number} | null {
    const {raw, quoted} = cell;
    if (raw === '') {
        return quoted ? {t: 1, v: ''} : null;
    }
    // Preserve literals beginning with '=' (or formula triggers) strictly as literal text, never formulas.
    const trimmedLeft = raw.replace(/^[ ]+/, '');
    if (trimmedLeft.startsWith('=')) {
        diagnostics.push({
            code: 'csv_formula_literal_preserved',
            message: 'CSV cell starting with "=" was imported as literal text rather than an active formula',
            target: coord,
        });
        return {t: 1, v: raw};
    }
    return (quoted ? null : coerceCsvScalar(raw)) ?? {t: 1, v: raw};
}

function coerceCsvScalar(raw: string): {t: number; v: number} | null {
    if (raw === 'TRUE' || raw === 'FALSE') {
        return {t: 3, v: raw === 'TRUE' ? 1 : 0};
    }
    // Leading zeros are excluded so text identifiers such as 00123 keep their exact values.
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        const num = Number(raw);
        const hasFractionOrExp = raw.includes('.') || raw.includes('e') || raw.includes('E');
        if (Number.isFinite(num) && (hasFractionOrExp || Number.isSafeInteger(num) || String(num) === raw)) {
            return {t: 2, v: num};
        }
    }
    return null;
}

export async function importCsv(bytes: Buffer, options: JsonObject): Promise<ImportResult> {
    const sourceSha = createHash('sha256').update(bytes).digest('hex');
    const dialect = resolveCsvDialect(options, 'import');
    let text: string;
    try {
        text = utf8Decoder.decode(bytes);
    } catch {
        throw new ExchangeError('unsupported_content', 'CSV file is not valid UTF-8', {reason: 'invalid_utf8'});
    }
    const diagnostics: ExchangeDiagnostic[] = [];
    if (text.startsWith('\uFEFF')) {
        text = text.slice(1);
        diagnostics.push({code: 'utf8_bom_stripped', message: 'Stripped UTF-8 BOM from CSV input'});
    }

    const parsedRows = parseCsvRows(text, dialect.delimiter, dialect.quote);
    const maxCols = Math.max(1, ...parsedRows.map(r => r.length));
    const maxRows = Math.max(1, parsedRows.length);
    const cellData: Record<string, Record<string, {t: number; v: string | number}>> = {};
    let cellCount = 0;

    for (let r = 0; r < parsedRows.length; r++) {
        const rowCells = parsedRows[r];
        const rowMap: Record<string, {t: number; v: string | number}> = {};
        for (let c = 0; c < rowCells.length; c++) {
            const converted = classifyCsvCell(rowCells[c], diagnostics, `R${r + 1}C${c + 1}`);
            if (converted !== null) {
                cellCount++;
                if (cellCount > MAX_CSV_CELLS) {
                    throw new ExchangeError('limit_exceeded', `CSV cell count exceeds ${MAX_CSV_CELLS}`);
                }
                rowMap[String(c)] = converted;
            }
        }
        if (Object.keys(rowMap).length > 0) {
            cellData[String(r)] = rowMap;
        }
    }

    const sheetId = typeof options.sheet_id === 'string' && options.sheet_id !== '' ? options.sheet_id : 'sheet_1';
    const sheetName = typeof options.sheet_name === 'string' && options.sheet_name !== '' ? options.sheet_name : 'Sheet1';

    const nativeInput: JsonObject = {
        id: `wb_${randomUUID()}`,
        name: typeof options.workbook_name === 'string' && options.workbook_name !== '' ? options.workbook_name : 'Workbook',
        appVersion: '1.5.2',
        locale: 'enUS',
        styles: {},
        resources: [],
        sheetOrder: [sheetId],
        sheets: {
            [sheetId]: {
                id: sheetId,
                name: sheetName,
                rowCount: Math.max(100, maxRows + 10),
                columnCount: Math.max(26, maxCols + 5),
                cellData,
            },
        },
    };

    const session = UniverWorkbookSession.open(nativeInput);
    let savedNative: JsonObject;
    try {
        await session.settle(20_000);
        savedNative = session.save();
    } finally {
        session.dispose();
    }

    const workbook: WorkbookV2 = {
        format_version: 2,
        profile: WIRE_PROFILE,
        native: savedNative,
        tables: [],
    };
    const outputSha = sha256Canonical(workbook);

    return {
        workbook,
        report: {
            format: 'csv',
            operation: 'import',
            source_sha256: sourceSha,
            output_sha256: outputSha,
            dialect,
            sheets: [
                {
                    sheet_id: sheetId,
                    name: sheetName,
                    rows: parsedRows.length,
                    columns: maxCols,
                    cells: cellCount,
                    formulas: 0,
                    styles: 0,
                    merges: 0,
                    validations: 0,
                    conditional_formatting: 0,
                },
            ],
            defined_names: {preserved: 0, lost: 0},
            losses: [],
            diagnostics,
            unknown_parts: [],
            editable_published: true,
        },
    };
}

function escapeCsvText(value: string, delimiter: string, quote: string): string {
    if (value === '' || coerceCsvScalar(value) !== null || value.includes(delimiter) || value.includes(quote) || value.includes('\n') || value.includes('\r')) {
        return `${quote}${value.replaceAll(quote, quote + quote)}${quote}`;
    }
    return value;
}

function sanitizeFormulaInjection(value: string, coord: string, diagnostics: ExchangeDiagnostic[]): string {
    const trimmedLeft = value.replace(/^[ ]+/, '');
    if (/^[=+\-@\t\r]/.test(trimmedLeft)) {
        diagnostics.push({
            code: 'formula_injection_escaped',
            message: 'Prefixed leading single quote to neutralize spreadsheet formula injection on CSV export',
            target: coord,
        });
        return `'${value}`;
    }
    return value;
}

export async function exportCsv(workbook: WorkbookV2, options: JsonObject): Promise<ExportResult> {
    const sourceSha = sha256Canonical(workbook);
    const dialect = resolveCsvDialect(options, 'export');
    const timeoutMs = typeof options.calculation_timeout_ms === 'number' && Number.isSafeInteger(options.calculation_timeout_ms) && options.calculation_timeout_ms > 0
        ? Math.min(options.calculation_timeout_ms, 20_000)
        : 20_000;

    const session = UniverWorkbookSession.open(workbook.native);
    let settledNative: JsonObject;
    try {
        await session.settle(timeoutMs);
        settledNative = session.save();
    } finally {
        session.dispose();
    }

    const sheetOrder = Array.isArray(settledNative.sheetOrder) ? settledNative.sheetOrder.filter((id): id is string => typeof id === 'string') : [];
    const sheetsMap = (settledNative.sheets && typeof settledNative.sheets === 'object' && !Array.isArray(settledNative.sheets))
        ? settledNative.sheets as Record<string, JsonObject>
        : {};

    let selectedId: string | undefined;
    if (typeof options.sheet_id === 'string' && options.sheet_id !== '') {
        if (!sheetOrder.includes(options.sheet_id) || !sheetsMap[options.sheet_id]) {
            throw new ExchangeError('unknown_target', `Sheet ${options.sheet_id} does not exist`, {sheet_id: options.sheet_id});
        }
        selectedId = options.sheet_id;
    } else if (typeof options.sheet_name === 'string' && options.sheet_name !== '') {
        selectedId = sheetOrder.find(id => sheetsMap[id]?.name === options.sheet_name);
        if (!selectedId) {
            throw new ExchangeError('unknown_target', `Sheet named ${options.sheet_name} does not exist`, {sheet_name: options.sheet_name});
        }
    } else {
        selectedId = sheetOrder[0];
    }
    if (!selectedId || !sheetsMap[selectedId]) {
        throw new ExchangeError('unknown_target', 'Workbook has no sheets to export');
    }

    const losses: ExchangeLossEntry[] = [];
    const diagnostics: ExchangeDiagnostic[] = [];
    if (sheetOrder.length > 1) {
        for (const otherId of sheetOrder) {
            if (otherId !== selectedId) {
                losses.push({
                    scope: 'sheet',
                    target: String(sheetsMap[otherId]?.name ?? otherId),
                    property: 'worksheet',
                    status: 'lost',
                    reason: 'csv_exports_single_sheet_only',
                });
            }
        }
    }

    const sheet = sheetsMap[selectedId];
    const sheetName = typeof sheet.name === 'string' ? sheet.name : selectedId;
    const cellData = (sheet.cellData && typeof sheet.cellData === 'object' && !Array.isArray(sheet.cellData))
        ? sheet.cellData as Record<string, Record<string, JsonObject>>
        : {};

    let maxRow = -1;
    let maxCol = -1;
    let formulaCount = 0;
    let styledCount = 0;

    for (const [rKey, rowObj] of Object.entries(cellData)) {
        const r = Number(rKey);
        if (!Number.isSafeInteger(r) || r < 0 || !rowObj || typeof rowObj !== 'object' || Array.isArray(rowObj)) continue;
        for (const [cKey, cell] of Object.entries(rowObj)) {
            const c = Number(cKey);
            if (!Number.isSafeInteger(c) || c < 0 || !cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
            if (cell.v !== undefined && cell.v !== null || typeof cell.f === 'string' && cell.f !== '') {
                if (r > maxRow) maxRow = r;
                if (c > maxCol) maxCol = c;
            }
            if (typeof cell.f === 'string' && cell.f !== '') formulaCount++;
            if (typeof cell.s === 'string' && cell.s !== '') styledCount++;
        }
    }

    if (formulaCount > 0) {
        losses.push({
            scope: 'sheet',
            target: sheetName,
            property: 'formulas',
            status: 'transformed',
            reason: 'csv_exports_evaluated_values_only',
        });
    }
    if (styledCount > 0 || (Array.isArray(sheet.mergeData) && sheet.mergeData.length > 0)) {
        losses.push({
            scope: 'sheet',
            target: sheetName,
            property: 'styles_and_merges',
            status: 'lost',
            reason: 'csv_does_not_support_styles_or_merges',
        });
    }

    const lines: string[] = [];
    let cellCount = 0;

    if (maxRow >= 0 && maxCol >= 0) {
        if ((maxRow + 1) * (maxCol + 1) > MAX_CSV_CELLS) {
            throw new ExchangeError('limit_exceeded', `Exported CSV grid exceeds ${MAX_CSV_CELLS} cells`);
        }
        for (let r = 0; r <= maxRow; r++) {
            const rowObj = cellData[String(r)] ?? {};
            const fields: string[] = [];
            for (let c = 0; c <= maxCol; c++) {
                const cell = rowObj[String(c)];
                if (!cell || cell.v === undefined || cell.v === null) {
                    fields.push('');
                    continue;
                }
                cellCount++;
                const coord = `R${r + 1}C${c + 1}`;
                if (cell.t === 3) {
                    fields.push(cell.v === 1 || cell.v === true ? 'TRUE' : 'FALSE');
                } else if (typeof cell.v === 'number') {
                    if (!Number.isFinite(cell.v)) {
                        throw new ExchangeError('unsupported_content', `Non-finite numeric value at ${coord}`);
                    }
                    fields.push(String(cell.v));
                } else {
                    const safe = sanitizeFormulaInjection(String(cell.v), coord, diagnostics);
                    fields.push(escapeCsvText(safe, dialect.delimiter, dialect.quote));
                }
            }
            lines.push(fields.join(dialect.delimiter));
        }
    }

    const textOut = (options.bom === true ? '\uFEFF' : '') + lines.join(dialect.line_ending) + (lines.length > 0 ? dialect.line_ending : '');
    const bytes = Buffer.from(textOut, 'utf8');
    const outputSha = createHash('sha256').update(bytes).digest('hex');

    return {
        bytes,
        report: {
            format: 'csv',
            operation: 'export',
            source_sha256: sourceSha,
            output_sha256: outputSha,
            dialect,
            sheets: [
                {
                    sheet_id: selectedId,
                    name: sheetName,
                    rows: maxRow >= 0 ? maxRow + 1 : 0,
                    columns: maxCol >= 0 ? maxCol + 1 : 0,
                    cells: cellCount,
                    formulas: formulaCount,
                    styles: styledCount,
                    merges: Array.isArray(sheet.mergeData) ? sheet.mergeData.length : 0,
                    validations: 0,
                    conditional_formatting: 0,
                },
            ],
            defined_names: {preserved: 0, lost: 0},
            losses,
            diagnostics,
            unknown_parts: [],
            editable_published: false,
        },
    };
}
