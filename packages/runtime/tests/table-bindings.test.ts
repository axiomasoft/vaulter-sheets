import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TableBindings} from '../src/table-bindings.ts';
import type {TableBinding} from '../src/protocol.ts';

function sampleTables(): TableBinding[] {
    return [
        {
            table_id: 'items',
            sheet_id: 's1',
            header_row: 2,
            columns: [
                {column_id: 'name', column: 1},
                {column_id: 'qty', column: 2},
                {column_id: 'total', column: 3},
            ],
            rows: [
                {row_id: 'r1', row: 3},
                {row_id: 'r2', row: 4},
                {row_id: 'r3', row: 5},
            ],
        },
        {
            table_id: 'other',
            sheet_id: 's2',
            header_row: 1,
            columns: [{column_id: 'x', column: 1}],
            rows: [{row_id: 'o1', row: 2}],
        },
    ];
}

test('validates table bindings invariants on construction', () => {
    assert.throws(() => new TableBindings([
        {table_id: 't1', sheet_id: 's1', header_row: 2, columns: [], rows: [{row_id: 'r1', row: 2}]},
    ]), {code: 'invalid_message'});
    assert.throws(() => new TableBindings([
        {table_id: 't1', sheet_id: 's1', header_row: 1, columns: [{column_id: 'c1', column: 1}, {column_id: 'c2', column: 1}], rows: []},
    ]), {code: 'invalid_message'});
});

test('insertRows shifts header/rows, requires owner IDs inside data, and leaves unrelated sheets untouched', () => {
    const bindings = new TableBindings(sampleTables());
    bindings.insertRows('s1', 2, 1, undefined);
    const items = bindings.table('s1', 'items');
    assert.equal(items.header_row, 3);
    assert.deepEqual(items.rows.map(r => r.row), [4, 5, 6]);

    assert.throws(() => new TableBindings(sampleTables()).insertRows('s1', 4, 1, undefined), {code: 'identity_required'});
    assert.throws(() => new TableBindings(sampleTables()).insertRows('s1', 4, 1, {items: ['r1']}), {code: 'identity_required'});

    bindings.insertRows('s1', 5, 1, {items: ['r_new']});
    assert.deepEqual(bindings.members(items), ['r1', 'r_new', 'r2', 'r3']);
    assert.equal(bindings.rowOf(items, 'r3'), 7);
    assert.equal(bindings.rowOf(bindings.table('s2', 'other'), 'o1'), 2);
});

test('deleteRows removes active members, shifts lower rows, and protects header_row', () => {
    const bindings = new TableBindings(sampleTables());
    assert.throws(() => bindings.deleteRows('s1', 2, 1), {code: 'unknown_target'});

    bindings.deleteRows('s1', 4, 1);
    const items = bindings.table('s1', 'items');
    assert.deepEqual(bindings.members(items), ['r1', 'r3']);
    assert.equal(bindings.rowOf(items, 'r3'), 4);
    assert.throws(() => bindings.rowOf(items, 'r2'), {code: 'unknown_target'});

    bindings.deleteRows('s1', 1, 1);
    assert.equal(items.header_row, 1);
    assert.deepEqual(items.rows.map(r => r.row), [2, 3]);
});

test('insertColumns and deleteColumns update column coordinates deterministically', () => {
    const bindings = new TableBindings(sampleTables());
    bindings.insertColumns('s1', 2, 2);
    const items = bindings.table('s1', 'items');
    assert.equal(bindings.columnOf(items, 'name'), 1);
    assert.equal(bindings.columnOf(items, 'qty'), 4);
    assert.equal(bindings.columnOf(items, 'total'), 5);

    bindings.deleteColumns('s1', 4, 1);
    assert.throws(() => bindings.columnOf(items, 'qty'), {code: 'unknown_target'});
    assert.equal(bindings.columnOf(items, 'total'), 4);
});

test('deleteSheet removes bound tables on that sheet and toJSON sorts canonically', () => {
    const bindings = new TableBindings(sampleTables());
    bindings.deleteSheet('s1');
    assert.throws(() => bindings.table('s1', 'items'), {code: 'unknown_target'});
    assert.deepEqual(bindings.toJSON().map(t => t.table_id), ['other']);
});
