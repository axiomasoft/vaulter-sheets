/**
 * Decision Gate 4.1 for vaulter-sheets.
 *
 * Production engine: Univer OSS `@univerjs/*@1.5.2` (Apache-2.0), manual Plugin Mode.
 * IronCalc `@ironcalc/nodejs@0.9.1` (MIT OR Apache-2.0) is the calculation cross-check.
 * It does not share a Univer snapshot, so it is not the browser engine.
 * `handsontable` and `hyperformula` stay out of production dependencies.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PROFILE_SCHEMA_VERSION = 1 as const;

export interface ProfilePlugin {
    name: string;
    version: string;
    license: 'Apache-2.0';
}

export interface ProfileRef {
    id: string;
    engine: string;
    plugins: ProfilePlugin[];
}

/** Wire profile. `engine` is `name@version` of `@univerjs/core`. */
export const PROFILE: ProfileRef = {
    id: 'univer-oss-basic-1',
    engine: '@univerjs/core@1.5.2',
    plugins: [
        { name: '@univerjs/docs', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/engine-formula', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/engine-render', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-formula', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-numfmt', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/data-validation', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-data-validation', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-conditional-formatting', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-filter', version: '1.5.2', license: 'Apache-2.0' },
        { name: '@univerjs/sheets-hyper-link', version: '1.5.2', license: 'Apache-2.0' },
    ],
};

/**
 * Resource names `save()` emitted for this plugin set on the formula corpus
 * (Node 26.13.1, @univerjs/* 1.5.2). `SHEET_HYPER_LINK_PLUGIN` is not in the
 * list: a book with no links did not write it, so a link resource stays fail-closed
 * until a round-trip is measured.
 * Conditional formatting is preserved as bytes and still refused for
 * `insert_row_before`: the range stays on D2:D3.
 */
export const PROFILE_RESOURCES: readonly string[] = [
    'SHEET_AuthzIoMockService_PLUGIN',
    'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
    'SHEET_DATA_VALIDATION_PLUGIN',
    'SHEET_DEFINED_NAME_PLUGIN',
    'SHEET_FILTER_PLUGIN',
    'SHEET_RANGE_PROTECTION_PLUGIN',
    'SHEET_RANGE_THEME_MODEL_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_PLUGIN',
    'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
];

/** Resource id written by `@univerjs/sheets-conditional-formatting`. */
export const CONDITIONAL_FORMATTING_RESOURCE = 'SHEET_CONDITIONAL_FORMATTING_PLUGIN';

export const SUPPORTED_COMMANDS = [
    'set_number',
    'set_text',
    'set_formula',
    'set_values',
    'insert_row_before',
    'fill_formula',
] as const;

export type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];

/** Commands that round-trip through `save()`. Unknown resources are refused before the write. */
const PERSISTING_COMMANDS: ReadonlySet<string> = new Set(SUPPORTED_COMMANDS);

/** Commands that move coordinates. Conditional formatting ranges do not follow them on 1.5.2. */
const STRUCTURAL_COMMANDS: ReadonlySet<string> = new Set(['insert_row_before']);

export const DEFAULT_LIMITS = {
    max_commands: 64,
    max_cells_per_command: 10_000,
    calculation_timeout_ms: 20_000,
} as const;

/**
 * Node isolation for the calculator (4.2 implements the pool).
 * `worker_threads` share one V8 heap and are forbidden.
 */
export const RUNTIME_PROCESS = {
    isolation: 'child_process.fork',
    workerThreads: false,
    maxOldSpaceSizeMb: 640,
    restartAfterTasks: 50,
    formulaMode: 'FORCED',
    calculationBarrier: 'onCalculationResultApplied',
    staleCache: 'unverified_until_recalculation',
} as const;

/** Zero-Royalty names that must not appear in a production dependency map. */
export const BANNED_PRODUCTION_PACKAGES = [
    'handsontable',
    'hyperformula',
    'dunglas/mercure',
    'minio/minio',
    'exceljs',
    'unzipper',
    'mammoth',
    'xlsx',
    'libclamav',
    '@tiptap-pro',
    '@univerjs-pro',
    '@univer-cli',
] as const;

const BANNED_EXACT = new Set<string>(BANNED_PRODUCTION_PACKAGES);
const BANNED_PREFIXES = ['@univerjs-pro/', '@univer-cli/', '@tiptap-pro/'] as const;

export type GateReason = 'unknown_resource' | 'conditional_formatting_shift' | 'resource_not_preserved';

export type GateDecision =
    | { allowed: true }
    | { allowed: false; code: 'unsupported_content'; reason: GateReason; resources: string[] };

export function isBannedProductionPackage(name: string): boolean {
    if (BANNED_EXACT.has(name)) return true;
    return BANNED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Throws before install or publish when a dependency map contains a banned name. */
export function assertProductionDependencies(dependencies: Readonly<Record<string, string>>): void {
    for (const name of Object.keys(dependencies)) {
        if (isBannedProductionPackage(name)) {
            throw new Error(`unsupported production dependency ${name}`);
        }
    }
}

/**
 * Pre-write gate. Returns `unsupported_content` and does not describe a mutation.
 * Unknown resources may pass through a non-persisting read. A persisting command
 * is refused before save, because `save()` drops an unregistered resource.
 * `insert_row_before` on a book that carries conditional formatting is refused
 * even when that resource is otherwise preserved: on 1.5.2 the range stays put.
 */
export function gateCommand(resourceNames: readonly string[], commandKind: string): GateDecision {
    const persisted = PERSISTING_COMMANDS.has(commandKind);
    const structural = STRUCTURAL_COMMANDS.has(commandKind);
    const unknown = resourceNames.filter((name) => !PROFILE_RESOURCES.includes(name) && name !== CONDITIONAL_FORMATTING_RESOURCE);
    if (unknown.length > 0 && persisted) {
        return { allowed: false, code: 'unsupported_content', reason: 'unknown_resource', resources: unknown };
    }
    const hasConditionalFormatting = resourceNames.includes(CONDITIONAL_FORMATTING_RESOURCE);
    if (hasConditionalFormatting && structural) {
        return {
            allowed: false,
            code: 'unsupported_content',
            reason: 'conditional_formatting_shift',
            resources: [CONDITIONAL_FORMATTING_RESOURCE],
        };
    }
    if (hasConditionalFormatting && persisted && !PROFILE_RESOURCES.includes(CONDITIONAL_FORMATTING_RESOURCE)) {
        return {
            allowed: false,
            code: 'unsupported_content',
            reason: 'resource_not_preserved',
            resources: [CONDITIONAL_FORMATTING_RESOURCE],
        };
    }
    return { allowed: true };
}

/** Same decision as {@link gateCommand}, as a thrown error a caller can catch before it touches the engine. */
export function assertCommandAllowed(resourceNames: readonly string[], commandKind: string): void {
    const decision = gateCommand(resourceNames, commandKind);
    if (!decision.allowed) {
        throw new Error(`unsupported_content ${decision.reason}: ${decision.resources.join(', ')}`);
    }
}

export const PROFILE_MANIFEST = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: PROFILE.id,
    engine: PROFILE.engine,
    license: 'Apache-2.0',
    plugins: PROFILE.plugins,
    resources: PROFILE_RESOURCES,
    commands: SUPPORTED_COMMANDS,
    limits: DEFAULT_LIMITS,
    process: RUNTIME_PROCESS,
    bannedProductionPackages: BANNED_PRODUCTION_PACKAGES,
    conditionalFormattingResource: CONDITIONAL_FORMATTING_RESOURCE,
    crossCheck: { name: '@ironcalc/nodejs', version: '0.9.1', license: 'MIT OR Apache-2.0', production: false },
    offlineBenchmark: { name: 'handsontable+hyperformula', production: false },
} as const;

function installedVersion(name: string): string {
    const require = createRequire(import.meta.url);
    let directory = dirname(require.resolve(name));
    for (;;) {
        const candidate = join(directory, 'package.json');
        if (existsSync(candidate)) {
            const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
            if (manifest.name === name && typeof manifest.version === 'string') return manifest.version;
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`package.json of ${name} not found`);
        directory = parent;
    }
}

/** Readiness check: installed packages match the pinned profile. Used once the runtime installs them. */
export function assertInstalledProfile(profile: ProfileRef = PROFILE): void {
    const at = profile.engine.lastIndexOf('@');
    const engineName = profile.engine.slice(0, at);
    const engineVersion = profile.engine.slice(at + 1);
    for (const { name, version } of [{ name: engineName, version: engineVersion }, ...profile.plugins]) {
        const actual = installedVersion(name);
        if (actual !== version) throw new Error(`profile ${profile.id} pins ${name}@${version}, installed ${actual}`);
    }
}
