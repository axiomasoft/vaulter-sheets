import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {WIRE_PROFILE} from '../src/profile.ts';
import type {JsonObject} from '../src/protocol.ts';
import {
    encodeExchangeStreamFrame, getMaxExchangeBinaryBytes, processExchangeFrame,
} from '../src/exchange/worker.ts';

// The exchange worker takes a request from the PHP host either as one JSON line or as a VX01 binary frame,
// and refuses anything it cannot read before an import or export starts. Each refusal is an `ok: false`
// answer with a stable code (never a thrown error), echoing the request id once it could be read.

const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const csv = Buffer.from('a,b\n1,2\n', 'utf8');
const workbook = {...JSON.parse(readFileSync(new URL('./fixtures/apply-request.json', import.meta.url), 'utf8')).workbook, profile: WIRE_PROFILE};
const both = ['csv', 'xlsx'] as const;

function request(overrides: JsonObject = {}, input: Buffer = csv): JsonObject {
    return {
        version: 1, request_id: 'req', operation: 'import', format: 'csv', profile_id: WIRE_PROFILE.id,
        input_b64: input.toString('base64'), input_sha256: sha256Hex(input), options: {}, ...overrides,
    };
}

const line = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + '\n', 'utf8');

async function refusal(frame: Buffer): Promise<{code: string; requestId: string | null}> {
    const response = await processExchangeFrame(frame, both);
    assert.equal(response.ok, false, `accepted: ${frame.subarray(0, 120).toString()}`);
    return {code: response.ok ? '' : response.error.code, requestId: response.request_id};
}

test('a JSON-line request is one LF-terminated, valid UTF-8 line', async () => {
    assert.equal((await processExchangeFrame(line(request()), both)).ok, true);
    assert.deepEqual(await refusal(Buffer.from(JSON.stringify(request()) + ' ', 'utf8')), {code: 'invalid_message', requestId: null});
    assert.equal((await refusal(Buffer.from(JSON.stringify(request()) + '\r\n', 'utf8'))).code, 'invalid_message');
    assert.equal((await refusal(Buffer.from('{"version":1,\n"request_id":"x"}\n', 'utf8'))).code, 'invalid_message');
    assert.equal((await refusal(Buffer.concat([Buffer.from('{"request_id":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]))).code, 'invalid_message');
    assert.equal((await refusal(Buffer.from('{"version":1,\n'))).code, 'invalid_message');
});

test('the request envelope is closed: unknown fields, versions, operations and formats are refused with the request id', async () => {
    const cases: [JsonObject, string][] = [
        [{extra: true}, 'invalid_message'],
        [{version: 2}, 'unsupported_version'],
        [{request_id: ''}, 'invalid_message'],
        [{request_id: 'r'.repeat(129)}, 'invalid_message'],
        [{operation: 'convert'}, 'invalid_message'],
        [{format: 'ods'}, 'invalid_message'],
        [{profile_id: ''}, 'invalid_message'],
        [{profile_id: 'univer-oss-basic-0'}, 'profile_mismatch'],
        [{input_b64: 7}, 'invalid_message'],
        [{input_sha256: sha256Hex(csv).toUpperCase()}, 'invalid_message'],
        [{options: []}, 'invalid_message'],
        [{input_b64: 'YSxi\n'}, 'invalid_message'],
        [{input_b64: 'YSx'}, 'invalid_message'],
        [{input_sha256: '0'.repeat(64)}, 'base_mismatch'],
    ];
    for (const [overrides, code] of cases) {
        const {code: actual, requestId} = await refusal(line(request(overrides)));
        assert.equal(actual, code, JSON.stringify(overrides));
        if (typeof (overrides.request_id ?? 'req') === 'string') assert.equal(requestId, overrides.request_id ?? 'req');
    }
    assert.equal((await processExchangeFrame(line(request()), ['xlsx'])).ok, false);
    assert.equal((await refusal(line([request()]))).code, 'invalid_message');
});

test('an export takes only a v2 workbook of the served profile', async () => {
    const exportOf = (input: Buffer) => line(request({operation: 'export'}, input));
    assert.equal((await processExchangeFrame(exportOf(Buffer.from(JSON.stringify(workbook))), both)).ok, true);
    assert.equal((await refusal(exportOf(Buffer.from([0xff, 0xfe])))).code, 'invalid_message');
    assert.equal((await refusal(exportOf(Buffer.from('[1]')))).code, 'invalid_message');
    assert.equal((await refusal(exportOf(Buffer.from(JSON.stringify({...workbook, format_version: 1}))))).code, 'unsupported_content');
    assert.equal((await refusal(exportOf(Buffer.from(JSON.stringify({...workbook, native: []}))))).code, 'unsupported_content');
    assert.equal((await refusal(exportOf(Buffer.from(JSON.stringify({...workbook, profile: {...workbook.profile, id: 'other'}}))))).code, 'profile_mismatch');
});

test('a VX01 frame carries the request as metadata and the input as raw bytes after it', async () => {
    const meta = request();
    delete meta.input_b64;
    const ok = await processExchangeFrame(encodeExchangeStreamFrame(meta, csv), both);
    assert.equal(ok.ok, true);
    assert.equal(ok.request_id, 'req');

    assert.equal((await refusal(encodeExchangeStreamFrame({...meta, input_sha256: '0'.repeat(64)}, csv))).code, 'base_mismatch');
    const frame = encodeExchangeStreamFrame(meta, csv);
    const short = Buffer.from(frame);
    short.writeUInt32BE(1, 4);
    assert.equal((await refusal(short)).code, 'invalid_message');
    const long = Buffer.from(frame);
    long.writeUInt32BE(frame.length, 4);
    assert.equal((await refusal(long)).code, 'invalid_message');
    assert.equal((await refusal(Buffer.from('VX01'))).code, 'invalid_message');
    assert.equal((await refusal(Buffer.concat([Buffer.from('VX01'), Buffer.alloc(4), Buffer.alloc(getMaxExchangeBinaryBytes() + 8 * 1024 * 1024)]))).code, 'limit_exceeded');
});

test('SHEETS_EXCHANGE_MAX_BYTES is clamped to 1 MiB .. 128 MiB and falls back to 32 MiB', () => {
    const before = process.env.SHEETS_EXCHANGE_MAX_BYTES;
    const at = (value: string | undefined) => {
        if (value === undefined) delete process.env.SHEETS_EXCHANGE_MAX_BYTES;
        else process.env.SHEETS_EXCHANGE_MAX_BYTES = value;
        return getMaxExchangeBinaryBytes();
    };
    try {
        assert.equal(at(undefined), 32 * 1024 * 1024);
        assert.equal(at('2097152.9'), 2 * 1024 * 1024);
        assert.equal(at(String(1024 * 1024 - 1)), 32 * 1024 * 1024);
        assert.equal(at('lots'), 32 * 1024 * 1024);
        assert.equal(at(String(512 * 1024 * 1024)), 128 * 1024 * 1024);
    } finally {
        at(before);
    }
});
