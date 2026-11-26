import {createHash, randomUUID} from 'node:crypto';
import {BorderStyleTypes} from '@univerjs/core';
import {zipSync} from 'fflate';
import {SaxesParser, type SaxesTagNS} from 'saxes';
import {columnLetters} from '../coordinates.ts';
import {UniverWorkbookSession} from '../engine/univer.ts';
import {WIRE_PROFILE} from '../profile.ts';
import {sha256Canonical, type JsonObject, type TableBinding, type WorkbookV2} from '../protocol.ts';
import {
    ExchangeError,
    type ExchangeDiagnostic,
    type ExchangeLossEntry,
    type ExchangeReport,
    type ExportResult,
    type ImportResult,
    type SheetExchangeSummary,
} from './types.ts';
import {inspectAndReadXlsxZip} from './zip-guard.ts';

const MAX_XLSX_SHEETS = 100;
const MAX_XLSX_CELLS = 250_000;
const EXCEL_1904_OFFSET_DAYS = 1462;
const SERIAL_60_LEAP_BUG = 60;

const BUILTIN_NUMFMTS: Readonly<Record<number, string>> = {
    0: 'General',
    1: '0',
    2: '0.00',
    3: '#,##0',
    4: '#,##0.00',
    9: '0%',
    10: '0.00%',
    11: '0.00E+00',
    12: '# ?/?',
    13: '# ??/??',
    14: 'yyyy-mm-dd',
    15: 'd-mmm-yy',
    16: 'd-mmm',
    17: 'mmm-yy',
    18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM',
    20: 'h:mm',
    21: 'h:mm:ss',
    22: 'm/d/yy h:mm',
    37: '#,##0 ;(#,##0)',
    38: '#,##0 ;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)',
    40: '#,##0.00;[Red](#,##0.00)',
    45: 'mm:ss',
    46: '[h]:mm:ss',
    47: 'mmss.0',
    48: '##0.0E+0',
    49: '@',
};

const BUILTIN_CALENDAR_NUMFMT_IDS = new Set([
    14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 36, 50, 51, 54, 57, 58,
]);

const BORDER_SIDES = new Map<string, string>([['left', 'l'], ['right', 'r'], ['top', 't'], ['bottom', 'b']]);
const BORDER_STYLES = new Map<string, BorderStyleTypes>([
    ['thin', BorderStyleTypes.THIN], ['hair', BorderStyleTypes.HAIR], ['dotted', BorderStyleTypes.DOTTED],
    ['dashed', BorderStyleTypes.DASHED], ['dashDot', BorderStyleTypes.DASH_DOT], ['dashDotDot', BorderStyleTypes.DASH_DOT_DOT],
    ['double', BorderStyleTypes.DOUBLE], ['medium', BorderStyleTypes.MEDIUM], ['mediumDashed', BorderStyleTypes.MEDIUM_DASHED],
    ['mediumDashDot', BorderStyleTypes.MEDIUM_DASH_DOT], ['mediumDashDotDot', BorderStyleTypes.MEDIUM_DASH_DOT_DOT],
    ['slantDashDot', BorderStyleTypes.SLANT_DASH_DOT], ['thick', BorderStyleTypes.THICK],
]);
const OOXML_BORDER_STYLES = new Map<number, string>(Array.from(BORDER_STYLES, ([name, style]) => [style, name]));

const KNOWN_OOXML_PREFIXES = [
    '[Content_Types].xml',
    '_rels/',
    'docProps/',
    'xl/workbook.xml',
    'xl/_rels/',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
    'xl/theme/',
    'xl/calcChain.xml',
    'xl/worksheets/',
    'xl/tables/',
];

interface RichTextRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
}

interface SharedStringEntry {
    text: string;
    runs?: RichTextRun[];
}

interface ParsedCoord {
    row: number;
    col: number;
}

interface ParsedRange {
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
}

interface UniverStyle {
    ff?: string;
    fs?: number;
    bl?: number;
    it?: number;
    ul?: {s: number};
    st?: {s: number};
    cl?: {rgb: string};
    bg?: {rgb: string};
    ht?: number;
    vt?: number;
    tb?: number;
    bd?: Record<string, {s: number; cl: {rgb: string}}>;
    n?: {pattern: string};
}

function parseColLetters(letters: string): number {
    let col = 0;
    for (const ch of letters.toUpperCase()) {
        col = col * 26 + (ch.charCodeAt(0) - 64);
    }
    return col;
}

function parseCellRef(ref: string): ParsedCoord | null {
    const clean = ref.replace(/\$/g, '');
    const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/.exec(clean);
    if (!match) return null;
    return {row: Number(match[2]), col: parseColLetters(match[1])};
}

function parseSqref(ref: string): ParsedRange[] {
    const out: ParsedRange[] = [];
    for (const part of ref.trim().split(/\s+/)) {
        if (!part) continue;
        const [a, b] = part.split(':');
        const start = parseCellRef(a);
        if (!start) continue;
        const end = b ? parseCellRef(b) : start;
        if (!end) continue;
        out.push({
            startRow: Math.min(start.row, end.row) - 1,
            startColumn: Math.min(start.col, end.col) - 1,
            endRow: Math.max(start.row, end.row) - 1,
            endColumn: Math.max(start.col, end.col) - 1,
        });
    }
    return out;
}

function formatRangeA1(range: {startRow: number; startColumn: number; endRow: number; endColumn: number}): string {
    const start = `${columnLetters(range.startColumn + 1)}${range.startRow + 1}`;
    const end = `${columnLetters(range.endColumn + 1)}${range.endRow + 1}`;
    return start === end ? start : `${start}:${end}`;
}

function isCalendarNumFmt(numFmtId: number, pattern?: string): boolean {
    if (!pattern) return BUILTIN_CALENDAR_NUMFMT_IDS.has(numFmtId);
    const stripped = pattern
        .replace(/"[^"]*"|[\\_*].|\[(?![hms]+\])[^\]]*\]/gi, '')
        .replace(/AM\/PM|A\/P/gi, '')
        .toLowerCase();
    return stripped.split(';').some(section => {
        const tokens = section.match(/\[[hms]+\]|y+|d+|m+|h+|s+/g) ?? [];
        return tokens.some((token, i) => {
            if (/^[yd]|^mmm/.test(token)) return true;
            // A short m token means minutes after hours or before seconds.
            return /^m{1,2}$/.test(token)
                && !/^\[?h/.test(tokens[i - 1] ?? '')
                && !/^\[?s/.test(tokens[i + 1] ?? '');
        });
    });
}

const DEFAULT_THEME_PALETTE: Record<string, string> = {
    '0': '#ffffff',
    '1': '#000000',
    '2': '#e7e6e6',
    '3': '#44546a',
    '4': '#4472c4',
    '5': '#ed7d31',
    '6': '#a5a5a5',
    '7': '#ffc000',
    '8': '#5b9bd5',
    '9': '#70ad47',
    '10': '#0563c1',
    '11': '#954f72',
};

const THEME_SLOT_INDEX: Record<string, string> = {
    lt1: '0',
    dk1: '1',
    lt2: '2',
    dk2: '3',
    accent1: '4',
    accent2: '5',
    accent3: '6',
    accent4: '7',
    accent5: '8',
    accent6: '9',
    hlink: '10',
    folHlink: '11',
};

function parseThemePalette(xmlText: string | undefined): Record<string, string> {
    const palette: Record<string, string> = {...DEFAULT_THEME_PALETTE};
    if (!xmlText) return palette;
    let inClrScheme = false;
    let currentSlot: string | undefined;

    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('doctype', () => {
        throw new ExchangeError('unsafe_archive', 'DOCTYPE is forbidden in theme1.xml');
    });
    parser.on('opentag', tag => {
        if (tag.local === 'clrScheme') {
            inClrScheme = true;
        } else if (inClrScheme && THEME_SLOT_INDEX[tag.local] !== undefined) {
            currentSlot = THEME_SLOT_INDEX[tag.local];
        } else if (inClrScheme && currentSlot !== undefined && (tag.local === 'srgbClr' || tag.local === 'sysClr')) {
            const val = tag.attributes.lastClr?.value ?? tag.attributes.val?.value;
            if (val && /^[0-9A-Fa-f]{6}$/.test(val)) {
                palette[currentSlot] = `#${val.toLowerCase()}`;
            }
        }
    });
    parser.on('closetag', tag => {
        if (tag.local === 'clrScheme') {
            inClrScheme = false;
            currentSlot = undefined;
        } else if (inClrScheme && THEME_SLOT_INDEX[tag.local] !== undefined) {
            currentSlot = undefined;
        }
    });
    parser.write(xmlText).close();
    return palette;
}

function applyColorTint(hex: string, tintRaw: string | undefined): string {
    if (!tintRaw) return hex;
    const tint = Number(tintRaw);
    if (!Number.isFinite(tint) || tint === 0) return hex;
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    let l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }

    if (tint < 0) {
        l = l * (1 + tint);
    } else {
        l = l * (1 - tint) + tint;
    }
    l = Math.max(0, Math.min(1, l));

    const hue2rgb = (p: number, q: number, t: number): number => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };

    let nr: number;
    let ng: number;
    let nb: number;
    if (s === 0) {
        nr = ng = nb = l;
    } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        nr = hue2rgb(p, q, h + 1 / 3);
        ng = hue2rgb(p, q, h);
        nb = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = (c: number) => Math.round(Math.max(0, Math.min(255, c * 255))).toString(16).padStart(2, '0');
    return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

function normalizeColor(attrs: Record<string, {value: string}>, themePalette: Record<string, string> = DEFAULT_THEME_PALETTE): string | undefined {
    const rgb = attrs.rgb?.value;
    if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) {
        const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
        return applyColorTint(`#${hex.toLowerCase()}`, attrs.tint?.value);
    }
    const theme = attrs.theme?.value;
    if (theme !== undefined) {
        const base = themePalette[theme] ?? DEFAULT_THEME_PALETTE[theme];
        if (!base) return undefined;
        return applyColorTint(base, attrs.tint?.value);
    }
    return undefined;
}

function rgbHexForOoxml(color: string | undefined): string | undefined {
    if (!color) return undefined;
    const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
    if (hexMatch) return `FF${hexMatch[1].toUpperCase()}`;
    const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(color.trim());
    if (rgbMatch) {
        const parts = [rgbMatch[1], rgbMatch[2], rgbMatch[3]].map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0').toUpperCase());
        return `FF${parts.join('')}`;
    }
    return undefined;
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function attrVal(tag: SaxesTagNS, localName: string): string | undefined {
    for (const attr of Object.values(tag.attributes)) {
        if (attr.local === localName || attr.name === localName) return attr.value;
    }
    return undefined;
}

function normalizeZipPath(baseDir: string, target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (baseDir ? `${baseDir}/${target}` : target).split('/');
    const stack: string[] = [];
    for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return stack.join('/');
}

function parseRelsXml(xmlText: string): Map<string, {type: string; target: string; targetMode: string}> {
    const rels = new Map<string, {type: string; target: string; targetMode: string}>();
    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('opentag', tag => {
        if (tag.local !== 'Relationship') return;
        const id = attrVal(tag, 'Id');
        const type = attrVal(tag, 'Type') ?? '';
        const target = attrVal(tag, 'Target') ?? '';
        const targetMode = attrVal(tag, 'TargetMode') ?? '';
        if (id) rels.set(id, {type, target, targetMode});
    });
    parser.write(xmlText).close();
    return rels;
}

function stripXlfn(formula: string): {formula: string; stripped: boolean} {
    let stripped = false;
    let out = '';
    let inString = false;
    let i = 0;
    while (i < formula.length) {
        const ch = formula[i];
        if (ch === '"') {
            out += ch;
            i++;
            if (inString && formula[i] === '"') {
                out += '"';
                i++;
            } else {
                inString = !inString;
            }
            continue;
        }
        if (!inString && formula.startsWith('_xlfn.', i)) {
            stripped = true;
            i += 6;
            if (formula.startsWith('_xlws.', i)) i += 6;
            continue;
        }
        out += ch;
        i++;
    }
    return {formula: out, stripped};
}

/**
 * Functions that let a spreadsheet application run a program, load a library or open a DDE
 * channel when the workbook is opened (Excel's `CALL`/`REGISTER.ID`, the XLM `EXEC`,
 * LibreOffice's `DDE`). No workbook here computes with them, so a formula calling one is
 * dropped on import and on export.
 */
const LAUNCHING_FUNCTIONS = new Set(['CALL', 'DDE', 'DDEAUTO', 'EXEC', 'REGISTER', 'REGISTER.ID']);

/**
 * Whether a formula carries a dynamic data exchange link: Excel's `app|topic!item` form
 * (`=cmd|' /C calc'!A0`), whose `|` is no operator of the formula grammar, or a call of one of
 * LAUNCHING_FUNCTIONS. String literals and quoted sheet names are skipped, so `"a|b"` and
 * `'Q1|Q2'!A1` stay formulas.
 */
export function hasDynamicExchangeLink(expr: string): boolean {
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '"' || ch === "'") {
            const close = skipQuoted(expr, i, ch);
            if (close < 0) return false;
            i = close;
            continue;
        }
        if (ch === '|') return true;
        if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_.]/.test(expr[i - 1]))) {
            let end = i;
            while (end < expr.length && /[A-Za-z0-9_.]/.test(expr[end])) end++;
            let next = end;
            while (next < expr.length && expr[next] === ' ') next++;
            const name = expr.slice(i, end).toUpperCase().replace(/^_XLFN\./, '').replace(/^_XLL\./, '');
            if (expr[next] === '(' && LAUNCHING_FUNCTIONS.has(name)) return true;
            i = end - 1;
        }
    }
    return false;
}

/** The index of the quote closing the literal opened at `start` (doubled quotes escape), or -1. */
function skipQuoted(expr: string, start: number, quote: string): number {
    for (let i = start + 1; i < expr.length; i++) {
        if (expr[i] !== quote) continue;
        if (expr[i + 1] === quote) {
            i++;
            continue;
        }
        return i;
    }
    return -1;
}

/** The formulas of a conditional format rule: its value(s) and its scale/bar thresholds. */
function cfFormulaTexts(rule: JsonObject): string[] {
    const texts: string[] = [];
    const values = Array.isArray(rule.value) ? rule.value : [rule.value];
    for (const value of values) if (typeof value === 'string') texts.push(value);
    const config = Array.isArray(rule.config) ? rule.config : [];
    for (const entry of config) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)) {
            const threshold = entry.value.value;
            if (typeof threshold === 'string') texts.push(threshold);
        }
    }
    return texts;
}

/** Why a formula from or into a file must not be kept, or null when it may. */
function unsafeFormulaReason(expr: string): 'external_ref_stripped' | 'dde_link_stripped' | null {
    if (hasDynamicExchangeLink(expr)) return 'dde_link_stripped';
    return hasExternalWorkbookRef(expr) ? 'external_ref_stripped' : null;
}

function hasExternalWorkbookRef(expr: string): boolean {
    let inString = false;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '"') {
            if (inString && expr[i + 1] === '"') i++;
            else inString = !inString;
            continue;
        }
        if (!inString && ch === '[') {
            const close = expr.indexOf(']', i + 1);
            if (close > i + 1) {
                const inside = expr.slice(i + 1, close);
                // Ignore structured table references like Table1[Column] where '[' is preceded by identifier char.
                const prev = i > 0 ? expr[i - 1] : '';
                if (!/[A-Za-z0-9_.]/.test(prev) && !inside.startsWith('http://') && !inside.startsWith('https://')) {
                    return true;
                }
            }
        }
    }
    return false;
}

function shiftSharedFormula(formula: string, rowDelta: number, colDelta: number): string {
    if (rowDelta === 0 && colDelta === 0) return formula;
    // Match strings and sheet qualifiers first so that A1-like names stay intact.
    const token = /"[^"]*(?:""[^"]*)*"|'[^']*(?:''[^']*)*'|(?<![\w.])[\w.]+(?::[\w.]+)?(?=!)|(?<![\w.])(\$?)([A-Z]{1,3})(\$?)([1-9]\d{0,6})(?![\w.(!])/gi;
    return formula.replace(token, (match, absoluteCol, colLetters, absoluteRow, rowNumber) => {
        if (colLetters === undefined) return match;
        const col = Math.max(1, parseColLetters(colLetters) + (absoluteCol ? 0 : colDelta));
        const row = Math.max(1, Number(rowNumber) + (absoluteRow ? 0 : rowDelta));
        return `${absoluteCol}${columnLetters(col)}${absoluteRow}${row}`;
    });
}

function buildUniverRichTextDoc(text: string, runs: RichTextRun[], hyperlink?: {url: string; tooltip?: string}): JsonObject {
    const textRuns: JsonObject[] = [];
    let offset = 0;
    for (const run of runs) {
        if (!run.text) continue;
        const ts: JsonObject = {};
        if (run.bold !== undefined) ts.bl = run.bold ? 1 : 0;
        if (run.italic !== undefined) ts.it = run.italic ? 1 : 0;
        if (run.underline !== undefined) ts.ul = {s: run.underline ? 1 : 0};
        if (run.strike !== undefined) ts.st = {s: run.strike ? 1 : 0};
        if (run.color) ts.cl = {rgb: run.color};
        if (run.fontFamily) ts.ff = run.fontFamily;
        if (run.fontSize !== undefined) ts.fs = run.fontSize;
        textRuns.push({
            st: offset,
            ed: offset + run.text.length,
            ts,
        });
        offset += run.text.length;
    }
    const customRanges: JsonObject[] = hyperlink
        ? [{
            rangeId: `hl_${randomUUID()}`,
            rangeType: 0,
            startIndex: 0,
            endIndex: Math.max(0, text.length - 1),
            properties: {
                url: hyperlink.url,
                ...(hyperlink.tooltip ? {tooltip: hyperlink.tooltip} : {}),
            },
        }]
        : [];
    return {
        id: `doc_${randomUUID()}`,
        body: {
            dataStream: `${text}\r\n`,
            textRuns,
            customRanges,
            paragraphs: [{startIndex: text.length}],
        },
        documentStyle: {},
    };
}

function parseSharedStrings(xmlText: string | undefined, themePalette: Record<string, string> = DEFAULT_THEME_PALETTE): SharedStringEntry[] {
    if (!xmlText) return [];
    const strings: SharedStringEntry[] = [];
    let inSi = false;
    let inR = false;
    let inRPr = false;
    let inT = false;
    let inPhonetic = false;
    let current = '';
    let currentRuns: RichTextRun[] = [];
    let currentRun: RichTextRun | null = null;
    let hasRuns = false;

    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('doctype', () => {
        throw new ExchangeError('unsafe_archive', 'DOCTYPE is forbidden in sharedStrings.xml');
    });
    parser.on('opentag', tag => {
        if (tag.local === 'si') {
            inSi = true;
            current = '';
            currentRuns = [];
            currentRun = null;
            hasRuns = false;
        } else if (tag.local === 'rPh') {
            inPhonetic = true;
        } else if (inSi && !inPhonetic && tag.local === 'r') {
            inR = true;
            hasRuns = true;
            currentRun = {text: ''};
        } else if (inR && tag.local === 'rPr') {
            inRPr = true;
        } else if (inRPr && currentRun) {
            const val = tag.attributes.val?.value;
            if (tag.local === 'b') currentRun.bold = val !== '0' && val !== 'false';
            else if (tag.local === 'i') currentRun.italic = val !== '0' && val !== 'false';
            else if (tag.local === 'u') currentRun.underline = val !== 'none';
            else if (tag.local === 'strike') currentRun.strike = val !== '0' && val !== 'false';
            else if (tag.local === 'color') {
                const c = normalizeColor(tag.attributes, themePalette);
                if (c) currentRun.color = c;
            } else if (tag.local === 'rFont' && val) {
                currentRun.fontFamily = val;
            } else if (tag.local === 'sz' && val) {
                const sz = Number(val);
                if (Number.isFinite(sz) && sz > 0) currentRun.fontSize = sz;
            }
        } else if (inSi && !inPhonetic && tag.local === 't') {
            inT = true;
        }
    });
    parser.on('text', text => {
        if (inSi && inT && !inPhonetic) {
            current += text;
            if (inR && currentRun) currentRun.text += text;
        }
    });
    parser.on('closetag', tag => {
        if (tag.local === 't') inT = false;
        else if (tag.local === 'rPh') inPhonetic = false;
        else if (tag.local === 'rPr') inRPr = false;
        else if (tag.local === 'r') {
            if (currentRun && currentRun.text.length > 0) {
                currentRuns.push(currentRun);
            }
            currentRun = null;
            inR = false;
        } else if (tag.local === 'si') {
            strings.push(hasRuns && currentRuns.length > 0 ? {text: current, runs: currentRuns} : {text: current});
            inSi = false;
        }
    });
    parser.write(xmlText).close();
    return strings;
}

interface ParsedStyles {
    styles: UniverStyle[];
    numFmtIds: number[];
    numFmtPatterns: (string | undefined)[];
    dxfs: UniverStyle[];
}

function parseStylesXml(xmlText: string | undefined, losses: ExchangeLossEntry[], themePalette: Record<string, string> = DEFAULT_THEME_PALETTE): ParsedStyles {
    if (!xmlText) {
        return {styles: [{}], numFmtIds: [0], numFmtPatterns: [undefined], dxfs: []};
    }

    const customNumFmts = new Map<number, string>();
    const fonts: Partial<UniverStyle>[] = [];
    const fills: Partial<UniverStyle>[] = [];
    const borders: Partial<UniverStyle>[] = [];
    const cellXfs: {numFmtId: number; fontId: number; fillId: number; borderId: number; ht?: number; vt?: number; tb?: number}[] = [];
    const dxfs: UniverStyle[] = [];

    let section: 'none' | 'numFmts' | 'fonts' | 'fills' | 'borders' | 'cellXfs' | 'dxfs' = 'none';
    let currentFont: Partial<UniverStyle> | null = null;
    let currentFill: Partial<UniverStyle> | null = null;
    let currentBorder: Record<string, {s: number; cl: {rgb: string}}> | null = null;
    let currentBorderSide: string | null = null;
    let currentXf: {numFmtId: number; fontId: number; fillId: number; borderId: number; ht?: number; vt?: number; tb?: number} | null = null;
    let currentDxf: UniverStyle | null = null;
    let dxfSub: 'none' | 'font' | 'fill' | 'border' = 'none';

    const alignHt = (v?: string): number | undefined => v === 'left' ? 1 : v === 'center' ? 2 : v === 'right' ? 3 : undefined;
    const alignVt = (v?: string): number | undefined => v === 'top' ? 1 : v === 'center' ? 2 : v === 'bottom' ? 3 : undefined;
    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('opentag', tag => {
        const name = tag.local;
        if (section === 'none' && (name === 'numFmts' || name === 'fonts' || name === 'fills' || name === 'borders' || name === 'cellXfs' || name === 'dxfs')) {
            section = name;
            return;
        }
        if (section === 'numFmts' && name === 'numFmt') {
            const id = Number(attrVal(tag, 'numFmtId'));
            const code = attrVal(tag, 'formatCode');
            if (Number.isSafeInteger(id) && code !== undefined) customNumFmts.set(id, code);
        } else if (section === 'fonts') {
            if (name === 'font') currentFont = {};
            else if (currentFont) {
                if (name === 'b') currentFont.bl = attrVal(tag, 'val') === '0' ? 0 : 1;
                else if (name === 'i') currentFont.it = attrVal(tag, 'val') === '0' ? 0 : 1;
                else if (name === 'u') currentFont.ul = {s: attrVal(tag, 'val') === 'none' ? 0 : 1};
                else if (name === 'strike') currentFont.st = {s: attrVal(tag, 'val') === '0' ? 0 : 1};
                else if (name === 'sz') {
                    const sz = Number(attrVal(tag, 'val'));
                    if (Number.isFinite(sz)) currentFont.fs = sz;
                } else if (name === 'name') {
                    const ff = attrVal(tag, 'val');
                    if (ff) currentFont.ff = ff;
                } else if (name === 'color') {
                    const rgb = normalizeColor(tag.attributes, themePalette);
                    if (rgb) currentFont.cl = {rgb};
                }
            }
        } else if (section === 'fills') {
            if (name === 'fill') currentFill = {};
            else if (currentFill && name === 'patternFill') {
                const pt = attrVal(tag, 'patternType');
                if (pt === 'none' || pt === 'gray125') currentFill = {};
            } else if (currentFill && name === 'fgColor') {
                const rgb = normalizeColor(tag.attributes, themePalette);
                if (rgb) currentFill.bg = {rgb};
            }
        } else if (section === 'borders') {
            if (name === 'border') currentBorder = {};
            else if (currentBorder && name === 'color') {
                const rgb = normalizeColor(tag.attributes, themePalette);
                if (currentBorderSide && rgb) currentBorder[currentBorderSide].cl = {rgb};
            } else if (currentBorder) {
                currentBorderSide = null;
                const style = attrVal(tag, 'style');
                if (style && style !== 'none') {
                    const key = BORDER_SIDES.get(name);
                    const mapped = BORDER_STYLES.get(style);
                    if (key && mapped !== undefined) {
                        currentBorderSide = key;
                        currentBorder[key] = {s: mapped, cl: {rgb: '#000000'}};
                    } else {
                        losses.push({
                            scope: 'object', target: `xl/styles.xml#border-${borders.length}:${name}`,
                            property: 'border', status: 'lost', reason: 'unsupported_ooxml_border',
                        });
                    }
                }
            }
        } else if (section === 'cellXfs') {
            if (name === 'xf') {
                currentXf = {
                    numFmtId: Number(attrVal(tag, 'numFmtId') ?? '0'),
                    fontId: Number(attrVal(tag, 'fontId') ?? '0'),
                    fillId: Number(attrVal(tag, 'fillId') ?? '0'),
                    borderId: Number(attrVal(tag, 'borderId') ?? '0'),
                };
            } else if (currentXf && name === 'alignment') {
                const ht = alignHt(attrVal(tag, 'horizontal'));
                const vt = alignVt(attrVal(tag, 'vertical'));
                if (ht !== undefined) currentXf.ht = ht;
                if (vt !== undefined) currentXf.vt = vt;
                if (attrVal(tag, 'wrapText') === '1') currentXf.tb = 3;
            }
        } else if (section === 'dxfs') {
            if (name === 'dxf') {
                currentDxf = {};
                dxfSub = 'none';
            } else if (currentDxf) {
                if (name === 'font') dxfSub = 'font';
                else if (name === 'fill') dxfSub = 'fill';
                else if (name === 'border') dxfSub = 'border';
                else if (dxfSub === 'font') {
                    if (name === 'b') currentDxf.bl = attrVal(tag, 'val') === '0' ? 0 : 1;
                    else if (name === 'i') currentDxf.it = attrVal(tag, 'val') === '0' ? 0 : 1;
                    else if (name === 'u') currentDxf.ul = {s: 1};
                    else if (name === 'strike') currentDxf.st = {s: 1};
                    else if (name === 'color') {
                        const rgb = normalizeColor(tag.attributes, themePalette);
                        if (rgb) currentDxf.cl = {rgb};
                    }
                } else if (dxfSub === 'fill' && (name === 'fgColor' || name === 'bgColor')) {
                    const rgb = normalizeColor(tag.attributes, themePalette);
                    if (rgb && !currentDxf.bg) currentDxf.bg = {rgb};
                }
            }
        }
    });
    parser.on('closetag', tag => {
        const name = tag.local;
        if (name === section) {
            section = 'none';
            return;
        }
        if (section === 'fonts' && name === 'font' && currentFont) {
            fonts.push(currentFont);
            currentFont = null;
        } else if (section === 'fills' && name === 'fill' && currentFill) {
            fills.push(currentFill);
            currentFill = null;
        } else if (section === 'borders' && name === 'border' && currentBorder) {
            borders.push(Object.keys(currentBorder).length > 0 ? {bd: currentBorder} : {});
            currentBorder = null;
            currentBorderSide = null;
        } else if (section === 'borders' && BORDER_SIDES.has(name)) {
            currentBorderSide = null;
        } else if (section === 'cellXfs' && name === 'xf' && currentXf) {
            cellXfs.push(currentXf);
            currentXf = null;
        } else if (section === 'dxfs') {
            if (name === 'font' || name === 'fill' || name === 'border') dxfSub = 'none';
            else if (name === 'dxf' && currentDxf) {
                dxfs.push(currentDxf);
                currentDxf = null;
            }
        }
    });
    parser.write(xmlText).close();

    const styles: UniverStyle[] = [];
    const numFmtIds: number[] = [];
    const numFmtPatterns: (string | undefined)[] = [];

    for (const xf of cellXfs) {
        const merged: UniverStyle = {
            ...(fonts[xf.fontId] ?? {}),
            ...(fills[xf.fillId] ?? {}),
            ...(borders[xf.borderId] ?? {}),
        };
        if (xf.ht !== undefined) merged.ht = xf.ht;
        if (xf.vt !== undefined) merged.vt = xf.vt;
        if (xf.tb !== undefined) merged.tb = xf.tb;
        const pattern = customNumFmts.get(xf.numFmtId) ?? BUILTIN_NUMFMTS[xf.numFmtId];
        if (pattern && pattern !== 'General') {
            merged.n = {pattern};
        }
        styles.push(merged);
        numFmtIds.push(xf.numFmtId);
        numFmtPatterns.push(pattern);
    }

    if (styles.length === 0) {
        styles.push({});
        numFmtIds.push(0);
        numFmtPatterns.push(undefined);
    }

    return {styles, numFmtIds, numFmtPatterns, dxfs};
}

interface ParsedWorkbookXml {
    date1904: boolean;
    sheets: {name: string; sheetId: string; rId: string}[];
    definedNames: {name: string; localSheetId?: number; formula: string}[];
}

function parseWorkbookXml(xmlText: string): ParsedWorkbookXml {
    let date1904 = false;
    const sheets: {name: string; sheetId: string; rId: string}[] = [];
    const definedNames: {name: string; localSheetId?: number; formula: string}[] = [];
    let currentDef: {name: string; localSheetId?: number; formula: string} | null = null;

    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('opentag', tag => {
        if (tag.local === 'workbookPr') {
            const flag = attrVal(tag, 'date1904');
            if (flag === '1' || flag === 'true') date1904 = true;
        } else if (tag.local === 'sheet') {
            const name = attrVal(tag, 'name') ?? 'Sheet';
            const sheetId = attrVal(tag, 'sheetId') ?? String(sheets.length + 1);
            const rId = attrVal(tag, 'id') ?? '';
            sheets.push({name, sheetId, rId});
        } else if (tag.local === 'definedName') {
            const name = attrVal(tag, 'name') ?? '';
            const localRaw = attrVal(tag, 'localSheetId');
            const localSheetId = localRaw !== undefined && /^\d+$/.test(localRaw) ? Number(localRaw) : undefined;
            currentDef = {name, ...(localSheetId !== undefined ? {localSheetId} : {}), formula: ''};
        }
    });
    parser.on('text', text => {
        if (currentDef) currentDef.formula += text;
    });
    parser.on('closetag', tag => {
        if (tag.local === 'definedName' && currentDef) {
            definedNames.push(currentDef);
            currentDef = null;
        }
    });
    parser.write(xmlText).close();
    return {date1904, sheets, definedNames};
}

function mapValidationOperator(op: string | undefined): string {
    return matchOp(op ?? 'between');
}

function matchOp(op: string): string {
    switch (op) {
        case 'between':
        case 'notBetween':
        case 'equal':
        case 'notEqual':
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual':
            return op;
        default:
            return 'between';
    }
}

function mapCfOperator(op: string | undefined): string {
    switch (op) {
        case 'greaterThan':
        case 'lessThan':
        case 'equal':
        case 'notEqual':
        case 'between':
        case 'notBetween':
        case 'greaterThanOrEqual':
        case 'lessThanOrEqual':
            return op;
        default:
            return 'greaterThan';
    }
}

function parseTableXml(xmlText: string, sheetId: string): TableBinding | null {
    let tableInfo: TableBinding | null = null;
    let startCol = 0;
    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('doctype', () => {
        throw new ExchangeError('unsafe_archive', 'DOCTYPE is forbidden in table XML');
    });
    parser.on('opentag', tag => {
        if (tag.local === 'table') {
            const ref = attrVal(tag, 'ref') ?? 'A1:A1';
            const parsedRange = parseSqref(ref)[0] ?? {startRow: 0, startColumn: 0, endRow: 0, endColumn: 0};
            startCol = parsedRange.startColumn;
            const headerRowCount = attrVal(tag, 'headerRowCount') === '0' ? 0 : 1;
            const firstDataRow = parsedRange.startRow + headerRowCount + 1;
            const lastDataRow = parsedRange.endRow + 1;
            const rows: {row_id: string; row: number}[] = [];
            for (let r = firstDataRow; r <= lastDataRow; r++) {
                rows.push({row_id: `row_${r}`, row: r});
            }
            tableInfo = {
                table_id: `tbl_${attrVal(tag, 'id') ?? randomUUID()}`,
                sheet_id: sheetId,
                header_row: parsedRange.startRow + 1,
                columns: [],
                rows,
            };
        } else if (tag.local === 'tableColumn' && tableInfo) {
            const colName = attrVal(tag, 'name') ?? `col_${tableInfo.columns.length + 1}`;
            tableInfo.columns.push({
                column_id: colName,
                column: startCol + tableInfo.columns.length + 1,
            });
        }
    });
    parser.write(xmlText).close();
    return tableInfo;
}

export async function importXlsx(bytes: Buffer, options: JsonObject): Promise<ImportResult> {
    const sourceSha = createHash('sha256').update(bytes).digest('hex');
    const archive = await inspectAndReadXlsxZip(bytes);

    const workbookXml = archive.xmlTexts.get('xl/workbook.xml');
    if (!workbookXml) {
        throw new ExchangeError('unsupported_content', 'Missing xl/workbook.xml in XLSX archive', {reason: 'missing_workbook_xml'});
    }
    const wbMeta = parseWorkbookXml(workbookXml);
    if (wbMeta.sheets.length === 0) {
        throw new ExchangeError('unsupported_content', 'XLSX workbook contains no sheets', {reason: 'no_sheets'});
    }
    if (wbMeta.sheets.length > MAX_XLSX_SHEETS) {
        throw new ExchangeError('limit_exceeded', `Workbook sheet count ${wbMeta.sheets.length} exceeds ${MAX_XLSX_SHEETS}`);
    }

    const wbRelsXml = archive.xmlTexts.get('xl/_rels/workbook.xml.rels');
    const wbRels = wbRelsXml ? parseRelsXml(wbRelsXml) : new Map();
    const themePalette = parseThemePalette(archive.xmlTexts.get('xl/theme/theme1.xml'));
    const sharedStrings = parseSharedStrings(archive.xmlTexts.get('xl/sharedStrings.xml'), themePalette);
    const losses: ExchangeLossEntry[] = [];
    const parsedStyles = parseStylesXml(archive.xmlTexts.get('xl/styles.xml'), losses, themePalette);

    const unitId = `wb_${randomUUID()}`;
    const sheetOrder: string[] = [];
    const sheets: Record<string, JsonObject> = {};
    const univerStyles: Record<string, JsonObject> = {};
    const styleIdByXf = new Map<number, string>();
    const diagnostics: ExchangeDiagnostic[] = [];
    const sheetSummaries: SheetExchangeSummary[] = [];
    const dataValidationsBySheet: Record<string, JsonObject[]> = {};
    const cfBySheet: Record<string, JsonObject[]> = {};
    const filterBySheet: Record<string, JsonObject> = {};
    const knownEntries = new Set<string>();
    let hasHyperlinks = false;
    const importedTables: TableBinding[] = [];
    const protectionRules: JsonObject[] = [];

    const styleKeyForXf = (xfIdx: number): string | undefined => {
        const existing = styleIdByXf.get(xfIdx);
        if (existing) return existing;
        const styleObj = parsedStyles.styles[xfIdx];
        if (!styleObj || Object.keys(styleObj).length === 0) return undefined;
        const key = `st_${sha256Canonical(styleObj).slice(0, 12)}`;
        styleIdByXf.set(xfIdx, key);
        univerStyles[key] = styleObj as unknown as JsonObject;
        return key;
    };

    const targetSheetIds: string[] = [];
    const sheetNameById = new Map<string, string>();
    const sheetIdByIndex: string[] = [];
    for (let i = 0; i < wbMeta.sheets.length; i++) {
        const id = `sheet_${i + 1}`;
        targetSheetIds.push(id);
        sheetIdByIndex.push(id);
        sheetNameById.set(id, wbMeta.sheets[i].name);
    }

    let totalCells = 0;

    for (let sIdx = 0; sIdx < wbMeta.sheets.length; sIdx++) {
        const meta = wbMeta.sheets[sIdx];
        const sheetId = targetSheetIds[sIdx];
        const rel = wbRels.get(meta.rId);
        const sheetPath = rel ? normalizeZipPath('xl', rel.target) : `xl/worksheets/sheet${sIdx + 1}.xml`;
        knownEntries.add(sheetPath);
        const sheetXml = archive.xmlTexts.get(sheetPath);
        if (!sheetXml) {
            throw new ExchangeError('unsupported_content', `Missing worksheet XML ${sheetPath}`, {reason: 'missing_worksheet'});
        }

        const cellData: Record<string, Record<string, JsonObject>> = {};
        const columnData: Record<string, JsonObject> = {};
        const rowData: Record<string, JsonObject> = {};
        const mergeData: JsonObject[] = [];
        const validations: JsonObject[] = [];
        const cfRules: JsonObject[] = [];
        const sharedFormulas = new Map<string, {baseRow: number; baseCol: number; formula: string}>();
        let showGridlines = 1;
        const freeze: {startColumn: number; startRow: number; xSplit: number; ySplit: number} = {
            startColumn: -1,
            startRow: -1,
            xSplit: 0,
            ySplit: 0,
        };
        let maxRowSeen = 0;
        let maxColSeen = 0;
        let sheetCellCount = 0;
        let sheetFormulaCount = 0;
        const sheetStyledKeys = new Set<string>();

        let currentCellRef: string | null = null;
        let currentCellType = 'n';
        let currentCellStyleIdx = 0;
        let inV = false;
        let inF = false;
        let inIsT = false;
        let vText = '';
        let fText = '';
        let fAttrs: {type?: string; ref?: string; si?: string} = {};
        let isText = '';
        let currentDv: {type: string; operator: string; formula1: string; formula2: string; sqref: string; showDropDown: boolean} | null = null;
        let inDvF1 = false;
        let inDvF2 = false;
        let inX14Dv = false;
        let inX14F1 = false;
        let currentFilterCol: JsonObject | null = null;
        const pendingHyperlinks: {ref: string; rId?: string; location?: string; tooltip?: string}[] = [];
        let sheetProtection: JsonObject | null = null;
        const tablePartRIds: string[] = [];
        const sheetBasename = `sheet${sheetOrder.length + 1}.xml`;
        const sheetRelsPath = `xl/worksheets/_rels/${sheetBasename}.rels`;
        const sheetRelsXml = archive.xmlTexts.get(sheetRelsPath);
        if (sheetRelsXml) knownEntries.add(sheetRelsPath);
        const sheetRels = sheetRelsXml ? parseRelsXml(sheetRelsXml) : new Map();
        let inX14F2 = false;
        let inX14Sqref = false;
        let currentCfSqref = '';
        let currentCfRule: {type: string; operator?: string; dxfId?: number; stopIfTrue: boolean; formulas: string[]; text?: string; cfvos?: {type: string; val?: string}[]; colors?: string[]; rank?: number; bottom?: boolean; percent?: boolean; aboveAverage?: boolean; equalAverage?: boolean; showValue?: boolean} | null = null;
        let inCfFormula = false;
        let cfFormulaBuf = '';

        const parser = new SaxesParser({xmlns: true, position: false});
        parser.on('doctype', () => {
            throw new ExchangeError('unsafe_archive', `DOCTYPE is forbidden in ${sheetPath}`);
        });
        parser.on('opentag', tag => {
            const name = tag.local;
            if (name === 'sheetView') {
                if (attrVal(tag, 'showGridLines') === '0') showGridlines = 0;
            } else if (name === 'pane' && attrVal(tag, 'state') === 'frozen') {
                const x = Number(attrVal(tag, 'xSplit') ?? '0');
                const y = Number(attrVal(tag, 'ySplit') ?? '0');
                if (Number.isSafeInteger(x) && x >= 0) {
                    freeze.xSplit = x;
                    freeze.startColumn = x;
                }
                if (Number.isSafeInteger(y) && y >= 0) {
                    freeze.ySplit = y;
                    freeze.startRow = y;
                }
            } else if (name === 'col') {
                const min = Number(attrVal(tag, 'min') ?? '0');
                const max = Number(attrVal(tag, 'max') ?? '0');
                const width = Number(attrVal(tag, 'width') ?? '0');
                const hidden = attrVal(tag, 'hidden') === '1' ? 1 : 0;
                if (min >= 1 && max >= min && max - min < 200) {
                    for (let c = min; c <= max; c++) {
                        const colInfo: JsonObject = {};
                        if (width > 0) colInfo.w = Math.round(width * 8);
                        if (hidden) colInfo.hd = 1;
                        if (Object.keys(colInfo).length > 0) columnData[String(c - 1)] = colInfo;
                    }
                }
            } else if (name === 'row') {
                const r = Number(attrVal(tag, 'r') ?? '0');
                const ht = Number(attrVal(tag, 'ht') ?? '0');
                const hidden = attrVal(tag, 'hidden') === '1' ? 1 : 0;
                if (r >= 1 && (ht > 0 || hidden)) {
                    const rowInfo: JsonObject = {};
                    if (ht > 0) rowInfo.h = Math.round(ht * 1.333);
                    if (hidden) rowInfo.hd = 1;
                    rowData[String(r - 1)] = rowInfo;
                }
            } else if (name === 'c') {
                currentCellRef = attrVal(tag, 'r') ?? null;
                currentCellType = attrVal(tag, 't') ?? 'n';
                currentCellStyleIdx = Number(attrVal(tag, 's') ?? '0');
                vText = '';
                fText = '';
                isText = '';
                fAttrs = {};
            } else if (currentCellRef && name === 'v') {
                inV = true;
            } else if (currentCellRef && name === 'f') {
                inF = true;
                fAttrs = {
                    type: attrVal(tag, 't'),
                    ref: attrVal(tag, 'ref'),
                    si: attrVal(tag, 'si'),
                };
            } else if (currentCellRef && name === 't') {
                inIsT = true;
            } else if (name === 'mergeCell') {
                const ref = attrVal(tag, 'ref');
                if (ref) {
                    for (const range of parseSqref(ref)) {
                        mergeData.push({
                            ...range,
                            startAbsoluteRefType: 0,
                            endAbsoluteRefType: 0,
                            rangeType: 0,
                            unitId,
                            sheetId,
                        });
                    }
                }
            } else if (name === 'dataValidation' && tag.uri.includes('2009/9/main')) {
                inX14Dv = true;
                currentDv = {
                    type: attrVal(tag, 'type') ?? 'any',
                    operator: mapValidationOperator(attrVal(tag, 'operator')),
                    formula1: '',
                    formula2: '',
                    sqref: '',
                    showDropDown: attrVal(tag, 'showDropDown') !== '1',
                };
            } else if (name === 'dataValidation') {
                inX14Dv = false;
                currentDv = {
                    type: attrVal(tag, 'type') ?? 'any',
                    operator: mapValidationOperator(attrVal(tag, 'operator')),
                    formula1: '',
                    formula2: '',
                    sqref: attrVal(tag, 'sqref') ?? '',
                    showDropDown: attrVal(tag, 'showDropDown') !== '1',
                };
            } else if (currentDv) {
                if (inX14Dv) {
                    if (name === 'formula1') inX14F1 = true;
                    else if (name === 'formula2') inX14F2 = true;
                    else if (name === 'sqref') inX14Sqref = true;
                } else {
                    if (name === 'formula1') inDvF1 = true;
                    else if (name === 'formula2') inDvF2 = true;
                }
            } else if (name === 'conditionalFormatting') {
                currentCfSqref = attrVal(tag, 'sqref') ?? '';
            } else if (name === 'cfRule' && currentCfSqref) {
                const dxfRaw = attrVal(tag, 'dxfId');
                const rankRaw = attrVal(tag, 'rank');
                currentCfRule = {
                    type: attrVal(tag, 'type') ?? 'cellIs',
                    operator: attrVal(tag, 'operator'),
                    ...(dxfRaw !== undefined ? {dxfId: Number(dxfRaw)} : {}),
                    stopIfTrue: attrVal(tag, 'stopIfTrue') === '1',
                    formulas: [],
                    text: attrVal(tag, 'text'),
                    cfvos: [],
                    colors: [],
                    ...(rankRaw !== undefined ? {rank: Number(rankRaw)} : {}),
                    bottom: attrVal(tag, 'bottom') === '1',
                    percent: attrVal(tag, 'percent') === '1',
                    aboveAverage: attrVal(tag, 'aboveAverage') !== '0',
                    equalAverage: attrVal(tag, 'equalAverage') === '1',
                    showValue: true,
                };
            } else if (currentCfRule && name === 'dataBar') {
                if (attrVal(tag, 'showValue') === '0') {
                    currentCfRule.showValue = false;
                }
            } else if (currentCfRule && name === 'cfvo') {
                (currentCfRule.cfvos as {type: string; val?: string}[]).push({
                    type: attrVal(tag, 'type') ?? 'num',
                    val: attrVal(tag, 'val'),
                });
            } else if (currentCfRule && name === 'color') {
                const c = normalizeColor(tag.attributes, themePalette);
                if (c) (currentCfRule.colors as string[]).push(c);
            } else if (currentCfRule && name === 'formula') {
                inCfFormula = true;
                cfFormulaBuf = '';
            } else if (name === 'autoFilter') {
                const ref = attrVal(tag, 'ref');
                if (ref) {
                    const parsed = parseSqref(ref)[0];
                    if (parsed) {
                        filterBySheet[sheetId] = {
                            ref: {...parsed, rangeType: 0},
                            filterColumns: [],
                            cachedFilteredOut: [],
                        };
                    }
                }
            } else if (name === 'filterColumn' && filterBySheet[sheetId]) {
                const relColId = Number(attrVal(tag, 'colId') ?? '0');
                const baseStartCol = (filterBySheet[sheetId].ref as JsonObject)?.startColumn as number ?? 0;
                const absColId = baseStartCol + (Number.isFinite(relColId) ? relColId : 0);
                currentFilterCol = {colId: absColId};
            } else if (name === 'filters' && currentFilterCol) {
                currentFilterCol.filters = {filters: []};
            } else if (name === 'filter' && currentFilterCol && currentFilterCol.filters) {
                const val = attrVal(tag, 'val');
                if (val !== undefined) {
                    ((currentFilterCol.filters as JsonObject).filters as string[]).push(val);
                }
            } else if (name === 'customFilters' && currentFilterCol) {
                currentFilterCol.customFilters = {
                    and: attrVal(tag, 'and') === '1' ? 1 : 0,
                    customFilters: [],
                };
            } else if (name === 'customFilter' && currentFilterCol && currentFilterCol.customFilters) {
                const op = attrVal(tag, 'operator') ?? 'equal';
                const val = attrVal(tag, 'val') ?? '';
                ((currentFilterCol.customFilters as JsonObject).customFilters as JsonObject[]).push({
                    operator: op,
                    val,
                });
            } else if (name === 'hyperlink') {
                const ref = attrVal(tag, 'ref');
                const rId = attrVal(tag, 'r:id') ?? attrVal(tag, 'id');
                const location = attrVal(tag, 'location');
                const tooltip = attrVal(tag, 'tooltip');
                if (ref) {
                    pendingHyperlinks.push({ref, rId, location, tooltip});
                }
            } else if (name === 'sheetProtection') {
                sheetProtection = {
                    sheet: attrVal(tag, 'sheet') !== '0',
                    objects: attrVal(tag, 'objects') === '1',
                    scenarios: attrVal(tag, 'scenarios') === '1',
                    formatCells: attrVal(tag, 'formatCells') !== '0',
                    formatColumns: attrVal(tag, 'formatColumns') !== '0',
                    formatRows: attrVal(tag, 'formatRows') !== '0',
                    insertColumns: attrVal(tag, 'insertColumns') !== '0',
                    insertRows: attrVal(tag, 'insertRows') !== '0',
                    deleteColumns: attrVal(tag, 'deleteColumns') !== '0',
                    deleteRows: attrVal(tag, 'deleteRows') !== '0',
                    sort: attrVal(tag, 'sort') !== '0',
                    autoFilter: attrVal(tag, 'autoFilter') !== '0',
                };
            } else if (name === 'tablePart') {
                const rId = attrVal(tag, 'r:id') ?? attrVal(tag, 'id');
                if (rId) tablePartRIds.push(rId);
            } else if (name === 'drawing' || name === 'legacyDrawing' || name === 'oleObjects' || name === 'controls' || name === 'sparklineGroups') {
                losses.push({
                    scope: 'object',
                    target: `${meta.name}:${name}`,
                    property: name,
                    status: 'lost',
                    reason: 'unsupported_ooxml_sheet_object',
                });
            }
        });
        parser.on('text', text => {
            if (inV) vText += text;
            else if (inF) fText += text;
            else if (inIsT) isText += text;
            else if (inDvF1 && currentDv) currentDv.formula1 += text;
            else if (inDvF2 && currentDv) currentDv.formula2 += text;
            else if (inX14F1 && currentDv) currentDv.formula1 += text;
            else if (inX14F2 && currentDv) currentDv.formula2 += text;
            else if (inX14Sqref && currentDv) currentDv.sqref += text;
            else if (inCfFormula) cfFormulaBuf += text;
        });
        parser.on('closetag', tag => {
            const name = tag.local;
            if (name === 'filterColumn' && currentFilterCol && filterBySheet[sheetId]) {
                (filterBySheet[sheetId].filterColumns as JsonObject[]).push(currentFilterCol);
                currentFilterCol = null;
            } else if (name === 'v') inV = false;
            else if (name === 'f') inF = false;
            else if (name === 't') inIsT = false;
            else if (name === 'formula1') {
                inDvF1 = false;
                inX14F1 = false;
            } else if (name === 'formula2') {
                inDvF2 = false;
                inX14F2 = false;
            } else if (name === 'sqref') {
                inX14Sqref = false;
            } else if (name === 'formula' && inCfFormula && currentCfRule) {
                currentCfRule.formulas.push(cfFormulaBuf);
                inCfFormula = false;
            } else if (name === 'dataValidation' && currentDv) {
                const ranges = parseSqref(currentDv.sqref).map(r => ({
                    ...r,
                    startAbsoluteRefType: 0,
                    endAbsoluteRefType: 0,
                    rangeType: 0,
                    unitId,
                    sheetId,
                }));
                if (ranges.length > 0 && currentDv.type !== 'none') {
                    let f1 = currentDv.formula1.trim();
                    const literalList = currentDv.type === 'list' && /^"(?:[^"]|"")*"$/.test(f1);
                    const dvUnsafe = (literalList ? null : unsafeFormulaReason(f1)) ?? unsafeFormulaReason(currentDv.formula2);
                    if (dvUnsafe !== null) {
                        losses.push({
                            scope: 'object', target: `${meta.name}!${currentDv.sqref}`,
                            property: currentDv.type === 'list' ? 'list_validation' : 'data_validation', status: 'lost', reason: dvUnsafe,
                        });
                        currentDv = null;
                        inX14Dv = false;
                        return;
                    }
                    if (currentDv.type === 'list' && f1 !== '') {
                        if (literalList) {
                            f1 = JSON.stringify(f1.slice(1, -1).replaceAll('""', '"').split(','));
                        } else if (!f1.startsWith('=')) {
                            f1 = `=${f1}`;
                        }
                    }
                    const dvEntry: JsonObject = {
                        uid: `dv_${randomUUID().slice(0, 12)}`,
                        ranges,
                        type: currentDv.type,
                        ...(f1 !== '' ? {formula1: f1} : {}),
                        ...(currentDv.formula2.trim() !== '' ? {formula2: currentDv.formula2.trim()} : {}),
                        ...(currentDv.type !== 'list' && currentDv.type !== 'custom' ? {operator: currentDv.operator} : {}),
                        ...(currentDv.type === 'list' ? {showDropDown: currentDv.showDropDown} : {}),
                    };
                    validations.push(dvEntry);
                }
                currentDv = null;
                inX14Dv = false;
            } else if (name === 'cfRule' && currentCfRule) {
                const ranges = parseSqref(currentCfSqref).map(r => ({
                    ...r,
                    startAbsoluteRefType: 0,
                    endAbsoluteRefType: 0,
                    rangeType: 0,
                    unitId,
                    sheetId,
                }));
                const dxfStyle = currentCfRule.dxfId !== undefined ? parsedStyles.dxfs[currentCfRule.dxfId] : undefined;
                const styleObj = (dxfStyle ?? {}) as unknown as JsonObject;
                const cfUnsafe = [...currentCfRule.formulas, ...(currentCfRule.cfvos ?? []).map(v => v.val ?? '')].map(unsafeFormulaReason).find(reason => reason !== null) ?? null;
                if (cfUnsafe !== null) {
                    losses.push({
                        scope: 'sheet',
                        target: `${meta.name}:${currentCfSqref}`,
                        property: 'conditional_formatting',
                        status: 'lost',
                        reason: cfUnsafe,
                    });
                } else if (ranges.length > 0) {
                    if (currentCfRule.type === 'cellIs') {
                        const rawF1 = currentCfRule.formulas[0] ?? '0';
                        const rawF2 = currentCfRule.formulas[1];
                        const val1 = /^-?\d+(?:\.\d+)?$/.test(rawF1.trim()) ? Number(rawF1.trim()) : rawF1.trim();
                        const val2 = rawF2 !== undefined && /^-?\d+(?:\.\d+)?$/.test(rawF2.trim()) ? Number(rawF2.trim()) : rawF2?.trim();
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: 'number',
                                operator: mapCfOperator(currentCfRule.operator),
                                value: val2 !== undefined ? [val1, val2] : val1,
                                style: styleObj,
                            },
                        });
                    } else if (currentCfRule.type === 'expression') {
                        const expr = currentCfRule.formulas[0] ?? '';
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: 'formula',
                                value: expr.startsWith('=') ? expr : `=${expr}`,
                                style: styleObj,
                            },
                        });
                    } else if (currentCfRule.type === 'containsText' || currentCfRule.type === 'notContainsText' || currentCfRule.type === 'beginsWith' || currentCfRule.type === 'endsWith') {
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: 'text',
                                operator: currentCfRule.type,
                                value: currentCfRule.text ?? currentCfRule.formulas[0] ?? '',
                                style: styleObj,
                            },
                        });
                    } else if (currentCfRule.type === 'colorScale') {
                        const cfvos = (currentCfRule.cfvos as {type: string; val?: string}[] | undefined) ?? [];
                        const colors = (currentCfRule.colors as string[] | undefined) ?? [];
                        const mapCfvo = (v: {type: string; val?: string}): JsonObject => {
                            const t = v.type === 'min' || v.type === 'max' || v.type === 'percent' || v.type === 'percentile' || v.type === 'formula' ? v.type : 'num';
                            if (v.val === undefined) return {type: t};
                            if (t === 'formula') return {type: t, value: v.val.startsWith('=') ? v.val : `=${v.val}`};
                            const n = Number(v.val);
                            return {type: t, value: Number.isFinite(n) ? n : v.val};
                        };
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'colorScale',
                                config: cfvos.map((v, index) => ({
                                    index,
                                    color: colors[index] ?? '#ffffff',
                                    value: mapCfvo(v),
                                })),
                            },
                        });
                    } else if (currentCfRule.type === 'dataBar') {
                        const cfvos = (currentCfRule.cfvos as {type: string; val?: string}[] | undefined) ?? [];
                        const colors = (currentCfRule.colors as string[] | undefined) ?? [];
                        const mapCfvo = (v: {type: string; val?: string}): JsonObject => {
                            const t = v.type === 'min' || v.type === 'max' || v.type === 'percent' || v.type === 'percentile' || v.type === 'formula' ? v.type : 'num';
                            if (v.val === undefined) return {type: t};
                            if (t === 'formula') return {type: t, value: v.val.startsWith('=') ? v.val : `=${v.val}`};
                            const n = Number(v.val);
                            return {type: t, value: Number.isFinite(n) ? n : v.val};
                        };
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'dataBar',
                                isShowValue: currentCfRule.showValue !== false,
                                config: {
                                    min: mapCfvo(cfvos[0] ?? {type: 'min'}),
                                    max: mapCfvo(cfvos[1] ?? {type: 'max'}),
                                    isGradient: true,
                                    positiveColor: colors[0] ?? '#638ec6',
                                    nativeColor: '#ff5555',
                                },
                            },
                        });
                    } else if (currentCfRule.type === 'top10') {
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: 'rank',
                                isBottom: Boolean(currentCfRule.bottom),
                                isPercent: Boolean(currentCfRule.percent),
                                value: Number(currentCfRule.rank ?? 10),
                                style: styleObj,
                            },
                        });
                    } else if (currentCfRule.type === 'aboveAverage') {
                        const op = currentCfRule.aboveAverage === false
                            ? (currentCfRule.equalAverage ? 'lessThanOrEqual' : 'lessThan')
                            : (currentCfRule.equalAverage ? 'greaterThanOrEqual' : 'greaterThan');
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: 'average',
                                operator: op,
                                style: styleObj,
                            },
                        });
                    } else if (currentCfRule.type === 'uniqueValues' || currentCfRule.type === 'duplicateValues') {
                        cfRules.push({
                            cfId: `cf_${randomUUID().slice(0, 8)}`,
                            ranges,
                            stopIfTrue: currentCfRule.stopIfTrue,
                            rule: {
                                type: 'highlightCell',
                                subType: currentCfRule.type,
                                style: styleObj,
                            },
                        });
                    } else {
                        losses.push({
                            scope: 'sheet',
                            target: `${meta.name}:${currentCfSqref}`,
                            property: 'conditional_formatting',
                            status: 'lost',
                            reason: `unsupported_cf_rule_type:${currentCfRule.type}`,
                        });
                    }
                }
                currentCfRule = null;
            } else if (name === 'conditionalFormatting') {
                currentCfSqref = '';
            } else if (name === 'c' && currentCellRef) {
                const coord = parseCellRef(currentCellRef);
                if (coord) {
                    if (coord.row > maxRowSeen) maxRowSeen = coord.row;
                    if (coord.col > maxColSeen) maxColSeen = coord.col;
                    const cellObj: JsonObject = {};
                    const defaultStyle = parsedStyles.styles[0];
                    const styleKey = currentCellStyleIdx > 0 || defaultStyle?.bd || defaultStyle?.n
                        ? styleKeyForXf(currentCellStyleIdx)
                        : undefined;
                    if (styleKey) {
                        cellObj.s = styleKey;
                        sheetStyledKeys.add(styleKey);
                    }

                    let resolvedFormula: string | undefined;
                    if (fAttrs.type === 'shared' && fAttrs.si !== undefined) {
                        if (fText !== '') {
                            const {formula, stripped} = stripXlfn(fText);
                            if (stripped) {
                                diagnostics.push({code: 'xlfn_stripped', message: 'Stripped _xlfn. prefix from formula', target: `${meta.name}!${currentCellRef}`});
                            }
                            sharedFormulas.set(fAttrs.si, {baseRow: coord.row, baseCol: coord.col, formula});
                            resolvedFormula = formula;
                        } else {
                            const base = sharedFormulas.get(fAttrs.si);
                            if (base) {
                                resolvedFormula = shiftSharedFormula(base.formula, coord.row - base.baseRow, coord.col - base.baseCol);
                            }
                        }
                    } else if (fText !== '') {
                        const {formula, stripped} = stripXlfn(fText);
                        if (stripped) {
                            diagnostics.push({code: 'xlfn_stripped', message: 'Stripped _xlfn. prefix from formula', target: `${meta.name}!${currentCellRef}`});
                        }
                        resolvedFormula = formula;
                    }

                    let hadExternalRef = false;
                    if (resolvedFormula !== undefined) {
                        const unsafe = unsafeFormulaReason(resolvedFormula);
                        if (unsafe !== null) {
                            hadExternalRef = true;
                            losses.push({
                                scope: 'cell',
                                target: `${meta.name}!${currentCellRef}`,
                                property: 'formula',
                                status: 'lost',
                                reason: unsafe,
                            });
                            diagnostics.push({
                                code: unsafe,
                                message: unsafe === 'dde_link_stripped' ? 'Removed formula with a DDE link or program call' : 'Removed external workbook reference formula',
                                target: `${meta.name}!${currentCellRef}`,
                            });
                        } else {
                            cellObj.f = resolvedFormula.startsWith('=') ? resolvedFormula : `=${resolvedFormula}`;
                            sheetFormulaCount++;
                        }
                    }

                    if (!hadExternalRef) {
                        if (currentCellType === 's') {
                            const idx = Number(vText);
                            const str = Number.isSafeInteger(idx) ? sharedStrings[idx] : undefined;
                            if (str !== undefined) {
                                cellObj.t = 1;
                                cellObj.v = str.text;
                                if (str.runs && str.runs.length > 0) {
                                    cellObj.p = buildUniverRichTextDoc(str.text, str.runs);
                                }
                            }
                        } else if (currentCellType === 'inlineStr') {
                            cellObj.t = 1;
                            cellObj.v = isText;
                        } else if (currentCellType === 'str') {
                            cellObj.t = 1;
                            cellObj.v = vText;
                        } else if (currentCellType === 'b') {
                            cellObj.t = 3;
                            cellObj.v = vText === '1' || vText.toLowerCase() === 'true' ? 1 : 0;
                        } else if (currentCellType === 'e') {
                            cellObj.t = 1;
                            cellObj.v = vText;
                        } else if (currentCellType === 'd') {
                            const parsedMs = Date.parse(vText);
                            if (Number.isFinite(parsedMs)) {
                                // Convert ISO-8601 date to Excel 1900 serial (epoch 1899-12-30 UTC accounts for Lotus 1900 leap bug).
                                const excelEpochMs = Date.UTC(1899, 11, 30);
                                cellObj.t = 2;
                                cellObj.v = (parsedMs - excelEpochMs) / 86_400_000;
                            } else {
                                cellObj.t = 1;
                                cellObj.v = vText;
                            }
                        } else if (vText !== '') {
                            const num = Number(vText);
                            if (Number.isFinite(num)) {
                                const numFmtId = parsedStyles.numFmtIds[currentCellStyleIdx] ?? 0;
                                const numFmtPat = parsedStyles.numFmtPatterns[currentCellStyleIdx];
                                let adjusted = num;
                                if (isCalendarNumFmt(numFmtId, numFmtPat)) {
                                    if (wbMeta.date1904) {
                                        adjusted = num + EXCEL_1904_OFFSET_DAYS;
                                        diagnostics.push({
                                            code: 'date1904_shifted',
                                            message: `Shifted 1904 date serial (${num}) by +1462 to 1900 epoch (${adjusted}); 1900 leap-year serial 60 boundary accounted for`,
                                            target: `${meta.name}!${currentCellRef}`,
                                        });
                                    } else if (Math.trunc(num) === SERIAL_60_LEAP_BUG) {
                                        diagnostics.push({
                                            code: 'serial_60_leap_bug',
                                            message: 'Preserved Excel 1900 serial 60 (1900-02-29 Lotus compatibility date)',
                                            target: `${meta.name}!${currentCellRef}`,
                                        });
                                    }
                                }
                                cellObj.t = 2;
                                cellObj.v = adjusted;
                            }
                        }
                    } else {
                        cellObj.t = 1;
                        cellObj.v = '#REF!';
                    }

                    if (cellObj.v !== undefined || cellObj.f !== undefined || cellObj.s !== undefined) {
                        totalCells++;
                        sheetCellCount++;
                        if (totalCells > MAX_XLSX_CELLS) {
                            throw new ExchangeError('limit_exceeded', `Workbook cell count exceeds ${MAX_XLSX_CELLS}`);
                        }
                        const rKey = String(coord.row - 1);
                        cellData[rKey] ??= {};
                        cellData[rKey][String(coord.col - 1)] = cellObj;
                    }
                }
                currentCellRef = null;
            }
        });
        parser.write(sheetXml).close();

        for (const hl of pendingHyperlinks) {
            const coord = parseCellRef(hl.ref);
            if (!coord) continue;
            let url = '';
            if (hl.rId) {
                const rel = sheetRels.get(hl.rId);
                if (rel && /^(https?:\/\/|mailto:)/i.test(rel.target)) {
                    url = rel.target;
                }
            } else if (hl.location) {
                const bangIdx = hl.location.indexOf('!');
                const targetSheetName = bangIdx >= 0 ? hl.location.slice(0, bangIdx).replace(/^'|'$/g, '') : meta.name;
                const targetRange = bangIdx >= 0 ? hl.location.slice(bangIdx + 1) : hl.location;
                const targetMetaIdx = wbMeta.sheets.findIndex(s => s.name === targetSheetName);
                const targetGid = targetMetaIdx >= 0 ? `sheet_${targetMetaIdx + 1}` : sheetId;
                url = `#gid=${targetGid}&range=${targetRange}`;
            }
            if (!url) continue;
            hasHyperlinks = true;
            const rowKey = String(coord.row - 1);
            const colKey = String(coord.col - 1);
            const existingCell = cellData[rowKey]?.[colKey] ?? {};
            const cellText = String(existingCell.v ?? url);
            const existingDoc = existingCell.p as JsonObject | undefined;
            if (existingDoc && typeof existingDoc.body === 'object' && existingDoc.body !== null) {
                const body = existingDoc.body as JsonObject;
                const ranges = Array.isArray(body.customRanges) ? body.customRanges : [];
                ranges.push({
                    rangeId: `hl_${randomUUID()}`,
                    rangeType: 0,
                    startIndex: 0,
                    endIndex: Math.max(0, cellText.length - 1),
                    properties: {url, ...(hl.tooltip ? {tooltip: hl.tooltip} : {})},
                });
                body.customRanges = ranges;
            } else {
                existingCell.p = buildUniverRichTextDoc(cellText, [], {url, tooltip: hl.tooltip});
            }
            if (existingCell.v === undefined) {
                existingCell.t = 1;
                existingCell.v = cellText;
            }
            cellData[rowKey] ??= {};
            cellData[rowKey][colKey] = existingCell;
        }

        for (const rId of tablePartRIds) {
            const rel = sheetRels.get(rId);
            if (!rel) continue;
            const tablePath = rel.target.startsWith('../')
                ? `xl/${rel.target.slice(3)}`
                : rel.target.startsWith('/')
                    ? rel.target.slice(1)
                    : `xl/worksheets/${rel.target}`;
            const tableXml = archive.xmlTexts.get(tablePath);
            if (!tableXml) continue;
            knownEntries.add(tablePath);
            const parsedTable = parseTableXml(tableXml, sheetId);
            if (parsedTable) importedTables.push(parsedTable);
        }

        if (validations.length > 0) dataValidationsBySheet[sheetId] = validations;
        if (cfRules.length > 0) cfBySheet[sheetId] = cfRules;

        sheetOrder.push(sheetId);
        sheets[sheetId] = {
            id: sheetId,
            name: meta.name,
            rowCount: Math.max(100, maxRowSeen + 10),
            columnCount: Math.max(26, maxColSeen + 5),
            rowData,
            columnData,
            cellData,
            mergeData,
            showGridlines,
            freeze,
            hidden: 0,
            rightToLeft: 0,
            defaultColumnWidth: 88,
            defaultRowHeight: 24,
            zoomRatio: 1,
            scrollLeft: 0,
            scrollTop: 0,
            tabColor: '',
        };
        if (sheetProtection) {
            protectionRules.push({
                unitId,
                subUnitId: sheetId,
                permissionId: `prot_${sheetId}`,
                name: meta.name,
                sheetProtection,
            });
        }

        sheetSummaries.push({
            sheet_id: sheetId,
            name: meta.name,
            rows: maxRowSeen,
            columns: maxColSeen,
            cells: sheetCellCount,
            formulas: sheetFormulaCount,
            styles: sheetStyledKeys.size,
            merges: mergeData.length,
            validations: validations.length,
            conditional_formatting: cfRules.length,
        });
    }

    const definedNamesMap: Record<string, JsonObject> = {};
    let defPreserved = 0;
    let defLost = 0;
    for (const def of wbMeta.definedNames) {
        if (def.name.startsWith('_xlnm.') && def.name !== '_xlnm.Print_Area' && def.name !== '_xlnm.Print_Titles') {
            defLost++;
            losses.push({
                scope: 'workbook',
                target: def.name,
                property: 'defined_name',
                status: 'lost',
                reason: 'builtin_defined_name_unsupported',
            });
            continue;
        }
        const {formula, stripped} = stripXlfn(def.formula);
        if (stripped) {
            diagnostics.push({code: 'xlfn_stripped', message: 'Stripped _xlfn. from defined name formula', target: def.name});
        }
        const unsafeName = unsafeFormulaReason(formula);
        if (unsafeName !== null) {
            defLost++;
            losses.push({
                scope: 'workbook',
                target: def.name,
                property: 'defined_name',
                status: 'lost',
                reason: unsafeName,
            });
            diagnostics.push({
                code: unsafeName,
                message: unsafeName === 'dde_link_stripped' ? 'Removed DDE link or program call in defined name' : 'Removed external workbook reference in defined name',
                target: def.name,
            });
            continue;
        }
        const localSheetId = def.localSheetId !== undefined && sheetIdByIndex[def.localSheetId]
            ? sheetIdByIndex[def.localSheetId]
            : 'AllDefaultWorkbook';
        const id = `dn_${defPreserved + 1}`;
        definedNamesMap[id] = {
            id,
            name: def.name,
            formulaOrRefString: formula.startsWith('=') ? formula : `=${formula}`,
            localSheetId,
        };
        defPreserved++;
    }

    const resources: JsonObject[] = [];
    if (Object.keys(cfBySheet).length > 0) {
        resources.push({name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify(cfBySheet)});
    }
    if (Object.keys(dataValidationsBySheet).length > 0) {
        resources.push({name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify(dataValidationsBySheet)});
    }
    if (Object.keys(definedNamesMap).length > 0) {
        resources.push({name: 'SHEET_DEFINED_NAME_PLUGIN', data: JSON.stringify(definedNamesMap)});
    }
    if (hasHyperlinks) {
        resources.push({name: 'SHEET_HYPER_LINK_PLUGIN', data: '{}'});
    }
    if (Object.keys(filterBySheet).length > 0) {
        resources.push({name: 'SHEET_FILTER_PLUGIN', data: JSON.stringify(filterBySheet)});
    }
    if (protectionRules.length > 0) {
        resources.push({name: 'SHEET_WORKSHEET_PROTECTION_PLUGIN', data: JSON.stringify({[unitId]: protectionRules})});
    }

    const unknownParts: string[] = [];
    for (const entryName of archive.files.keys()) {
        if (knownEntries.has(entryName)) continue;
        if (KNOWN_OOXML_PREFIXES.some(prefix => entryName === prefix || entryName.startsWith(prefix))) continue;
        unknownParts.push(entryName);
        losses.push({
            scope: 'object',
            target: entryName,
            property: 'ooxml_part',
            status: 'lost',
            reason: 'unsupported_ooxml_part',
        });
    }
    for (const entryName of archive.files.keys()) {
        if (entryName.startsWith('xl/externalLinks/')) {
            unknownParts.push(entryName);
            losses.push({
                scope: 'object',
                target: entryName,
                property: 'external_link',
                status: 'lost',
                reason: 'external_ref_stripped',
            });
        }
    }

    const report: Omit<ExchangeReport, 'output_sha256'> = {
        format: 'xlsx',
        operation: 'import',
        source_sha256: sourceSha,
        date_system: wbMeta.date1904 ? '1904' : '1900',
        sheets: sheetSummaries,
        defined_names: {preserved: defPreserved, lost: defLost},
        losses,
        diagnostics,
        unknown_parts: unknownParts.sort(),
        editable_published: false,
    };
    const lossCount = losses.filter(entry => entry.status === 'lost').length;
    if (options.strict_profile === true && lossCount > 0) {
        throw new ExchangeError('unsupported_content', 'Strict profile refuses publishing lossy XLSX import as editable workbook', {
            reason: 'strict_profile_loss',
            loss_count: lossCount,
            report: report as unknown as JsonObject,
        });
    }

    const nativeInput: JsonObject = {
        id: unitId,
        name: typeof options.workbook_name === 'string' && options.workbook_name !== '' ? options.workbook_name : 'Workbook',
        appVersion: '1.5.2',
        locale: 'enUS',
        styles: univerStyles,
        resources,
        sheetOrder,
        sheets,
    };

    const timeoutMs = typeof options.calculation_timeout_ms === 'number' && Number.isSafeInteger(options.calculation_timeout_ms) && options.calculation_timeout_ms > 0
        ? Math.min(options.calculation_timeout_ms, 20_000)
        : 20_000;

    const session = UniverWorkbookSession.open(nativeInput);
    let savedNative: JsonObject;
    try {
        await session.settle(timeoutMs);
        savedNative = session.save();
    } finally {
        session.dispose();
    }

    if (hasHyperlinks) {
        const savedResources = Array.isArray(savedNative.resources) ? savedNative.resources as JsonObject[] : [];
        if (!savedResources.some(r => r && typeof r === 'object' && r.name === 'SHEET_HYPER_LINK_PLUGIN')) {
            savedResources.push({name: 'SHEET_HYPER_LINK_PLUGIN', data: '{}'});
            savedNative.resources = savedResources;
        }
    }

    const workbook: WorkbookV2 = {
        format_version: 2,
        profile: WIRE_PROFILE,
        native: savedNative,
        tables: importedTables,
    };
    const outputSha = sha256Canonical(workbook);

    return {
        workbook,
        report: {
            ...report,
            output_sha256: outputSha,
            editable_published: true,
        },
    };
}

export async function exportXlsx(workbook: WorkbookV2, options: JsonObject): Promise<ExportResult> {
    const sourceSha = sha256Canonical(workbook);
    const dateSystem: '1900' | '1904' = options.date_system === '1904' ? '1904' : '1900';
    const timeoutMs = typeof options.calculation_timeout_ms === 'number' && Number.isSafeInteger(options.calculation_timeout_ms) && options.calculation_timeout_ms > 0
        ? Math.min(options.calculation_timeout_ms, 20_000)
        : 20_000;

    const session = UniverWorkbookSession.open(workbook.native);
    let native: JsonObject;
    try {
        await session.settle(timeoutMs);
        native = session.save();
    } finally {
        session.dispose();
    }

    const unitId = typeof native.id === 'string' ? native.id : 'workbook';
    const sheetOrder = Array.isArray(native.sheetOrder) ? native.sheetOrder.filter((id): id is string => typeof id === 'string') : [];
    const sheetsMap = (native.sheets && typeof native.sheets === 'object' && !Array.isArray(native.sheets))
        ? native.sheets as Record<string, JsonObject>
        : {};
    if (sheetOrder.length === 0) {
        throw new ExchangeError('unknown_target', 'Workbook has no sheets to export');
    }

    const stylesMap = (native.styles && typeof native.styles === 'object' && !Array.isArray(native.styles))
        ? native.styles as Record<string, UniverStyle>
        : {};
    const resourcesArr = Array.isArray(native.resources) ? native.resources as JsonObject[] : [];
    const parseResource = (name: string): Record<string, unknown> => {
        const found = resourcesArr.find(item => item?.name === name);
        if (!found || typeof found.data !== 'string' || found.data === '' || found.data === '{}') return {};
        try {
            return JSON.parse(found.data) as Record<string, unknown>;
        } catch {
            return {};
        }
    };

    const cfAll = parseResource('SHEET_CONDITIONAL_FORMATTING_PLUGIN') as Record<string, JsonObject[]>;
    const dvAll = parseResource('SHEET_DATA_VALIDATION_PLUGIN') as Record<string, JsonObject[]>;
    const dnAll = parseResource('SHEET_DEFINED_NAME_PLUGIN') as Record<string, JsonObject>;
    const filterAll = parseResource('SHEET_FILTER_PLUGIN') as Record<string, JsonObject>;

    const losses: ExchangeLossEntry[] = [];
    const diagnostics: ExchangeDiagnostic[] = [];
    // A formula another application would act on when the file is opened (a DDE link, a program
    // call, a link into another workbook) is not written; the report names what was left out.
    const refuseFormula = (formulas: readonly string[], scope: ExchangeLossEntry['scope'], target: string, property: string): boolean => {
        const reason = formulas.map(unsafeFormulaReason).find(found => found !== null) ?? null;
        if (reason === null) return false;
        losses.push({scope, target, property, status: 'lost', reason});
        diagnostics.push({code: reason, message: `Left out ${property.replaceAll('_', ' ')} the file would act on when opened`, target});
        return true;
    };
    if (dateSystem === '1904') {
        diagnostics.push({
            code: 'date1904_exported',
            message: 'Exported workbook with date1904="1" epoch (-1462 days applied to date serials)',
        });
    }

    const sharedStrings: string[] = [];
    const sharedStringIndex = new Map<string, number>();
    const internString = (text: string): number => {
        const found = sharedStringIndex.get(text);
        if (found !== undefined) return found;
        const idx = sharedStrings.length;
        sharedStrings.push(text);
        sharedStringIndex.set(text, idx);
        return idx;
    };

    const numFmtsList: {id: number; code: string}[] = [];
    const numFmtIdByCode = new Map<string, number>();
    for (const [idStr, code] of Object.entries(BUILTIN_NUMFMTS)) {
        numFmtIdByCode.set(code, Number(idStr));
    }
    let nextCustomNumFmtId = 164;
    const ensureNumFmt = (pattern: string | undefined): number => {
        if (!pattern || pattern === 'General') return 0;
        const existing = numFmtIdByCode.get(pattern);
        if (existing !== undefined) return existing;
        const id = nextCustomNumFmtId++;
        numFmtIdByCode.set(pattern, id);
        numFmtsList.push({id, code: pattern});
        return id;
    };

    const fontsXml: string[] = ['<font><sz val="11"/><name val="Calibri"/></font>'];
    const fontIdxByKey = new Map<string, number>([['default', 0]]);
    const ensureFont = (st: UniverStyle): number => {
        const cl = rgbHexForOoxml(st.cl?.rgb);
        const key = JSON.stringify([st.ff ?? null, st.fs ?? null, st.bl ?? 0, st.it ?? 0, st.ul?.s ?? 0, st.st?.s ?? 0, cl ?? null]);
        const existing = fontIdxByKey.get(key);
        if (existing !== undefined) return existing;
        const parts: string[] = [];
        if (st.bl === 1) parts.push('<b/>');
        if (st.it === 1) parts.push('<i/>');
        if (st.ul?.s === 1) parts.push('<u/>');
        if (st.st?.s === 1) parts.push('<strike/>');
        parts.push(`<sz val="${st.fs ?? 11}"/>`);
        if (cl) parts.push(`<color rgb="${cl}"/>`);
        parts.push(`<name val="${escapeXml(st.ff ?? 'Calibri')}"/>`);
        const idx = fontsXml.length;
        fontsXml.push(`<font>${parts.join('')}</font>`);
        fontIdxByKey.set(key, idx);
        return idx;
    };

    const fillsXml: string[] = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
    ];
    const fillIdxByKey = new Map<string, number>([['none', 0], ['gray125', 1]]);
    const ensureFill = (st: UniverStyle): number => {
        const bg = rgbHexForOoxml(st.bg?.rgb);
        if (!bg) return 0;
        const existing = fillIdxByKey.get(bg);
        if (existing !== undefined) return existing;
        const idx = fillsXml.length;
        fillsXml.push(`<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`);
        fillIdxByKey.set(bg, idx);
        return idx;
    };

    const bordersXml: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const borderIdxByKey = new Map<string, number>([['none', 0]]);
    const ensureBorder = (st: UniverStyle, styleKey: string): number => {
        if (!st.bd || Object.keys(st.bd).length === 0) return 0;
        const key = JSON.stringify(st.bd);
        const existing = borderIdxByKey.get(key);
        if (existing !== undefined) return existing;
        const sidesXml = new Map(Array.from(BORDER_SIDES.values(), side => [side, '']));
        for (const [side, entry] of Object.entries(st.bd)) {
            if (!entry || entry.s === BorderStyleTypes.NONE) continue;
            const style = OOXML_BORDER_STYLES.get(entry.s);
            if (style && sidesXml.has(side)) {
                const cl = rgbHexForOoxml(entry.cl?.rgb) ?? 'FF000000';
                sidesXml.set(side, ` style="${style}"><color rgb="${cl}"/>`);
            } else {
                losses.push({
                    scope: 'object', target: `${styleKey}:${side}`, property: 'border',
                    status: 'lost', reason: 'unsupported_univer_border',
                });
            }
        }
        const sides = Array.from(BORDER_SIDES, ([tag, side]) => {
            const styleXml = sidesXml.get(side);
            return styleXml ? `<${tag}${styleXml}</${tag}>` : `<${tag}/>`;
        });
        const idx = bordersXml.length;
        bordersXml.push(`<border>${sides.join('')}<diagonal/></border>`);
        borderIdxByKey.set(key, idx);
        return idx;
    };

    const xfsXml: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const xfIdxByStyleKey = new Map<string, number>();
    const xfDateFlags: boolean[] = [false];

    const ensureXf = (styleKey: string | undefined): {idx: number; isDate: boolean} => {
        if (!styleKey) return {idx: 0, isDate: false};
        const existing = xfIdxByStyleKey.get(styleKey);
        if (existing !== undefined) return {idx: existing, isDate: xfDateFlags[existing] ?? false};
        const st = stylesMap[styleKey];
        if (!st) return {idx: 0, isDate: false};
        const numFmtId = ensureNumFmt(st.n?.pattern);
        const fontId = ensureFont(st);
        const fillId = ensureFill(st);
        const borderId = ensureBorder(st, styleKey);
        const isDate = isCalendarNumFmt(numFmtId, st.n?.pattern);
        const alignParts: string[] = [];
        if (st.ht === 1) alignParts.push('horizontal="left"');
        else if (st.ht === 2) alignParts.push('horizontal="center"');
        else if (st.ht === 3) alignParts.push('horizontal="right"');
        if (st.vt === 1) alignParts.push('vertical="top"');
        else if (st.vt === 2) alignParts.push('vertical="center"');
        else if (st.vt === 3) alignParts.push('vertical="bottom"');
        if (st.tb === 3) alignParts.push('wrapText="1"');
        const alignXml = alignParts.length > 0 ? `<alignment ${alignParts.join(' ')}/>` : '';
        const idx = xfsXml.length;
        xfsXml.push(
            `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${alignXml ? ' applyAlignment="1"' : ''}>${alignXml}</xf>`,
        );
        xfIdxByStyleKey.set(styleKey, idx);
        xfDateFlags[idx] = isDate;
        return {idx, isDate};
    };

    const dxfsXml: string[] = [];
    const ensureDxf = (st: UniverStyle | undefined): number => {
        const parts: string[] = [];
        if (st) {
            const cl = rgbHexForOoxml(st.cl?.rgb);
            if (st.bl === 1 || st.it === 1 || st.ul?.s === 1 || st.st?.s === 1 || cl) {
                parts.push('<font>');
                if (st.bl === 1) parts.push('<b/>');
                if (st.it === 1) parts.push('<i/>');
                if (st.ul?.s === 1) parts.push('<u/>');
                if (st.st?.s === 1) parts.push('<strike/>');
                if (cl) parts.push(`<color rgb="${cl}"/>`);
                parts.push('</font>');
            }
            const bg = rgbHexForOoxml(st.bg?.rgb);
            if (bg) {
                parts.push(`<fill><patternFill><bgColor rgb="${bg}"/></patternFill></fill>`);
            }
        }
        const idx = dxfsXml.length;
        dxfsXml.push(`<dxf>${parts.join('')}</dxf>`);
        return idx;
    };

    const zipEntries: Record<string, Uint8Array> = {};
    const encoder = new TextEncoder();
    const workbookSheetsXml: string[] = [];
    const workbookRelsXml: string[] = [];
    const tableContentTypeOverrides: string[] = [];
    let tableExportCounter = 1;
    const contentTypeOverrides: string[] = [];
    const sheetSummaries: SheetExchangeSummary[] = [];

    for (let sIdx = 0; sIdx < sheetOrder.length; sIdx++) {
        const sheetId = sheetOrder[sIdx];
        const sheet = sheetsMap[sheetId];
        if (!sheet) continue;
        const sheetName = typeof sheet.name === 'string' ? sheet.name : sheetId;
        const sheetFileName = `sheet${sIdx + 1}.xml`;
        const rId = `rId${sIdx + 1}`;
        workbookSheetsXml.push(`<sheet name="${escapeXml(sheetName)}" sheetId="${sIdx + 1}" r:id="${rId}"/>`);
        workbookRelsXml.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${sheetFileName}"/>`);
        contentTypeOverrides.push(`<Override PartName="/xl/worksheets/${sheetFileName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);

        const cellData = (sheet.cellData && typeof sheet.cellData === 'object' && !Array.isArray(sheet.cellData))
            ? sheet.cellData as Record<string, Record<string, JsonObject>>
            : {};
        const rowIndices = Object.keys(cellData).map(Number).filter(n => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);

        let maxRowSeen = 0;
        let maxColSeen = 0;
        let sheetCellCount = 0;
        let sheetFormulaCount = 0;
        const styledKeys = new Set<string>();
        const rowsXml: string[] = [];

        const rowMeta = (sheet.rowData && typeof sheet.rowData === 'object' && !Array.isArray(sheet.rowData))
            ? sheet.rowData as Record<string, JsonObject>
            : {};

        for (const r of rowIndices) {
            const rowObj = cellData[String(r)];
            if (!rowObj || typeof rowObj !== 'object') continue;
            const colIndices = Object.keys(rowObj).map(Number).filter(n => Number.isSafeInteger(n) && n >= 0).sort((a, b) => a - b);
            const cellsXml: string[] = [];
            for (const c of colIndices) {
                const cell = rowObj[String(c)];
                if (!cell || typeof cell !== 'object') continue;
                const coordRef = `${columnLetters(c + 1)}${r + 1}`;
                if (r + 1 > maxRowSeen) maxRowSeen = r + 1;
                if (c + 1 > maxColSeen) maxColSeen = c + 1;

                const styleKey = typeof cell.s === 'string' ? cell.s : undefined;
                if (styleKey) styledKeys.add(styleKey);
                const {idx: xfIdx, isDate} = ensureXf(styleKey);
                const sAttr = xfIdx > 0 ? ` s="${xfIdx}"` : '';

                const formulaText = typeof cell.f === 'string' && cell.f !== '' ? cell.f : undefined;
                const formulaRaw = formulaText !== undefined && !refuseFormula([formulaText], 'cell', `${sheetName}!${coordRef}`, 'formula') ? formulaText : undefined;
                const formulaXml = formulaRaw ? `<f>${escapeXml(formulaRaw.startsWith('=') ? formulaRaw.slice(1) : formulaRaw)}</f>` : '';
                if (formulaRaw) sheetFormulaCount++;

                let cellTypeAttr = '';
                let valXml = '';
                if (cell.v !== undefined && cell.v !== null) {
                    if (cell.t === 3) {
                        cellTypeAttr = ' t="b"';
                        valXml = `<v>${cell.v === 1 || cell.v === true ? '1' : '0'}</v>`;
                    } else if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
                        let outNum = cell.v;
                        if (dateSystem === '1904' && isDate && !formulaRaw) {
                            outNum = cell.v - EXCEL_1904_OFFSET_DAYS;
                        }
                        valXml = `<v>${String(outNum)}</v>`;
                    } else if (typeof cell.v === 'string') {
                        if (formulaRaw) {
                            cellTypeAttr = ' t="str"';
                            valXml = `<v>${escapeXml(cell.v)}</v>`;
                        } else {
                            const sIdxStr = internString(cell.v);
                            cellTypeAttr = ' t="s"';
                            valXml = `<v>${sIdxStr}</v>`;
                        }
                    }
                }
                if (formulaXml === '' && valXml === '' && sAttr === '') continue;
                sheetCellCount++;
                cellsXml.push(`<c r="${coordRef}"${sAttr}${cellTypeAttr}>${formulaXml}${valXml}</c>`);
            }
            if (cellsXml.length > 0) {
                const rm = rowMeta[String(r)];
                const htAttr = typeof rm?.h === 'number' && rm.h > 0 ? ` ht="${(rm.h / 1.333).toFixed(2)}" customHeight="1"` : '';
                const hdAttr = rm?.hd === 1 ? ' hidden="1"' : '';
                rowsXml.push(`<row r="${r + 1}"${htAttr}${hdAttr}>${cellsXml.join('')}</row>`);
            }
        }

        const merges = Array.isArray(sheet.mergeData) ? sheet.mergeData as JsonObject[] : [];
        const mergesXml = merges.length > 0
            ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${formatRangeA1({
                startRow: Number(m.startRow ?? 0),
                startColumn: Number(m.startColumn ?? 0),
                endRow: Number(m.endRow ?? 0),
                endColumn: Number(m.endColumn ?? 0),
            })}"/>`).join('')}</mergeCells>`
            : '';

        const sheetCf = Array.isArray(cfAll[sheetId]) ? cfAll[sheetId] : [];
        const cfXmlParts: string[] = [];
        for (const item of sheetCf) {
            const ranges = Array.isArray(item.ranges) ? item.ranges as JsonObject[] : [];
            const sqref = ranges.map(r => formatRangeA1({
                startRow: Number(r.startRow ?? 0),
                startColumn: Number(r.startColumn ?? 0),
                endRow: Number(r.endRow ?? 0),
                endColumn: Number(r.endColumn ?? 0),
            })).join(' ');
            const rule = item.rule as JsonObject | undefined;
            if (!sqref || !rule) continue;
            if (rule.subType !== 'text' && refuseFormula(cfFormulaTexts(rule), 'sheet', `${sheetName}:${sqref}`, 'conditional_formatting')) continue;
            const dxfId = ensureDxf(rule.style as UniverStyle | undefined);
            const priority = cfXmlParts.length + 1;
            const stop = item.stopIfTrue === true ? ' stopIfTrue="1"' : '';
            if (rule.type === 'colorScale') {
                const config = Array.isArray(rule.config) ? rule.config as JsonObject[] : [];
                const cfvosXml = config.map(item => {
                    const valObj = (item.value ?? {}) as JsonObject;
                    const t = String(valObj.type ?? 'num');
                    const vAttr = valObj.value !== undefined ? ` val="${escapeXml(String(valObj.value).replace(/^=/, ''))}"` : '';
                    return `<cfvo type="${escapeXml(t)}"${vAttr}/>`;
                }).join('');
                const colorsXml = config.map(item => {
                    const rgb = rgbHexForOoxml(typeof item.color === 'string' ? item.color : undefined) ?? 'FFFFFFFF';
                    return `<color rgb="${rgb}"/>`;
                }).join('');
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="colorScale" priority="${priority}"${stop}><colorScale>${cfvosXml}${colorsXml}</colorScale></cfRule></conditionalFormatting>`);
            } else if (rule.type === 'dataBar') {
                const cfg = (rule.config ?? {}) as JsonObject;
                const minObj = (cfg.min ?? {type: 'min'}) as JsonObject;
                const maxObj = (cfg.max ?? {type: 'max'}) as JsonObject;
                const minXml = `<cfvo type="${escapeXml(String(minObj.type ?? 'min'))}"${minObj.value !== undefined ? ` val="${escapeXml(String(minObj.value).replace(/^=/, ''))}"` : ''}/>`;
                const maxXml = `<cfvo type="${escapeXml(String(maxObj.type ?? 'max'))}"${maxObj.value !== undefined ? ` val="${escapeXml(String(maxObj.value).replace(/^=/, ''))}"` : ''}/>`;
                const posRgb = rgbHexForOoxml(typeof cfg.positiveColor === 'string' ? cfg.positiveColor : undefined) ?? 'FF638EC6';
                const showValAttr = rule.isShowValue === false ? ' showValue="0"' : '';
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="dataBar" priority="${priority}"${stop}><dataBar${showValAttr}>${minXml}${maxXml}<color rgb="${posRgb}"/></dataBar></cfRule></conditionalFormatting>`);
            } else if (rule.subType === 'rank') {
                const rankVal = Number(rule.value ?? 10);
                const bottomAttr = rule.isBottom ? ' bottom="1"' : '';
                const percentAttr = rule.isPercent ? ' percent="1"' : '';
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="top10" dxfId="${dxfId}" priority="${priority}"${stop} rank="${rankVal}"${bottomAttr}${percentAttr}/></conditionalFormatting>`);
            } else if (rule.subType === 'average') {
                const op = String(rule.operator ?? 'greaterThan');
                const aboveAttr = op.startsWith('less') ? ' aboveAverage="0"' : '';
                const equalAttr = op.endsWith('OrEqual') ? ' equalAverage="1"' : '';
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="aboveAverage" dxfId="${dxfId}" priority="${priority}"${stop}${aboveAttr}${equalAttr}/></conditionalFormatting>`);
            } else if (rule.subType === 'uniqueValues' || rule.subType === 'duplicateValues') {
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="${rule.subType}" dxfId="${dxfId}" priority="${priority}"${stop}/></conditionalFormatting>`);
            } else if (rule.subType === 'formula') {
                const expr = String(rule.value ?? '');
                const formula = expr.startsWith('=') ? expr.slice(1) : expr;
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="expression" dxfId="${dxfId}" priority="${priority}"${stop}><formula>${escapeXml(formula)}</formula></cfRule></conditionalFormatting>`);
            } else if (rule.subType === 'text') {
                const op = String(rule.operator ?? 'containsText');
                const val = String(rule.value ?? '');
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="${escapeXml(op)}" operator="${escapeXml(op)}" text="${escapeXml(val)}" dxfId="${dxfId}" priority="${priority}"${stop}/></conditionalFormatting>`);
            } else {
                const op = String(rule.operator ?? 'greaterThan');
                const vals = Array.isArray(rule.value) ? rule.value : [rule.value ?? 0];
                const formulas = vals.map(v => `<formula>${escapeXml(String(v))}</formula>`).join('');
                cfXmlParts.push(`<conditionalFormatting sqref="${escapeXml(sqref)}"><cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="${escapeXml(op)}"${stop}>${formulas}</cfRule></conditionalFormatting>`);
            }
        }

        const sheetDvs = Array.isArray(dvAll[sheetId]) ? dvAll[sheetId] : [];
        const stdDvXml: string[] = [];
        const x14DvXml: string[] = [];
        for (const dv of sheetDvs) {
            const ranges = Array.isArray(dv.ranges) ? dv.ranges as JsonObject[] : [];
            const sqref = ranges.map(r => formatRangeA1({
                startRow: Number(r.startRow ?? 0),
                startColumn: Number(r.startColumn ?? 0),
                endRow: Number(r.endRow ?? 0),
                endColumn: Number(r.endColumn ?? 0),
            })).join(' ');
            if (!sqref) continue;
            const dvType = String(dv.type ?? 'any');
            const opAttr = dv.operator ? ` operator="${escapeXml(String(dv.operator))}"` : '';
            let f1 = typeof dv.formula1 === 'string' ? dv.formula1 : '';
            if (dvType === 'list' && f1.startsWith('[')) {
                try {
                    const parsed = JSON.parse(f1) as unknown[];
                    f1 = `"${parsed.map(String).join(',').replaceAll('"', '""')}"`;
                } catch {
                    // Keep raw formula1.
                }
            } else if (f1.startsWith(`=[${unitId}]`)) {
                f1 = f1.slice(`=[${unitId}]`.length);
            } else if (f1.startsWith('=')) {
                f1 = f1.slice(1);
            }
            const f2 = typeof dv.formula2 === 'string' ? dv.formula2 : '';
            const listed = dvType === 'list' && f1.startsWith('"');
            if (refuseFormula(listed ? [f2] : [f1, f2], 'object', `${sheetName}!${sqref}`, dvType === 'list' ? 'list_validation' : 'data_validation')) continue;
            const isCrossSheetRange = dvType === 'list' && f1.includes('!') && !f1.startsWith('"');
            if (isCrossSheetRange) {
                x14DvXml.push(
                    `<x14:dataValidation type="${escapeXml(dvType)}"${opAttr}><x14:formula1><xm:f>${escapeXml(f1)}</xm:f></x14:formula1>${f2 ? `<x14:formula2><xm:f>${escapeXml(f2)}</xm:f></x14:formula2>` : ''}<xm:sqref>${escapeXml(sqref)}</xm:sqref></x14:dataValidation>`,
                );
            } else {
                stdDvXml.push(
                    `<dataValidation type="${escapeXml(dvType)}"${opAttr} sqref="${escapeXml(sqref)}">${f1 ? `<formula1>${escapeXml(f1)}</formula1>` : ''}${f2 ? `<formula2>${escapeXml(f2)}</formula2>` : ''}</dataValidation>`,
                );
            }
        }
        const stdDvsBlock = stdDvXml.length > 0 ? `<dataValidations count="${stdDvXml.length}">${stdDvXml.join('')}</dataValidations>` : '';
        const x14DvsBlock = x14DvXml.length > 0
            ? `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="${x14DvXml.length}" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${x14DvXml.join('')}</x14:dataValidations></ext></extLst>`
            : '';

        const filterObj = filterAll[sheetId];
        const filterRef = filterObj?.ref as JsonObject | undefined;
        let autoFilterXml = '';
        if (filterRef) {
            const filterRefA1 = formatRangeA1({
                startRow: Number(filterRef.startRow ?? 0),
                startColumn: Number(filterRef.startColumn ?? 0),
                endRow: Number(filterRef.endRow ?? 0),
                endColumn: Number(filterRef.endColumn ?? 0),
            });
            const baseStartCol = Number(filterRef.startColumn ?? 0);
            const filterCols = Array.isArray(filterObj?.filterColumns) ? filterObj.filterColumns as JsonObject[] : [];
            const filterColsXml = filterCols.map(fc => {
                const relColId = Math.max(0, Number(fc.colId ?? 0) - baseStartCol);
                if (fc.filters && typeof fc.filters === 'object' && Array.isArray((fc.filters as JsonObject).filters)) {
                    const vals = ((fc.filters as JsonObject).filters as unknown[]).map(v => `<filter val="${escapeXml(String(v))}"/>`).join('');
                    return `<filterColumn colId="${relColId}"><filters>${vals}</filters></filterColumn>`;
                }
                if (fc.customFilters && typeof fc.customFilters === 'object' && Array.isArray((fc.customFilters as JsonObject).customFilters)) {
                    const cfObj = fc.customFilters as JsonObject;
                    const andAttr = cfObj.and ? ' and="1"' : '';
                    const items = (cfObj.customFilters as JsonObject[]).map(item =>
                        `<customFilter operator="${escapeXml(String(item.operator ?? 'equal'))}" val="${escapeXml(String(item.val ?? ''))}"/>`,
                    ).join('');
                    return `<filterColumn colId="${relColId}"><customFilters${andAttr}>${items}</customFilters></filterColumn>`;
                }
                return '';
            }).filter(Boolean).join('');
            autoFilterXml = filterColsXml
                ? `<autoFilter ref="${escapeXml(filterRefA1)}">${filterColsXml}</autoFilter>`
                : `<autoFilter ref="${escapeXml(filterRefA1)}"/>`;
        }

        const freezeObj = sheet.freeze as JsonObject | undefined;
        const xSplit = Number(freezeObj?.xSplit ?? 0);
        const ySplit = Number(freezeObj?.ySplit ?? 0);
        const gridAttr = sheet.showGridlines === 0 ? ' showGridLines="0"' : '';
        const paneXml = xSplit > 0 || ySplit > 0
            ? `<pane xSplit="${xSplit}" ySplit="${ySplit}" topLeftCell="${columnLetters(xSplit + 1)}${ySplit + 1}" state="frozen"/>`
            : '';
        const sheetViewsXml = gridAttr || paneXml
            ? `<sheetViews><sheetView workbookViewId="0"${gridAttr}>${paneXml}</sheetView></sheetViews>`
            : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

        const colMeta = (sheet.columnData && typeof sheet.columnData === 'object' && !Array.isArray(sheet.columnData))
            ? sheet.columnData as Record<string, JsonObject>
            : {};
        const colXmlItems = Object.entries(colMeta)
            .map(([k, v]) => ({col: Number(k) + 1, w: typeof v?.w === 'number' ? v.w / 8 : 0, hd: v?.hd === 1}))
            .filter(item => Number.isSafeInteger(item.col) && item.col >= 1 && (item.w > 0 || item.hd))
            .sort((a, b) => a.col - b.col)
            .map(item => `<col min="${item.col}" max="${item.col}"${item.w > 0 ? ` width="${item.w.toFixed(2)}" customWidth="1"` : ''}${item.hd ? ' hidden="1"' : ''}/>`);
        const colsXml = colXmlItems.length > 0 ? `<cols>${colXmlItems.join('')}</cols>` : '';

        const protAll = parseResource('SHEET_WORKSHEET_PROTECTION_PLUGIN');
        let sheetProtectionXml = '';
        const protRules = Array.isArray(protAll[unitId]) ? protAll[unitId] as JsonObject[] : Object.values(protAll).flat().filter((x): x is JsonObject => Boolean(x && typeof x === 'object'));
        const matchedProt = protRules.find(r => r.subUnitId === sheetId);
        if (matchedProt && matchedProt.sheetProtection && typeof matchedProt.sheetProtection === 'object') {
            const sp = matchedProt.sheetProtection as JsonObject;
            sheetProtectionXml = `<sheetProtection sheet="${sp.sheet === false ? '0' : '1'}"` +
                `${sp.objects ? ' objects="1"' : ''}` +
                `${sp.scenarios ? ' scenarios="1"' : ''}` +
                `${sp.formatCells === false ? ' formatCells="0"' : ''}` +
                `${sp.formatColumns === false ? ' formatColumns="0"' : ''}` +
                `${sp.formatRows === false ? ' formatRows="0"' : ''}` +
                `${sp.insertColumns === false ? ' insertColumns="0"' : ''}` +
                `${sp.insertRows === false ? ' insertRows="0"' : ''}` +
                `${sp.deleteColumns === false ? ' deleteColumns="0"' : ''}` +
                `${sp.deleteRows === false ? ' deleteRows="0"' : ''}` +
                `${sp.sort === false ? ' sort="0"' : ''}` +
                `${sp.autoFilter === false ? ' autoFilter="0"' : ''}/>`;
        }

        const sheetRelsEntries: string[] = [];
        const hyperlinkXmlParts: string[] = [];
        for (const [rKey, rowObj] of Object.entries(cellData)) {
            const rNum = Number(rKey);
            if (!Number.isSafeInteger(rNum) || rNum < 0 || !rowObj || typeof rowObj !== 'object') continue;
            for (const [cKey, cell] of Object.entries(rowObj)) {
                const cNum = Number(cKey);
                if (!Number.isSafeInteger(cNum) || cNum < 0 || !cell || typeof cell !== 'object') continue;
                const p = cell.p as JsonObject | undefined;
                const body = p?.body as JsonObject | undefined;
                const customRanges = Array.isArray(body?.customRanges) ? body.customRanges as JsonObject[] : [];
                for (const cr of customRanges) {
                    if (cr.rangeType !== 0 || !cr.properties || typeof cr.properties !== 'object') continue;
                    const props = cr.properties as JsonObject;
                    const url = typeof props.url === 'string' ? props.url : '';
                    if (!url) continue;
                    const coordRef = `${columnLetters(cNum + 1)}${rNum + 1}`;
                    const tooltipAttr = typeof props.tooltip === 'string' && props.tooltip ? ` tooltip="${escapeXml(props.tooltip)}"` : '';
                    if (url.startsWith('#gid=')) {
                        const m = /^#gid=([^&]+)&range=(.+)$/.exec(url);
                        if (m) {
                            const targetSheet = sheetsMap[m[1]];
                            const targetName = typeof targetSheet?.name === 'string' ? targetSheet.name : m[1];
                            hyperlinkXmlParts.push(`<hyperlink ref="${coordRef}" location="${escapeXml(`${targetName}!${m[2]}`)}"${tooltipAttr}/>`);
                        }
                    } else if (/^(https?:\/\/|mailto:)/i.test(url)) {
                        const rId = `rId${sheetRelsEntries.length + 1}`;
                        sheetRelsEntries.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`);
                        hyperlinkXmlParts.push(`<hyperlink ref="${coordRef}" r:id="${rId}"${tooltipAttr}/>`);
                    }
                }
            }
        }
        const hyperlinksXml = hyperlinkXmlParts.length > 0 ? `<hyperlinks>${hyperlinkXmlParts.join('')}</hyperlinks>` : '';

        const sheetTables = Array.isArray(workbook.tables)
            ? workbook.tables.filter(t => t.sheet_id === sheetId)
            : [];
        const tablePartXmlParts: string[] = [];
        for (const tbl of sheetTables) {
            const tableNum = tableExportCounter++;
            const startRow = Math.max(0, tbl.header_row - 1);
            const endRow = tbl.rows.length > 0 ? Math.max(startRow, ...tbl.rows.map(r => r.row - 1)) : startRow;
            const startCol = tbl.columns.length > 0 ? Math.max(0, Math.min(...tbl.columns.map(c => c.column - 1))) : 0;
            const endCol = tbl.columns.length > 0 ? Math.max(startCol, ...tbl.columns.map(c => c.column - 1)) : 0;
            const refA1 = formatRangeA1({startRow, startColumn: startCol, endRow, endColumn: endCol});
            const safeName = tbl.table_id.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^[^A-Za-z_]/, 'T_');
            const colsXmlInner = tbl.columns.map((c, idx) =>
                `<tableColumn id="${idx + 1}" name="${escapeXml(c.column_id)}"/>`,
            ).join('');
            const tableXml =
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableNum}" name="${escapeXml(safeName)}" displayName="${escapeXml(safeName)}" ref="${escapeXml(refA1)}" totalsRowShown="0">` +
                `<autoFilter ref="${escapeXml(refA1)}"/>` +
                `<tableColumns count="${tbl.columns.length}">${colsXmlInner}</tableColumns>` +
                '</table>';
            zipEntries[`xl/tables/table${tableNum}.xml`] = encoder.encode(tableXml);
            tableContentTypeOverrides.push(`<Override PartName="/xl/tables/table${tableNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`);
            const rId = `rId${sheetRelsEntries.length + 1}`;
            sheetRelsEntries.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableNum}.xml"/>`);
            tablePartXmlParts.push(`<tablePart r:id="${rId}"/>`);
        }
        const tablePartsXml = tablePartXmlParts.length > 0 ? `<tableParts count="${tablePartXmlParts.length}">${tablePartXmlParts.join('')}</tableParts>` : '';

        if (sheetRelsEntries.length > 0) {
            zipEntries[`xl/worksheets/_rels/${sheetFileName}.rels`] = encoder.encode(
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRelsEntries.join('')}</Relationships>`,
            );
        }

        const sheetXml =
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            sheetViewsXml +
            colsXml +
            `<sheetData>${rowsXml.join('')}</sheetData>` +
            sheetProtectionXml +
            autoFilterXml +
            mergesXml +
            cfXmlParts.join('') +
            stdDvsBlock +
            hyperlinksXml +
            x14DvsBlock +
            tablePartsXml +
            '</worksheet>';

        zipEntries[`xl/worksheets/${sheetFileName}`] = encoder.encode(sheetXml);

        sheetSummaries.push({
            sheet_id: sheetId,
            name: sheetName,
            rows: maxRowSeen,
            columns: maxColSeen,
            cells: sheetCellCount,
            formulas: sheetFormulaCount,
            styles: styledKeys.size,
            merges: merges.length,
            validations: sheetDvs.length,
            conditional_formatting: sheetCf.length,
        });
    }

    const definedNameEntries = Object.values(dnAll);
    const definedNamesXmlParts: string[] = [];
    let defPreserved = 0;
    for (const dn of definedNameEntries) {
        const name = typeof dn.name === 'string' ? dn.name : '';
        const expr = typeof dn.formulaOrRefString === 'string' ? dn.formulaOrRefString : '';
        if (!name || !expr) continue;
        if (refuseFormula([expr], 'workbook', name, 'defined_name')) continue;
        const localSheetId = typeof dn.localSheetId === 'string' && dn.localSheetId !== 'AllDefaultWorkbook'
            ? sheetOrder.indexOf(dn.localSheetId)
            : -1;
        const localAttr = localSheetId >= 0 ? ` localSheetId="${localSheetId}"` : '';
        definedNamesXmlParts.push(`<definedName name="${escapeXml(name)}"${localAttr}>${escapeXml(expr.startsWith('=') ? expr.slice(1) : expr)}</definedName>`);
        defPreserved++;
    }
    const definedNamesXml = definedNamesXmlParts.length > 0 ? `<definedNames>${definedNamesXmlParts.join('')}</definedNames>` : '';

    const stylesRid = `rId${sheetOrder.length + 1}`;
    const stringsRid = `rId${sheetOrder.length + 2}`;
    workbookRelsXml.push(
        `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
        `<Relationship Id="${stringsRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    );

    const workbookXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<workbookPr${dateSystem === '1904' ? ' date1904="1"' : ''}/>` +
        `<sheets>${workbookSheetsXml.join('')}</sheets>` +
        definedNamesXml +
        '</workbook>';

    const numFmtsXml = numFmtsList.length > 0
        ? `<numFmts count="${numFmtsList.length}">${numFmtsList.map(n => `<numFmt numFmtId="${n.id}" formatCode="${escapeXml(n.code)}"/>`).join('')}</numFmts>`
        : '';
    const dxfsSection = dxfsXml.length > 0 ? `<dxfs count="${dxfsXml.length}">${dxfsXml.join('')}</dxfs>` : '<dxfs count="0"/>';
    const stylesXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        numFmtsXml +
        `<fonts count="${fontsXml.length}">${fontsXml.join('')}</fonts>` +
        `<fills count="${fillsXml.length}">${fillsXml.join('')}</fills>` +
        `<borders count="${bordersXml.length}">${bordersXml.join('')}</borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="${xfsXml.length}">${xfsXml.join('')}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        dxfsSection +
        '</styleSheet>';

    const sharedStringsXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
        sharedStrings.map(s => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
        '</sst>';

    const contentTypesXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        contentTypeOverrides.join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        tableContentTypeOverrides.join('') +
        '</Types>';

    const rootRelsXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>';

    const wbRelsFileXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        workbookRelsXml.join('') +
        '</Relationships>';

    zipEntries['[Content_Types].xml'] = encoder.encode(contentTypesXml);
    zipEntries['_rels/.rels'] = encoder.encode(rootRelsXml);
    zipEntries['xl/workbook.xml'] = encoder.encode(workbookXml);
    zipEntries['xl/_rels/workbook.xml.rels'] = encoder.encode(wbRelsFileXml);
    zipEntries['xl/styles.xml'] = encoder.encode(stylesXml);
    zipEntries['xl/sharedStrings.xml'] = encoder.encode(sharedStringsXml);

    const zipped = zipSync(zipEntries, {level: 6});
    const outBuffer = Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
    const outputSha = createHash('sha256').update(outBuffer).digest('hex');

    return {
        bytes: outBuffer,
        report: {
            format: 'xlsx',
            operation: 'export',
            source_sha256: sourceSha,
            output_sha256: outputSha,
            date_system: dateSystem,
            sheets: sheetSummaries,
            defined_names: {preserved: defPreserved, lost: 0},
            losses,
            diagnostics,
            unknown_parts: [],
            editable_published: false,
        },
    };
}
