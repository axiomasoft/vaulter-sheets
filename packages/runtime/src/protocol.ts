/**
 * Private PHP <-> Node wire contract v1 of vaulter-sheets runtime.
 * Normative description: plan/spec/implementation/sheets-runtime-wire.md, schema: runtime-v1.schema.json.
 * Target file in vaulter-sheets: packages/runtime/src/protocol.ts.
 */
import {createHash} from 'node:crypto';
import {WireError} from './wire-error.ts';

export const WIRE_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export type JsonObject = {[key: string]: Json};

/** Cell content as stored by the user: literal number/text, formula source or empty. */
export type CellContent = null | {number: number} | {text: string} | {boolean: boolean} | {formula: string};

export interface Base {generation: number; position: number; sha256: string}

export interface ProfileRef {id: string; engine: string; plugins: {name: string; version: string}[]}

/** All coordinates on the wire and in `tables` are one-based. */
export interface TableColumnBinding {column_id: string; column: number}
export interface TableRowBinding {row_id: string; row: number}
export interface TableBinding {
    table_id: string;
    sheet_id: string;
    header_row: number;
    columns: TableColumnBinding[];
    rows: TableRowBinding[];
}

export interface WorkbookV2 {format_version: 2; profile: ProfileRef; native: JsonObject; tables: TableBinding[]}

export type Literal = {number: number} | {text: string} | null;

export interface OperandExpectation {content: CellContent; value?: number}

export type Command =
    | {kind: 'set_number'; sheet_id: string; row: number; column: number; expected: CellContent; value: number}
    | {kind: 'set_text'; sheet_id: string; row: number; column: number; expected: CellContent; value: string}
    | {kind: 'set_formula'; sheet_id: string; row: number; column: number; expected: CellContent; formula: string}
    | {kind: 'set_values'; sheet_id: string; row: number; column: number; expected: CellContent[][]; values: Literal[][]}
    | {kind: 'insert_row_before'; sheet_id: string; row: number; count: number; new_row_ids?: {[tableId: string]: string[]}}
    | {
        kind: 'fill_formula';
        sheet_id: string;
        table_id: string;
        scope: 'fixed_members' | 'current_rows';
        row_ids: string[];
        destination_column_id: string;
        expression: {op: 'subtract'; left_column_id: string; right_column_id: string};
        expected_destination: CellContent[];
        expected_inputs?: {left: OperandExpectation; right: OperandExpectation}[];
    };

export interface RangeSelector {sheet_id: string; range: string}

export interface Limits {max_commands: number; max_cells_per_command: number; calculation_timeout_ms: number}

export type Request =
    | {version: 1; request_id: string; operation: 'apply'; base: Base; profile_id: string; workbook: WorkbookV2; commands: Command[]; limits?: Partial<Limits>}
    | {version: 1; request_id: string; operation: 'read' | 'recalculate'; base: Base; profile_id: string; workbook: WorkbookV2; selector: {ranges: RangeSelector[]}; limits?: Partial<Limits>};

export interface CellReadback {sheet_id: string; a1: string; row: number; column: number; formula: string | null; value: number | string | boolean | null}

export interface Calculation {state: 'ready'; source_sha256: string}

export type ErrorCode =
    | 'invalid_message'
    | 'unsupported_version'
    | 'profile_mismatch'
    | 'base_mismatch'
    | 'unsupported_command'
    | 'unsupported_content'
    | 'unknown_target'
    | 'identity_required'
    | 'precondition_failed'
    | 'scope_changed'
    | 'limit_exceeded'
    | 'calculation_timeout';

export type Response =
    | {
        version: 1; request_id: string; ok: true; operation: 'apply' | 'recalculate';
        base_sha256: string; workbook: WorkbookV2; candidate_sha256: string;
        changed_ranges: RangeSelector[]; calculation: Calculation;
        checks: {resources_preserved: string[]; cells: CellReadback[]};
    }
    | {
        version: 1; request_id: string; ok: true; operation: 'read';
        base_sha256: string; calculation: Calculation;
        data: {ranges: {sheet_id: string; range: string; cells: CellReadback[]}[]};
    }
    | {version: 1; request_id: string | null; ok: false; error: {code: ErrorCode; message: string; detail?: JsonObject}};

export {WireError} from './wire-error.ts';

/**
 * Strict JSON decoding for the wire: duplicate object keys, integers outside the
 * JavaScript safe range and non-finite numbers are rejected instead of silently
 * taking the last key / losing precision (JSON.parse would do both).
 */
export function parseStrict(text: string): Json {
    let i = 0;
    const fail = (why: string): never => {
        throw new WireError('invalid_message', `${why} at offset ${i}`);
    };
    const ws = (): void => {
        while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
    };
    const number = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    const parseString = (): string => {
        const start = i++;
        while (i < text.length) {
            const c = text[i];
            if (c === '\\') i += 2;
            else if (c === '"') {
                i++;
                try {
                    return JSON.parse(text.slice(start, i)) as string;
                } catch {
                    return fail('invalid string escape');
                }
            } else if (c < ' ') fail('control character in string');
            else i++;
        }
        return fail('unterminated string');
    };
    const parseValue = (depth: number): Json => {
        if (depth > 256) fail('nesting too deep');
        ws();
        const c = text[i];
        if (c === '{') {
            i++;
            const out: JsonObject = {};
            const seen = new Set<string>();
            ws();
            if (text[i] === '}') {
                i++;
                return out;
            }
            for (;;) {
                ws();
                if (text[i] !== '"') fail('expected key');
                const key = parseString();
                if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
                seen.add(key);
                ws();
                if (text[i++] !== ':') fail('expected colon');
                Object.defineProperty(out, key, {value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true});
                ws();
                const sep = text[i++];
                if (sep === '}') return out;
                if (sep !== ',') fail('expected comma');
            }
        }
        if (c === '[') {
            i++;
            const out: Json[] = [];
            ws();
            if (text[i] === ']') {
                i++;
                return out;
            }
            for (;;) {
                out.push(parseValue(depth + 1));
                ws();
                const sep = text[i++];
                if (sep === ']') return out;
                if (sep !== ',') fail('expected comma');
            }
        }
        if (c === '"') return parseString();
        for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
            if (text.startsWith(word, i)) {
                i += word.length;
                return value;
            }
        }
        number.lastIndex = i;
        const match = number.exec(text);
        if (match === null) return fail('unexpected token');
        i = number.lastIndex;
        const value = Number(match[0]);
        if (!Number.isFinite(value)) fail('non-finite number');
        // An integer token beyond 2^53-1 is accepted only if it is exactly how ES prints the
        // resulting double (e.g. 1e16 -> "10000000000000000"); otherwise digits were lost.
        if (match[1] === undefined && match[2] === undefined && !Number.isSafeInteger(value) && String(value) !== match[0]) {
            fail('integer outside safe range');
        }
        return value;
    };
    const result = parseValue(0);
    ws();
    if (i !== text.length) fail('trailing data');
    return result;
}

/** RFC 8785 (JCS): ES number/string serialization, keys ordered by UTF-16 code units. */
export function canonicalize(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new WireError('invalid_message', 'non-finite number cannot be canonicalized');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
        const object = value as {[key: string]: unknown};
        const keys = Object.keys(object).filter(key => object[key] !== undefined).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`;
    }
    throw new WireError('invalid_message', `unsupported JSON value of type ${typeof value}`);
}

export function sha256Canonical(value: unknown): string {
    return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
