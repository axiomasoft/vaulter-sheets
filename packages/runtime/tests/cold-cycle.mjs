import assert from 'node:assert/strict';
import {UniverWorkbookSession} from '../dist/engine/univer.js';
import {sha256Canonical} from '../dist/protocol.js';
import {WIRE_PROFILE} from '../dist/profile.js';

const rows = 1000;
const columns = 100;
const cells = {};
for (let row = 0; row < rows; row++) {
    cells[row] = {};
    for (let column = 0; column < columns; column++) {
        cells[row][column] = column >= 90
            ? {f: `=A${row + 1}+${row * 10 + column}`}
            : {v: row + column, t: 2};
    }
}
const native = {
    id: 'cold-cycle', name: 'Cold workbook', locale: 'enUS', appVersion: '1.5.2',
    sheetOrder: ['grid'], styles: {}, resources: [],
    sheets: {grid: {id: 'grid', name: 'Grid', rowCount: rows, columnCount: columns, cellData: cells}},
};
const started = performance.now();
const session = UniverWorkbookSession.open(native);
const opened = performance.now();
try {
    await session.settle(20_000);
    const calculated = performance.now();
    assert.equal(session.readback('grid', {row: 1000, column: 100}).value, 11_088);
    sha256Canonical({format_version: 2, profile: WIRE_PROFILE, native: session.save(), tables: []});
    const ended = performance.now();
    const stats = {
        openMs: Math.round(opened - started), calculateMs: Math.round(calculated - opened),
        saveAndCanonicalizeMs: Math.round(ended - calculated), totalMs: Math.round(ended - started),
    };
    console.log(JSON.stringify(stats));
    assert.ok(stats.totalMs <= 950, 'Cold 100k-cell / 10k-formula workbook exceeded 950 ms');
} finally {
    session.dispose();
}
