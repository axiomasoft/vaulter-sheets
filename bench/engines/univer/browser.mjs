/** Browser measurements that the headless corpus does not cover. Input 35→41 is also in the official probe. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const server = await createServer({
    root: join(here, 'browser'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repoRoot] } },
    logLevel: 'warn',
});
let browser;
const report = { node: process.version, chromeBin: process.env.CHROME_BIN ?? null };
try {
    await server.listen();
    browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
    const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.probe?.univerAPI?.getActiveWorkbook?.());
    report.browser = browser.version();

    report.cells = await page.evaluate(async () => {
        const api = window.probe.univerAPI;
        const formula = api.getFormula();
        const applied = formula.onCalculationResultApplied(20_000);
        formula.executeCalculation();
        await applied;
        const book = api.getActiveWorkbook();
        const detail = book.getSheetByName('Detail');
        const summary = book.getSheetByName('Summary');
        return {
            initial: summary.getRange('B2').getRawValue(),
        };
    }).catch((error) => ({ error: String(error) }));

    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: 20_000 });
    report.accessibility = await page.locator('main').ariaSnapshot().catch((error) => `unavailable: ${error.message}`);

    report.input = await page.evaluate(async () => {
        const book = window.probe.univerAPI.getActiveWorkbook();
        const detail = book.getSheetByName('Detail');
        detail.getRange('C3').setValue(7);
        const formula = window.probe.univerAPI.getFormula();
        const applied = formula.onCalculationResultApplied(20_000);
        formula.executeCalculation();
        await applied;
        return {
            price: detail.getRange('C3').getRawValue(),
            line: detail.getRange('D3').getRawValue(),
            total: book.getSheetByName('Summary').getRange('B2').getRawValue(),
        };
    });

    const undoReport = await page.evaluate(async () => {
        const api = window.probe.univerAPI;
        if (typeof api.undo !== 'function') return { available: false };
        const detail = api.getActiveWorkbook().getSheetByName('Detail');
        const before = detail.getRange('C3').getRawValue();
        await api.undo();
        const after = detail.getRange('C3').getRawValue();
        await api.redo();
        const formula = api.getFormula();
        const applied = formula.onCalculationResultApplied(20_000);
        formula.executeCalculation();
        await applied;
        return { available: true, before, after };
    });

    report.clipboard = await page.evaluate(async () => {
        const book = window.probe.univerAPI.getActiveWorkbook();
        const detail = book.getSheetByName('Detail');
        const copied = detail.getRange('C3').getRawValue();
        detail.getRange('E3').setValue(copied);
        return { source: copied, pastedByValue: detail.getRange('E3').getRawValue(), keyboard: false };
    });
    try {
        await page.getByRole('tab', { name: 'Detail' }).click();
        await page.waitForFunction(() => window.probe.univerAPI.getActiveWorkbook().getActiveSheet()?.getSheetName() === 'Detail', null, { timeout: 3_000 });
        await page.locator('canvas[id^="univer-sheet-main-canvas"]').click({ position: { x: 266, y: 80 } });
        await page.waitForFunction(() => window.probe.univerAPI.getActiveWorkbook().getActiveSheet().getSelection()?.getActiveRange()?.getA1Notation() === 'C3', null, { timeout: 3_000 });
        await page.waitForTimeout(50);
        await page.keyboard.press('Control+c');
        await page.waitForTimeout(50);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => window.probe.univerAPI.getActiveWorkbook().getActiveSheet().getSelection()?.getActiveRange()?.getA1Notation() === 'F3', null, { timeout: 3_000 });
        await page.waitForTimeout(50);
        await page.keyboard.press('Control+v');
        await page.waitForFunction(() => window.probe.univerAPI.getActiveWorkbook().getSheetByName('Detail').getRange('F3').getRawValue() === 7, null, { timeout: 3_000 });
        const pasted = await page.evaluate(() => window.probe.univerAPI.getActiveWorkbook().getSheetByName('Detail').getRange('F3').getRawValue());
        report.clipboard.keyboardPaste = pasted ?? null;
        report.clipboard.keyboard = true;
    } catch (error) {
        report.clipboard.keyboardError = error instanceof Error ? error.message : String(error);
    }

    report.undo = undoReport;

    report.largePaste = await page.evaluate(() => {
        const detail = window.probe.univerAPI.getActiveWorkbook().getSheetByName('Detail');
        detail.setRowCount(200);
        detail.setColumnCount(120);
        const block = Array.from({ length: 100 }, (_, row) => Array.from({ length: 100 }, (_, column) => row + column));
        const started = performance.now();
        detail.getRange('A20:CV119').setValues(block);
        return { rows: 100, columns: 100, ms: Math.round((performance.now() - started) * 1000) / 1000 };
    });

    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');
    async function heap() {
        await client.send('HeapProfiler.collectGarbage');
        const { metrics } = await client.send('Performance.getMetrics');
        const sample = metrics.find((item) => item.name === 'JSHeapUsedSize')?.value;
        if (typeof sample === 'number') return sample;
        const usage = await client.send('Runtime.getHeapUsage');
        return usage.usedSize;
    }
    const before = await heap();
    report.memory = await page.evaluate(async () => {
        const host = document.querySelector('main');
        window.probe.disposeMounted();
        for (let i = 0; i < 20; i += 1) window.createProbe(host).dispose();
        return { cycles: 20, liveUniver: window.liveUniver() };
    });
    const after = await heap();
    report.memory.heapBefore = before;
    report.memory.heapAfter = after;
    report.memory.deltaBytes = before == null || after == null ? null : after - before;
    report.memory.budgetBytes = 5 * 1024 * 1024;
    report.longTasks = await page.evaluate(() => window.probe.longTasks.slice(0, 20));
    report.pageErrors = errors;
} catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    console.log(JSON.stringify(report));
    process.exitCode = 1;
} finally {
    await browser?.close();
    await server.close();
}
if (!report.error) console.log(JSON.stringify(report));
