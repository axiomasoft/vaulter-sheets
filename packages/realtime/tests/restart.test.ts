import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {CanceledError, CommandType, type CommandListener, type IExecutionOptions} from '@univerjs/core';
import {
    AddWorksheetMergeMutation, InsertRowMutation, SetFrozenMutation, SetRangeValuesMutation,
} from '@univerjs/sheets';
import {SetCellEditVisibleOperation} from '@univerjs/sheets-ui';
import {WebSocket, WebSocketServer} from 'ws';
import {replay} from '../src/replay.ts';
import {connectNativeWorkbook, shiftDraftRow} from '../src/native-adapter.ts';
import {WEBSOCKET_SUBPROTOCOL, type ClientMessage, type WorkbookRoomState} from '../src/protocol.ts';
import {createRealtimeServer, proxyList} from '../src/server.ts';

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

test('broadcasts awareness presence between peers and removes on disconnect', {timeout: 5000}, async t => {
    const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');
    const owner = createServer(async (request, response) => {
        const reply = (data: object) => response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(data));
        if (request.url === '/read') return reply({generation: 2, head_seq: 0, checkpoint_seq: 0, checkpoint, marker, etag: initial.etag, tail: [], insertions: []});
        return reply({}, 404);
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

    const peersA: unknown[] = [];
    const peersB: unknown[] = [];
    const {WorkbookRoomClient} = await import('../src/client.ts');
    const clientA = new WorkbookRoomClient({
        session: async () => ({endpoint: `ws://127.0.0.1:${address.port}/v1/rooms/aw`, token: 'tokA', generation: 2, mode: 'write'}),
        onState: () => {},
        onAwareness: peers => { peersA.push([...peers]); },
    });
    const clientB = new WorkbookRoomClient({
        session: async () => ({endpoint: `ws://127.0.0.1:${address.port}/v1/rooms/aw`, token: 'tokB', generation: 2, mode: 'write'}),
        onState: () => {},
        onAwareness: peers => { peersB.push([...peers]); },
    });
    t.after(() => { clientA.close(); clientB.close(); });
    clientA.connect();
    clientB.connect();
    await waitFor(() => Boolean(clientA.state && clientB.state));

    clientA.updateAwareness({client_id: 'c-a', user: {name: 'Alice', color: '#2563eb'}, selection: {sheet_id: 'detail', start_row: 2, start_column: 2, end_row: 3, end_column: 4}});
    await waitFor(() => peersB.some(list => Array.isArray(list) && list.length === 1));
    // The room names the socket; the client's own client_id is not passed on.
    assert.match((peersB.at(-1) as {client_id: string}[])[0].client_id, /^[0-9a-f-]{36}$/);

    clientA.close();
    await waitFor(() => Array.isArray(peersB.at(-1)) && (peersB.at(-1) as unknown[]).length === 0);
});

test('an opening peer never rides on another peer\'s read: its own token is checked', {timeout: 5000}, async t => {
    const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');
    const log = {generation: 2, head_seq: 0, checkpoint_seq: 0, checkpoint, marker, etag: initial.etag, tail: [], insertions: []};
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const readers: string[] = [];
    const owner = createServer(async (request, response) => {
        const reply = (status: number, data: object) => response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(data));
        if (request.url !== '/read') return reply(404, {});
        const bearer = request.headers.authorization ?? '';
        readers.push(bearer);
        if (bearer !== 'Bearer valid') return reply(403, {code: 'forbidden'});
        await held;
        return reply(200, log);
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

    const open = async (token: string) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/shared`, WEBSOCKET_SUBPROTOCOL);
        const types: string[] = [];
        let closed = false;
        socket.on('message', data => { types.push(String(JSON.parse(data.toString()).type)); });
        socket.on('close', () => { closed = true; });
        t.after(() => socket.terminate());
        await once(socket, 'open');
        socket.send(JSON.stringify({type: 'open', token}));
        return {types, isClosed: () => closed};
    };
    const valid = await open('valid');
    await waitFor(() => readers.length === 1);
    // The valid peer's read is held open; a forged token joins while it is in flight.
    const forged = await open('forged');
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    release();

    await waitFor(() => valid.types.includes('state') && forged.isClosed());
    assert.ok(readers.includes('Bearer forged'), 'the forged token was sent to the owner');
    assert.ok(!forged.types.includes('state'), 'the forged peer received no room state');
});

/** A room token as the PHP owner issues it, as far as the room process reads it (header and signature unchecked). */
function roomToken(claims: Record<string, unknown>): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({alg: 'HS256', typ: 'JWT'})}.${part(claims)}.signature`;
}

async function startRoomServer(t: TestContext, handle: (bearer: string) => {status: number; body: object}, timing: {refreshMs?: number; revalidateMs?: number} = {}) {
    const owner = createServer((request, response) => {
        const {status, body} = request.url === '/read' ? handle(request.headers.authorization ?? '') : {status: 404, body: {}};
        response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
    });
    owner.listen(0, '127.0.0.1');
    t.after(() => { owner.close(); owner.closeAllConnections(); });
    await once(owner, 'listening');
    const ownerAddress = owner.address();
    assert.ok(ownerAddress && typeof ownerAddress !== 'string');
    const app = createRealtimeServer({ownerUrl: `http://127.0.0.1:${ownerAddress.port}`, ownerToken: 'x'.repeat(32), ...timing});
    app.server.listen(0, '127.0.0.1');
    t.after(app.close);
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    return async (token: string) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/guarded`, WEBSOCKET_SUBPROTOCOL);
        const types: string[] = [];
        let closeCode: number | null = null;
        socket.on('message', data => { types.push(String(JSON.parse(data.toString()).type)); });
        socket.on('close', code => { closeCode = code; });
        t.after(() => socket.terminate());
        await once(socket, 'open');
        socket.send(JSON.stringify({type: 'open', token}));
        return {types, closeCode: () => closeCode};
    };
}

function roomLog(): object {
    const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');
    return {generation: 2, head_seq: 0, checkpoint_seq: 0, checkpoint, marker, etag: initial.etag, tail: [], insertions: []};
}

test('closes a peer with 4001 when its room token expires', {timeout: 5000}, async t => {
    const open = await startRoomServer(t, () => ({status: 200, body: roomLog()}));
    const peer = await open(roomToken({exp: Math.floor(Date.now() / 1000) + 1}));
    await waitFor(() => peer.types.includes('state'));
    assert.equal(peer.closeCode(), null, 'the peer is served while its token lives');
    for (let attempt = 0; attempt < 150 && peer.closeCode() === null; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    assert.equal(peer.closeCode(), 4001);
});

test('re-checks every peer with its own token and drops a revoked one, not only the first peer', {timeout: 8000}, async t => {
    const revoked = new Set<string>();
    const reads = new Map<string, number>();
    const open = await startRoomServer(t, bearer => {
        reads.set(bearer, (reads.get(bearer) ?? 0) + 1);
        return revoked.has(bearer) ? {status: 401, body: {code: 'room_credential_invalid'}} : {status: 200, body: roomLog()};
    }, {refreshMs: 100, revalidateMs: 300});

    const first = await open('first');
    await waitFor(() => first.types.includes('state'));
    const second = await open('second');
    await waitFor(() => second.types.includes('state'));
    revoked.add('Bearer second');
    const before = reads.get('Bearer second') ?? 0;

    await waitFor(() => second.closeCode() !== null);
    assert.equal(second.closeCode(), 4403, 'the revoked peer is closed as "Room access ended"');
    assert.ok((reads.get('Bearer second') ?? 0) > before, 'its own token was sent to the owner again');
    assert.equal(first.closeCode(), null, 'the peer whose token is still valid stays');
});

test('captures format, freeze, and merge mutations in connectNativeWorkbook', {timeout: 5000}, async t => {
    const peer = new WebSocketServer({port: 0, host: '127.0.0.1'});
    await once(peer, 'listening');
    const address = peer.address();
    assert.ok(address && typeof address !== 'string');
    const intents: {commands: unknown[]; policy: string}[] = [];
    peer.on('connection', socket => socket.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'open') socket.send(JSON.stringify({type: 'state', state: initial}));
        else if (message.type === 'intent') intents.push(message.intent);
    }));
    let before: CommandListener | undefined;
    let after: CommandListener | undefined;
    let readyResolve!: () => void;
    const ready = new Promise<void>(resolve => { readyResolve = resolve; });
    const binding = connectNativeWorkbook({
        unitId: 'wb',
        commands: {
            beforeCommandExecuted(l) { before = l; return {dispose() {}}; },
            onCommandExecuted(l) { after = l; return {dispose() {}}; },
            async executeCommand() { return true; },
        },
        readCell: () => null,
        replace() { readyResolve(); },
    }, {session: async () => ({endpoint: `ws://127.0.0.1:${address.port}`, token: 'fixture', generation: 2, mode: 'write'})});
    t.after(() => {
        binding.dispose();
        for (const client of peer.clients) client.terminate();
        peer.close();
    });
    await ready;
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    const mutations = [
        {id: SetRangeValuesMutation.id, type: CommandType.MUTATION, params: {unitId: 'wb', subUnitId: 'detail', cellValue: {1: {1: {s: {bl: 1}}}}}},
        {id: SetFrozenMutation.id, type: CommandType.MUTATION, params: {unitId: 'wb', subUnitId: 'detail', startRow: 1, startColumn: 0, ySplit: 1, xSplit: 0}},
        {id: AddWorksheetMergeMutation.id, type: CommandType.MUTATION, params: {unitId: 'wb', subUnitId: 'detail', ranges: [{startRow: 0, startColumn: 0, endRow: 0, endColumn: 1}]}},
    ];
    // The room client keeps one intent in flight until the peer acknowledges it, so the wire shows only
    // the first intent; the translated commands are read where the adapter submits them. Each submit
    // re-renders the pending view and the adapter cancels a mutation that arrives before that render
    // lands, so the mutations are applied one settled render at a time.
    const submitted: unknown[] = [];
    const submit = binding.client.submit.bind(binding.client);
    binding.client.submit = (...args: Parameters<typeof submit>) => {
        submitted.push(args[0]);
        return submit(...args);
    };
    for (const [index, m] of mutations.entries()) {
        before?.(m);
        after?.(m);
        await waitFor(() => submitted.length === index + 1);
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    await waitFor(() => intents.length === 1);
    assert.deepEqual(submitted, [
        [{kind: 'set_format', sheet_id: 'detail', start_row: 2, start_column: 2, end_row: 2, end_column: 2, format: {font: {bold: true}}}],
        [{kind: 'set_freeze', sheet_id: 'detail', row_count: 1, column_count: 0}],
        [{kind: 'merge_cells', sheet_id: 'detail', start_row: 1, start_column: 1, end_row: 1, end_column: 2}],
    ]);
    assert.deepEqual(intents[0].commands, submitted[0]);
});

/** A socket on the guarded room of `startRoomServer`'s process that never presents a credential. */
async function squat(t: TestContext, port: number, room: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/rooms/${room}`, WEBSOCKET_SUBPROTOCOL, {headers});
    t.after(() => socket.terminate());
    await once(socket, 'open');
    return socket;
}

async function startOpenRoomServer(t: TestContext, limits: {pendingPerAddress?: number; trustedProxies?: string[]} = {}) {
    const owner = createServer((request, response) => {
        response.writeHead(request.url === '/read' ? 200 : 404, {'Content-Type': 'application/json'}).end(JSON.stringify(request.url === '/read' ? roomLog() : {}));
    });
    owner.listen(0, '127.0.0.1');
    t.after(() => { owner.close(); owner.closeAllConnections(); });
    await once(owner, 'listening');
    const ownerAddress = owner.address();
    assert.ok(ownerAddress && typeof ownerAddress !== 'string');
    const app = createRealtimeServer({ownerUrl: `http://127.0.0.1:${ownerAddress.port}`, ownerToken: 'x'.repeat(32), ...limits});
    app.server.listen(0, '127.0.0.1');
    t.after(app.close);
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const open = async (room: string, token: string, headers: Record<string, string> = {}) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/${room}`, WEBSOCKET_SUBPROTOCOL, {headers});
        const messages: {type: string; peers?: {selection?: {end_row: number}}[]}[] = [];
        let closeCode: number | null = null;
        let refused = false;
        socket.on('message', data => { messages.push(JSON.parse(data.toString())); });
        socket.on('close', code => { closeCode = code; });
        socket.on('error', () => { refused = true; });
        t.after(() => socket.terminate());
        await new Promise<void>(resolve => {
            socket.once('open', () => resolve());
            socket.once('close', () => resolve());
            // A refused upgrade: ws emits only this event once a listener is attached.
            socket.once('unexpected-response', request => { refused = true; request.destroy(); resolve(); });
        });
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'open', token}));
        return {socket, messages, closeCode: () => closeCode, refused: () => refused, has: (type: string) => messages.some(m => m.type === type)};
    };
    return {port: address.port, open};
}

test('sockets without a credential do not take a room\'s peer slots', {timeout: 8000}, async t => {
    const {port, open} = await startOpenRoomServer(t, {pendingPerAddress: 64});
    for (let i = 0; i < 32; i++) await squat(t, port, 'squatted');

    const peer = await open('squatted', 'valid');
    await waitFor(() => peer.has('state') || peer.refused());
    assert.equal(peer.refused(), false, 'the upgrade was not refused');
    assert.ok(peer.has('state'), 'the credentialed peer is served');
});

test('a room serves at most 32 admitted peers, also when they open together', {timeout: 8000}, async t => {
    const {open} = await startOpenRoomServer(t);
    const peers = await Promise.all(Array.from({length: 33}, (_, i) => open('crowded', `t${i}`)));
    await waitFor(() => peers.every(p => p.has('state') || p.closeCode() !== null || p.refused()));

    assert.equal(peers.filter(p => p.has('state')).length, 32);
    const turnedAway = peers.filter(p => !p.has('state'));
    assert.equal(turnedAway.length, 1);
    assert.ok(turnedAway[0].refused() || turnedAway[0].closeCode() === 1013);
});

test('presence changes are sent on once per interval, the latest one included', {timeout: 8000}, async t => {
    const {open} = await startOpenRoomServer(t);
    const sender = await open('presence', 'a');
    const watcher = await open('presence', 'b');
    await waitFor(() => sender.has('state') && watcher.has('state'));

    for (let row = 1; row <= 200; row++) {
        sender.socket.send(JSON.stringify({type: 'awareness', client_id: 'c-a', selection: {sheet_id: 'detail', start_row: 1, start_column: 1, end_row: row, end_column: 1}}));
    }
    const latest = () => watcher.messages.filter(m => m.type === 'awareness').at(-1)?.peers?.[0]?.selection?.end_row;
    await waitFor(() => latest() === 200);
    await new Promise<void>(resolve => setTimeout(resolve, 200));

    const broadcasts = watcher.messages.filter(m => m.type === 'awareness').length;
    assert.ok(broadcasts <= 10, `200 changes were sent on as ${broadcasts} broadcasts`);
    assert.equal(latest(), 200);
});

test('one client address holds at most its pending sockets; admitted peers and other addresses are not limited', {timeout: 8000}, async t => {
    const {port, open} = await startOpenRoomServer(t, {pendingPerAddress: 4});
    for (let i = 0; i < 4; i++) await squat(t, port, `idle-${i}`);

    const refused = await open('work', 'valid');
    assert.equal(refused.refused(), true, 'a fifth pending socket from the address is refused');

    const {port: proxied, open: openProxied} = await startOpenRoomServer(t, {pendingPerAddress: 4, trustedProxies: ['127.0.0.0/8']});
    for (let i = 0; i < 4; i++) await squat(t, proxied, `idle-${i}`, {'X-Forwarded-For': '198.51.100.7'});
    const blocked = await openProxied('work', 'valid', {'X-Forwarded-For': '198.51.100.7'});
    assert.equal(blocked.refused(), true, 'the forwarded client is the one limited');
    // A spoofed left-most hop does not move the client to a fresh address.
    const spoofed = await openProxied('work', 'valid', {'X-Forwarded-For': '203.0.113.9, 198.51.100.7'});
    assert.equal(spoofed.refused(), true);
    const other = await openProxied('work', 'valid', {'X-Forwarded-For': '198.51.100.8'});
    await waitFor(() => other.has('state') || other.refused());
    assert.ok(other.has('state'), 'another client behind the same proxy is served');

    // Admitted peers release their slot: one address may hold more peers than pending sockets.
    const {open: openPlain} = await startOpenRoomServer(t, {pendingPerAddress: 2});
    const peers = [];
    for (let i = 0; i < 6; i++) {
        const peer = await openPlain('tabs', `tab-${i}`);
        await waitFor(() => peer.has('state') || peer.refused() || peer.closeCode() !== null);
        peers.push(peer);
    }
    assert.ok(peers.every(peer => peer.has('state')));
});

test('trusted proxies accept addresses and CIDR subnets and refuse anything else', () => {
    const list = proxyList(['10.0.0.0/8', '::1', 'fd00::/8']);
    assert.equal(list.check('10.2.3.4', 'ipv4'), true);
    assert.equal(list.check('11.0.0.1', 'ipv4'), false);
    assert.equal(list.check('fd00::5', 'ipv6'), true);
    for (const bad of ['proxy.local', '10.0.0.0/33', '10.0.0.0/8/1', '::/129', '10.0.0.0/x']) {
        assert.throws(() => proxyList([bad]), /Invalid trusted proxy/, bad);
    }
});

test('presence carries the admitted token\'s subject and a room-given client id, not what the client claims', {timeout: 8000}, async t => {
    const {open} = await startOpenRoomServer(t);
    const alice = await open('identity', roomToken({sub: '7', sub_type: 'user'}));
    const bob = await open('identity', roomToken({sub: '8', sub_type: 'user'}));
    await waitFor(() => alice.has('state') && bob.has('state'));
    const selection = {sheet_id: 'detail', start_row: 1, start_column: 1, end_row: 1, end_column: 1};

    bob.socket.send(JSON.stringify({type: 'awareness', client_id: 'shared', user: {name: 'Bob'}, selection}));
    // Alice claims Bob's id and his client id.
    alice.socket.send(JSON.stringify({type: 'awareness', client_id: 'shared', user: {id: '8', type: 'admin', name: 'Bob', color: '#000'}, selection}));
    type Seen = {client_id: string; user?: Record<string, unknown>};
    const seenBy = (peer: typeof alice): Seen[] => (peer.messages.filter(m => m.type === 'awareness').at(-1)?.peers ?? []) as Seen[];
    await waitFor(() => seenBy(bob).length === 1 && seenBy(alice).length === 1);

    const aliceAsSeen = seenBy(bob)[0];
    const bobAsSeen = seenBy(alice)[0];
    assert.deepEqual(aliceAsSeen.user, {id: '7', type: 'user', name: 'Bob', color: '#000'});
    assert.deepEqual(bobAsSeen.user, {id: '8', type: 'user', name: 'Bob'});
    assert.notEqual(aliceAsSeen.client_id, 'shared');
    assert.notEqual(aliceAsSeen.client_id, bobAsSeen.client_id);
});
