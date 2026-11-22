/**
 * Offline benchmark only. Packages are installed in a temp directory and are
 * not production dependencies. Handsontable is commercial. HyperFormula is GPL-3.0-only.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCorpus, step } from '../corpus.mjs';

const dir = mkdtempSync(join(tmpdir(), 'vaulter-offline-bench-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
        handsontable: '18.1.2',
        hyperformula: '3.5.0',
    },
}));
const cache = process.env.NPM_CONFIG_CACHE || join(tmpdir(), 'npm-cache');
const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], {
    cwd: dir,
    encoding: 'utf8',
});
if (installed.status !== 0) {
    console.log(JSON.stringify({
        status: 'not_run',
        production: false,
        node: process.version,
        error: (installed.stderr || installed.stdout || '').slice(0, 2000),
    }));
    process.exit(0);
}

const require = createRequire(join(dir, 'package.json'));
const hyperformulaModule = require('hyperformula');
const HyperFormula = hyperformulaModule.HyperFormula ?? hyperformulaModule.default ?? hyperformulaModule;
const corpus = loadCorpus().book;
const initial = step(corpus, 'recalculate');
const edited = step(corpus, 'set_number');
const inserted = step(corpus, 'insert_row_before');

const hf = HyperFormula.buildFromSheets({
    Detail: [
        ['Товар', 'Количество', 'Цена', 'Сумма'],
        ['Яблоки', 2, 10, '=B2*C2'],
        ['Груши', 3, 5, '=B3*C3'],
    ],
    Summary: [
        [null, null],
        ['Итого', '=SUM(Detail!D2:D3)'],
    ],
}, { licenseKey: 'gpl-v3' });

const detail = hf.getSheetId('Detail');
const summary = hf.getSheetId('Summary');
const value = (sheet, row, column) => hf.getCellValue({ sheet, row, col: column });
const formula = (sheet, row, column) => hf.getCellFormula({ sheet, row, col: column });
const checks = [];
function expect(name, actual, expectedValue) {
    checks.push({ name, ok: actual === expectedValue, actual, expected: expectedValue });
}
expect('initial Detail!D2', value(detail, 1, 3), initial.expect['Detail!D2']);
expect('initial Detail!D3', value(detail, 2, 3), initial.expect['Detail!D3']);
expect('initial Summary!B2', value(summary, 1, 1), initial.expect['Summary!B2']);
hf.setCellContents({ sheet: detail, row: 2, col: 2 }, 7);
expect('edited Detail!C3', value(detail, 2, 2), edited.expect['Detail!C3']);
expect('edited Detail!D3', value(detail, 2, 3), edited.expect['Detail!D3']);
expect('edited Summary!B2', value(summary, 1, 1), edited.expect['Summary!B2']);
hf.addRows(detail, [1, 1]);
expect('insert Detail!C3', value(detail, 2, 2), inserted.expect['Detail!C3']);
expect('insert Detail!C4', value(detail, 3, 2), inserted.expect['Detail!C4']);
expect('insert Summary!B2', value(summary, 1, 1), inserted.expect['Summary!B2'].number);
const summaryFormula = formula(summary, 1, 1);

let handsontable = { status: 'not_run', production: false };
try {
    const mod = require('handsontable');
    const ctor = mod?.default ?? mod;
    handsontable = {
        status: 'loaded_not_mounted',
        production: false,
        exportType: typeof ctor,
        reason: 'The grid needs a browser document and a commercial key. This process did not mount it.',
    };
} catch (error) {
    handsontable = { status: 'not_run', production: false, error: error instanceof Error ? error.message : String(error) };
}

console.log(JSON.stringify({
    status: 'ran',
    production: false,
    node: process.version,
    hyperformula: { version: '3.5.0', license: 'GPL-3.0-only', calculation: 'formula' },
    handsontable,
    checks,
    corpusMatched: checks.every((item) => item.ok),
    summaryFormulaAfterInsert: summaryFormula,
    unknownResource: { note: 'Not a Univer snapshot. Unknown resources are out of scope.' },
    conditionalFormatting: { note: 'Not measured. The grid was not mounted.' },
}));
