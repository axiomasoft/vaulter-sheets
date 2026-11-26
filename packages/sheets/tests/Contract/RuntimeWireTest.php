<?php

declare(strict_types=1);

use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\RuntimeWire;

it('accepts a typed optional IronCalc comparison and rejects malformed diagnostics', function (): void {
    $sha = str_repeat('a', 64);
    $request = (object) ['request_id' => 'verify', 'operation' => 'recalculate', 'base' => (object) ['sha256' => $sha]];
    $report = [
        'engine' => '@ironcalc/nodejs', 'checked_formulas' => 1, 'matched' => 1, 'mismatched' => 0,
        'skipped_unsupported' => 0, 'discrepancies' => [],
    ];
    $frame = static fn (array $diagnostics): string => json_encode([
        'version' => 1, 'request_id' => 'verify', 'ok' => true, 'operation' => 'recalculate', 'base_sha256' => $sha,
        'candidate_sha256' => $sha, 'workbook' => new stdClass, 'changed_ranges' => [],
        'calculation' => ['state' => 'ready', 'source_sha256' => $sha],
        'checks' => ['cells' => [], 'resources_preserved' => [], 'ironcalc_verification' => $diagnostics],
    ], JSON_THROW_ON_ERROR)."\n";

    expect(RuntimeWire::response($frame($report), $request)->checks->ironcalc_verification->matched)->toBe(1);
    $report['matched'] = 'one';
    expect(fn (): stdClass => RuntimeWire::response($frame($report), $request))->toThrow(WorkbookProblem::class, 'runtime_failed');
});
