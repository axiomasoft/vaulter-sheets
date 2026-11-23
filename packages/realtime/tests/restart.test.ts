import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {CanceledError, CommandType, type CommandListener, type IExecutionOptions} from '@univerjs/core';
import {InsertRowMutation, SetRangeValuesMutation} from '@univerjs/sheets';
import {SetCellEditVisibleOperation} from '@univerjs/sheets-ui';
import {WebSocket, WebSocketServer} from 'ws';
import {replay} from '../src/replay.ts';
import {connectNativeWorkbook, shiftDraftRow} from '../src/native-adapter.ts';
import {WEBSOCKET_SUBPROTOCOL, type ClientMessage, type WorkbookRoomState} from '../src/protocol.ts';
import {createRealtimeServer} from '../src/server.ts';

const {workbook} = JSON.parse(readFileSync(new URL('../../runtime/tests/fixtures/apply-request.json', import.meta.url), 'utf8'));
const marker = {generation: 2, position: 9, sha256: 'a'.repeat(64)};
const initial: WorkbookRoomState = {generation: 2, seq: 0, etag: '"9.2.9"', marker, workbook, insertions: []};

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for room activity');
}

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

async function nativeRoom(t: TestContext) {
    const peer = new WebSocketServer({port: 0, host: '127.0.0.1'});
    await once(peer, 'listening');
    const address = peer.address();
    assert.ok(address && typeof address !== 'string');
    const shifted = structuredClone(workbook);
    shifted.native.sheets.detail.cellData['4'] = {'2': {v: 5, t: 2}};
    shifted.native.sheets.detail.cellData['3'] = {'2': {v: 5, t: 2}};
    delete shifted.native.sheets.detail.cellData['2'];
    const base = structuredClone(workbook);
    base.native.sheets.detail.cellData['3'] = {'2': {v: 5, t: 2}};
    let state = {...initial, workbook: base};
    let socket: WebSocket;
    const messages: Extract<ClientMessage, {type: 'intent'}>[] = [];
    peer.on('connection', connection => {
        socket = connection;
        connection.on('message', bytes => {
            const message: ClientMessage = JSON.parse(bytes.toString());
            if (message.type === 'open') connection.send(JSON.stringify({type: 'state', state}));
            else messages.push(message);
        });
    });
    let before!: CommandListener;
    let after!: CommandListener;
    let draftOpen = false;
    let conflicts = 0;
    let displayed = base;
    let replacements = 0;
    type EditLocation = ReturnType<NonNullable<Parameters<typeof connectNativeWorkbook>[0]['editor']>['getEditLocation']>;
    const editLocation = {unitId: 'budget-probe', sheetId: 'detail', row: 2, column: 2};
    const binding = connectNativeWorkbook({
        unitId: 'budget-probe',
        commands: {
            beforeCommandExecuted(listener) { before = listener; return {dispose() {}}; },
            onCommandExecuted(listener) { after = listener; return {dispose() {}}; },
            async executeCommand(id, params) {
                if (id === InsertRowMutation.id) displayed = shifted;
                if (id === SetCellEditVisibleOperation.id) {
                    assert.deepEqual(params, {unitId: 'budget-probe', visible: false, eventType: 4, keycode: 27});
                    draftOpen = false;
                }
                return true;
            },
        },
        editor: {
            getEditLocation: () => editLocation as EditLocation,
            isVisible: () => ({visible: draftOpen, unitId: 'budget-probe', eventType: 4}),
            updateEditLocation: (row, column) => { Object.assign(editLocation, {row, column}); },
            refreshEditCellPosition() {},
        },
        readCell: (_sheet, row, column) => {
            const cell = displayed.native.sheets.detail.cellData[row]?.[column];
            return cell ? {number: cell.v} : null;
        },
        replace(next) { displayed = next; replacements++; },
        onDraftConflict: () => { conflicts++; },
    }, {session: async () => ({endpoint: `ws://127.0.0.1:${address.port}`, token: 'fixture', generation: 2, mode: 'write'})});
    t.after(() => {
        binding.dispose();
        for (const connection of peer.clients) connection.terminate();
        peer.close();
    });
    await waitFor(() => replacements > 0);
    return {
        messages, client: binding.client, conflicts: () => conflicts,
        displayed: () => displayed,
        edit(row: number, value: number) {
            const mutation = {id: SetRangeValuesMutation.id, type: CommandType.MUTATION, params: {
                unitId: 'budget-probe', subUnitId: 'detail', cellValue: {[row]: {2: {v: value, t: 2}}},
            }};
            before(mutation);
            after(mutation);
        },
        openDraft(row: number) { editLocation.row = row; draftOpen = true; },
        commitDraft(value: number) {
            if (draftOpen) this.edit(editLocation.row, value);
        },
        draftOpen: () => draftOpen,
        async advance(seq: number, insertions: WorkbookRoomState['insertions'], reconnect = false) {
            const previous = replacements;
            state = {...state, seq, insertions, etag: `"9.2.${9 + seq}"`, workbook: shifted};
            if (reconnect) socket.terminate();
            else {
                socket.send(JSON.stringify({type: 'ack', receipt: {command_id: messages[0].intent.command_id, seq}}));
                socket.send(JSON.stringify({type: 'state', state}));
            }
            await waitFor(() => replacements > previous && binding.client.state?.seq === seq);
        },
    };
}

test('rejects a positional edit based on an optimistic insertion, then writes against the confirmed row', {timeout: 5000}, async t => {
    const room = await nativeRoom(t);
    const insertion = {kind: 'insert_row_before', sheet_id: 'detail', row: 3, count: 1} as const;
    const edit = {kind: 'set_number', sheet_id: 'detail', row: 4, column: 3, value: 8, expected: {number: 5}} as const;
    room.client.submit([insertion], 'exact_base');
    await waitFor(() => room.messages.length === 1 && !room.displayed().native.sheets.detail.cellData['2']);
    assert.equal(room.displayed().native.sheets.detail.cellData['3']['2'].v, 5);
    assert.equal(room.displayed().native.sheets.detail.cellData['4']['2'].v, 5);
    assert.throws(() => room.edit(3, 8), CanceledError);
    assert.throws(() => room.client.submit([edit], 'rebase_cells'), /pending row insertion/i);
    room.openDraft(3);
    await room.advance(1, [insertion]);
    assert.equal(room.draftOpen(), false);
    room.edit(3, 8);
    await waitFor(() => room.messages.length === 2);
    assert.equal(room.messages[1].if_match, room.client.state?.etag);
    assert.deepEqual(room.messages[1].intent.commands, [edit]);
});

test('discards a retained editor draft when a reconnect cannot recover row history', {timeout: 5000}, async t => {
    const room = await nativeRoom(t);
    room.openDraft(2);
    await room.advance(65, null, true);
    room.commitDraft(8);
    assert.equal(room.draftOpen(), false);
    assert.equal(room.conflicts(), 1);
    room.openDraft(3);
    room.commitDraft(9);
    await waitFor(() => room.messages.length > 0);
    assert.deepEqual(room.messages[0].intent.commands,
        [{kind: 'set_number', sheet_id: 'detail', row: 4, column: 3, expected: {number: 5}, value: 9}]);
});

test('renews the same owner fence during a slow append and stops after the receipt', {timeout: 28000}, async t => {
    const leaseMs = 15_000;
    let expires = 0;
    let seq = 0;
    let renewAttempts = 0;
    let renewals = 0;
    let ownerId: string;
    const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');
    const owner = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const reply = (data: object, status = 200) => response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(data));
        switch (request.url) {
            case '/read': return reply({generation: 2, head_seq: seq, checkpoint_seq: seq, checkpoint, marker, etag: initial.etag, tail: [], insertions: []});
            case '/acquire':
                ownerId = body.owner_id;
                expires = performance.now() + leaseMs;
                return reply({owner_fence: 7, head_seq: seq});
            case '/renew':
                if (++renewAttempts === 2) return reply({code: 'room_unavailable'}, 503);
                if (body.owner_id !== ownerId || body.owner_fence !== 7 || performance.now() >= expires) return reply({code: 'stale_owner'}, 409);
                expires = performance.now() + leaseMs;
                renewals++;
                return reply({owner_fence: 7});
            case '/append':
                await new Promise(resolve => setTimeout(resolve, 16_000));
                if (body.owner_id !== ownerId || body.owner_fence !== 7 || performance.now() >= expires) return reply({code: 'stale_owner'}, 409);
                return reply({state: 'committed', command_id: body.intent.command_id, seq: ++seq, marker, etag: initial.etag});
            default: return reply({}, 404);
        }
    });
    owner.listen(0, '127.0.0.1');
    t.after(() => { owner.close(); owner.closeAllConnections(); });
    await once(owner, 'listening');
    const ownerAddress = owner.address();
    assert.ok(ownerAddress && typeof ownerAddress !== 'string');
    const app = createRealtimeServer({ownerUrl: `http://127.0.0.1:${ownerAddress.port}`, ownerToken: 'x'.repeat(32)});
    app.server.listen(0, '127.0.0.1');
    t.after(app.close);
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/fixture`, WEBSOCKET_SUBPROTOCOL);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const first = once(socket, 'message');
    socket.send(JSON.stringify({type: 'open', token: 'fixture'}));
    assert.equal(JSON.parse((await first)[0].toString()).type, 'state');
    const result = Promise.race([
        once(socket, 'message').then(([bytes]) => JSON.parse(bytes.toString())),
        once(socket, 'close').then(([code, reason]) => ({code, reason: reason.toString()})),
    ]);
    socket.send(JSON.stringify({type: 'intent', if_match: initial.etag, intent: {
        command_id: 'slow', expected_generation: 2, policy: 'rebase_cells',
        commands: [{kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, expected: {number: 5}, value: 8}],
    }}));
    const receipt = await result;
    assert.equal(receipt.type, 'ack', JSON.stringify(receipt));
    assert.equal(receipt.receipt.command_id, 'slow');
    assert.ok(renewals > 1);
    const afterReceipt = renewAttempts;
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(renewAttempts, afterReceipt);
});
