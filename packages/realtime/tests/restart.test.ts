import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CommandType, type CommandListener, type IExecutionOptions} from '@univerjs/core';
import {SetRangeValuesMutation} from '@univerjs/sheets';
import {WebSocketServer} from 'ws';
import {replay} from '../src/replay.ts';
import {connectNativeWorkbook, shiftDraftRow} from '../src/native-adapter.ts';

const {workbook} = JSON.parse(readFileSync(new URL('../../runtime/tests/fixtures/apply-request.json', import.meta.url), 'utf8'));

test('replays a verified tail after restart and fails closed on gaps or altered bytes', () => {
    const next = structuredClone(workbook);
    next.native.sheets.detail.cellData['2']['2'].v = 8;
    const payload = Buffer.from(JSON.stringify({workbook: next, commands: [{kind: 'set_number'}], update_id: 'op-1'}));
    const update = {seq: 4, update_id: 'op-1', payload: payload.toString('base64'), sha256: createHash('sha256').update(payload).digest('hex')};
    const log = {
        generation: 2, head_seq: 4, checkpoint_seq: 3,
        checkpoint: Buffer.from(JSON.stringify({workbook, update_id: 'op-0'})).toString('base64'),
        marker: {generation: 2, position: 9, sha256: 'a'.repeat(64)}, etag: '"9.2.9"', tail: [update], insertions: [],
    };
    assert.deepEqual(replay(log).workbook, next);
    assert.throws(() => replay({...log, tail: []}), /incomplete/);
    assert.throws(() => replay({...log, tail: [{...update, seq: 5}]}), /gap/);
    assert.throws(() => replay({...log, tail: [{...update, sha256: '0'.repeat(64)}]}), /identity mismatch/);
});

test('moves an active editor only for rows at or below an insertion on its sheet', () => {
    const effects = [{sheet_id: 'detail', row: 3, count: 1}, {sheet_id: 'summary', row: 1, count: 20}];
    assert.equal(shiftDraftRow('detail', 2, effects), 3);
    assert.equal(shiftDraftRow('detail', 1, effects), 1);
});

test('captures the prior cell value and suppresses local-only and echoed mutations', {timeout: 5000}, async () => {
    const peer = new WebSocketServer({port: 0, host: '127.0.0.1'});
    await once(peer, 'listening');
    const address = peer.address();
    assert.ok(address && typeof address !== 'string');
    const state = {generation: 2, seq: 0, etag: '"9.2.9"', marker: {generation: 2, position: 9, sha256: 'a'.repeat(64)}, workbook, insertions: []};
    const intents: unknown[] = [];
    peer.on('connection', socket => socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'open') {
            socket.send(JSON.stringify({type: 'state', state}));
            return;
        }
        intents.push(message.intent);
    }));

    let before: CommandListener | undefined;
    let after: CommandListener | undefined;
    let displayedValue = 5;
    const optimistic: IExecutionOptions[] = [];
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const binding = connectNativeWorkbook({
        unitId: 'budget-probe',
        commands: {
            beforeCommandExecuted(listener) { before = listener; return {dispose() { before = undefined; }}; },
            onCommandExecuted(listener) { after = listener; return {dispose() { after = undefined; }}; },
            async executeCommand(_id, _params, flags) { optimistic.push(flags); return true; },
        },
        readCell: () => ({number: displayedValue}),
        replace(_workbook, flags) { assert.equal(flags.fromCollab, true); opened(); },
    }, {session: async () => ({endpoint: `ws://127.0.0.1:${address.port}`, token: 'fixture', generation: 2, mode: 'write'})});
    try {
        await ready;
        await new Promise<void>(resolve => setImmediate(resolve));
        const mutation = {id: SetRangeValuesMutation.id, type: CommandType.MUTATION, params: {
            unitId: 'budget-probe', subUnitId: 'detail', cellValue: {2: {2: {v: 8, t: 2}}},
        }};
        for (const flags of [{fromCollab: true}, {onlyLocal: true}]) { before?.(mutation, flags); after?.(mutation, flags); }
        before?.(mutation);
        displayedValue = 8;
        after?.(mutation);
        for (let attempt = 0; attempt < 40 && (intents.length === 0 || optimistic.length === 0); attempt++) {
            await new Promise<void>(resolve => setTimeout(resolve, 20));
        }
        assert.equal(intents.length, 1);
        assert.deepEqual((intents[0] as {commands: unknown; policy: string}).commands,
            [{kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, expected: {number: 5}, value: 8}]);
        assert.deepEqual(optimistic, [{fromCollab: true, onlyLocal: true}]);
    } finally {
        binding.dispose();
        for (const client of peer.clients) client.terminate();
        peer.close();
    }
});
