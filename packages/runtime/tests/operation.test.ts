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
