/**
 * Stable logical IDs of named tables, rows and columns -> current one-based coordinates.
 * Target: packages/runtime/src/table-bindings.ts. The bindings travel inside the
 * authoritative wrapper (`tables`), so reopen/restore does not need a projection.
 */
import {WireError, type TableBinding} from './protocol.ts';

export class TableBindings {
    readonly #tables: TableBinding[];

    constructor(tables: TableBinding[]) {
        this.#tables = structuredClone(tables);
        const tableIds = new Set<string>();
        for (const table of this.#tables) {
            if (tableIds.has(table.table_id)) throw new WireError('invalid_message', `duplicate table ${table.table_id}`);
            tableIds.add(table.table_id);
            const rowIds = new Set<string>();
            const rows = new Set<number>();
            for (const binding of table.rows) {
                if (rowIds.has(binding.row_id) || rows.has(binding.row) || binding.row <= table.header_row) {
                    throw new WireError('invalid_message', `inconsistent row binding ${binding.row_id} in ${table.table_id}`);
                }
                rowIds.add(binding.row_id);
                rows.add(binding.row);
            }
            const columnIds = new Set<string>();
            const columns = new Set<number>();
            for (const binding of table.columns) {
                if (columnIds.has(binding.column_id) || columns.has(binding.column)) {
                    throw new WireError('invalid_message', `inconsistent column binding ${binding.column_id} in ${table.table_id}`);
                }
                columnIds.add(binding.column_id);
                columns.add(binding.column);
            }
        }
    }

    table(sheetId: string, tableId: string): TableBinding {
        const table = this.#tables.find(candidate => candidate.table_id === tableId);
        if (table === undefined || table.sheet_id !== sheetId) {
            throw new WireError('unknown_target', `table ${tableId} is not bound on sheet ${sheetId}`, {table_id: tableId});
        }
        return table;
    }

    /** Active members in current sheet order. */
    members(table: TableBinding): string[] {
        return [...table.rows].sort((a, b) => a.row - b.row).map(binding => binding.row_id);
    }

    rowOf(table: TableBinding, rowId: string): number {
        const binding = table.rows.find(candidate => candidate.row_id === rowId);
        if (binding === undefined) throw new WireError('unknown_target', `row ${rowId} is not an active member of ${table.table_id}`, {row_id: rowId});
        return binding.row;
    }

    columnOf(table: TableBinding, columnId: string): number {
        const binding = table.columns.find(candidate => candidate.column_id === columnId);
        if (binding === undefined) throw new WireError('unknown_target', `column ${columnId} is not bound in ${table.table_id}`, {column_id: columnId});
        return binding.column;
    }

    /**
     * Effect of inserting `count` sheet rows before one-based `row`.
     * Rows at or below the insertion point move down and keep their IDs. An insertion
     * inside the data region (header < row <= last member row) creates new members whose
     * IDs must be supplied by the trusted owner; the runtime never invents identities.
     */
    insertRows(sheetId: string, row: number, count: number, newRowIds: {[tableId: string]: string[]} | undefined): void {
        const supplied = new Set(Object.keys(newRowIds ?? {}));
        for (const table of this.#tables.filter(candidate => candidate.sheet_id === sheetId)) {
            if (table.header_row >= row) {
                table.header_row += count;
                for (const binding of table.rows) binding.row += count;
                continue;
            }
            const lastRow = Math.max(-Infinity, ...table.rows.map(binding => binding.row));
            for (const binding of table.rows) if (binding.row >= row) binding.row += count;
            if (row > lastRow) continue;
            const ids = newRowIds?.[table.table_id];
            supplied.delete(table.table_id);
            if (ids === undefined || ids.length !== count) {
                throw new WireError('identity_required', `insertion inside ${table.table_id} needs ${count} new row IDs`, {table_id: table.table_id});
            }
            for (const [offset, rowId] of ids.entries()) {
                if (table.rows.some(binding => binding.row_id === rowId) || ids.indexOf(rowId) !== offset) {
                    throw new WireError('identity_required', `row ID ${rowId} is already used in ${table.table_id}`, {row_id: rowId});
                }
                table.rows.push({row_id: rowId, row: row + offset});
            }
        }
        if (supplied.size > 0) {
            throw new WireError('invalid_message', `new_row_ids given for tables without new members: ${[...supplied].join(', ')}`);
        }
    }

    toJSON(): TableBinding[] {
        return [...this.#tables]
            .sort((a, b) => (a.table_id < b.table_id ? -1 : a.table_id > b.table_id ? 1 : 0))
            .map(table => ({
                ...table,
                columns: [...table.columns].sort((a, b) => a.column - b.column),
                rows: [...table.rows].sort((a, b) => a.row - b.row),
            }));
    }
}
