<?php

declare(strict_types=1);

use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Documents\Testing\Contracts\DocumentTypeContractTests;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

uses(DocumentTypeContractTests::class);

it('round-trips v2 workbooks and hashes their contents independently of key order', function (): void {
    $type = app(SpreadsheetDocumentType::class);
    $this->assertDocumentTypeContract($type);
    $workbook = $type->defaultContent()->toArray();
    $sheet = $workbook['native']['sheetOrder'][0];
    $workbook['native']['sheets'][$sheet]['cellData'][0][0] = ['v' => 42];
    $decoded = $type->codec()->decode($workbook, 2);

    expect($decoded->toArray()['native']['sheets'][$sheet]['cellData'][0][0])->toBe(['v' => 42])
        ->and($decoded->contentHash())->toMatch('/^[0-9a-f]{64}$/')
        ->and($type->codec()->decode(array_reverse($workbook, true), 2)->contentHash())->toBe($decoded->contentHash());
});

it('rejects legacy content and caller supplied blob manifests', function (): void {
    $type = app(SpreadsheetDocumentType::class);
    $manifest = $type->defaultContent()->toArray();
    unset($manifest['native']);
    $manifest += ['storage' => 'media_blob', 'blob_id' => '1', 'sha256' => str_repeat('a', 64)];

    expect(fn () => $type->codec()->decode(['id' => 'v1'], 1))->toThrow(InvalidDocumentContentException::class)
        ->and(fn () => $type->codec()->decode($manifest, 2))->toThrow(InvalidDocumentContentException::class);
});
