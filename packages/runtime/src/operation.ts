/**
 * One workbook operation: decode -> profile/base/resource checks -> resolve logical IDs ->
 * engine commands -> calculation barrier -> full snapshot -> candidate digest.
 * Target: packages/runtime/src/operation.ts (called by src/cli.ts and src/server.ts).
 */
import {assertOneBased, rangeCells, toA1, type CellCoord} from './coordinates.ts';
import {UniverWorkbookSession} from './engine/univer.ts';
import {DEFAULT_LIMITS, WIRE_PROFILE, PROFILE_RESOURCES, CONDITIONAL_FORMATTING_RESOURCE, SUPPORTED_COMMANDS} from './profile.ts';
import {TableBindings} from './table-bindings.ts';
import {
    WIRE_VERSION, WireError, canonicalize, sha256Canonical,
    type CellContent, type CellReadback, type Command, type Json, type JsonObject, type Limits,
    type Literal, type OperandExpectation, type ProfileRef, type RangeSelector, type Request, type Response, type TableBinding, type WorkbookV2,
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
    if (parsed !== null && !('number' in parsed) && !('text' in parsed)) throw new WireError('invalid_message', `${path} must be number, text or null`);
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

function command(value: Json, index: number): Command {
    const path = `commands[${index}]`;
    const raw = object(value, path);
    const kind = string(raw.kind, `${path}.kind`);
    if (!(SUPPORTED_COMMANDS as readonly string[]).includes(kind)) {
        throw new WireError('unsupported_command', `${kind} is not in profile ${WIRE_PROFILE.id}`, {kind});
    }
    const sheet_id = string(raw.sheet_id, `${path}.sheet_id`);
    const at = (): {row: number; column: number} => ({row: assertOneBased(raw.row, `${path}.row`), column: assertOneBased(raw.column, `${path}.column`)});
    switch (kind) {
        case 'set_number':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'value'], path);
            return {kind, sheet_id, ...at(), expected: content(raw.expected, `${path}.expected`), value: finite(raw.value, `${path}.value`)};
        case 'set_text':
            only(raw, ['kind', 'sheet_id', 'row', 'column', 'expected', 'value'], path);
            if (typeof raw.value !== 'string') throw new WireError('invalid_message', `${path}.value must be a string`);
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
        default: {
            only(raw, ['kind', 'sheet_id', 'table_id', 'scope', 'row_ids', 'destination_column_id', 'expression', 'expected_destination', 'expected_inputs'], path);
            if (raw.scope !== 'fixed_members' && raw.scope !== 'current_rows') throw new WireError('invalid_message', `${path}.scope`);
            const expression = object(raw.expression, `${path}.expression`);
            only(expression, ['op', 'left_column_id', 'right_column_id'], `${path}.expression`);
            if (expression.op !== 'subtract') throw new WireError('unsupported_command', `expression ${String(expression.op)} is not in profile`);
            const rowIds = array(raw.row_ids, `${path}.row_ids`).map(id => string(id, 'row_id'));
            const expected = array(raw.expected_destination, `${path}.expected_destination`).map((v, i) => content(v, `${path}.expected_destination[${i}]`));
            if (rowIds.length === 0 || new Set(rowIds).size !== rowIds.length || expected.length !== rowIds.length) {
                throw new WireError('invalid_message', `${path}.row_ids must be unique, non-empty and match expected_destination`);
            }
            const parsedCmd: Extract<Command, {kind: 'fill_formula'}> = {
                kind: 'fill_formula', sheet_id, table_id: string(raw.table_id, `${path}.table_id`), scope: raw.scope, row_ids: rowIds,
                destination_column_id: string(raw.destination_column_id, `${path}.destination_column_id`),
                expression: {op: 'subtract', left_column_id: string(expression.left_column_id, 'left_column_id'), right_column_id: string(expression.right_column_id, 'right_column_id')},
                expected_destination: expected,
            };
            if (raw.expected_inputs !== undefined) {
                const expectedInputs = array(raw.expected_inputs, `${path}.expected_inputs`).map((item, i) => {
                    const rowObj = object(item, `${path}.expected_inputs[${i}]`);
                    only(rowObj, ['left', 'right'], `${path}.expected_inputs[${i}]`);
                    return {
                        left: operandExpectation(rowObj.left, `${path}.expected_inputs[${i}].left`),
                        right: operandExpectation(rowObj.right, `${path}.expected_inputs[${i}].right`),
                    };
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
    const common = {
        version: 1 as const, request_id,
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
    if (raw.operation === 'apply') {
        only(raw, ['version', 'request_id', 'operation', 'base', 'profile_id', 'workbook', 'commands', 'limits'], 'message');
        const commands = array(raw.commands, 'commands');
        if (commands.length === 0) throw new WireError('invalid_message', 'apply needs at least one command');
        const max = Math.min(limits.max_commands ?? DEFAULT_LIMITS.max_commands, DEFAULT_LIMITS.max_commands);
        if (commands.length > max) throw new WireError('limit_exceeded', `${commands.length} commands exceed ${max}`);
        return {...common, operation: 'apply', commands: commands.map(command), limits};
    }
    if (raw.operation === 'read' || raw.operation === 'recalculate') {
        only(raw, ['version', 'request_id', 'operation', 'base', 'profile_id', 'workbook', 'selector', 'limits'], 'message');
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

function applyCommand(session: UniverWorkbookSession, bindings: TableBindings, cmd: Command, limits: Limits, checked: Written[], changed: RangeSelector[]): void {
    switch (cmd.kind) {
        case 'set_number':
        case 'set_text':
        case 'set_formula': {
            const coord = {row: cmd.row, column: cmd.column};
            requireContent(session, cmd.sheet_id, coord, cmd.expected);
            const value = cmd.kind === 'set_number' ? {number: cmd.value}
                : cmd.kind === 'set_text' ? {text: cmd.value} : {formula: cmd.formula};
            if (sameContent(cmd.expected, value)) return;
            if (cmd.kind === 'set_number') session.writeLiteral(cmd.sheet_id, coord, {number: cmd.value});
            else if (cmd.kind === 'set_text') session.writeLiteral(cmd.sheet_id, coord, {text: cmd.value});
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
        case 'fill_formula': {
            const table = bindings.table(cmd.sheet_id, cmd.table_id);
            if (cmd.scope === 'current_rows') {
                const current = bindings.members(table);
                if (canonicalize(current) !== canonicalize(cmd.row_ids)) {
                    throw new WireError('scope_changed', `membership of ${cmd.table_id} changed since prepare`, {expected: cmd.row_ids, actual: current});
                }
            }
            const destination = bindings.columnOf(table, cmd.destination_column_id);
            const left = bindings.columnOf(table, cmd.expression.left_column_id);
            const right = bindings.columnOf(table, cmd.expression.right_column_id);
            // Resolve all targets and verify all preconditions before the first engine write.
            const targets = cmd.row_ids.map((rowId, index) => {
                const row = bindings.rowOf(table, rowId);
                requireContent(session, cmd.sheet_id, {row, column: destination}, cmd.expected_destination[index], {row_id: rowId});
                if (cmd.expected_inputs !== undefined) {
                    const inputs = cmd.expected_inputs[index];
                    requireContent(session, cmd.sheet_id, {row, column: left}, inputs.left.content, {row_id: rowId, operand: 'left'});
                    requireContent(session, cmd.sheet_id, {row, column: right}, inputs.right.content, {row_id: rowId, operand: 'right'});
                }
                return {row, formula: `=${toA1({row, column: left})}-${toA1({row, column: right})}`};
            });
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
    const left = bindings.columnOf(table, cmd.expression.left_column_id);
    const right = bindings.columnOf(table, cmd.expression.right_column_id);
    cmd.row_ids.forEach((rowId, index) => {
        const row = bindings.rowOf(table, rowId);
        const inputs = cmd.expected_inputs![index];
        for (const [operand, column, expected] of [['left', left, inputs.left], ['right', right, inputs.right]] as const) {
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

/**
 * Runs one decoded message. `profile`/`resources` are parameters only so that a test can
 * widen the allow-list and observe the second, post-save line of defence.
 */
export async function runOperation(message: Json, profile: ProfileRef = WIRE_PROFILE, resources: readonly string[] = PROFILE_RESOURCES): Promise<Response> {
    const request = decodeRequest(message);
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
    const structural = request.operation === 'apply' && request.commands.some(command => command.kind === 'insert_row_before');
    const requiredUnknown = resourcesIn(request.workbook.native).some(resource =>
        typeof resource.name === 'string' && unknown.includes(resource.name) && resource.required === true);
    if ((structural || requiredUnknown) && unknown.length > 0) {
        throw new WireError('unsupported_content', 'structural command with unknown resources', {reason: 'unknown_resource', resources: unknown});
    }
    if (structural && resourcesIn(request.workbook.native).some(resource =>
        resource.name === CONDITIONAL_FORMATTING_RESOURCE && resource.data !== '' && resource.data !== '{}')) {
        throw new WireError('unsupported_content', 'conditional formatting coordinates cannot be shifted', {reason: 'conditional_formatting_shift'});
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
            for (const cmd of request.commands) applyCommand(session, bindings, cmd, limits, checked, changed);
        }
        await session.settle(limits.calculation_timeout_ms);
        if (request.operation === 'apply') {
            for (const cmd of request.commands) verifySettledOperandValues(session, bindings, cmd);
        }
        const native = session.save();
        if (unknown.length > 0 && Array.isArray(request.workbook.native.resources)) {
            const preservedUnknown = request.workbook.native.resources.filter(resource =>
                resource && typeof resource === 'object' && !Array.isArray(resource) && typeof resource.name === 'string' && unknown.includes(resource.name));
            native.resources = [...(Array.isArray(native.resources) ? native.resources : []), ...preservedUnknown];
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
        return {
            version: 1, request_id: request.request_id, ok: true, operation: request.operation,
            base_sha256: baseSha, workbook: candidate, candidate_sha256: candidateSha, changed_ranges: changed,
            calculation: {state: 'ready', source_sha256: candidateSha},
            checks: {resources_preserved: preserved, cells},
        };
    } finally {
        session.dispose();
    }
}
