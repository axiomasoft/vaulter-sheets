/** One-based wire coordinates and A1 notation. Target: packages/runtime/src/coordinates.ts. */
import {WireError} from './wire-error.ts';

/** One-based row/column as used on the wire, in `tables` and in A1 notation. */
export interface CellCoord {row: number; column: number}

export function assertOneBased(value: unknown, what: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new WireError('invalid_message', `${what} must be a one-based integer`);
    }
    return value;
}

/**
 * The only conversion between one-based wire coordinates and zero-based engine indices.
 * Every engine call that takes a row or column index receives the result of this function.
 */
export function engineIndex(oneBased: number): number {
    return assertOneBased(oneBased, 'coordinate') - 1;
}

export function columnLetters(column: number): string {
    let n = assertOneBased(column, 'column');
    let out = '';
    while (n > 0) {
        const rest = (n - 1) % 26;
        out = String.fromCharCode(65 + rest) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

export function toA1(coord: CellCoord): string {
    return `${columnLetters(coord.column)}${assertOneBased(coord.row, 'row')}`;
}

export function parseA1(a1: string): CellCoord {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(a1);
    if (match === null) throw new WireError('invalid_message', `invalid A1 cell ${JSON.stringify(a1)}`);
    let column = 0;
    for (const letter of match[1]) column = column * 26 + (letter.charCodeAt(0) - 64);
    return {row: Number(match[2]), column};
}

export function parseRange(range: string): {start: CellCoord; end: CellCoord} {
    const [first, second, extra] = range.split(':');
    if (extra !== undefined) throw new WireError('invalid_message', `invalid range ${JSON.stringify(range)}`);
    const start = parseA1(first);
    const end = second === undefined ? start : parseA1(second);
    if (end.row < start.row || end.column < start.column) throw new WireError('invalid_message', `reversed range ${range}`);
    return {start, end};
}

export function rangeCells(range: string, limit: number): CellCoord[] {
    const {start, end} = parseRange(range);
    const count = (end.row - start.row + 1) * (end.column - start.column + 1);
    if (count > limit) throw new WireError('limit_exceeded', `range ${range} has ${count} cells, limit ${limit}`);
    const cells: CellCoord[] = [];
    for (let row = start.row; row <= end.row; row++) {
        for (let column = start.column; column <= end.column; column++) cells.push({row, column});
    }
    return cells;
}
