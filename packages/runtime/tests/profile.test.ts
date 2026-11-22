import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    BANNED_PRODUCTION_PACKAGES,
    CONDITIONAL_FORMATTING_RESOURCE,
    PROFILE,
    PROFILE_MANIFEST,
    PROFILE_RESOURCES,
    assertCommandAllowed,
    assertProductionDependencies,
    gateCommand,
    isBannedProductionPackage,
} from '../src/profile.ts';

const SENTINEL = 'VAULTER_UNREGISTERED_SENTINEL';

test('schema, engine pin and plugin list stay on Univer OSS 1.5.2', () => {
    assert.equal(PROFILE_MANIFEST.schemaVersion, 1);
    assert.equal(PROFILE.id, 'univer-oss-basic-1');
    assert.equal(PROFILE.engine, '@univerjs/core@1.5.2');
    assert.ok(PROFILE.plugins.length > 0);
    for (const plugin of PROFILE.plugins) {
        assert.equal(plugin.version, '1.5.2');
        assert.equal(plugin.license, 'Apache-2.0');
        assert.equal(isBannedProductionPackage(plugin.name), false);
        assert.equal(plugin.name.startsWith('@univerjs-pro/'), false);
    }
    assert.equal(PROFILE_MANIFEST.crossCheck.production, false);
    assert.equal(PROFILE_MANIFEST.offlineBenchmark.production, false);
    assert.equal(PROFILE_MANIFEST.process.workerThreads, false);
    assert.equal(PROFILE_MANIFEST.process.isolation, 'child_process.fork');
});

test('production dependency map rejects handsontable, hyperformula and Univer Pro', () => {
    assert.equal(isBannedProductionPackage('handsontable'), true);
    assert.equal(isBannedProductionPackage('hyperformula'), true);
    assert.equal(isBannedProductionPackage('@univerjs-pro/collaboration'), true);
    assert.equal(isBannedProductionPackage('@univerjs/core'), false);
    assert.throws(
        () => assertProductionDependencies({ hyperformula: '3.5.0' }),
        /unsupported production dependency hyperformula/,
    );
    assert.throws(
        () => assertProductionDependencies({ handsontable: '18.1.2' }),
        /unsupported production dependency handsontable/,
    );
    assert.throws(
        () => assertProductionDependencies({ '@univerjs-pro/sheets-chart': '1.5.2' }),
        /unsupported production dependency @univerjs-pro\/sheets-chart/,
    );
    assert.doesNotThrow(() => assertProductionDependencies({ '@univerjs/core': '1.5.2', '@ironcalc/nodejs': '0.9.1' }));
    for (const name of BANNED_PRODUCTION_PACKAGES) assert.equal(isBannedProductionPackage(name), true);
});

test('runtime package.json does not depend on a banned package', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
    };
    assertProductionDependencies(manifest.dependencies ?? {});
    assertProductionDependencies(manifest.devDependencies ?? {});
    assertProductionDependencies(manifest.optionalDependencies ?? {});
});

test('a profile resource accepts a cell write', () => {
    const decision = gateCommand([PROFILE_RESOURCES[0]], 'set_number');
    assert.deepEqual(decision, { allowed: true });
    assert.doesNotThrow(() => assertCommandAllowed([PROFILE_RESOURCES[0]], 'set_number'));
});

test('unknown resource rejects a persisting command before a write and allows a read', () => {
    const write = gateCommand([SENTINEL], 'set_number');
    assert.equal(write.allowed, false);
    if (!write.allowed) {
        assert.equal(write.code, 'unsupported_content');
        assert.equal(write.reason, 'unknown_resource');
        assert.deepEqual(write.resources, [SENTINEL]);
    }
    assert.throws(() => assertCommandAllowed([SENTINEL], 'insert_row_before'), /unsupported_content unknown_resource/);
    assert.deepEqual(gateCommand([SENTINEL], 'read'), { allowed: true });
});

test('conditional formatting rejects insert_row_before before a write', () => {
    const decision = gateCommand([CONDITIONAL_FORMATTING_RESOURCE], 'insert_row_before');
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
        assert.equal(decision.code, 'unsupported_content');
        assert.equal(decision.reason, 'conditional_formatting_shift');
    }
    assert.throws(
        () => assertCommandAllowed([CONDITIONAL_FORMATTING_RESOURCE, PROFILE_RESOURCES[0]], 'insert_row_before'),
        /unsupported_content conditional_formatting_shift/,
    );
});

test('conditional formatting content edit follows whether save() preserves that resource', () => {
    const decision = gateCommand([CONDITIONAL_FORMATTING_RESOURCE], 'set_number');
    const preserved = PROFILE_RESOURCES.includes(CONDITIONAL_FORMATTING_RESOURCE);
    assert.equal(decision.allowed, preserved);
    if (!decision.allowed) assert.equal(decision.reason, 'resource_not_preserved');
});
