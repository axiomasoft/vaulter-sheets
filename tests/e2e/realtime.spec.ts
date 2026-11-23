import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {expect, test, type APIRequestContext, type Page} from '@playwright/test';
import type {Command} from '../../packages/runtime/src/browser.ts';

const insert: Command = {kind: 'insert_row_before', sheet_id: 'detail', row: 3, count: 1};
const price: Command = {kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, value: 8, expected: {number: 5}};
const processes: ChildProcess[] = [];

async function startRoomProcess(request: APIRequestContext): Promise<{url: string; stop: () => Promise<void>}> {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
        import {readFileSync} from 'node:fs';
        import {createRealtimeServer} from './packages/realtime/dist/server.js';
        const ownerToken = readFileSync(process.env.SHEETS_REALTIME_OWNER_TOKEN_FILE, 'utf8').trim();
        const app = createRealtimeServer({ownerUrl: process.env.SHEETS_REALTIME_OWNER_URL, ownerToken, refreshMs: 200});
        app.server.listen(0, '127.0.0.1', () => process.stdout.write(String(app.server.address().port)));
        process.on('SIGTERM', app.close);
    `], {stdio: ['ignore', 'pipe', 'inherit'], cwd: new URL('../../', import.meta.url)});
    processes.push(child);
    const [port] = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('Room process exited'); })]);
    const url = `http://127.0.0.1:${String(port).trim()}`;
    const readiness = await request.get(`${url}/readyz`);
    expect(readiness.ok()).toBe(true);

    return {url: url.replace('http:', 'ws:'), stop: async () => {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
    }};
}

test.afterEach(() => {
    while (processes.length) processes.pop()?.kill();
});

async function open(page: Page, node: string, actor: number, endpoint: string): Promise<void> {
    await page.goto('/realtime.html');
    await page.evaluate(({node, actor, endpoint}) => { window.connectWorkbook(node, actor, endpoint); }, {node, actor, endpoint});
    await expect(page.locator('#room')).toHaveAttribute('data-seq', /\d+/);
}

async function submit(page: Page, id: string, command: Command): Promise<void> {
    await page.evaluate(({id, command}) => window.workbookClient!.submit([command], command.kind === 'insert_row_before' ? 'exact_base' : 'rebase_cells', id), {id, command});
}

const receipt = (page: Page, id: string) => page.evaluate(id => window.receipts[id] ?? '', id);
const code = (page: Page, id: string) => page.evaluate(id => window.conflicts[id], id);
const workbook = (page: Page) => page.evaluate(() => window.workbookClient!.state!.workbook);

for (const order of ['insert-first', 'price-first']) {
    test(`${order}: preserves the logical row across disconnect, leader handoff and restore`, async ({browser, request}) => {
        const created = await request.post('/api/test/workbooks');
        expect(created.ok()).toBe(true);
        const {id} = await created.json();
        const node = String(id);
        const book = `/api/vaulter-sheets/v1/workbooks/${node}`;
        const original = await request.get(book);
        expect((await request.post(`${book}/realtime/session`)).status()).toBe(409);
        expect((await request.put(`${book}/realtime/profile`, {headers: {'If-Match': original.headers().etag}, data: {mode: 'journal'}})).ok()).toBe(true);
        const leader = await startRoomProcess(request);
        const standby = await startRoomProcess(request);
        const a = await browser.newPage();
        const b = await browser.newPage();
        let lost = false;
        let stale = false;
        let delayed: (() => void) | undefined;
        await a.routeWebSocket(/\/v1\/rooms\//, route => {
            const upstream = route.connectToServer();
            upstream.onMessage(message => {
                if (order === 'insert-first' && !lost && JSON.parse(String(message)).type === 'ack') {
                    lost = true;
                    route.close();
                    return;
                }
                if (order === 'price-first' && stale && JSON.parse(String(message)).type === 'state') delayed = () => route.send(message);
                else route.send(message);
            });
        });
        await b.routeWebSocket(/\/v1\/rooms\//, route => {
            const upstream = route.connectToServer();
            upstream.onMessage(message => {
                if (order === 'insert-first' && stale && JSON.parse(String(message)).type === 'state') delayed = () => route.send(message);
                else route.send(message);
            });
        });
        await open(a, node, 1, leader.url);
        await open(b, node, 2, leader.url);
        stale = true;
        if (order === 'insert-first') {
            await submit(a, 'insert', insert);
            await expect.poll(() => receipt(a, 'insert')).toMatch(/^[\da-f-]{36}$/);
            expect(lost).toBe(true);
            await submit(b, 'price', price);
        } else {
            await submit(b, 'price', price);
            await expect.poll(() => receipt(b, 'price')).toMatch(/^[\da-f-]{36}$/);
            await submit(a, 'stale-insert', insert);
            await expect.poll(() => code(a, 'stale-insert')).toBe('version_conflict');
            stale = false;
            delayed?.();
            await expect(a.locator('#room')).toHaveAttribute('data-seq', '1');
            await submit(a, 'insert', insert);
        }
        stale = false;
        delayed?.();
        await expect.poll(() => receipt(a, 'insert')).toMatch(/^[\da-f-]{36}$/);
        await expect.poll(() => receipt(b, 'price')).toMatch(/^[\da-f-]{36}$/);
        await expect(a.locator('#room')).toHaveAttribute('data-seq', '2');
        await expect(b.locator('#room')).toHaveAttribute('data-seq', '2');
        const converged = await workbook(a);
        expect(await workbook(b)).toEqual(converged);
        expect(converged.tables[0].rows.find(row => row.row_id === 'pears')?.row).toBe(4);
        expect(converged.native.sheets).toMatchObject({detail: {cellData: {3: {2: {v: 8}, 3: {f: '=B4*C4', v: 24}}}}});

        const doc = `/api/vaulter/v1/documents/${node}`;
        const named = await request.post(`${doc}/revisions`, {data: {label: 'Converged workbook'}});
        expect(named.status()).toBe(201);
        const {data: revision} = await named.json();
        const session = (await (await request.post(`${book}/realtime/session`)).json()).data;
        const directOwner = process.env.SHEETS_REALTIME_OWNER_URL!;
        const ownerHeaders = {
            Authorization: `Bearer ${session.token}`,
            'X-Vaulter-Sheets-Owner': readFileSync(process.env.SHEETS_REALTIME_OWNER_TOKEN_FILE!, 'utf8').trim(),
        };
        const port = {room: session.options.room, owner_id: '00000000-0000-4000-8000-000000000061'};
        expect((await request.post(`${directOwner}/acquire`, {headers: ownerHeaders, data: port})).status()).toBe(409);
        await open(b, node, 2, standby.url);
        await expect(b.locator('#room')).toHaveAttribute('data-seq', '2');
        await submit(b, 'handoff', {...price, row: 4, value: 9, expected: {number: 8}});
        await leader.stop();
        await expect.poll(() => receipt(b, 'handoff'), {timeout: 22_000, intervals: [500]}).toMatch(/^[\da-f-]{36}$/);
        await expect(b.locator('#room')).toHaveAttribute('data-seq', '3');
        expect((await workbook(b)).native.sheets).toMatchObject({detail: {cellData: {3: {2: {v: 9}}}}});
        const finalHead = await request.get(book);
        const restore = await request.post(`${doc}/revisions/${revision.id}/restore`, {headers: {'If-Match': finalHead.headers().etag}});
        expect(restore.ok()).toBe(true);
        expect((await request.post(`${directOwner}/read`, {headers: ownerHeaders, data: port})).status()).toBe(409);
        const restored = (await (await request.post(`${book}/realtime/session`)).json()).data;
        const restoredPort = {...port, room: restored.options.room};
        const headers = {...ownerHeaders, Authorization: `Bearer ${restored.token}`};
        const acquired = await request.post(`${directOwner}/acquire`, {headers, data: restoredPort});
        expect(acquired.ok()).toBe(true);
        const lease = await acquired.json();
        const append = await request.post(`${directOwner}/append`, {headers, data: {
            ...restoredPort, owner_fence: lease.owner_fence, base_seq: lease.head_seq, if_match: lease.etag,
            intent: {command_id: 'owner-edit', expected_generation: restored.generation, policy: 'exact_base', commands: [
                {kind: 'set_number', sheet_id: 'detail', row: 4, column: 3, expected: {number: 8}, value: 8},
            ]},
        }});
        expect(append.ok()).toBe(true);
        const c = await browser.newPage();
        await open(c, node, 1, standby.url);
        await expect(c.locator('#room')).toHaveAttribute('data-generation', String(session.generation + 1));
        expect(await workbook(c)).toEqual(converged);
        const ranges = await request.get(`${book}/ranges?sheet_id=detail&range=C4:D4`);
        expect((await ranges.json()).data[0].cells.map(({value}: {value: number}) => value)).toEqual([8, 24]);
        await Promise.all([a.close(), b.close(), c.close()]);
    });
}
