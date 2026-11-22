import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('edits C3, reopens the acknowledged workbook cold and releases the editor', async ({page, browser, request, baseURL}) => {
    const created = await request.post('/api/test/workbooks');
    expect(created.ok(), await created.text()).toBe(true);
    const {id} = await created.json();
    const workbook = `/api/vaulter-sheets/v1/workbooks/${id}`;
    await page.goto(`/?node=${id}`);
    const canvas = page.locator('canvas[id^=univer-sheet-main-canvas_]').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.dblclick(box!.x + 263, box!.y + 90);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('7');
    const submitted = page.waitForResponse(response => response.url().endsWith(`${workbook}/commands`) && response.request().method() === 'POST', {timeout: 8_000});
    await page.keyboard.press('Enter');
    const saved = await submitted;
    expect(saved.ok(), await saved.text()).toBe(true);
    expect(saved.request().postDataJSON().commands[0]).toMatchObject({kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, value: 7});
    await expect(page.getByText('Workbook saved')).toBeVisible();
    await page.close();

    const signal = process.env.SHEETS_RUNTIME_RESTART_SIGNAL;
    const workerPid = process.env.SHEETS_RUNTIME_CHILD_PID;
    if (signal && workerPid) {
        const previous = readFileSync(workerPid, 'utf8');
        process.kill(Number(readFileSync(signal, 'utf8').trim()), 'SIGUSR2');
        await expect.poll(async () => {
            try {
                return readFileSync(workerPid, 'utf8') !== previous &&
                    (await request.get(`${workbook}/ranges?sheet_id=summary&range=B2`)).ok();
            } catch {
                return false;
            }
        }).toBe(true);
    }
    const reopened = await browser.newPage({baseURL});
    await reopened.goto(`/?node=${id}`);
    await expect(reopened.locator('canvas[id^=univer-sheet-main-canvas_]').first()).toBeVisible();
    const results = await request.get(`${workbook}/ranges?sheet_id=summary&range=B2`);
    expect(await results.json()).toMatchObject({data: [{cells: [{value: 41}]}]});
    const current = await (await request.get(workbook)).json();
    expect(current.data.workbook.native.sheets.detail.cellData[2][3]).toMatchObject({f: '=B3*C3', v: 21, s: expect.stringMatching(/^st_/)});

    const sheetCanvas = reopened.locator('canvas[id^=univer-sheet-main-canvas_]').first();
    await sheetCanvas.click({position: {x: 80, y: 131}});
    const batch = reopened.waitForResponse(response => response.url().endsWith(`${workbook}/commands`) && response.request().method() === 'POST', {timeout: 8_000});
    await sheetCanvas.evaluate(element => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', '7\ttext');
        element.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}));
    });
    const batchResult = await batch;
    expect(batchResult.ok(), await batchResult.text()).toBe(true);
    expect(batchResult.request().postDataJSON().commands[0]).toMatchObject({kind: 'set_values', values: [[{number: 7}, {text: 'text'}]]});
    await expect(reopened.getByText('Workbook saved')).toBeVisible();

    const cdp = await reopened.context().newCDPSession(reopened);
    const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    await reopened.getByRole('button', {name: 'Close workbook'}).click();
    const cycleEditor = async () => {
        await reopened.getByRole('button', {name: 'Open workbook'}).click();
        await expect(reopened.locator('canvas[id^=univer-sheet-main-canvas_]').first()).toBeVisible();
        await reopened.getByRole('button', {name: 'Close workbook'}).click();
        await expect(reopened.locator('canvas[id^=univer-sheet-main-canvas_]')).toHaveCount(0);
    };
    // Initialize lazily compiled engine and UI code before measuring retained heap.
    for (let cycle = 0; cycle < 10; cycle++) await cycleEditor();
    const baseline = await heap();
    for (let cycle = 0; cycle < 20; cycle++) await cycleEditor();
    const growth = await heap() - baseline;
    console.log(`Post-GC heap growth over 20 editor cycles: ${growth} bytes`);
    expect(growth).toBeLessThan(5 * 1024 * 1024);
    await reopened.close();
});
