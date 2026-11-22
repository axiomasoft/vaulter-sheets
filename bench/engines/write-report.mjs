/**
 * Turns bench JSON into bench/engines/results.md and bench/results/4.1/manifest.json.
 * Run with: node --experimental-strip-types bench/engines/write-report.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_MANIFEST, PROFILE_RESOURCES } from '../../packages/runtime/src/profile.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'bench/results/4.1');

function readJson(name) {
    try {
        return JSON.parse(readFileSync(join(outDir, name), 'utf8'));
    } catch {
        return null;
    }
}

function readText(name) {
    try {
        return readFileSync(join(outDir, name), 'utf8');
    } catch {
        return null;
    }
}

const univer = readJson('univer.json');
const ironcalc = readJson('ironcalc.json');
const offline = readJson('offline.json');
const browser = readJson('univer-browser.json');
const nodeVersion = (readText('node.txt') ?? '').trim();
const headlessExit = Number((readText('headless/exit') ?? 'null').trim());
const browserExit = Number((readText('sheets-browser.exit') ?? 'null').trim());
const corpusSha = createHash('sha256').update(readFileSync(join(root, 'examples/workbook.json'))).digest('hex');

const resourceDelta = univer
    ? {
        measured: univer.resources ?? [],
        approved: [...PROFILE_RESOURCES],
        onlyMeasured: (univer.resources ?? []).filter((name) => !PROFILE_RESOURCES.includes(name)),
        onlyApproved: PROFILE_RESOURCES.filter((name) => !(univer.resources ?? []).includes(name)),
    }
    : null;

const manifest = {
    schema: 'vaulter-sheets-engine-profile/v1',
    schemaVersion: PROFILE_MANIFEST.schemaVersion,
    task: '4.1',
    decision: PROFILE_MANIFEST.id,
    engine: PROFILE_MANIFEST.engine,
    license: PROFILE_MANIFEST.license,
    node: nodeVersion,
    corpusSha256: corpusSha,
    officialChecks: {
        'univer-headless': { exit: Number.isNaN(headlessExit) ? null : headlessExit },
        'sheets-browser': { exit: Number.isNaN(browserExit) ? null : browserExit },
    },
    profile: PROFILE_MANIFEST,
    resourceDelta,
    univer: univer ? { ...univer, saved: undefined } : null,
    ironcalc,
    offline,
    browser,
};

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

function yn(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'n/a';
}

function timing(block) {
    if (!block) return 'n/a';
    if (block.error) return `error: ${block.error}`;
    if (block.open) return `p50 ${block.open.p50_ms} ms, p95 ${block.open.p95_ms} ms (n=${block.open.n})`;
    return `p50 ${block.p50_ms} ms, p95 ${block.p95_ms} ms (n=${block.n})`;
}

const lines = [
    '# Engine comparison 4.1',
    '',
    `Decision: \`${PROFILE_MANIFEST.id}\` on \`${PROFILE_MANIFEST.engine}\` (${PROFILE_MANIFEST.license}).`,
    'IronCalc `@ironcalc/nodejs@0.9.1` (MIT OR Apache-2.0) is the calculation cross-check and is not the browser engine.',
    'Handsontable and HyperFormula are an offline benchmark only and are not production dependencies.',
    '',
    `| Candidate | Ran | Corpus | License | Production |`,
    `| --- | --- | --- | --- | --- |`,
    `| Univer OSS ${univer?.version ?? '1.5.2'} | ${yn(Boolean(univer))} | ${yn(univer?.corpusMatched)} | Apache-2.0 | yes |`,
    `| IronCalc ${ironcalc?.version ?? '0.9.1'} | ${yn(Boolean(ironcalc))} | ${yn(ironcalc?.corpusMatched)} | MIT OR Apache-2.0 | no |`,
    `| HyperFormula 3.5.0 | ${offline?.status === 'ran' ? 'yes' : 'no'} | ${yn(offline?.corpusMatched)} | GPL-3.0-only | no |`,
    `| Handsontable 18.1.2 | ${offline?.handsontable?.status === 'loaded_not_mounted' ? 'loaded, not mounted' : 'not run'} | n/a | commercial | no |`,
    '',
    '## Formula corpus',
    '',
    'Vector: `examples/workbook.json`. Expected path: 35, then price 7 → 41, then insert → `=SUM(Detail!D3:D4)` = 41, cold cache 999 unverified until forced recalculation returns 41.',
    '',
    `- Univer checks passed: ${yn(univer?.corpusMatched)}`,
    `- Univer cold cache: ${JSON.stringify(univer?.coldCache?.result ?? null)}`,
    `- Univer unknown resource kept: ${JSON.stringify(univer?.unknownResource?.result?.savedContainsSentinel ?? null)}`,
    `- Univer conditional formatting: ${JSON.stringify(univer?.conditionalFormatting ?? null)}`,
    `- Univer data validation: ${JSON.stringify(univer?.dataValidation ?? null)}`,
    `- IronCalc corpus: ${yn(ironcalc?.corpusMatched)}. Shared Univer snapshot: ${yn(ironcalc?.sharedUniverSnapshot)}.`,
    `- IronCalc cold cache: ${ironcalc?.coldCache?.note ?? 'n/a'}`,
    `- IronCalc conditional formatting: ${JSON.stringify(ironcalc?.conditionalFormatting ?? null)}`,
    `- IronCalc undo: ${JSON.stringify(ironcalc?.undo ?? null)}`,
    `- IronCalc clipboard: ${JSON.stringify(ironcalc?.clipboard ?? null)}`,
    `- HyperFormula corpus: ${yn(offline?.corpusMatched)}. Summary formula after insert: ${offline?.summaryFormulaAfterInsert ?? 'n/a'}.`,
    `- Handsontable: ${offline?.handsontable?.status ?? 'not run'}. ${offline?.handsontable?.reason ?? ''}`,
    '',
    '## Resources and commands',
    '',
    `Approved resources: ${PROFILE_RESOURCES.join(', ') || '(none)'}.`,
    `Measured save() resources: ${(univer?.resources ?? []).join(', ') || '(none)'}.`,
    `Only measured: ${resourceDelta?.onlyMeasured.join(', ') || '(none)'}. Only approved: ${resourceDelta?.onlyApproved.join(', ') || '(none)'}.`,
    '',
    'A persisting command on an unknown resource returns `unsupported_content` before the write.',
    '`insert_row_before` on `SHEET_CONDITIONAL_FORMATTING_PLUGIN` returns `unsupported_content` before the write.',
    '',
    '## Timing and memory',
    '',
    `- Univer open of 100k cells / 10k formulas (forced): ${timing(univer?.timings?.openForced100kCells10kFormulas)}`,
    `- Univer 100×100 paste: ${univer?.largePaste ? `${univer.largePaste.ms} ms` : 'n/a'}`,
    `- Univer 20× open/dispose Node heap delta: ${univer?.memory?.deltaBytes ?? 'n/a'} bytes (gc=${univer?.memory?.gc ?? 'n/a'})`,
    `- Browser CDP heap delta: ${browser?.memory?.deltaBytes ?? 'n/a'} bytes`,
    `- Browser long tasks: ${JSON.stringify(browser?.longTasks ?? null)}`,
    `- IronCalc large book: ${timing(ironcalc?.timings?.open100kCells10kFormulas)}`,
    '',
    '## Browser, clipboard, undo, accessibility',
    '',
    `- Official sheets-browser exit: ${Number.isNaN(browserExit) ? 'not run' : browserExit}`,
    `- Official univer-headless exit: ${Number.isNaN(headlessExit) ? 'not run' : headlessExit}`,
    `- Bench browser input: ${JSON.stringify(browser?.input ?? null)}`,
    `- Bench clipboard: ${JSON.stringify(browser?.clipboard ?? null)}`,
    `- Bench undo: ${JSON.stringify(browser?.undo ?? null)}`,
    `- Bench accessibility snapshot: ${typeof browser?.accessibility === 'string' ? 'recorded in manifest.json' : 'n/a'}`,
    '',
    '## Process rules',
    '',
    `- Isolation: \`${PROFILE_MANIFEST.process.isolation}\`, worker_threads ${PROFILE_MANIFEST.process.workerThreads}, max old space ${PROFILE_MANIFEST.process.maxOldSpaceSizeMb} MB.`,
    `- Formula barrier: \`${PROFILE_MANIFEST.process.calculationBarrier}\` after \`${PROFILE_MANIFEST.process.formulaMode}\`. Stale cache is ${PROFILE_MANIFEST.process.staleCache}.`,
    `- Node recorded by this run: ${nodeVersion || 'unknown'}.`,
    '',
];

writeFileSync(join(root, 'bench/engines/results.md'), `${lines.join('\n')}\n`);

const univerOk = univer?.corpusMatched === true;
const headlessOk = headlessExit === 0;
const browserOk = browserExit === 0;
if (!univerOk || !headlessOk || !browserOk) {
    console.error(JSON.stringify({ univerOk, headlessOk, browserOk }));
    process.exit(1);
}
console.log('compare-engines: univer corpus and official checks passed');
