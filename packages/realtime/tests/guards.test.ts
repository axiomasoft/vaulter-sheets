import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {WEBSOCKET_SUBPROTOCOL} from '../src/protocol.ts';
import {clientAddress, createRealtimeServer, proxyList} from '../src/server.ts';

// The bounds a room process enforces on what reaches it from the network: who a client is behind a proxy,
// how large a credential, presence or intent may be, how many peers a room upgrades, how long a socket may
// stay without a credential, and which owner answers it trusts.

const {workbook} = JSON.parse(readFileSync(new URL('../../runtime/tests/fixtures/apply-request.json', import.meta.url), 'utf8'));
const marker = {generation: 2, position: 9, sha256: 'a'.repeat(64)};
const etag = '"9.2.9"';
const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');
const roomLog = {generation: 2, head_seq: 0, checkpoint_seq: 0, checkpoint, marker, etag, tail: [], insertions: []};

type Answer = {status?: number; body: unknown};
type Message = {type: string; command_id?: string; code?: string; state?: {generation: number}};

async function waitFor(condition: () => boolean, attempts = 150): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (condition()) return;
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for room activity');
}

/** A room process in front of a fake PHP owner; `owner` answers every call but `/read` unless it says otherwise. */
async function startRoom(t: TestContext, owner: (url: string, body: Record<string, unknown>) => Answer | undefined = () => undefined) {
    const reads: string[] = [];
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
        if (request.url === '/read') reads.push(request.headers.authorization ?? '');
        const answer = owner(request.url ?? '', body) ?? (request.url === '/read' ? {body: roomLog} : {status: 404, body: {}});
        const raw = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
        response.writeHead(answer.status ?? 200, {'Content-Type': 'application/json'}).end(raw);
    };
    const php = createServer((request, response) => { void handle(request, response); });
    php.listen(0, '127.0.0.1');
    t.after(() => { php.close(); php.closeAllConnections(); });
    await once(php, 'listening');
    const phpAddress = php.address();
    assert.ok(phpAddress && typeof phpAddress !== 'string');
    const app = createRealtimeServer({ownerUrl: `http://127.0.0.1:${phpAddress.port}`, ownerToken: 'x'.repeat(32), pendingPerAddress: 64});
    app.server.listen(0, '127.0.0.1');
    t.after(app.close);
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');

    /** A socket on `room`; it presents `token` once open unless `token` is null. */
    const connect = async (room: string, token: string | null = 'fixture') => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/${room}`, WEBSOCKET_SUBPROTOCOL);
        t.after(() => socket.terminate());
        const messages: Message[] = [];
        let closed: number | null = null;
        let refused = false;
        socket.on('message', data => { messages.push(JSON.parse(data.toString())); });
        socket.on('close', code => { closed = code; });
        socket.on('error', () => { refused = true; });
        await new Promise<void>(resolve => {
            socket.once('open', () => resolve());
            socket.once('close', () => resolve());
            socket.once('unexpected-response', request => { refused = true; request.destroy(); resolve(); });
        });
        if (token !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'open', token}));
        const send = (message: unknown) => socket.send(JSON.stringify(message));
        return {socket, messages, send, closed: () => closed, refused: () => refused, has: (type: string) => messages.some(m => m.type === type)};
    };
    /** An admitted peer holding its first state. */
    const join = async (room: string, token = 'fixture') => {
        const peer = await connect(room, token);
        await waitFor(() => peer.has('state') || peer.closed() !== null || peer.refused());
        return peer;
    };
    return {connect, join, reads};
}

function upgrade(remoteAddress: string, forwarded?: string): IncomingMessage {
    return {socket: {remoteAddress}, headers: forwarded === undefined ? {} : {'x-forwarded-for': forwarded}} as unknown as IncomingMessage;
}

test('the client address is the peer unless that is a trusted proxy, and a malformed hop never moves it', () => {
    const proxies = proxyList(['10.0.0.0/8']);
    assert.equal(clientAddress(upgrade('198.51.100.1', '203.0.113.9'), proxies), '198.51.100.1', 'an untrusted peer cannot name another address');
    assert.equal(clientAddress(upgrade('10.0.0.2', '203.0.113.9'), proxies), '203.0.113.9');
    assert.equal(clientAddress(upgrade('10.0.0.2', '203.0.113.9, not-an-address'), proxies), '10.0.0.2', 'a malformed hop leaves the proxy as the client');
    assert.equal(clientAddress(upgrade('10.0.0.2', '203.0.113.9, 10.0.0.3'), proxies), '203.0.113.9', 'trusted hops are skipped');
});

test('the owner token and the pending socket limit are validated when the server is created', () => {
    const owner = {ownerUrl: 'http://127.0.0.1:1'};
    for (const ownerToken of ['x'.repeat(31), 'x'.repeat(4097)]) {
        assert.throws(() => createRealtimeServer({...owner, ownerToken}), /Invalid PHP owner configuration/, `${ownerToken.length} characters`);
    }
    for (const pendingPerAddress of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => createRealtimeServer({...owner, ownerToken: 'x'.repeat(32), pendingPerAddress}), /Invalid pending connection limit/, String(pendingPerAddress));
    }
});

test('a credential above 8192 characters is refused before the owner reads it', {timeout: 8000}, async t => {
    const {join, reads} = await startRoom(t);
    const long = await join('token', 'x'.repeat(8193));
    assert.equal(long.closed(), 4403);
    assert.deepEqual(reads, []);
    assert.ok((await join('token', 'x'.repeat(8192))).has('state'), 'a credential at the limit is read');
});

test('presence above its bounds closes the peer; presence at the bounds is passed on', {timeout: 8000}, async t => {
    const {join} = await startRoom(t);
    const selection = {sheet_id: 'detail', start_row: 1, start_column: 1, end_row: 1, end_column: 1};
    for (const [label, overrides] of Object.entries({
        'empty client id': {client_id: ''},
        'client id above 128': {client_id: 'c'.repeat(129)},
        'name above 128': {user: {name: 'n'.repeat(129)}},
        'colour above 32': {user: {color: '#'.repeat(33)}},
        'object user id': {user: {id: {}}},
        'empty sheet id': {selection: {...selection, sheet_id: ''}},
        'sheet id above 128': {selection: {...selection, sheet_id: 's'.repeat(129)}},
        'end row before start row': {selection: {...selection, start_row: 2, end_row: 1}},
        'end column before start column': {selection: {...selection, start_column: 2, end_column: 1}},
    })) {
        const peer = await join('presence');
        peer.send({type: 'awareness', client_id: 'c', ...overrides});
        await waitFor(() => peer.closed() !== null);
        assert.equal(peer.closed(), 1007, label);
    }

    const sender = await join('presence');
    const watcher = await join('presence');
    sender.send({type: 'awareness', client_id: 'c'.repeat(128), user: {id: 7, name: 'n'.repeat(128), color: '#'.repeat(32)}, selection: {...selection, sheet_id: 's'.repeat(128), end_row: 3, end_column: 2}});
    await waitFor(() => watcher.has('awareness'));
    assert.equal(sender.closed(), null);
});

test('an intent with a malformed command id or If-Match closes the peer before anything is queued', {timeout: 8000}, async t => {
    const calls: string[] = [];
    const {join} = await startRoom(t, url => { if (url !== '/read') calls.push(url); return undefined; });
    const intent = (commandId: string) => ({command_id: commandId, expected_generation: 2, policy: 'rebase_cells', commands: []});
    for (const [label, message] of Object.entries({
        'command id with a space': {type: 'intent', if_match: etag, intent: intent('bad id')},
        'command id above 255': {type: 'intent', if_match: etag, intent: intent('c'.repeat(256))},
        'numeric If-Match': {type: 'intent', if_match: 9, intent: intent('ok')},
    })) {
        const peer = await join('intents');
        peer.send(message);
        await waitFor(() => peer.closed() !== null);
        assert.equal(peer.closed(), 1007, label);
    }
    assert.deepEqual(calls, []);
});

test('a receipt for another command is not acknowledged', {timeout: 8000}, async t => {
    const {join} = await startRoom(t, url => {
        if (url === '/acquire') return {body: {owner_fence: 1, head_seq: 0, owner_expires_at: new Date(Date.now() + 60_000).toISOString()}};
        if (url === '/append') return {body: {state: 'committed', command_id: 'someone-else', seq: 1, marker, etag}};
        return undefined;
    });
    const peer = await join('receipts');
    peer.send({type: 'intent', if_match: etag, intent: {command_id: 'mine', expected_generation: 2, policy: 'rebase_cells', commands: []}});
    await waitFor(() => peer.has('error'));
    assert.equal(peer.has('ack'), false);
    assert.equal(peer.messages.find(m => m.type === 'error')?.command_id, 'mine');
});

test('a full room refuses the upgrade itself, before a 33rd socket is opened', {timeout: 8000}, async t => {
    const {join, connect} = await startRoom(t);
    for (let i = 0; i < 32; i++) assert.ok((await join('full')).has('state'));
    const late = await connect('full', null);
    assert.equal(late.refused(), true);
});

test('an oversized owner answer is refused instead of served', {timeout: 8000}, async t => {
    const padding = 'p'.repeat(24 * 1024 * 1024 + 1);
    const {join} = await startRoom(t, url => url === '/read' ? {body: JSON.stringify({...roomLog, padding})} : undefined);
    const peer = await join('oversized');
    assert.equal(peer.has('state'), false);
    assert.equal(peer.closed(), 1013);
});

test('a socket that presents no credential is closed after 5 s', {timeout: 9000}, async t => {
    const {connect} = await startRoom(t);
    const idle = await connect('idle', null);
    await waitFor(() => idle.closed() !== null, 350);
    assert.equal(idle.closed(), 4403);
});

test('a new generation reaches every peer and drops the cached owner lease, so the next intent acquires one for it', {timeout: 8000}, async t => {
    let generation = 2;
    let acquires = 0;
    const {join} = await startRoom(t, (url, body) => {
        if (url === '/read') return {body: {...roomLog, generation, marker: {...marker, generation}}};
        if (url === '/acquire') return {body: {owner_fence: ++acquires, head_seq: 0, owner_expires_at: new Date(Date.now() + 60_000).toISOString()}};
        if (url === '/append') {
            // The first command ends the generation (a restore); its receipt carries no update, so the room re-reads.
            const answer = {body: {state: 'committed', command_id: (body.intent as {command_id: string}).command_id, seq: 1, marker, etag}};
            generation = 3;
            return answer;
        }
        return undefined;
    });
    const peer = await join('restored');
    const intent = (id: string) => ({type: 'intent', if_match: etag, intent: {command_id: id, expected_generation: 2, policy: 'rebase_cells', commands: []}});
    peer.send(intent('first'));
    // The re-read after the receipt runs on the room's queue, ahead of the next intent.
    await waitFor(() => peer.has('ack'));
    peer.send(intent('second'));
    await waitFor(() => peer.messages.filter(m => m.type === 'ack').length === 2 || peer.has('error'));
    assert.equal(acquires, 2, 'the lease of generation 2 is not reused for generation 3');
    assert.equal(peer.messages.filter(m => m.type === 'state').at(-1)?.state?.generation, 3, 'the peer is sent the new generation even at the same seq');
});
