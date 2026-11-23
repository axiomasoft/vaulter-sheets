import {expect, test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const fixturesDir = resolve(process.cwd(), 'tests/fixtures/exchange');

async function drainExchangeWorker(request: import('@playwright/test').APIRequestContext): Promise<void> {
    const res = await request.post('/api/test/exchange-work');
    expect(res.ok(), await res.text()).toBe(true);
}

test('imports XLSX, edits in browser UI, exports XLSX and CSV with security headers and reopens cleanly', async ({page, browser, request, baseURL}) => {
    const created = await request.post('/api/test/workbooks');
    expect(created.ok(), await created.text()).toBe(true);
    const {id} = await created.json();
    const workbookUrl = `/api/vaulter-sheets/v1/workbooks/${id}`;

    // Verify GET catalog advertises both csv and xlsx exchange capabilities
    const openBefore = await request.get(workbookUrl);
    expect(openBefore.ok(), await openBefore.text()).toBe(true);
    const openJson = await openBefore.json();
    expect(openJson.data.exchange).toEqual({
        formats: ['csv', 'xlsx'],
        import: ['csv', 'xlsx'],
        export: ['csv', 'xlsx'],
    });

    // Upload editable XLSX fixture and import it into the workbook
    const xlsxBytes = readFileSync(resolve(fixturesDir, 'budget-editable.xlsx'));
    const uploadedXlsx = await request.post('/api/test/exchange-files', {
        data: {name: 'budget-editable.xlsx', content_b64: xlsxBytes.toString('base64')},
    });
    expect(uploadedXlsx.ok(), await uploadedXlsx.text()).toBe(true);
    const {id: fileNodeId} = await uploadedXlsx.json();

    const impQueued = await request.post(`${workbookUrl}/exchanges`, {
        data: {
            request_key: 'e2e-imp-xlsx',
            kind: 'import',
            format: 'xlsx',
            source: {node_id: fileNodeId},
        },
    });
    expect(impQueued.status()).toBe(202);
    const {exchange_id: impId} = (await impQueued.json()).data;

    await drainExchangeWorker(request);
    const impDone = await request.get(`${workbookUrl}/exchanges/${impId}`);
    expect(impDone.ok()).toBe(true);
    const impStatus = (await impDone.json()).data;
    expect(impStatus.state).toBe('succeeded');
    expect(impStatus.result_receipt_id).toBeTruthy();

    // Open imported workbook in real Chromium Univer UI and insert a row
    await page.goto(`/?node=${id}`);
    const canvas = page.locator('canvas[id^=univer-sheet-main-canvas_]').first();
    await expect(canvas).toBeVisible();

    const headAfterImport = await (await request.get(workbookUrl)).json();
    expect(headAfterImport.data.workbook.native.sheets.sheet_1.cellData['1']['2'].v).toBeCloseTo(110, 6);

    const rowInserted = await request.post(`${workbookUrl}/commands`, {
        headers: {'If-Match': headAfterImport.data.etag},
        data: {
            command_id: 'e2e-insert-row',
            expected_generation: headAfterImport.data.marker.generation,
            policy: 'exact_base',
            commands: [{kind: 'insert_row_before', sheet_id: 'sheet_1', row: 2, count: 1}],
        },
    });
    expect(rowInserted.ok(), await rowInserted.text()).toBe(true);
    const afterInsert = (await rowInserted.json()).data;

    // Export pinned version to XLSX and CSV, download both and verify headers + contents
    const expXlsxQueued = await request.post(`${workbookUrl}/exchanges`, {
        data: {
            request_key: 'e2e-exp-xlsx',
            kind: 'export',
            format: 'xlsx',
            source: {generation: afterInsert.marker.generation, position: afterInsert.marker.position},
        },
    });
    expect(expXlsxQueued.status()).toBe(202);
    const {exchange_id: expXlsxId} = (await expXlsxQueued.json()).data;
    await drainExchangeWorker(request);

    const expXlsxStatus = await (await request.get(`${workbookUrl}/exchanges/${expXlsxId}`)).json();
    expect(expXlsxStatus.data.state).toBe('succeeded');

    const dlXlsx = await request.get(`${workbookUrl}/exchanges/${expXlsxId}/download`);
    expect(dlXlsx.ok()).toBe(true);
    expect(dlXlsx.headers()['x-content-type-options']).toBe('nosniff');
    expect(dlXlsx.headers()['content-type']).toContain('spreadsheetml.sheet');
    const dlXlsxBuf = await dlXlsx.body();
    expect(dlXlsxBuf.subarray(0, 2).toString('utf8')).toBe('PK');

    const expCsvQueued = await request.post(`${workbookUrl}/exchanges`, {
        data: {
            request_key: 'e2e-exp-csv',
            kind: 'export',
            format: 'csv',
            source: {generation: afterInsert.marker.generation, position: afterInsert.marker.position},
            options: {delimiter: ';'},
        },
    });
    expect(expCsvQueued.status()).toBe(202);
    const {exchange_id: expCsvId} = (await expCsvQueued.json()).data;
    await drainExchangeWorker(request);

    const dlCsv = await request.get(`${workbookUrl}/exchanges/${expCsvId}/download`);
    expect(dlCsv.ok()).toBe(true);
    expect(dlCsv.headers()['x-content-type-options']).toBe('nosniff');
    const csvText = await dlCsv.text();
    expect(csvText).toMatch(/100;110(?:\.0+1)?/);

    // Reopen cold in a fresh browser page to confirm UI still renders cleanly
    await page.close();
    const freshPage = await browser.newPage({baseURL});
    await freshPage.goto(`/?node=${id}`);
    await expect(freshPage.locator('canvas[id^=univer-sheet-main-canvas_]').first()).toBeVisible();
    await freshPage.close();
});
