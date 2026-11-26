/**
 * One workbook operation: decode -> profile/base/resource checks -> resolve logical IDs ->
 * engine commands -> calculation barrier -> full snapshot -> candidate digest.
 * Target: packages/runtime/src/operation.ts (called by src/cli.ts and src/server.ts).
 */
import {assertOneBased, columnLetters, rangeCells, toA1, type CellCoord} from './coordinates.ts';
import {UniverWorkbookSession} from './engine/univer.ts';
import {verifyWorkbookWithIronCalc} from './engine/ironcalc.ts';
import {DEFAULT_LIMITS, WIRE_PROFILE, PROFILE_RESOURCES, CONDITIONAL_FORMATTING_RESOURCE, SUPPORTED_COMMANDS} from './profile.ts';
import {TableBindings} from './table-bindings.ts';
import {
    WIRE_VERSION, WireError, canonicalize, sha256Canonical,
    type BorderSideSpec, type BorderStyleName, type CellContent, type CellReadback, type Command, type FormatSpec,
    type FormulaExpression, type IfComparator, type IfScalar, type Json, type JsonObject, type Limits,
    type Literal, type OperandExpectation, type ProfileRef, type RangeSelector, type Request, type Response,
    type TableBinding, type WorkbookV2,
} from './protocol.ts';

type Path = string;

function object(value: Json | undefined, path: Path): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WireError('invalid_message', `${path} must be an object`);
    return value;
}
function array(value: Json | undefined, path: Path): Json[] {
    if (!Array.isArray(value)) throw new WireError('invalid_message', `${path} must be an array`);
    return value;
}
function string(value: Json | undefined, path: Path): string {
    if (typeof value !== 'string' || value === '') throw new WireError('invalid_message', `${path} must be a non-empty string`);
    return value;
}
function finite(value: Json | undefined, path: Path): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new WireError('invalid_message', `${path} must be a finite number`);
    return value;
}
function counter(value: Json | undefined, path: Path, min: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new WireError('invalid_message', `${path} must be an integer >= ${min}`);
    return value;
}
function only(value: JsonObject, keys: string[], path: Path): void {
    const extra = Object.keys(value).filter(key => !keys.includes(key));
    if (extra.length > 0) throw new WireError('invalid_message', `${path} has unknown fields ${extra.join(', ')}`);
}
function content(value: Json | undefined, path: Path): CellContent {
    if (value === null) return null;
    const cell = object(value, path);
    const [key, ...rest] = Object.keys(cell);
    if (rest.length > 0) throw new WireError('invalid_message', `${path} must have exactly one tag`);
    if (key === 'number') return {number: finite(cell.number, `${path}.number`)};
    if (key === 'text' && typeof cell.text === 'string') return {text: cell.text};
    if (key === 'boolean' && typeof cell.boolean === 'boolean') return {boolean: cell.boolean};
    if (key === 'formula') return {formula: string(cell.formula, `${path}.formula`)};
    throw new WireError('invalid_message', `${path} is not a cell content`);
}
function literal(value: Json | undefined, path: Path): Literal {
    const parsed = content(value, path);
    if (parsed !== null && !('number' in parsed) && !('text' in parsed) && !('boolean' in parsed)) {
        throw new WireError('invalid_message', `${path} must be number, text, boolean or null`);
    }
    return parsed;
}

function operandExpectation(value: Json | undefined, path: Path): OperandExpectation {
    const obj = object(value, path);
    only(obj, ['content', 'value'], path);
    const parsedContent = content(obj.content, `${path}.content`);
    if (obj.value !== undefined) {
        return {content: parsedContent, value: finite(obj.value, `${path}.value`)};
    }
    return {content: parsedContent};
}

function profileRef(value: Json | undefined): ProfileRef {
    const profile = object(value, 'workbook.profile');
    only(profile, ['id', 'engine', 'plugins'], 'workbook.profile');
    return {
        id: string(profile.id, 'profile.id'),
        engine: string(profile.engine, 'profile.engine'),
        plugins: array(profile.plugins, 'profile.plugins').map((plugin, index) => {
            const entry = object(plugin, `profile.plugins[${index}]`);
            only(entry, ['name', 'version'], `profile.plugins[${index}]`);
            return {name: string(entry.name, 'plugin.name'), version: string(entry.version, 'plugin.version')};
        }),
    };
}

function tables(value: Json | undefined): TableBinding[] {
    return array(value, 'workbook.tables').map((item, index) => {
        const path = `workbook.tables[${index}]`;
        const table = object(item, path);
        only(table, ['table_id', 'sheet_id', 'header_row', 'columns', 'rows'], path);
        return {
            table_id: string(table.table_id, `${path}.table_id`),
            sheet_id: string(table.sheet_id, `${path}.sheet_id`),
            header_row: counter(table.header_row, `${path}.header_row`, 1),
            columns: array(table.columns, `${path}.columns`).map((c, i) => {
                const column = object(c, `${path}.columns[${i}]`);
                only(column, ['column_id', 'column'], `${path}.columns[${i}]`);
                return {column_id: string(column.column_id, 'column_id'), column: counter(column.column, 'column', 1)};
            }),
            rows: array(table.rows, `${path}.rows`).map((r, i) => {
                const row = object(r, `${path}.rows[${i}]`);
                only(row, ['row_id', 'row'], `${path}.rows[${i}]`);
                return {row_id: string(row.row_id, 'row_id'), row: counter(row.row, 'row', 1)};
            }),
        };
    });
}

function workbook(value: Json | undefined): WorkbookV2 {
    const book = object(value, 'workbook');
    only(book, ['format_version', 'profile', 'native', 'tables'], 'workbook');
    if (book.format_version !== 2) throw new WireError('unsupported_version', 'workbook.format_version must be 2');
    return {format_version: 2, profile: profileRef(book.profile), native: object(book.native, 'workbook.native'), tables: tables(book.tables)};
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BORDER_STYLES = new Set<BorderStyleName>(['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);
const IF_COMPARATORS = new Set<IfComparator>(['=', '<>', '>', '>=', '<', '<=']);
const ALLOWED_TEMPLATE_FUNCTIONS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ROUND', 'ABS', 'IF', 'AND', 'OR', 'NOT']);
const TEMPLATE_PARAM_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function hexColor(value: Json | undefined, path: Path): string {
    const s = string(value, path);
    if (!HEX_COLOR_RE.test(s)) throw new WireError('invalid_message', `${path} must be #RRGGBB or #RRGGBBAA`);
    return s;
}

function borderSide(value: Json | undefined, path: Path): BorderSideSpec {
    if (value === null) return null;
    const obj = object(value, path);
    only(obj, ['style', 'color'], path);
    const style = string(obj.style, `${path}.style`) as BorderStyleName;
    if (!BORDER_STYLES.has(style)) throw new WireError('invalid_message', `${path}.style is invalid`);
    return obj.color === undefined ? {style} : {style, color: hexColor(obj.color, `${path}.color`)};
}

function formatSpec(value: Json | undefined, path: Path): FormatSpec {
    const obj = object(value, path);
    only(obj, ['font', 'fill', 'borders', 'alignment', 'numFmt'], path);
    if (Object.keys(obj).length === 0) throw new WireError('invalid_message', `${path} must not be empty`);
    const out: FormatSpec = {};
    if (obj.font !== undefined) {
        const f = object(obj.font, `${path}.font`);
        only(f, ['bold', 'italic', 'size', 'color'], `${path}.font`);
        if (Object.keys(f).length === 0) throw new WireError('invalid_message', `${path}.font must not be empty`);
        const font: NonNullable<FormatSpec['font']> = {};
        if (f.bold !== undefined) {
            if (typeof f.bold !== 'boolean') throw new WireError('invalid_message', `${path}.font.bold must be boolean`);
            font.bold = f.bold;
        }
        if (f.italic !== undefined) {
            if (typeof f.italic !== 'boolean') throw new WireError('invalid_message', `${path}.font.italic must be boolean`);
            font.italic = f.italic;
        }
        if (f.size !== undefined) {
            const sz = finite(f.size, `${path}.font.size`);
            if (sz < 1 || sz > 409) throw new WireError('invalid_message', `${path}.font.size must be between 1 and 409`);
            font.size = sz;
        }
        if (f.color !== undefined) font.color = f.color === null ? null : hexColor(f.color, `${path}.font.color`);
        out.font = font;
    }
    if (obj.fill !== undefined) out.fill = obj.fill === null ? null : hexColor(obj.fill, `${path}.fill`);
    if (obj.borders !== undefined) {
        const b = object(obj.borders, `${path}.borders`);
        only(b, ['all', 'top', 'right', 'bottom', 'left'], `${path}.borders`);
        if (Object.keys(b).length === 0) throw new WireError('invalid_message', `${path}.borders must not be empty`);
        const borders: NonNullable<FormatSpec['borders']> = {};
        for (const side of ['all', 'top', 'right', 'bottom', 'left'] as const) {
            if (b[side] !== undefined) borders[side] = borderSide(b[side], `${path}.borders.${side}`);
        }
        out.borders = borders;
    }
    if (obj.alignment !== undefined) {
        const a = object(obj.alignment, `${path}.alignment`);
        only(a, ['horizontal', 'vertical', 'wrap'], `${path}.alignment`);
        if (Object.keys(a).length === 0) throw new WireError('invalid_message', `${path}.alignment must not be empty`);
        const alignment: NonNullable<FormatSpec['alignment']> = {};
        if (a.horizontal !== undefined) {
            if (a.horizontal !== null && a.horizontal !== 'left' && a.horizontal !== 'center' && a.horizontal !== 'right') {
                throw new WireError('invalid_message', `${path}.alignment.horizontal is invalid`);
            }
            alignment.horizontal = a.horizontal;
        }
        if (a.vertical !== undefined) {
            if (a.vertical !== null && a.vertical !== 'top' && a.vertical !== 'middle' && a.vertical !== 'bottom') {
                throw new WireError('invalid_message', `${path}.alignment.vertical is invalid`);
            }
            alignment.vertical = a.vertical;
        }
        if (a.wrap !== undefined) {
            if (typeof a.wrap !== 'boolean') throw new WireError('invalid_message', `${path}.alignment.wrap must be boolean`);
            alignment.wrap = a.wrap;
        }
        out.alignment = alignment;
    }
    if (obj.numFmt !== undefined) {
        if (obj.numFmt === null) out.numFmt = null;
        else {
            const fmt = string(obj.numFmt, `${path}.numFmt`);
            if (fmt.length > 255) throw new WireError('invalid_message', `${path}.numFmt too long`);
            out.numFmt = fmt;
        }
    }
    return out;
}

function ifScalar(value: Json | undefined, path: Path): IfScalar {
    if (typeof value === 'number') return finite(value, path);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/[\x00-\x1f]/.test(value)) throw new WireError('invalid_message', `${path} contains control characters`);
        return value;
    }
    throw new WireError('invalid_message', `${path} must be number, string, or boolean`);
}

function validateFormulaTemplate(template: string, params: {[key: string]: string}, path: Path): void {
    if (!template.startsWith('=') || template.length < 2 || template.length > 255 || /[\x00-\x1f"[\];!]/.test(template)) {
        throw new WireError('invalid_message', `${path}.template is invalid or contains forbidden characters`);
    }
    const placeholders = new Set<string>();
    const stripped = template.replace(TEMPLATE_PARAM_RE, (_, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(params, key)) {
            throw new WireError('invalid_message', `${path}.template references unknown param ${key}`);
        }
        placeholders.add(key);
        return '1';
    });
    if (/[{}]/.test(stripped)) {
        throw new WireError('invalid_message', `${path}.template has malformed placeholder braces`);
    }
    if (!/^=[A-Za-z0-9_+\-*/(),.<>\s]+$/.test(stripped)) {
        throw new WireError('invalid_message', `${path}.template contains disallowed characters`);
    }
    for (const match of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g)) {
        const ident = match[1].toUpperCase();
        const isCall = match[2] !== undefined;
        if (isCall) {
            if (!ALLOWED_TEMPLATE_FUNCTIONS.has(ident)) {
                throw new WireError('invalid_message', `${path}.template uses disallowed function ${ident}`);
            }
        } else if (ident !== 'TRUE' && ident !== 'FALSE') {
            throw new WireError('invalid_message', `${path}.template must parameterize cell coordinates (${match[1]})`);
        }
    }
}

function parseFormulaExpression(raw: Json | undefined, path: Path): FormulaExpression {
    const expr = object(raw, path);
    const op = string(expr.op, `${path}.op`);
    if (op === 'subtract' || op === 'add' || op === 'multiply' || op === 'divide') {
        only(expr, ['op', 'left_column_id', 'right_column_id'], path);
        return {op, left_column_id: string(expr.left_column_id, `${path}.left_column_id`), right_column_id: string(expr.right_column_id, `${path}.right_column_id`)};
    }
    if (op === 'sum' || op === 'average') {
        only(expr, ['op', 'column_ids'], path);
        const colIds = array(expr.column_ids, `${path}.column_ids`).map((c, i) => string(c, `${path}.column_ids[${i}]`));
        if (colIds.length === 0 || colIds.length > 64) throw new WireError('invalid_message', `${path}.column_ids must have 1..64 items`);
        return {op, column_ids: colIds};
    }
    if (op === 'if') {
        only(expr, ['op', 'condition', 'then_column_id', 'then_value', 'else_column_id', 'else_value'], path);
        const cond = object(expr.condition, `${path}.condition`);
        only(cond, ['left_column_id', 'comparator', 'right_column_id', 'right_value'], `${path}.condition`);
        const comparator = string(cond.comparator, `${path}.condition.comparator`) as IfComparator;
        if (!IF_COMPARATORS.has(comparator)) throw new WireError('invalid_message', `${path}.condition.comparator is invalid`);
        if ((cond.right_column_id !== undefined) === (cond.right_value !== undefined)) {
            throw new WireError('invalid_message', `${path}.condition must specify exactly one of right_column_id or right_value`);
        }
        if ((expr.then_column_id !== undefined) === (expr.then_value !== undefined)) {
            throw new WireError('invalid_message', `${path} must specify exactly one of then_column_id or then_value`);
        }
        if ((expr.else_column_id !== undefined) === (expr.else_value !== undefined)) {
            throw new WireError('invalid_message', `${path} must specify exactly one of else_column_id or else_value`);
        }
        const parsedCond = cond.right_column_id !== undefined
            ? {left_column_id: string(cond.left_column_id, `${path}.condition.left_column_id`), comparator, right_column_id: string(cond.right_column_id, `${path}.condition.right_column_id`)}
            : {left_column_id: string(cond.left_column_id, `${path}.condition.left_column_id`), comparator, right_value: ifScalar(cond.right_value, `${path}.condition.right_value`)};
        const thenBranch = expr.then_column_id !== undefined ? {then_column_id: string(expr.then_column_id, `${path}.then_column_id`)} : {then_value: ifScalar(expr.then_value, `${path}.then_value`)};
        const elseBranch = expr.else_column_id !== undefined ? {else_column_id: string(expr.else_column_id, `${path}.else_column_id`)} : {else_value: ifScalar(expr.else_value, `${path}.else_value`)};
        return {op: 'if', condition: parsedCond, ...thenBranch, ...elseBranch};
    }
    if (op === 'template') {
        only(expr, ['op', 'template', 'params'], path);
        const template = string(expr.template, `${path}.template`);
        const rawParams = object(expr.params, `${path}.params`);
        const params: {[key: string]: string} = {};
        for (const [key, val] of Object.entries(rawParams)) {
            params[key] = string(val, `${path}.params.${key}`);
        }
        validateFormulaTemplate(template, params, path);
        return {op: 'template', template, params};
    }
    throw new WireError('unsupported_command', `expression ${op} is not in profile`);
}

function command(value: Json, index: number): Command {
    const path = `commands[${index}]`;
    const raw = object(value, path);
    const kind = string(raw.kind, `${path}.kind`);
    if (!(SUPPORTED_COMMANDS as readonly string[]).includes(kind)) {
        throw new WireError('unsupported_command', `${kind} is not in profile ${WIRE_PROFILE.id}`, {kind});
    }
    const sheet_id = string(raw.sheet_id, `${path}.sheet_id`);
    const at = (): {row: number; column: number} => ({row: assertOneBased(raw.row, `${path}.row`), column: assertOneBased(raw.column, `${path}.column`)});
    const rect = (): {start_row: number; start_column: number; end_row: number; end_column: number} => {
        const start_row = assertOneBased(raw.start_row, `${path}.start_row`);
        const start_column = assertOneBased(raw.start_column, `${path}.start_column`);
        const end_row = assertOneBased(raw.end_row, `${path}.end_row`);
        const end_column = assertOneBased(raw.end_column, `${path}.end_column`);
        if (end_row < start_row || end_column < start_column) {
            throw new WireError('invalid_message', `${path} range end must be >= start`);
        }
        return {start_row, start_column, end_row, end_column};
    };
    switch (kind) {
        case 'set_number':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'value'], path);
            return {kind, sheet_id, ...at(), expected: content(raw.expected, `${path}.expected`), value: finite(raw.value, `${path}.value`)};
        case 'set_text':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'value'], path);
            if (typeof raw.value !== 'string') throw new WireError('invalid_message', `${path}.value must be a string`);
            return {kind, sheet_id, ...at(), expected: content(raw.expected, `${path}.expected`), value: raw.value};
        case 'set_boolean':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'value'], path);
            if (typeof raw.value !== 'boolean') throw new WireError('invalid_message', `${path}.value must be a boolean`);
            return {kind, sheet_id, ...at(), expected: content(raw.expected, `${path}.expected`), value: raw.value};
        case 'set_formula':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'formula'], path);
            return {kind, sheet_id, ...at(), expected: content(raw.expected, `${path}.expected`), formula: string(raw.formula, `${path}.formula`)};
        case 'set_values': {
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'values'], path);
            const values = array(raw.values, `${path}.values`).map((r, i) => array(r, `${path}.values[${i}]`).map((v, j) => literal(v, `${path}.values[${i}][${j}]`)));
            const expected = array(raw.expected, `${path}.expected`).map((r, i) => array(r, `${path}.expected[${i}]`).map((v, j) => content(v, `${path}.expected[${i}][${j}]`)));
            const width = values[0]?.length ?? 0;
            if (values.length === 0 || width === 0 || values.some(r => r.length !== width) || expected.length !== values.length || expected.some(r => r.length !== width)) {
                throw new WireError('invalid_message', `${path} must be a non-empty rectangle with matching expected`);
            }
            return {kind, sheet_id, ...at(), expected, values};
        }
        case 'insert_row_before': {
            only(raw, ['kind', 'sheet_id', 'row', 'count', 'new_row_ids'], path);
            const count = counter(raw.count, `${path}.count`, 1);
            if (count > DEFAULT_LIMITS.max_cells_per_command) {
                throw new WireError('limit_exceeded', `row insertion exceeds ${DEFAULT_LIMITS.max_cells_per_command} rows`);
            }
            const ids = raw.new_row_ids === undefined ? undefined : Object.fromEntries(
                Object.entries(object(raw.new_row_ids, `${path}.new_row_ids`)).map(([table, list]) => [table, array(list, `${path}.new_row_ids.${table}`).map(id => string(id, 'row_id'))]),
            );
            const cmd: Command = {kind, sheet_id, row: assertOneBased(raw.row, `${path}.row`), count};
            if (ids !== undefined) cmd.new_row_ids = ids;
            return cmd;
        }
        case 'delete_row': {
            only(raw, ['kind', 'sheet_id', 'row', 'count'], path);
            const count = counter(raw.count, `${path}.count`, 1);
            if (count > DEFAULT_LIMITS.max_cells_per_command) throw new WireError('limit_exceeded', `row deletion exceeds ${DEFAULT_LIMITS.max_cells_per_command} rows`);
            return {kind, sheet_id, row: assertOneBased(raw.row, `${path}.row`), count};
        }
        case 'insert_column_before': {
            only(raw, ['kind', 'sheet_id', 'column', 'count'], path);
            const count = counter(raw.count, `${path}.count`, 1);
            if (count > DEFAULT_LIMITS.max_cells_per_command) throw new WireError('limit_exceeded', `column insertion exceeds ${DEFAULT_LIMITS.max_cells_per_command} columns`);
            return {kind, sheet_id, column: assertOneBased(raw.column, `${path}.column`), count};
        }
        case 'delete_column': {
            only(raw, ['kind', 'sheet_id', 'column', 'count'], path);
            const count = counter(raw.count, `${path}.count`, 1);
            if (count > DEFAULT_LIMITS.max_cells_per_command) throw new WireError('limit_exceeded', `column deletion exceeds ${DEFAULT_LIMITS.max_cells_per_command} columns`);
            return {kind, sheet_id, column: assertOneBased(raw.column, `${path}.column`), count};
        }
        case 'add_sheet': {
            only(raw, ['kind', 'sheet_id', 'name', 'index', 'row_count', 'column_count'], path);
            const name = string(raw.name, `${path}.name`);
            if (name.length > 255) throw new WireError('invalid_message', `${path}.name too long`);
            const cmd: Extract<Command, {kind: 'add_sheet'}> = {kind, sheet_id, name};
            if (raw.index !== undefined) cmd.index = counter(raw.index, `${path}.index`, 0);
            if (raw.row_count !== undefined) cmd.row_count = assertOneBased(raw.row_count, `${path}.row_count`);
            if (raw.column_count !== undefined) cmd.column_count = assertOneBased(raw.column_count, `${path}.column_count`);
            return cmd;
        }
        case 'rename_sheet': {
            only(raw, ['kind', 'sheet_id', 'name', 'expected_name'], path);
            const name = string(raw.name, `${path}.name`);
            if (name.length > 255) throw new WireError('invalid_message', `${path}.name too long`);
            const cmd: Extract<Command, {kind: 'rename_sheet'}> = {kind, sheet_id, name};
            if (raw.expected_name !== undefined) cmd.expected_name = string(raw.expected_name, `${path}.expected_name`);
            return cmd;
        }
        case 'delete_sheet':
            only(raw, ['kind', 'sheet_id'], path);
            return {kind, sheet_id};
        case 'set_freeze':
            only(raw, ['kind', 'sheet_id', 'row_count', 'column_count'], path);
            return {kind, sheet_id, row_count: counter(raw.row_count, `${path}.row_count`, 0), column_count: counter(raw.column_count, `${path}.column_count`, 0)};
        case 'merge_cells': {
            only(raw, ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column', 'strategy'], path);
            const cmd: Extract<Command, {kind: 'merge_cells'}> = {kind, sheet_id, ...rect()};
            if (raw.strategy !== undefined) {
                if (raw.strategy !== 'default' && raw.strategy !== 'across' && raw.strategy !== 'vertically') {
                    throw new WireError('invalid_message', `${path}.strategy is invalid`);
                }
                cmd.strategy = raw.strategy;
            }
            return cmd;
        }
        case 'unmerge_cells':
            only(raw, ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column'], path);
            return {kind, sheet_id, ...rect()};
        case 'set_format':
            only(raw, ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column', 'format'], path);
            return {kind, sheet_id, ...rect(), format: formatSpec(raw.format, `${path}.format`)};
        default: {
            only(raw, ['kind', 'sheet_id', 'table_id', 'scope', 'row_ids', 'destination_column_id', 'expression', 'expected_destination', 'expected_inputs'], path);
            if (raw.scope !== 'fixed_members' && raw.scope !== 'current_rows') throw new WireError('invalid_message', `${path}.scope`);
            const expression = parseFormulaExpression(raw.expression, `${path}.expression`);
            const rowIds = array(raw.row_ids, `${path}.row_ids`).map(id => string(id, 'row_id'));
            const expected = array(raw.expected_destination, `${path}.expected_destination`).map((v, i) => content(v, `${path}.expected_destination[${i}]`));
            if (rowIds.length === 0 || new Set(rowIds).size !== rowIds.length || expected.length !== rowIds.length) {
                throw new WireError('invalid_message', `${path}.row_ids must be unique, non-empty and match expected_destination`);
            }
            const parsedCmd: Extract<Command, {kind: 'fill_formula'}> = {
                kind: 'fill_formula', sheet_id, table_id: string(raw.table_id, `${path}.table_id`), scope: raw.scope, row_ids: rowIds,
                destination_column_id: string(raw.destination_column_id, `${path}.destination_column_id`),
                expression,
                expected_destination: expected,
            };
            if (raw.expected_inputs !== undefined) {
                const expectedInputs = array(raw.expected_inputs, `${path}.expected_inputs`).map((item, i) => {
                    const rowObj = object(item, `${path}.expected_inputs[${i}]`);
                    if ('left' in rowObj || 'right' in rowObj) {
                        if (expression.op !== 'subtract' && expression.op !== 'add' && expression.op !== 'multiply' && expression.op !== 'divide') {
                            throw new WireError('invalid_message', `${path}.expected_inputs[${i}] left/right only applies to binary expressions`);
                        }
                        only(rowObj, ['left', 'right'], `${path}.expected_inputs[${i}]`);
                        return {
                            left: operandExpectation(rowObj.left, `${path}.expected_inputs[${i}].left`),
                            right: operandExpectation(rowObj.right, `${path}.expected_inputs[${i}].right`),
                        };
                    }
                    const mapped: {[columnId: string]: OperandExpectation} = {};
                    for (const [colId, opExp] of Object.entries(rowObj)) {
                        mapped[colId] = operandExpectation(opExp, `${path}.expected_inputs[${i}].${colId}`);
                    }
                    return mapped;
                });
                if (expectedInputs.length !== rowIds.length) {
                    throw new WireError('invalid_message', `${path}.expected_inputs must match row_ids length`);
                }
                parsedCmd.expected_inputs = expectedInputs;
            }
            return parsedCmd;
        }
    }
}

export function decodeRequest(value: Json): Request {
    const raw = object(value, 'message');
    if (raw.version !== WIRE_VERSION) throw new WireError('unsupported_version', `wire version ${String(raw.version)} is not supported`);
    const request_id = string(raw.request_id, 'request_id');
    const base = object(raw.base, 'base');
    only(base, ['generation', 'position', 'sha256'], 'base');
    if (typeof base.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(base.sha256)) throw new WireError('invalid_message', 'base.sha256 must be lowercase hex SHA-256');
    if (raw.ironcalc_verify !== undefined && typeof raw.ironcalc_verify !== 'boolean') {
        throw new WireError('invalid_message', 'ironcalc_verify must be boolean');
    }
    const common = {
        version: 1 as const, request_id,
        ironcalc_verify: raw.ironcalc_verify,
        base: {generation: counter(base.generation, 'base.generation', 0), position: counter(base.position, 'base.position', 0), sha256: base.sha256},
        profile_id: string(raw.profile_id, 'profile_id'),
        workbook: workbook(raw.workbook),
    };
    const limits: Partial<Limits> = {};
    if (raw.limits !== undefined) {
        const given = object(raw.limits, 'limits');
        only(given, ['max_commands', 'max_cells_per_command', 'calculation_timeout_ms'], 'limits');
        for (const key of ['max_commands', 'max_cells_per_command', 'calculation_timeout_ms'] as const) {
            if (given[key] !== undefined) limits[key] = counter(given[key], `limits.${key}`, 1);
        }
    }
    if (raw.ironcalc_verify !== undefined && typeof raw.ironcalc_verify !== 'boolean') {
        throw new WireError('invalid_message', 'ironcalc_verify must be a boolean');
    }
    if (raw.operation === 'apply') {
        only(raw, ['version', 'request_id', 'operation', 'base', 'profile_id', 'workbook', 'commands', 'limits', 'ironcalc_verify'], 'message');
        const commands = array(raw.commands, 'commands');
        if (commands.length === 0) throw new WireError('invalid_message', 'apply needs at least one command');
        const max = Math.min(limits.max_commands ?? DEFAULT_LIMITS.max_commands, DEFAULT_LIMITS.max_commands);
        if (commands.length > max) throw new WireError('limit_exceeded', `${commands.length} commands exceed ${max}`);
        return {...common, operation: 'apply', commands: commands.map(command), limits};
    }
    if (raw.operation === 'read' || raw.operation === 'recalculate') {
        only(raw, ['version', 'request_id', 'operation', 'base', 'profile_id', 'workbook', 'selector', 'limits', 'ironcalc_verify'], 'message');
        const selector = object(raw.selector, 'selector');
        only(selector, ['ranges'], 'selector');
        const ranges = array(selector.ranges, 'selector.ranges').map((item, index) => {
            const range = object(item, `selector.ranges[${index}]`);
            only(range, ['sheet_id', 'range'], `selector.ranges[${index}]`);
            return {sheet_id: string(range.sheet_id, 'sheet_id'), range: string(range.range, 'range')};
        });
        return {...common, operation: raw.operation, selector: {ranges}, limits};
    }
    throw new WireError('unsupported_command', `operation ${String(raw.operation)} is not supported`);
}

function resourcesIn(native: JsonObject): JsonObject[] {
    return Array.isArray(native.resources) ? native.resources.filter((resource): resource is JsonObject =>
        resource !== null && typeof resource === 'object' && !Array.isArray(resource)) : [];
}

function resourceNames(native: JsonObject): string[] {
    if (native.resources === undefined) return [];
    return array(native.resources, 'native.resources').map((item, index) =>
        string(object(item, `native.resources[${index}]`).name, 'resource.name'));
}

function sameContent(a: CellContent, b: CellContent): boolean {
    return canonicalize(a) === canonicalize(b);
}

function requireContent(session: UniverWorkbookSession, sheetId: string, coord: CellCoord, expected: CellContent, extra: JsonObject = {}): void {
    const actual = session.content(sheetId, coord);
    if (!sameContent(actual, expected)) {
        throw new WireError('precondition_failed', `${sheetId}!${toA1(coord)} changed since it was read`, {
            sheet_id: sheetId, a1: toA1(coord), expected, actual, ...extra,
        });
    }
}

/** Every resource present in the input must survive engine save(); otherwise the candidate is refused. */
export function assertResourcesPreserved(before: JsonObject, after: JsonObject): string[] {
    const kept = new Set(resourceNames(after));
    const lost = resourceNames(before).filter(name => !kept.has(name));
    if (lost.length > 0) {
        throw new WireError('unsupported_content', `engine save() dropped resources ${lost.join(', ')}`, {reason: 'resource_lost', resources: lost});
    }
    return resourceNames(before);
}

interface Written {sheet_id: string; coord: CellCoord}

function formatIfScalar(value: IfScalar): string {
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    return `"${value.replace(/"/g, '""')}"`;
}

function expressionColumnIds(expression: FormulaExpression): string[] {
    if (expression.op === 'subtract' || expression.op === 'add' || expression.op === 'multiply' || expression.op === 'divide') {
        return [expression.left_column_id, expression.right_column_id];
    }
    if (expression.op === 'sum' || expression.op === 'average') {
        return expression.column_ids;
    }
    if (expression.op === 'if') {
        const cols = [expression.condition.left_column_id];
        if ('right_column_id' in expression.condition) cols.push(expression.condition.right_column_id);
        if ('then_column_id' in expression) cols.push(expression.then_column_id);
        if ('else_column_id' in expression) cols.push(expression.else_column_id);
        return cols;
    }
    if (expression.op === 'template') return Object.values(expression.params);
    return [];
}

function buildFormulaForRow(expression: FormulaExpression, row: number, colMap: ReadonlyMap<string, number>): string {
    const ref = (colId: string): string => toA1({row, column: colMap.get(colId)!});
    switch (expression.op) {
        case 'subtract': return `=${ref(expression.left_column_id)}-${ref(expression.right_column_id)}`;
        case 'add': return `=${ref(expression.left_column_id)}+${ref(expression.right_column_id)}`;
        case 'multiply': return `=${ref(expression.left_column_id)}*${ref(expression.right_column_id)}`;
        case 'divide': return `=${ref(expression.left_column_id)}/${ref(expression.right_column_id)}`;
        case 'sum': return `=SUM(${expression.column_ids.map(ref).join(',')})`;
        case 'average': return `=AVERAGE(${expression.column_ids.map(ref).join(',')})`;
        case 'if': {
            const c = expression.condition;
            const rhs = 'right_column_id' in c ? ref(c.right_column_id) : formatIfScalar(c.right_value);
            const thenPart = 'then_column_id' in expression ? ref(expression.then_column_id) : formatIfScalar(expression.then_value);
            const elsePart = 'else_column_id' in expression ? ref(expression.else_column_id) : formatIfScalar(expression.else_value);
            return `=IF(${ref(c.left_column_id)}${c.comparator}${rhs},${thenPart},${elsePart})`;
        }
        case 'template':
            return expression.template.replace(TEMPLATE_PARAM_RE, (_, key: string) => ref(expression.params[key]));
    }
}

async function applyCommand(session: UniverWorkbookSession, bindings: TableBindings, cmd: Command, limits: Limits, checked: Written[], changed: RangeSelector[]): Promise<void> {
    switch (cmd.kind) {
        case 'set_number':
        case 'set_text':
        case 'set_boolean':
        case 'set_formula': {
            const coord = {row: cmd.row, column: cmd.column};
            requireContent(session, cmd.sheet_id, coord, cmd.expected);
            const value: CellContent = cmd.kind === 'set_number' ? {number: cmd.value}
                : cmd.kind === 'set_text' ? {text: cmd.value}
                : cmd.kind === 'set_boolean' ? {boolean: cmd.value}
                : {formula: cmd.formula};
            if (sameContent(cmd.expected, value)) return;
            if (cmd.kind === 'set_number') session.writeLiteral(cmd.sheet_id, coord, {number: cmd.value});
            else if (cmd.kind === 'set_text') session.writeLiteral(cmd.sheet_id, coord, {text: cmd.value});
            else if (cmd.kind === 'set_boolean') session.writeBoolean(cmd.sheet_id, coord, cmd.value);
            else session.writeFormula(cmd.sheet_id, coord, cmd.formula);
            checked.push({sheet_id: cmd.sheet_id, coord});
            changed.push({sheet_id: cmd.sheet_id, range: toA1(coord)});
            return;
        }
        case 'set_values': {
            const cells = cmd.values.length * cmd.values[0].length;
            if (cells > limits.max_cells_per_command) throw new WireError('limit_exceeded', `${cells} cells exceed ${limits.max_cells_per_command}`);
            // The whole rectangle is checked before the first write.
            cmd.expected.forEach((row, i) => row.forEach((expected, j) => requireContent(session, cmd.sheet_id, {row: cmd.row + i, column: cmd.column + j}, expected)));
            if (cmd.values.every((row, i) => row.every((value, j) => sameContent(cmd.expected[i][j], value)))) return;
            cmd.values.forEach((row, i) => row.forEach((value, j) => {
                const coord = {row: cmd.row + i, column: cmd.column + j};
                session.writeLiteral(cmd.sheet_id, coord, value);
                checked.push({sheet_id: cmd.sheet_id, coord});
            }));
            const end = {row: cmd.row + cmd.values.length - 1, column: cmd.column + cmd.values[0].length - 1};
            changed.push({sheet_id: cmd.sheet_id, range: `${toA1({row: cmd.row, column: cmd.column})}:${toA1(end)}`});
            return;
        }
        case 'insert_row_before': {
            session.checkRowInsertion(cmd.sheet_id, cmd.row, cmd.count, limits.max_cells_per_command);
            // Bindings first: a missing identity is refused before the engine is touched.
            bindings.insertRows(cmd.sheet_id, cmd.row, cmd.count, cmd.new_row_ids);
            session.insertRowsBefore(cmd.sheet_id, cmd.row, cmd.count);
            for (const item of checked) if (item.sheet_id === cmd.sheet_id && item.coord.row >= cmd.row) item.coord = {...item.coord, row: item.coord.row + cmd.count};
            changed.push({sheet_id: cmd.sheet_id, range: `${cmd.row}:${cmd.row + cmd.count - 1}`});
            return;
        }
        case 'delete_row': {
            session.checkRowDeletion(cmd.sheet_id, cmd.row, cmd.count);
            bindings.deleteRows(cmd.sheet_id, cmd.row, cmd.count);
            session.deleteRows(cmd.sheet_id, cmd.row, cmd.count);
            const delEnd = cmd.row + cmd.count - 1;
            for (let i = checked.length - 1; i >= 0; i--) {
                const item = checked[i];
                if (item.sheet_id !== cmd.sheet_id) continue;
                if (item.coord.row >= cmd.row && item.coord.row <= delEnd) checked.splice(i, 1);
                else if (item.coord.row > delEnd) item.coord = {...item.coord, row: item.coord.row - cmd.count};
            }
            changed.push({sheet_id: cmd.sheet_id, range: `${cmd.row}:${delEnd}`});
            return;
        }
        case 'insert_column_before': {
            session.checkColumnInsertion(cmd.sheet_id, cmd.column, cmd.count, limits.max_cells_per_command);
            bindings.insertColumns(cmd.sheet_id, cmd.column, cmd.count);
            session.insertColumnsBefore(cmd.sheet_id, cmd.column, cmd.count);
            for (const item of checked) if (item.sheet_id === cmd.sheet_id && item.coord.column >= cmd.column) item.coord = {...item.coord, column: item.coord.column + cmd.count};
            changed.push({sheet_id: cmd.sheet_id, range: `${columnLetters(cmd.column)}:${columnLetters(cmd.column + cmd.count - 1)}`});
            return;
        }
        case 'delete_column': {
            session.checkColumnDeletion(cmd.sheet_id, cmd.column, cmd.count);
            bindings.deleteColumns(cmd.sheet_id, cmd.column, cmd.count);
            session.deleteColumns(cmd.sheet_id, cmd.column, cmd.count);
            const delEnd = cmd.column + cmd.count - 1;
            for (let i = checked.length - 1; i >= 0; i--) {
                const item = checked[i];
                if (item.sheet_id !== cmd.sheet_id) continue;
                if (item.coord.column >= cmd.column && item.coord.column <= delEnd) checked.splice(i, 1);
                else if (item.coord.column > delEnd) item.coord = {...item.coord, column: item.coord.column - cmd.count};
            }
            changed.push({sheet_id: cmd.sheet_id, range: `${columnLetters(cmd.column)}:${columnLetters(delEnd)}`});
            return;
        }
        case 'add_sheet': {
            session.addSheet(cmd.sheet_id, cmd.name, cmd.index, cmd.row_count, cmd.column_count);
            changed.push({sheet_id: cmd.sheet_id, range: 'A1'});
            return;
        }
        case 'rename_sheet': {
            if (session.renameSheet(cmd.sheet_id, cmd.name, cmd.expected_name)) {
                changed.push({sheet_id: cmd.sheet_id, range: 'A1'});
            }
            return;
        }
        case 'delete_sheet': {
            session.deleteSheet(cmd.sheet_id);
            bindings.deleteSheet(cmd.sheet_id);
            for (let i = checked.length - 1; i >= 0; i--) {
                if (checked[i].sheet_id === cmd.sheet_id) checked.splice(i, 1);
            }
            changed.push({sheet_id: cmd.sheet_id, range: 'A1'});
            return;
        }
        case 'set_freeze': {
            if (session.setFreeze(cmd.sheet_id, cmd.row_count, cmd.column_count)) {
                changed.push({sheet_id: cmd.sheet_id, range: 'A1'});
            }
            return;
        }
        case 'merge_cells': {
            if (session.mergeCells(cmd.sheet_id, cmd.start_row, cmd.start_column, cmd.end_row, cmd.end_column, cmd.strategy, limits.max_cells_per_command)) {
                changed.push({sheet_id: cmd.sheet_id, range: `${toA1({row: cmd.start_row, column: cmd.start_column})}:${toA1({row: cmd.end_row, column: cmd.end_column})}`});
            }
            return;
        }
        case 'unmerge_cells': {
            if (session.unmergeCells(cmd.sheet_id, cmd.start_row, cmd.start_column, cmd.end_row, cmd.end_column, limits.max_cells_per_command)) {
                changed.push({sheet_id: cmd.sheet_id, range: `${toA1({row: cmd.start_row, column: cmd.start_column})}:${toA1({row: cmd.end_row, column: cmd.end_column})}`});
            }
            return;
        }
        case 'set_format': {
            if (session.applyFormat(cmd.sheet_id, cmd.start_row, cmd.start_column, cmd.end_row, cmd.end_column, cmd.format, limits.max_cells_per_command)) {
                changed.push({sheet_id: cmd.sheet_id, range: `${toA1({row: cmd.start_row, column: cmd.start_column})}:${toA1({row: cmd.end_row, column: cmd.end_column})}`});
            }
            return;
        }
        case 'fill_formula': {
            const table = bindings.table(cmd.sheet_id, cmd.table_id);
            if (cmd.scope === 'current_rows') {
                const current = bindings.members(table);
                if (canonicalize(current) !== canonicalize(cmd.row_ids)) {
                    throw new WireError('scope_changed', `membership of ${cmd.table_id} changed since prepare`, {expected: cmd.row_ids, actual: current});
                }
            }
            const destination = bindings.columnOf(table, cmd.destination_column_id);
            const refCols = [...new Set(expressionColumnIds(cmd.expression))];
            const colMap = new Map<string, number>();
            for (const colId of refCols) colMap.set(colId, bindings.columnOf(table, colId));
            // Resolve all targets and verify all preconditions before the first engine write.
            const targets = cmd.row_ids.map((rowId, index) => {
                const row = bindings.rowOf(table, rowId);
                requireContent(session, cmd.sheet_id, {row, column: destination}, cmd.expected_destination[index], {row_id: rowId});
                if (cmd.expected_inputs !== undefined) {
                    const inputs = cmd.expected_inputs[index];
                    if ('left' in inputs && 'right' in inputs && (cmd.expression.op === 'subtract' || cmd.expression.op === 'add' || cmd.expression.op === 'multiply' || cmd.expression.op === 'divide')) {
                        requireContent(session, cmd.sheet_id, {row, column: colMap.get(cmd.expression.left_column_id)!}, inputs.left.content, {row_id: rowId, operand: 'left'});
                        requireContent(session, cmd.sheet_id, {row, column: colMap.get(cmd.expression.right_column_id)!}, inputs.right.content, {row_id: rowId, operand: 'right'});
                    } else {
                        for (const [colId, exp] of Object.entries(inputs as {[columnId: string]: OperandExpectation})) {
                            const col = colMap.get(colId) ?? bindings.columnOf(table, colId);
                            requireContent(session, cmd.sheet_id, {row, column: col}, exp.content, {row_id: rowId, column_id: colId});
                        }
                    }
                }
                return {row, formula: buildFormulaForRow(cmd.expression, row, colMap)};
            });
            const hasNumericExpectation = cmd.expected_inputs?.some(inputs => Object.values(inputs).some(op => op.value !== undefined)) ?? false;
            if (hasNumericExpectation) {
                await session.settle(limits.calculation_timeout_ms);
                verifySettledOperandValues(session, bindings, cmd);
            }
            for (const [index, {row, formula}] of targets.entries()) {
                const coord = {row, column: destination};
                checked.push({sheet_id: cmd.sheet_id, coord});
                if (sameContent(cmd.expected_destination[index], {formula})) continue;
                session.writeFormula(cmd.sheet_id, coord, formula);
                changed.push({sheet_id: cmd.sheet_id, range: toA1(coord)});
            }
            return;
        }
    }
}

function verifySettledOperandValues(session: UniverWorkbookSession, bindings: TableBindings, cmd: Command): void {
    if (cmd.kind !== 'fill_formula' || cmd.expected_inputs === undefined) return;
    const table = bindings.table(cmd.sheet_id, cmd.table_id);
    cmd.row_ids.forEach((rowId, index) => {
        const row = bindings.rowOf(table, rowId);
        const inputs = cmd.expected_inputs![index];
        const checks: [string, number, OperandExpectation][] = [];
        if ('left' in inputs && 'right' in inputs && (cmd.expression.op === 'subtract' || cmd.expression.op === 'add' || cmd.expression.op === 'multiply' || cmd.expression.op === 'divide')) {
            checks.push(['left', bindings.columnOf(table, cmd.expression.left_column_id), inputs.left]);
            checks.push(['right', bindings.columnOf(table, cmd.expression.right_column_id), inputs.right]);
        } else {
            for (const [colId, exp] of Object.entries(inputs as {[columnId: string]: OperandExpectation})) {
                checks.push([colId, bindings.columnOf(table, colId), exp]);
            }
        }
        for (const [operand, column, expected] of checks) {
            if (expected.value === undefined) continue;
            const readback = session.readback(cmd.sheet_id, {row, column});
            if (typeof readback.value !== 'number' || !Number.isFinite(readback.value)
                || (readback.value !== expected.value && Math.abs(readback.value - expected.value) > 1e-9)) {
                throw new WireError('precondition_failed', `${cmd.sheet_id}!${toA1({row, column})} evaluated value changed since prepare`, {
                    sheet_id: cmd.sheet_id, a1: toA1({row, column}), row_id: rowId, operand, expected_value: expected.value, actual_value: readback.value,
                });
            }
        }
    });
}

function readRanges(session: UniverWorkbookSession, ranges: RangeSelector[], limit: number): {sheet_id: string; range: string; cells: CellReadback[]}[] {
    return ranges.map(({sheet_id, range}) => ({sheet_id, range, cells: rangeCells(range, limit).map(coord => session.readback(sheet_id, coord))}));
}

interface CfRange {startRow: number; endRow: number; startColumn: number; endColumn: number; rangeType?: number}
interface CfRule {rule?: {type?: string; formula?: string; value?: Json}; ranges?: CfRange[]; [key: string]: unknown}

function hasFormulaInCfRule(rule: CfRule): boolean {
    if (rule.rule?.type === 'formula' || typeof rule.rule?.formula === 'string') return true;
    return typeof rule.rule?.value === 'string' && rule.rule.value.startsWith('=');
}

function shiftAxisInterval(start: number, end: number, at0: number, count: number, isInsert: boolean): [number, number] | null {
    if (isInsert) {
        if (end < at0) return [start, end];
        if (start >= at0) return [start + count, end + count];
        return [start, end + count];
    }
    const delEnd = at0 + count - 1;
    if (end < at0) return [start, end];
    if (start > delEnd) return [start - count, end - count];
    const nextStart = start < at0 ? start : at0;
    const nextEnd = end > delEnd ? end - count : at0 - 1;
    return nextEnd < nextStart ? null : [nextStart, nextEnd];
}

function shiftCfResources(
    inputNative: JsonObject,
    outputNative: JsonObject,
    commands: Command[],
    applyShift: boolean,
): void {
    const coordCmds = commands.filter((c): c is Extract<Command, {kind: 'insert_row_before' | 'delete_row' | 'insert_column_before' | 'delete_column'}> =>
        c.kind === 'insert_row_before' || c.kind === 'delete_row' || c.kind === 'insert_column_before' || c.kind === 'delete_column');
    const renameCmds = commands.filter((c): c is Extract<Command, {kind: 'rename_sheet'}> => c.kind === 'rename_sheet');
    if (coordCmds.length === 0 && renameCmds.length === 0) return;

    const cfResIn = resourcesIn(inputNative).find(r => r.name === CONDITIONAL_FORMATTING_RESOURCE && typeof r.data === 'string' && r.data !== '' && r.data !== '{}');
    if (!cfResIn || typeof cfResIn.data !== 'string') return;

    let cfMap: Record<string, CfRule[]>;
    try {
        const parsed = JSON.parse(cfResIn.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        cfMap = parsed as Record<string, CfRule[]>;
    } catch {
        throw new WireError('unsupported_content', 'conditional formatting coordinates cannot be shifted', {reason: 'conditional_formatting_shift'});
    }

    const anyFormulaRule = Object.values(cfMap).some(rules => Array.isArray(rules) && rules.some(hasFormulaInCfRule));
    if (renameCmds.length > 0 && anyFormulaRule) {
        throw new WireError('unsupported_content', 'conditional formatting formula cannot be shifted on sheet rename', {reason: 'conditional_formatting_shift'});
    }
    if (coordCmds.length === 0) return;

    const mutatedSheets = new Set(coordCmds.map(c => c.sheet_id));
    const hasRulesOnMutated = [...mutatedSheets].some(sid => Array.isArray(cfMap[sid]) && cfMap[sid].length > 0);
    if (!hasRulesOnMutated && !anyFormulaRule) return;
    if (anyFormulaRule) {
        throw new WireError('unsupported_content', 'conditional formatting formula cannot be shifted', {reason: 'conditional_formatting_shift'});
    }
    if (!applyShift) return;

    const cfResOut = resourcesIn(outputNative).find(r => r.name === CONDITIONAL_FORMATTING_RESOURCE);
    if (!cfResOut) return;
    const outMap: Record<string, CfRule[]> = typeof cfResOut.data === 'string' && cfResOut.data !== '' && cfResOut.data !== '{}'
        ? (JSON.parse(cfResOut.data) as Record<string, CfRule[]>)
        : {};

    for (const cmd of coordCmds) {
        const rules = outMap[cmd.sheet_id];
        if (!Array.isArray(rules) || rules.length === 0) continue;
        const isRow = cmd.kind === 'insert_row_before' || cmd.kind === 'delete_row';
        const isInsert = cmd.kind === 'insert_row_before' || cmd.kind === 'insert_column_before';
        const at0 = (isRow ? cmd.row : cmd.column) - 1;
        outMap[cmd.sheet_id] = rules.map(rule => {
            if (!Array.isArray(rule.ranges)) return rule;
            const nextRanges: CfRange[] = [];
            for (const r of rule.ranges) {
                const shifted = isRow
                    ? shiftAxisInterval(r.startRow, r.endRow, at0, cmd.count, isInsert)
                    : shiftAxisInterval(r.startColumn, r.endColumn, at0, cmd.count, isInsert);
                if (shifted === null) continue;
                nextRanges.push(isRow
                    ? {...r, startRow: shifted[0], endRow: shifted[1]}
                    : {...r, startColumn: shifted[0], endColumn: shifted[1]});
            }
            return {...rule, ranges: nextRanges};
        }).filter(rule => !Array.isArray(rule.ranges) || rule.ranges.length > 0);
    }
    cfResOut.data = JSON.stringify(outMap);
}

/**
 * Runs one decoded message. `profile`/`resources` are parameters only so that a test can
 * widen the allow-list and observe the second, post-save line of defence.
 */
export async function runOperation(message: Json, profile: ProfileRef = WIRE_PROFILE, resources: readonly string[] = PROFILE_RESOURCES): Promise<Response> {
    const request = decodeRequest(message);
    const ironcalcVerify = process.env.SHEETS_ENGINE_IRONCALC_VERIFY === '1' || request.ironcalc_verify === true;
    const limits: Limits = {
        max_commands: Math.min(request.limits?.max_commands ?? DEFAULT_LIMITS.max_commands, DEFAULT_LIMITS.max_commands),
        max_cells_per_command: Math.min(request.limits?.max_cells_per_command ?? DEFAULT_LIMITS.max_cells_per_command, DEFAULT_LIMITS.max_cells_per_command),
        calculation_timeout_ms: Math.min(request.limits?.calculation_timeout_ms ?? DEFAULT_LIMITS.calculation_timeout_ms, DEFAULT_LIMITS.calculation_timeout_ms),
    };
    if (request.profile_id !== profile.id || canonicalize(request.workbook.profile) !== canonicalize(profile)) {
        throw new WireError('profile_mismatch', `runtime serves ${profile.id}`, {expected: profile.id, actual: request.workbook.profile.id});
    }
    const baseSha = sha256Canonical(request.workbook);
    if (baseSha !== request.base.sha256) {
        throw new WireError('base_mismatch', 'workbook bytes do not match base.sha256', {expected: request.base.sha256, actual: baseSha});
    }
    const names = resourceNames(request.workbook.native);
    const unknown = names.filter(name => !resources.includes(name));
    const structural = request.operation === 'apply' && request.commands.some(command =>
        command.kind === 'insert_row_before' || command.kind === 'delete_row' || command.kind === 'insert_column_before' || command.kind === 'delete_column');
    const requiredUnknown = resourcesIn(request.workbook.native).some(resource =>
        typeof resource.name === 'string' && unknown.includes(resource.name) && resource.required === true);
    if ((structural || requiredUnknown) && unknown.length > 0) {
        throw new WireError('unsupported_content', 'structural command with unknown resources', {reason: 'unknown_resource', resources: unknown});
    }
    // Pre-validate CF rules before opening Univer when structural/rename commands are requested.
    if (request.operation === 'apply') {
        shiftCfResources(request.workbook.native, request.workbook.native, request.commands, false);
    }
    const bindings = new TableBindings(request.workbook.tables);
    const session = UniverWorkbookSession.open(request.workbook.native);
    try {
        if (request.operation === 'read') {
            await session.settle(limits.calculation_timeout_ms);
            return {
                version: 1, request_id: request.request_id, ok: true, operation: 'read', base_sha256: baseSha,
                calculation: {state: 'ready', source_sha256: baseSha},
                data: {ranges: readRanges(session, request.selector.ranges, limits.max_cells_per_command)},
            };
        }
        const checked: Written[] = [];
        const changed: RangeSelector[] = [];
        if (request.operation === 'apply') {
            for (const cmd of request.commands) await applyCommand(session, bindings, cmd, limits, checked, changed);
        }
        await session.settle(limits.calculation_timeout_ms);
        const native = session.save();
        if (request.operation === 'apply') {
            shiftCfResources(request.workbook.native, native, request.commands, true);
        }
        if (Array.isArray(request.workbook.native.resources)) {
            const savedNames = new Set(resourceNames(native));
            const preservedInput = request.workbook.native.resources.filter(resource =>
                resource && typeof resource === 'object' && !Array.isArray(resource) && typeof resource.name === 'string'
                && (unknown.includes(resource.name) || (resource.name === 'SHEET_HYPER_LINK_PLUGIN' && !savedNames.has(resource.name))));
            if (preservedInput.length > 0) {
                native.resources = [...(Array.isArray(native.resources) ? native.resources : []), ...preservedInput];
            }
        }
        if (Array.isArray(native.resources)) {
            native.resources.sort((left, right) => {
                const key = (value: Json) => value && typeof value === 'object' && !Array.isArray(value) ? `${value.name}\u0000${value.id ?? ''}` : '';
                return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
            });
        }
        const preserved = assertResourcesPreserved(request.workbook.native, native);
        const candidate: WorkbookV2 = {format_version: 2, profile: request.workbook.profile, native, tables: bindings.toJSON()};
        const candidateSha = sha256Canonical(candidate);
        const cells = request.operation === 'apply'
            ? checked.map(item => session.readback(item.sheet_id, item.coord))
            : readRanges(session, request.selector.ranges, limits.max_cells_per_command).flatMap(range => range.cells);
        const ironcalcVerification = ironcalcVerify ? await verifyWorkbookWithIronCalc(candidate) : undefined;
        return {
            version: 1, request_id: request.request_id, ok: true, operation: request.operation,
            base_sha256: baseSha, workbook: candidate, candidate_sha256: candidateSha, changed_ranges: changed,
            calculation: {state: 'ready', source_sha256: candidateSha},
            checks: {
                resources_preserved: preserved,
                cells,
                ...(ironcalcVerification ? {ironcalc_verification: ironcalcVerification} : {}),
            },
        };
    } finally {
        session.dispose();
    }
}
