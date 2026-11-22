/**
 * Univer OSS 1.5.2 Plugin Mode corpus.
 * Calls match plan/checks/sheets-headless: createWorkbook, getRange, setValue,
 * setFormula, insertRowsBefore, executeCalculation, onCalculationResultApplied,
 * save, and the conditional-formatting facade used by resources.mjs.
 */
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { LocaleType, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';
import '@univerjs/sheets-conditional-formatting/facade';
import '@univerjs/sheets-data-validation/facade';
import { loadCorpus, step, summarize } from '../corpus.mjs';

const PLUGIN_SPECS = [
    ['@univerjs/engine-render', UniverRenderEnginePlugin],
    ['@univerjs/engine-formula', UniverFormulaEnginePlugin],
    ['@univerjs/docs', UniverDocsPlugin],
    ['@univerjs/sheets', UniverSheetsPlugin],
    ['@univerjs/sheets-formula', UniverSheetsFormulaPlugin],
    ['@univerjs/sheets-numfmt', UniverSheetsNumfmtPlugin],
    ['@univerjs/data-validation', UniverDataValidationPlugin],
    ['@univerjs/sheets-data-validation', UniverSheetsDataValidationPlugin],
    ['@univerjs/sheets-conditional-formatting', UniverSheetsConditionalFormattingPlugin],
    ['@univerjs/sheets-filter', UniverSheetsFilterPlugin],
    ['@univerjs/sheets-hyper-link', UniverSheetsHyperLinkPlugin],
];

function versionOf(name) {
    const require = createRequire(import.meta.url);
    let directory = dirname(require.resolve(name));
    for (;;) {
        const candidate = join(directory, 'package.json');
        if (existsSync(candidate)) {
            const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
            if (manifest.name === name && typeof manifest.version === 'string') return manifest.version;
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`package.json of ${name} not found`);
        directory = parent;
    }
}

function startSession(mode) {
    const univer = new Univer({ locale: LocaleType.EN_US, locales: {} });
    const registered = [];
    const failed = [];
    for (const [name, plugin] of PLUGIN_SPECS) {
        try {
            if (name === '@univerjs/sheets-formula') univer.registerPlugin(plugin, { initialFormulaComputing: mode });
            else univer.registerPlugin(plugin);
            registered.push(name);
        } catch (error) {
            failed.push({ name, message: error instanceof Error ? error.message : String(error) });
        }
    }
    const api = FUniver.newAPI(univer);
    return { univer, api, formula: api.getFormula(), registered, failed };
}

async function recalc(formula) {
    const applied = formula.onCalculationResultApplied(20_000);
    formula.executeCalculation();
    await applied;
}

function writeCell(sheet, address, cell) {
    const range = sheet.getRange(address);
    if (cell.formula) range.setFormula(cell.formula);
    else if (typeof cell.number === 'number') range.setValue(cell.number);
    else range.setValue(cell.text);
    if (cell.numberFormat) range.setNumberFormat(cell.numberFormat);
}

function readCell(sheet, address) {
    const range = sheet.getRange(address);
    return { value: range.getRawValue(), formula: range.getFormula(), numberFormat: range.getNumberFormat() };
}

function sheetByName(book, name) {
    const sheet = book.getSheetByName(name);
    if (!sheet) throw new Error(`sheet ${name} missing`);
    return sheet;
}

function fillCorpus(book, corpus) {
    for (const spec of corpus.sheets) {
        const sheet = spec.name === 'Detail' ? book.getActiveSheet().setName('Detail') : book.insertSheet(spec.name);
        for (const [address, cell] of Object.entries(spec.cells)) writeCell(sheet, address, cell);
    }
}

function checkEqual(checks, name, actual, expected) {
    checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}

function runChild(phase, snapshot) {
    const dir = mkdtempSync(join(tmpdir(), 'vaulter-univer-'));
    const file = join(dir, 'snapshot.json');
    writeFileSync(file, JSON.stringify(snapshot));
    return new Promise((resolve) => {
        const child = fork(new URL('./run.mjs', import.meta.url), [phase, file], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('exit', (code) => {
            rmSync(dir, { recursive: true, force: true });
            const line = out.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
            resolve({ exit: code, stderr: err.slice(0, 2000), result: line ? JSON.parse(line) : null });
        });
    });
}

async function coldChild(file) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const session = startSession(CalculationMode.WHEN_EMPTY);
    try {
        const book = session.api.createWorkbook(snapshot);
        await session.formula.onCalculationResultApplied(10_000);
        const before = readCell(sheetByName(book, 'Summary'), 'B2');
        await recalc(session.formula);
        const after = readCell(sheetByName(book, 'Summary'), 'B2');
        console.log(JSON.stringify({
            phase: 'cold',
            afterDefaultInitialization: before.value,
            afterForcedRecalculation: after.value,
            formula: after.formula,
            numberFormat: after.numberFormat,
        }));
    } finally {
        session.univer.dispose();
    }
}

async function unknownChild(file) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    snapshot.resources = [...(snapshot.resources ?? []), { name: 'VAULTER_UNREGISTERED_SENTINEL', data: '{"kept":true}' }];
    const session = startSession(CalculationMode.WHEN_EMPTY);
    try {
        const book = session.api.createWorkbook(snapshot);
        const names = (book.save().resources ?? []).map((item) => item.name);
        console.log(JSON.stringify({
            phase: 'unknown-resource',
            savedContainsSentinel: names.includes('VAULTER_UNREGISTERED_SENTINEL'),
            resourceNames: names,
        }));
    } finally {
        session.univer.dispose();
    }
}

function largeSnapshot(skeleton) {
    const saved = structuredClone(skeleton);
    const sheet = saved.sheets[saved.sheetOrder[0]];
    sheet.name = 'Grid';
    sheet.rowCount = 10_000;
    sheet.columnCount = 20;
    sheet.cellData = {};
    for (let row = 0; row < 10_000; row += 1) {
        const line = {};
        for (let column = 0; column < 9; column += 1) line[column] = { v: row + column, t: 2 };
        line[9] = { f: `=A${row + 1}+1`, t: 2 };
        sheet.cellData[row] = line;
    }
    saved.sheetOrder = [saved.sheetOrder[0]];
    saved.sheets = { [saved.sheetOrder[0]]: sheet };
    return saved;
}

async function timeOpen(snapshot, runs) {
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
        const session = startSession(CalculationMode.FORCED);
        const started = performance.now();
        const applied = session.formula.onCalculationResultApplied(120_000);
        session.api.createWorkbook(structuredClone(snapshot));
        await applied;
        samples.push(Math.round((performance.now() - started) * 1000) / 1000);
        session.univer.dispose();
    }
    return summarize(samples);
}

function heapUsed() {
    if (typeof global.gc === 'function') global.gc();
    return process.memoryUsage().heapUsed;
}

async function disposeCycles(snapshot, cycles) {
    const before = heapUsed();
    for (let i = 0; i < cycles; i += 1) {
        const session = startSession(CalculationMode.NO_CALCULATION);
        session.api.createWorkbook(structuredClone(snapshot));
        session.univer.dispose();
    }
    const after = heapUsed();
    return {
        cycles,
        deltaBytes: after - before,
        gc: typeof global.gc === 'function',
        note: 'Node heapUsed around open/dispose. The browser CDP budget is recorded by browser.mjs.',
    };
}

async function measure() {
    const corpus = loadCorpus();
    const book = corpus.book;
    const initial = step(book, 'recalculate');
    const edited = step(book, 'set_number');
    const inserted = step(book, 'insert_row_before');
    const checks = [];
    const session = startSession(CalculationMode.FORCED);
    let saved = null;
    try {
        const workbook = session.api.createWorkbook({ id: book.bookId, name: 'Fruit' });
        fillCorpus(workbook, book);
        await recalc(session.formula);
        const detail = sheetByName(workbook, 'Detail');
        const summary = sheetByName(workbook, 'Summary');
        checkEqual(checks, 'initial Detail!D2', readCell(detail, 'D2').value, initial.expect['Detail!D2']);
        checkEqual(checks, 'initial Detail!D3', readCell(detail, 'D3').value, initial.expect['Detail!D3']);
        checkEqual(checks, 'initial Summary!B2', readCell(summary, 'B2').value, initial.expect['Summary!B2']);

        detail.getRange('C3').setValue(edited.value);
        await recalc(session.formula);
        checkEqual(checks, 'edited Detail!C3', readCell(detail, 'C3').value, edited.expect['Detail!C3']);
        checkEqual(checks, 'edited Detail!D3', readCell(detail, 'D3').value, edited.expect['Detail!D3']);
        checkEqual(checks, 'edited Summary!B2', readCell(summary, 'B2').value, edited.expect['Summary!B2']);

        const priceBeforeUndo = readCell(detail, 'C3').value;
        let undo = { available: typeof session.api.undo === 'function' };
        if (undo.available) {
            try {
                await session.api.undo();
                undo = { available: true, valueBeforeUndo: priceBeforeUndo, valueAfterUndo: readCell(detail, 'C3').value };
            } catch (error) {
                undo = { available: true, error: error instanceof Error ? error.message : String(error) };
            }
            if (readCell(detail, 'C3').value !== edited.value) {
                detail.getRange('C3').setValue(edited.value);
                await recalc(session.formula);
            }
        }

        detail.insertRowsBefore(1, 1);
        await recalc(session.formula);
        const expectInsert = inserted.expect;
        checkEqual(checks, 'insert Detail!C3', readCell(detail, 'C3').value, expectInsert['Detail!C3']);
        checkEqual(checks, 'insert Detail!C4', readCell(detail, 'C4').value, expectInsert['Detail!C4']);
        checkEqual(checks, 'insert Detail!D3 formula', readCell(detail, 'D3').formula, expectInsert['Detail!D3'].formula);
        checkEqual(checks, 'insert Detail!D4 formula', readCell(detail, 'D4').formula, expectInsert['Detail!D4'].formula);
        checkEqual(checks, 'insert Detail!D3 number', readCell(detail, 'D3').value, expectInsert['Detail!D3'].number);
        checkEqual(checks, 'insert Detail!D4 number', readCell(detail, 'D4').value, expectInsert['Detail!D4'].number);
        checkEqual(checks, 'insert Summary!B2 formula', readCell(summary, 'B2').formula, expectInsert['Summary!B2'].formula);
        checkEqual(checks, 'insert Summary!B2 number', readCell(summary, 'B2').value, expectInsert['Summary!B2'].number);
        checkEqual(checks, 'insert Summary!B2 format', readCell(summary, 'B2').numberFormat, expectInsert['Summary!B2'].numberFormat);

        saved = workbook.save();
        const resourceNames = (saved.resources ?? []).map((item) => item.name).sort();

        let largePasteMs = null;
        try {
            detail.setRowCount(200);
            detail.setColumnCount(120);
            const pasteStarted = performance.now();
            const block = Array.from({ length: 100 }, (_, row) => Array.from({ length: 100 }, (_, column) => row * 100 + column));
            detail.getRange('A10:CV109').setValues(block);
            largePasteMs = Math.round((performance.now() - pasteStarted) * 1000) / 1000;
        } catch (error) {
            largePasteMs = { error: error instanceof Error ? error.message : String(error) };
        }

        let dataValidation = null;
        try {
            await detail.getRange('B2:B3').setDataValidation(session.api.newDataValidation().requireNumberBetween(1, 100).build());
            const beforeRule = detail.getDataValidations()[0]?.rule?.ranges?.[0] ?? null;
            detail.insertRowsBefore(1, 1);
            const afterRule = detail.getDataValidations()[0]?.rule?.ranges?.[0] ?? null;
            dataValidation = {
                before: beforeRule ? { startRow: beforeRule.startRow, endRow: beforeRule.endRow } : null,
                afterInsertRowBefore: afterRule ? { startRow: afterRule.startRow, endRow: afterRule.endRow } : null,
                shifted: Boolean(afterRule && beforeRule && afterRule.startRow === beforeRule.startRow + 1),
            };
        } catch (error) {
            dataValidation = { error: error instanceof Error ? error.message : String(error) };
        }

        let conditional = null;
        try {
            detail.addConditionalFormattingRule(detail.newConditionalFormattingRule()
                .whenNumberGreaterThan(18)
                .setRanges([detail.getRange('D2:D3').getRange()])
                .setBackground('#ff0000')
                .build());
            const beforeRange = detail.getConditionalFormattingRules()[0]?.ranges?.[0] ?? null;
            detail.insertRowsBefore(1, 1);
            const afterRange = detail.getConditionalFormattingRules()[0]?.ranges?.[0] ?? null;
            conditional = {
                before: beforeRange ? { startRow: beforeRange.startRow, endRow: beforeRange.endRow } : null,
                afterInsertRowBefore: afterRange ? { startRow: afterRange.startRow, endRow: afterRange.endRow } : null,
                shifted: Boolean(afterRange && beforeRange && afterRange.startRow === beforeRange.startRow + 1),
            };
        } catch (error) {
            conditional = { error: error instanceof Error ? error.message : String(error) };
        }

        let openTiming = null;
        let memory = null;
        if (process.env.BENCH_SKIP_LARGE === '1') {
            openTiming = { skipped: true };
        } else {
            try {
                const large = largeSnapshot(workbook.save());
                openTiming = await timeOpen(large, 3);
                memory = await disposeCycles(large, 20);
            } catch (error) {
                openTiming = { error: error instanceof Error ? error.message : String(error) };
            }
        }

        return {
            engine: '@univerjs/core',
            version: versionOf('@univerjs/core'),
            license: 'Apache-2.0',
            mode: 'plugin',
            node: process.version,
            plugins: PLUGIN_SPECS.map(([name]) => ({ name, version: versionOf(name), license: 'Apache-2.0' })),
            registered: session.registered,
            failedPlugins: session.failed,
            opened: true,
            calculation: 'formula',
            checks,
            undo,
            largePaste: { rows: 100, columns: 100, ms: largePasteMs },
            resources: resourceNames,
            conditionalFormatting: conditional,
            dataValidation,
            timings: { openForced100kCells10kFormulas: openTiming },
            memory,
            saved,
        };
    } finally {
        session.univer.dispose();
    }
}

const phase = process.argv[2] ?? 'main';
if (phase === 'cold') {
    await coldChild(process.argv[3]);
} else if (phase === 'unknown') {
    await unknownChild(process.argv[3]);
} else {
    const measured = await measure();
    const saved = measured.saved;
    delete measured.saved;
    const summaryId = saved.sheetOrder.find((id) => saved.sheets[id].name === 'Summary');
    const poisoned = structuredClone(saved);
    poisoned.sheets[summaryId].cellData[1][1].v = 999;
    const cold = await runChild('cold', poisoned);
    const unknown = await runChild('unknown', saved);
    measured.coldCache = cold;
    measured.unknownResource = unknown;
    measured.corpusMatched = measured.checks.every((item) => item.ok)
        && cold.result?.afterDefaultInitialization === 999
        && cold.result?.afterForcedRecalculation === 41
        && cold.result?.formula === '=SUM(Detail!D3:D4)'
        && unknown.result?.savedContainsSentinel === false;
    console.log(JSON.stringify(measured));
}
