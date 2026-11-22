<?php

declare(strict_types=1);

use Vaulter\Documents\Testing\Contracts\DocumentTypeContractTests;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

uses(DocumentTypeContractTests::class);

it('keeps the document type contract for empty and non-empty workbook snapshots', function (): void {
    $type = new SpreadsheetDocumentType;

    $this->assertDocumentTypeContract($type);

    $workbook = [
        'id' => 'wb-1',
        'name' => 'Budget',
        'sheets' => [
            's1' => [
                'name' => 'Sheet1',
                'cellData' => [
                    '0' => [
                        '0' => ['v' => 42],
                    ],
                ],
            ],
        ],
    ];

    $decoded = $type->codec()->decode($workbook, $type->schemaVersion());
    expect($decoded->toArray())->toBe($workbook)
        ->and($decoded->contentHash())->toMatch('/^[0-9a-f]{64}$/');

    $reordered = [
        'sheets' => $workbook['sheets'],
        'name' => $workbook['name'],
        'id' => $workbook['id'],
    ];

    expect($type->codec()->decode($reordered, $type->schemaVersion())->contentHash())
        ->toBe($decoded->contentHash());
});
