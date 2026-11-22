/** IronCalc 0.9.1 (`@ironcalc/nodejs`) cross-check. Rows and columns are 1-based. */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Model, UserModel } from '@ironcalc/nodejs';
import { loadCorpus, step, summarize } from '../corpus.mjs';

function versionOf() {
    const require = createRequire(import.meta.url);
    return require('@ironcalc/nodejs/package.json').version;
}

function address(cell) {
    return { column: cell.charCodeAt(0) - 64, row: Number(cell.slice(1)) };
}

function write(model, sheet, cellAddress, cell) {
    const { row, column } = address(cellAddress);
    if (cell.formula) model.updateCellWithFormula(sheet, row, column, cell.formula);
    else if (typeof cell.number === 'number') model.updateCellWithNumber(sheet, row, column, cell.number);
    else model.updateCellWithText(sheet, row, column, cell.text);
    if (cell.numberFormat) {
        const style = model.getCellStyle(sheet, row, column);
        style.num_fmt = cell.numberFormat;
        model.setCellStyle(sheet, row, column, style);
    }
}

function read(model, sheetName, cellAddress) {
    const sheet = model.getWorksheetsProperties().findIndex((item) => item.name === sheetName);
    const { row, column } = address(cellAddress);
    return {
        value: model.getCellValue(sheet, row, column),
        formula: model.getCellFormula(sheet, row, column),
        numberFormat: model.getCellStyle(sheet, row, column).num_fmt,
    };
}

function build(book) {
    const model = new Model(book.bookId, 'en', 'UTC', 'en');
    model.renameSheet(0, 'Detail');
    model.addSheet('Summary');
    for (const spec of book.sheets) {
        const sheet = spec.name === 'Detail' ? 0 : 1;
        for (const [cellAddress, cell] of Object.entries(spec.cells)) write(model, sheet, cellAddress, cell);
    }
    return model;
}

function checkEqual(checks, name, actual, expected) {
    checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}

function freshUser(book) {
    const user = new UserModel(book.bookId, 'en', 'UTC', 'en');
    user.renameSheet(0, 'Detail');
    user.newSheet();
    user.renameSheet(1, 'Summary');
    for (const spec of book.sheets) {
        const sheet = spec.name === 'Detail' ? 0 : 1;
        for (const [cellAddress, cell] of Object.entries(spec.cells)) {
            const { row, column } = address(cellAddress);
            if (cell.formula) user.setUserInput(sheet, row, column, cell.formula);
            else if (typeof cell.number === 'number') user.setUserInput(sheet, row, column, String(cell.number));
            else user.setUserInput(sheet, row, column, cell.text);
        }
    }
    return user;
}

const corpus = loadCorpus();
const book = corpus.book;
const initial = step(book, 'recalculate');
const edited = step(book, 'set_number');
const inserted = step(book, 'insert_row_before');
const checks = [];
const model = build(book);
const beforeEvaluate = read(model, 'Summary', 'B2');
model.evaluate();
checkEqual(checks, 'initial Detail!D2', read(model, 'Detail', 'D2').value, initial.expect['Detail!D2']);
checkEqual(checks, 'initial Detail!D3', read(model, 'Detail', 'D3').value, initial.expect['Detail!D3']);
checkEqual(checks, 'initial Summary!B2', read(model, 'Summary', 'B2').value, initial.expect['Summary!B2']);

const { row, column } = address('C3');
model.updateCellWithNumber(0, row, column, edited.value);
model.evaluate();
checkEqual(checks, 'edited Detail!C3', read(model, 'Detail', 'C3').value, edited.expect['Detail!C3']);
checkEqual(checks, 'edited Detail!D3', read(model, 'Detail', 'D3').value, edited.expect['Detail!D3']);
checkEqual(checks, 'edited Summary!B2', read(model, 'Summary', 'B2').value, edited.expect['Summary!B2']);

model.insertRows(0, inserted.target.row, 1);
model.evaluate();
const expectInsert = inserted.expect;
checkEqual(checks, 'insert Detail!C3', read(model, 'Detail', 'C3').value, expectInsert['Detail!C3']);
checkEqual(checks, 'insert Detail!C4', read(model, 'Detail', 'C4').value, expectInsert['Detail!C4']);
checkEqual(checks, 'insert Detail!D3 formula', read(model, 'Detail', 'D3').formula, expectInsert['Detail!D3'].formula);
checkEqual(checks, 'insert Detail!D4 formula', read(model, 'Detail', 'D4').formula, expectInsert['Detail!D4'].formula);
checkEqual(checks, 'insert Detail!D3 number', read(model, 'Detail', 'D3').value, expectInsert['Detail!D3'].number);
checkEqual(checks, 'insert Detail!D4 number', read(model, 'Detail', 'D4').value, expectInsert['Detail!D4'].number);
checkEqual(checks, 'insert Summary!B2 formula', read(model, 'Summary', 'B2').formula, expectInsert['Summary!B2'].formula);
checkEqual(checks, 'insert Summary!B2 number', read(model, 'Summary', 'B2').value, expectInsert['Summary!B2'].number);

let conditional = null;
try {
    const user = freshUser(book);
    user.addConditionalFormatting(0, 'D2:D3', {
        type: 'CellIs',
        operator: 'GreaterThan',
        formula: '18',
        formula2: null,
        format: { fill: { color: '#FF0000' } },
        stop_if_true: false,
    });
    const before = user.getConditionalFormattingList(0).map((rule) => rule.range);
    user.insertRows(0, 2, 1);
    const after = user.getConditionalFormattingList(0).map((rule) => rule.range);
    conditional = { before, afterInsertRowBefore: after, shifted: JSON.stringify(before) !== JSON.stringify(after) };
} catch (error) {
    conditional = { error: error instanceof Error ? error.message : String(error) };
}

let undo = null;
try {
    const user = freshUser(book);
    const before = user.getCellContent(0, 3, 3);
    user.setUserInput(0, 3, 3, '7');
    const editedValue = user.getCellContent(0, 3, 3);
    const canUndo = user.canUndo();
    user.undo();
    undo = { available: true, canUndo, before, editedValue, afterUndo: user.getCellContent(0, 3, 3) };
} catch (error) {
    undo = { available: false, error: error instanceof Error ? error.message : String(error) };
}

let clipboard = null;
{
    const user = freshUser(book);
    let stepName = 'setup';
    let copied = null;
    try {
        stepName = 'select';
        user.setSelectedSheet(0);
        user.setSelectedCell(3, 3);
        user.setSelectedRange(3, 3, 3, 3);
        stepName = 'copy';
        copied = user.copyToClipboard();
        stepName = 'paste';
        user.setSelectedCell(5, 5);
        user.setSelectedRange(5, 5, 5, 5);
        const sourceRange = copied.range.map((item) => Number(item));
        user.pasteFromClipboard(0, sourceRange, copied.data, false);
        clipboard = { available: true, step: 'pasted', copiedCsv: copied.csv, pasted: user.getCellContent(0, 5, 5) };
    } catch (error) {
        clipboard = {
            available: false,
            step: stepName,
            copy: copied ? { csv: copied.csv, range: copied.range } : null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

const roundTrip = model.toBytes();
const reopened = Model.fromBytes(roundTrip, 'en');
reopened.evaluate();
const roundTripValue = read(reopened, 'Summary', 'B2').value;

let large = null;
try {
    const grid = new Model('grid', 'en', 'UTC', 'en');
    const startedBuild = performance.now();
    for (let rowIndex = 1; rowIndex <= 10_000; rowIndex += 1) {
        for (let columnIndex = 1; columnIndex <= 9; columnIndex += 1) grid.updateCellWithNumber(0, rowIndex, columnIndex, rowIndex + columnIndex);
        grid.updateCellWithFormula(0, rowIndex, 10, `=A${rowIndex}+1`);
    }
    const buildMs = performance.now() - startedBuild;
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
        const bytes = grid.toBytes();
        const started = performance.now();
        const opened = Model.fromBytes(bytes, 'en');
        opened.evaluate();
        samples.push(Math.round((performance.now() - started) * 1000) / 1000);
    }
    large = { buildMs: Math.round(buildMs), open: summarize(samples), cells: 100_000, formulas: 10_000 };
} catch (error) {
    large = { error: error instanceof Error ? error.message : String(error) };
}

console.log(JSON.stringify({
    engine: '@ironcalc/nodejs',
    requestedAs: 'ironcalc',
    version: versionOf(),
    license: 'MIT OR Apache-2.0',
    production: false,
    node: process.version,
    opened: true,
    calculation: 'formula',
    sharedUniverSnapshot: false,
    checks,
    corpusMatched: checks.every((item) => item.ok),
    coldCache: {
        representable: false,
        valueBeforeEvaluate: beforeEvaluate.value,
        note: 'Before evaluate(), Summary!B2 is #ERROR!, not a stored number. Model has no slot for an injected cache of 999 beside a formula.',
    },
    unknownResource: {
        savedContainsSentinel: false,
        note: 'No opaque resource bag. An unknown Univer resource cannot round-trip.',
    },
    conditionalFormatting: conditional,
    undo,
    clipboard,
    roundTrip: { format: 'icalc-bytes', summaryB2: roundTripValue },
    timings: { open100kCells10kFormulas: large },
}));
