import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
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
