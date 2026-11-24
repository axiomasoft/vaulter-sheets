import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyWorkbookWithIronCalc} from '../src/engine/ironcalc.ts';
import {runOperation} from '../src/operation.ts';
import {WIRE_PROFILE} from '../src/profile.ts';
import {sha256Canonical, type WorkbookV2} from '../src/protocol.ts';

function makeFormulaWorkbook(formula: string, settledValue: number): WorkbookV2 {
    return {
        format_version: 2,
        profile: WIRE_PROFILE,
        native: {
            id: 'wb_ic',
            name: 'IronCalcTest',
            appVersion: '1.5.2',
            locale: 'enUS',
            styles: {},
            resources: [],
            sheetOrder: ['sheet_1'],
            sheets: {
                sheet_1: {
                    id: 'sheet_1',
                    name: 'Sheet1',
                    rowCount: 20,
                    columnCount: 10,
                    cellData: {
                        '0': {
                            '0': {t: 2, v: 10},
                            '1': {t: 2, v: 20},
                            '2': {t: 2, v: settledValue, f: formula},
                        },
                    },
                },
            },
        },
        tables: [],
    };
}

test('verifyWorkbookWithIronCalc matches Univer arithmetic and detects mismatches', async () => {
    const okBook = makeFormulaWorkbook('=SUM(A1:B1)*2', 60);
    const okResult = await verifyWorkbookWithIronCalc(okBook);
    assert.equal(okResult.engine, '@ironcalc/nodejs');
    assert.equal(okResult.checked_formulas, 1);
    assert.equal(okResult.matched, 1);
    assert.equal(okResult.mismatched, 0);
    assert.deepEqual(okResult.discrepancies, []);

    const badBook = makeFormulaWorkbook('=SUM(A1:B1)*2', 999);
    const badResult = await verifyWorkbookWithIronCalc(badBook);
    assert.equal(badResult.mismatched, 1);
    assert.equal(badResult.discrepancies[0].a1, 'C1');
    assert.equal(badResult.discrepancies[0].univer_value, 999);
    assert.equal(badResult.discrepancies[0].ironcalc_value, '60');
});

test('runOperation attaches ironcalc_verification only when opt-in flag is set', async () => {
    const wb = makeFormulaWorkbook('=A1+B1', 30);
    const baseSha = sha256Canonical(wb);
    const resDefault = await runOperation({
        version: 1,
        request_id: 'ic_off',
        profile_id: WIRE_PROFILE.id,
        operation: 'read',
        base: {generation: 1, position: 0, sha256: baseSha},
        workbook: wb,
        selector: {ranges: [{sheet_id: 'sheet_1', range: 'A1:C1'}]},
    } as never);
    assert.equal(resDefault.ok, true);
    if (resDefault.ok) {
        assert.equal((resDefault as unknown as Record<string, unknown>).checks, undefined);
    }

    const resOptIn = await runOperation({
        version: 1,
        request_id: 'ic_on',
        profile_id: WIRE_PROFILE.id,
        operation: 'apply',
        base: {generation: 1, position: 0, sha256: baseSha},
        workbook: wb,
        commands: [{kind: 'set_number', sheet_id: 'sheet_1', row: 1, column: 1, expected: {number: 10}, value: 15}],
        ironcalc_verify: true,
    } as never);
    assert.equal(resOptIn.ok, true);
    if (resOptIn.ok && resOptIn.operation === 'apply') {
        const ic = (resOptIn.checks as Record<string, unknown>).ironcalc_verification as {matched: number; mismatched: number};
        assert.equal(ic.matched, 1);
        assert.equal(ic.mismatched, 0);
    }
});
