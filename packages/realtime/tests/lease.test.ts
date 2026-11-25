import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {WEBSOCKET_SUBPROTOCOL} from '../src/protocol.ts';
import {createRealtimeServer} from '../src/server.ts';

// How a room uses the PHP owner lease: one lease serves many intents, a lease another process took over is re-acquired
// once, a terminal owner answer ends the room for its peers, and a full queue turns intents away instead of growing.

const {workbook} = JSON.parse(readFileSync(new URL('../../runtime/tests/fixtures/apply-request.json', import.meta.url), 'utf8'));
const marker = {generation: 2, position: 9, sha256: 'a'.repeat(64)};
const etag = '"9.2.9"';
const checkpoint = Buffer.from(JSON.stringify({workbook, update_id: null})).toString('base64');

type Body = {owner_fence?: number; base_seq?: number; intent?: {command_id: string}};
type Reply = {status?: number; body: object} | Promise<{status?: number; body: object}>;

/** A room process in front of a fake PHP owner whose acquire and append answers the test decides. */
async function startRoom(t: TestContext, owner: {acquire: (body: Body) => Reply; append: (body: Body) => Reply; headSeq: () => number}) {
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body;
        const answer = request.url === '/read'
            ? {body: {generation: 2, head_seq: owner.headSeq(), checkpoint_seq: owner.headSeq(), checkpoint, marker, etag, tail: [], insertions: []}}
            : request.url === '/acquire' ? await owner.acquire(body)
                : request.url === '/append' ? await owner.append(body)
                    : request.url === '/renew' ? {body: {owner_fence: body.owner_fence}} : {status: 404, body: {}};
        if (!response.writableEnded) response.writeHead(answer.status ?? 200, {'Content-Type': 'application/json'}).end(JSON.stringify(answer.body));
    };
    const php = createServer((request, response) => { void handle(request, response); });
    php.listen(0, '127.0.0.1');
    t.after(() => { php.close(); php.closeAllConnections(); });
    await once(php, 'listening');
    const phpAddress = php.address();
    assert.ok(phpAddress && typeof phpAddress !== 'string');
    const app = createRealtimeServer({ownerUrl: `http://127.0.0.1:${phpAddress.port}`, ownerToken: 'x'.repeat(32)});
    app.server.listen(0, '127.0.0.1');
    t.after(app.close);
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/fixture`, WEBSOCKET_SUBPROTOCOL);
    t.after(() => socket.terminate());
    const messages: {type: string; command_id?: string; code?: string; retryable?: boolean; receipt?: {command_id: string; seq: number}}[] = [];
    let closed: {code: number; reason: string} | null = null;
    socket.on('message', data => { messages.push(JSON.parse(data.toString())); });
    socket.on('close', (code, reason) => { closed = {code, reason: reason.toString()}; });
    await once(socket, 'open');
    socket.send(JSON.stringify({type: 'open', token: 'fixture'}));
    await waitFor(() => messages.some(m => m.type === 'state'));
    const intent = (id: string) => socket.send(JSON.stringify({type: 'intent', if_match: etag, intent: {
        command_id: id, expected_generation: 2, policy: 'rebase_cells',
        commands: [{kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, expected: null, value: 1}],
    }}));
    return {messages, intent, closed: () => closed};
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
        if (condition()) return;
        await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for room activity');
}

const committed = (body: Body, seq: number) => ({body: {state: 'committed', command_id: body.intent?.command_id, seq, marker, etag}});
const later = () => new Date(Date.now() + 60_000).toISOString();

test('one lease serves consecutive intents; a taken-over lease is re-acquired once and the intent retried on its head', {timeout: 8000}, async t => {
    let seq = 0;
    let fence = 0;
    let taken = false;
    const appends: {fence?: number; base?: number}[] = [];
    const room = await startRoom(t, {
        headSeq: () => seq,
        acquire: () => ({body: {owner_fence: ++fence, head_seq: seq, owner_expires_at: later()}}),
        append: body => {
            appends.push({fence: body.owner_fence, base: body.base_seq});
            if (taken && body.owner_fence === 1) return {status: 409, body: {code: 'stale_owner'}};
            return committed(body, ++seq);
        },
    });

    room.intent('first');
    await waitFor(() => room.messages.some(m => m.type === 'ack' && m.receipt?.command_id === 'first'));
    room.intent('second');
    await waitFor(() => room.messages.some(m => m.type === 'ack' && m.receipt?.command_id === 'second'));
    assert.equal(fence, 1, 'the live lease was reused, not re-acquired per intent');
    assert.deepEqual(appends, [{fence: 1, base: 0}, {fence: 1, base: 1}], 'the reused lease carries the head of its last receipt');

    taken = true; // Another room process now holds the lease; the cached fence 1 is stale.
    seq = 5;
    room.intent('third');
    await waitFor(() => room.messages.some(m => m.type === 'ack' && m.receipt?.command_id === 'third'));
    assert.equal(fence, 2);
    assert.deepEqual(appends.slice(2), [{fence: 1, base: 2}, {fence: 2, base: 5}], 'the retry uses the new fence and the head it returned');
    assert.equal(room.messages.some(m => m.type === 'error'), false);
    assert.equal(room.closed(), null);
});

test('a terminal owner answer closes the peer with 4409 and its code instead of an intent error', {timeout: 8000}, async t => {
    let fence = 0;
    const room = await startRoom(t, {
        headSeq: () => 0,
        acquire: () => ({body: {owner_fence: ++fence, head_seq: 0, owner_expires_at: later()}}),
        append: () => ({status: 409, body: {code: 'generation_changed'}}),
    });
    room.intent('doomed');
    await waitFor(() => room.closed() !== null);
    assert.deepEqual(room.closed(), {code: 4409, reason: 'generation_changed'});
    assert.equal(room.messages.some(m => m.type === 'ack'), false);
});

test('a room queues at most 64 intents and answers the next with a retryable room_busy', {timeout: 8000}, async t => {
    const held: (() => void)[] = [];
    let seq = 0;
    const room = await startRoom(t, {
        headSeq: () => seq,
        acquire: () => ({body: {owner_fence: 1, head_seq: seq, owner_expires_at: later()}}),
        // The first append never returns until the test lets it, so every later intent waits in the room's queue.
        append: body => new Promise(resolve => { held.push(() => resolve(committed(body, ++seq))); }),
    });
    t.after(() => { for (const release of held) release(); });
    for (let index = 1; index <= 65; index++) room.intent(`intent-${index}`);
    await waitFor(() => room.messages.some(m => m.type === 'error'));
    const errors = room.messages.filter(m => m.type === 'error');
    assert.deepEqual(errors, [{type: 'error', command_id: 'intent-65', code: 'room_busy', retryable: true}]);
    assert.equal(held.length, 1, 'only the head of the queue reached the owner');

    held.shift()!();
    await waitFor(() => held.length === 1);
    room.intent('after-drain');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal(room.messages.filter(m => m.type === 'error').length, 1, 'a slot freed by a receipt takes a new intent');
});
