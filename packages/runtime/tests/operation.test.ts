import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {UniverWorkbookSession} from '../src/engine/univer.ts';
import {processFrame} from '../src/frame.ts';
import {decodeRequest} from '../src/operation.ts';
import {sha256Canonical, type JsonObject} from '../src/protocol.ts';
import {DEFAULT_LIMITS, WIRE_PROFILE} from '../src/profile.ts';

function request(name: string): JsonObject {
    const input = JSON.parse(readFileSync(new URL(`./fixtures/${name}-request.json`, import.meta.url), 'utf8'));
    input.workbook.profile = WIRE_PROFILE;
    input.base.sha256 = sha256Canonical(input.workbook);
    return input;
}

test('bounds the cells inserted on an unbound sheet before applying the row insertion', async () => {
    const input = request('apply');
    const workbook = input.workbook as JsonObject;
    const sheets = (workbook.native as JsonObject).sheets as JsonObject;
    (sheets.detail as JsonObject).columnCount = 100;
    workbook.tables = [];
    (input.base as JsonObject).sha256 = sha256Canonical(workbook);
    input.limits = {max_cells_per_command: 100};
    const insert = {kind: 'insert_row_before', sheet_id: 'detail', row: 2, count: 1};
    input.commands = [insert];
    const allowed = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(allowed.ok, true);

    input.commands = [{...insert, count: 2}];
    const rejected = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(rejected.ok ? null : rejected.error.code, 'limit_exceeded');

    input.commands = [{...insert, count: DEFAULT_LIMITS.max_cells_per_command + 1}];
    assert.throws(() => decodeRequest(input), {code: 'limit_exceeded'});
});

test('calculates the authoritative value and rejects a changed logical row set', async () => {
    const applied = await processFrame(Buffer.from(JSON.stringify(request('apply')) + '\n'));
    assert.equal(applied.ok, true, JSON.stringify(applied));
    if (applied.ok && applied.operation === 'apply') {
        const read = request('apply');
        read.operation = 'read';
        delete read.commands;
        read.workbook = JSON.parse(JSON.stringify(applied.workbook));
        (read.base as JsonObject).sha256 = applied.candidate_sha256;
        read.selector = {ranges: [{sheet_id: 'summary', range: 'B2'}]};
        const result = await processFrame(Buffer.from(JSON.stringify(read) + '\n'));
        assert.equal(result.ok && result.operation === 'read' && result.data.ranges[0].cells[0].value, 41, JSON.stringify(result));
        assert.equal(applied.candidate_sha256, sha256Canonical(applied.workbook));
    } else {
        assert.fail('expected an apply candidate');
    }
    const conflict = await processFrame(Buffer.from(JSON.stringify(request('scope-changed')) + '\n'));
    assert.equal(conflict.ok ? null : conflict.error.code, 'scope_changed');
});

test('rejects duplicate keys, missing LF and lossy integer tokens', async () => {
    for (const bytes of ['{"version":1,"version":1}\n', '{}', '{"counter":9007199254740993}\n']) {
        const result = await processFrame(Buffer.from(bytes));
        assert.equal(result.ok ? null : result.error.code, 'invalid_message');
    }
});

test('preserves optional opaque resources on a cell write and refuses structural shifts', async () => {
    const input = request('apply');
    const workbook = input.workbook as JsonObject;
    const native = workbook.native as JsonObject;
    const optional = {name: 'unknown.fixture', data: '{"unchanged":true}'};
    (native.resources as JsonObject[]).push(optional);
    (input.base as JsonObject).sha256 = sha256Canonical(workbook);
    const apply = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(apply.ok && apply.operation === 'apply', true);
    if (apply.ok && apply.operation === 'apply') {
        assert.deepEqual((apply.workbook.native.resources as JsonObject[]).find(item => item.name === optional.name), optional);
    }
    input.commands = [{kind: 'insert_row_before', sheet_id: 'detail', row: 3, count: 1}];
    const structural = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(structural.ok ? null : structural.error.code, 'unsupported_content');
    const mandatory = request('apply');
    const mandatoryBook = mandatory.workbook as JsonObject;
    ((mandatoryBook.native as JsonObject).resources as JsonObject[]).push({...optional, required: true});
    (mandatory.base as JsonObject).sha256 = sha256Canonical(mandatoryBook);
    const rejected = await processFrame(Buffer.from(JSON.stringify(mandatory) + '\n'));
    assert.equal(rejected.ok ? null : rejected.error.code, 'unsupported_content');
});

test('emits checks.cells for already-matching fill_formula targets and verifies expected_inputs', async () => {
    const baseReq = request('scope-changed');
    const wb = baseReq.workbook as JsonObject;
    const sheets = (wb.native as JsonObject).sheets as JsonObject;
    const expenses = sheets.expenses as JsonObject;
    const cellData = expenses.cellData as JsonObject;
    // Remove inserted row r-telecom2 so table has 2 rows (row 2 and row 3) and pre-seed D2 with =C2-B2.
    cellData['2'] = {'1': {t: 2, v: 200}, '2': {t: 2, v: 180}};
    delete cellData['3'];
    // Add an upstream formula column E2=60+60 referenced by C2? First test D2 preseeded as =C2-B2 while D3 is empty.
    (cellData['1'] as JsonObject)['3'] = {f: '=C2-B2', t: 2, v: 20};
    ((wb.tables as JsonObject[])[0] as JsonObject).rows = [
        {row_id: 'r-telecom', row: 2},
        {row_id: 'r-travel', row: 3},
    ];
    (baseReq.base as JsonObject).sha256 = sha256Canonical(wb);
    baseReq.commands = [
        {
            kind: 'fill_formula',
            sheet_id: 'expenses',
            table_id: 'costs',
            scope: 'fixed_members',
            row_ids: ['r-telecom', 'r-travel'],
            destination_column_id: 'delta',
            expression: {op: 'subtract', left_column_id: 'actual', right_column_id: 'plan'},
            expected_destination: [{formula: '=C2-B2'}, null],
            expected_inputs: [
                {left: {content: {number: 120}, value: 120}, right: {content: {number: 100}, value: 100}},
                {left: {content: {number: 180}, value: 180}, right: {content: {number: 200}, value: 200}},
            ],
        },
    ];

    const partialWrite = await processFrame(Buffer.from(JSON.stringify(baseReq) + '\n'));
    assert.equal(partialWrite.ok, true, JSON.stringify(partialWrite));
    if (partialWrite.ok && partialWrite.operation === 'apply') {
        assert.deepEqual(partialWrite.changed_ranges, [{sheet_id: 'expenses', range: 'D3'}]);
        assert.equal(partialWrite.checks.cells.length, 2);
        assert.equal(partialWrite.checks.cells[0].a1, 'D2');
        assert.equal(partialWrite.checks.cells[0].formula, '=C2-B2');
        assert.equal(partialWrite.checks.cells[0].value, 20);
        assert.equal(partialWrite.checks.cells[1].a1, 'D3');
        assert.equal(partialWrite.checks.cells[1].formula, '=C3-B3');
        assert.equal(partialWrite.checks.cells[1].value, -20);

        // Second pass where both D2 and D3 already match: changed_ranges is [] while checks.cells still contains both.
        const noopReq = JSON.parse(JSON.stringify(baseReq));
        noopReq.workbook = JSON.parse(JSON.stringify(partialWrite.workbook));
        noopReq.base.sha256 = partialWrite.candidate_sha256;
        noopReq.commands[0].expected_destination = [{formula: '=C2-B2'}, {formula: '=C3-B3'}];
        const noopWrite = await processFrame(Buffer.from(JSON.stringify(noopReq) + '\n'));
        assert.equal(noopWrite.ok, true, JSON.stringify(noopWrite));
        if (noopWrite.ok && noopWrite.operation === 'apply') {
            assert.deepEqual(noopWrite.changed_ranges, []);
            assert.equal(noopWrite.checks.cells.length, 2);
            assert.deepEqual(noopWrite.checks.cells.map(c => c.a1), ['D2', 'D3']);
        }
    }

    // Changed literal operand triggers precondition_failed.
    const changedLiteralReq = JSON.parse(JSON.stringify(baseReq));
    changedLiteralReq.workbook.native.sheets.expenses.cellData['1']['2'].v = 130;
    changedLiteralReq.base.sha256 = sha256Canonical(changedLiteralReq.workbook);
    const literalRejected = await processFrame(Buffer.from(JSON.stringify(changedLiteralReq) + '\n'));
    assert.equal(literalRejected.ok ? null : literalRejected.error.code, 'precondition_failed');

    // Formula operand whose upstream cell changed (even with stale cache 120) triggers precondition_failed after settle().
    const formulaInputReq = JSON.parse(JSON.stringify(baseReq));
    formulaInputReq.workbook.native.sheets.expenses.cellData['1']['4'] = {t: 2, v: 130};
    formulaInputReq.workbook.native.sheets.expenses.cellData['1']['2'] = {f: '=E2', t: 2, v: 120};
    formulaInputReq.base.sha256 = sha256Canonical(formulaInputReq.workbook);
    formulaInputReq.commands[0].expected_inputs[0].left = {content: {formula: '=E2'}, value: 120};
    const formulaRejected = await processFrame(Buffer.from(JSON.stringify(formulaInputReq) + '\n'));
    assert.equal(formulaRejected.ok ? null : formulaRejected.error.code, 'precondition_failed');
});

test('checks settled fill_formula operands before destination writes can change them', async () => {
    const input = request('scope-changed');
    const workbook = input.workbook as JsonObject;
    const sheets = (workbook.native as JsonObject).sheets as JsonObject;
    const cellData = (sheets.expenses as JsonObject).cellData as JsonObject;
    const row3 = cellData['2'] as JsonObject;
    row3['2'] = {f: '=SUM(D2,E3)', t: 2, v: 120};
    row3['4'] = {t: 2, v: 100};
    (input.base as JsonObject).sha256 = sha256Canonical(workbook);

    const [fill] = input.commands as JsonObject[];
    fill.scope = 'fixed_members';
    fill.row_ids = ['r-telecom', 'r-telecom2'];
    fill.expected_inputs = [
        {left: {content: {number: 120}, value: 120}, right: {content: {number: 100}, value: 100}},
        {left: {content: {formula: '=SUM(D2,E3)'}, value: 120}, right: {content: {number: 40}, value: 40}},
    ];

    // Filling D2 with 20 would bring C3 back to the approved 120.
    const rejected = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(rejected.ok ? null : rejected.error.code, 'precondition_failed');
    if (!rejected.ok) {
        assert.deepEqual(rejected.error.detail, {
            sheet_id: 'expenses', a1: 'C3', row_id: 'r-telecom2', operand: 'left', expected_value: 120, actual_value: 100,
        });
    }

    row3['2'] = {f: '=SUM(D2,E3)', t: 2, v: 100};
    row3['4'] = {t: 2, v: 120};
    (input.base as JsonObject).sha256 = sha256Canonical(workbook);
    const accepted = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.ok(accepted.ok && accepted.operation === 'apply', JSON.stringify(accepted));
    assert.deepEqual(accepted.checks.cells.map(({a1, value}) => ({a1, value})), [
        {a1: 'D2', value: 20},
        {a1: 'D3', value: 100},
    ]);
});

test('save() sorts native.resources by name then id', () => {
    const input = request('apply');
    const native = structuredClone((input.workbook as JsonObject).native) as JsonObject;
    const resources = native.resources as JsonObject[];
    native.resources = [...resources].reverse();
    const session = UniverWorkbookSession.open(native);
    try {
        const saved = session.save().resources as JsonObject[];
        const keys = saved.map(item => `${String(item.name)}\u0000${item.id ?? ''}`);
        const ordered = [...keys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        assert.deepEqual(keys, ordered);
        assert.ok(keys.length > 1);
        assert.notEqual(keys[0], keys[keys.length - 1]);
    } finally {
        session.dispose();
    }
});

test('executes set_boolean, structural row/column/sheet ops, format, merge/unmerge, and freeze in FORCED mode', async () => {
    const input = request('apply');
    const wb = input.workbook as JsonObject;
    (wb.native as JsonObject).locale = 'ruRU';
    const sheets = (wb.native as JsonObject).sheets as JsonObject;
    (sheets.detail as JsonObject).cellData = {
        '0': {'0': {t: 1, v: 'Flag'}, '1': {t: 1, v: 'X'}, '2': {t: 1, v: 'Y'}},
        '1': {'0': {t: 3, v: 0}, '1': {t: 2, v: 10}, '2': {t: 2, v: 20}},
        '2': {'0': {t: 3, v: 1}, '1': {t: 2, v: 30}, '2': {t: 2, v: 40}},
    };
    wb.tables = [{
        table_id: 't1', sheet_id: 'detail', header_row: 1,
        columns: [{column_id: 'flag', column: 1}, {column_id: 'x', column: 2}, {column_id: 'y', column: 3}],
        rows: [{row_id: 'r1', row: 2}, {row_id: 'r2', row: 3}],
    }];
    (input.base as JsonObject).sha256 = sha256Canonical(wb);
    input.commands = [
        {kind: 'set_boolean', sheet_id: 'detail', row: 2, column: 1, expected: {boolean: false}, value: true},
        {kind: 'set_formula', sheet_id: 'detail', row: 2, column: 4, expected: null, formula: '=AND(A2,B2=10)'},
        {kind: 'insert_column_before', sheet_id: 'detail', column: 2, count: 1},
        {kind: 'delete_column', sheet_id: 'detail', column: 2, count: 1},
        {kind: 'delete_row', sheet_id: 'detail', row: 3, count: 1},
        {kind: 'set_format', sheet_id: 'detail', start_row: 1, start_column: 1, end_row: 2, end_column: 2, format: {
            font: {bold: true, italic: true, size: 12, color: '#112233'},
            fill: '#EEEEEE',
            borders: {all: {style: 'thin', color: '#000000'}},
            alignment: {horizontal: 'right', vertical: 'middle', wrap: true},
            numFmt: '#,##0.00',
        }},
        {kind: 'merge_cells', sheet_id: 'detail', start_row: 4, start_column: 1, end_row: 5, end_column: 2},
        {kind: 'unmerge_cells', sheet_id: 'detail', start_row: 4, start_column: 1, end_row: 5, end_column: 2},
        {kind: 'set_freeze', sheet_id: 'detail', row_count: 1, column_count: 1},
        {kind: 'add_sheet', sheet_id: 'extra', name: 'Extra', index: 1, row_count: 20, column_count: 8},
        {kind: 'rename_sheet', sheet_id: 'extra', name: 'ExtraRenamed', expected_name: 'Extra'},
        {kind: 'delete_sheet', sheet_id: 'extra'},
    ];
    const res = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(res.ok, true, JSON.stringify(res));
    if (res.ok && res.operation === 'apply') {
        assert.equal(res.workbook.native.locale, 'ruRU');
        const boolCheck = res.checks.cells.find(c => c.sheet_id === 'detail' && c.a1 === 'A2');
        const formulaCheck = res.checks.cells.find(c => c.sheet_id === 'detail' && c.a1 === 'D2');
        assert.equal(boolCheck?.value, true);
        assert.equal(formulaCheck?.value, true);
        assert.deepEqual(res.workbook.tables[0].rows, [{row_id: 'r1', row: 2}]);
        const detailOut = (res.workbook.native.sheets as JsonObject).detail as JsonObject;
        assert.deepEqual(detailOut.freeze, {startRow: 1, startColumn: 1, ySplit: 1, xSplit: 1});
        assert.deepEqual(detailOut.mergeData, []);
    }
});

test('fill_formula supports add, multiply, divide, sum, average, if and safe template while rejecting unsafe templates', async () => {
    const baseReq = request('scope-changed');
    const wb = baseReq.workbook as JsonObject;
    const expenses = ((wb.native as JsonObject).sheets as JsonObject).expenses as JsonObject;
    expenses.cellData = {
        '0': {'0': {t: 1, v: 'Item'}, '1': {t: 2, v: 1}, '2': {t: 2, v: 2}, '3': {t: 2, v: 3}},
        '1': {'0': {t: 1, v: 'Tel'}, '1': {t: 2, v: 10}, '2': {t: 2, v: 20}},
        '2': {'0': {t: 1, v: 'Trv'}, '1': {t: 2, v: 5}, '2': {t: 2, v: 15}},
    };
    wb.tables = [{
        table_id: 'costs', sheet_id: 'expenses', header_row: 1,
        columns: [
            {column_id: 'plan', column: 2},
            {column_id: 'actual', column: 3},
            {column_id: 'delta', column: 4},
        ],
        rows: [{row_id: 'r1', row: 2}, {row_id: 'r2', row: 3}],
    }];
    (baseReq.base as JsonObject).sha256 = sha256Canonical(wb);

    for (const [expression, expectedValues] of [
        [{op: 'add', left_column_id: 'actual', right_column_id: 'plan'}, [30, 20]],
        [{op: 'multiply', left_column_id: 'actual', right_column_id: 'plan'}, [200, 75]],
        [{op: 'divide', left_column_id: 'actual', right_column_id: 'plan'}, [2, 3]],
        [{op: 'sum', column_ids: ['plan', 'actual']}, [30, 20]],
        [{op: 'average', column_ids: ['plan', 'actual']}, [15, 10]],
        [{op: 'if', condition: {left_column_id: 'actual', comparator: '>', right_value: 18}, then_column_id: 'actual', else_value: 0}, [20, 0]],
        [{op: 'template', template: '=({a}+{b})*2', params: {a: 'plan', b: 'actual'}}, [60, 40]],
    ] as const) {
        const req = JSON.parse(JSON.stringify(baseReq));
        req.commands = [{
            kind: 'fill_formula', sheet_id: 'expenses', table_id: 'costs', scope: 'fixed_members',
            row_ids: ['r1', 'r2'], destination_column_id: 'delta', expression, expected_destination: [null, null],
        }];
        const res = await processFrame(Buffer.from(JSON.stringify(req) + '\n'));
        assert.equal(res.ok, true, JSON.stringify(res));
        if (res.ok && res.operation === 'apply') {
            assert.deepEqual(res.checks.cells.map(c => c.value), expectedValues);
        }
    }

    for (const badTemplate of ['=A2+1', '=WEBSERVICE("https://x")', '={missing}+1']) {
        const badReq = JSON.parse(JSON.stringify(baseReq));
        badReq.commands = [{
            kind: 'fill_formula', sheet_id: 'expenses', table_id: 'costs', scope: 'fixed_members',
            row_ids: ['r1'], destination_column_id: 'delta',
            expression: {op: 'template', template: badTemplate, params: {a: 'plan'}},
            expected_destination: [null],
        }];
        assert.throws(() => decodeRequest(badReq), {code: 'invalid_message'});
    }
});

test('shifts value-based CF ranges on structural ops, allows untouched-sheet CF, and preserves SHEET_HYPER_LINK_PLUGIN', async () => {
    const input = request('apply');
    const wb = input.workbook as JsonObject;
    (wb.native as JsonObject).resources = [
        {name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: JSON.stringify({
            detail: [{rule: {type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 5}, ranges: [{startRow: 1, startColumn: 0, endRow: 3, endColumn: 1, rangeType: 0}], cfId: 'cf1', stopIfTrue: false}],
        })},
        {name: 'SHEET_HYPER_LINK_PLUGIN', data: '{}'},
    ];
    (input.base as JsonObject).sha256 = sha256Canonical(wb);
    input.commands = [{kind: 'insert_row_before', sheet_id: 'detail', row: 2, count: 1}];
    const res = await processFrame(Buffer.from(JSON.stringify(input) + '\n'));
    assert.equal(res.ok, true, JSON.stringify(res));
    if (res.ok && res.operation === 'apply') {
        const resList = res.workbook.native.resources as JsonObject[];
        const cf = resList.find(r => r.name === 'SHEET_CONDITIONAL_FORMATTING_PLUGIN');
        const parsed = JSON.parse(String(cf?.data));
        assert.equal(parsed.detail[0].ranges[0].startRow, 2);
        assert.equal(parsed.detail[0].ranges[0].endRow, 4);
        assert.ok(resList.some(r => r.name === 'SHEET_HYPER_LINK_PLUGIN'));
    }
});
