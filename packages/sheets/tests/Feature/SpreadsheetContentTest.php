<?php

declare(strict_types=1);

use Vaulter\Documents\Data\Documents\CreateDocumentInput;
use Vaulter\Documents\Types\DocumentTypeRegistry;
use Vaulter\Drive\Configuration\DriveOptions;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Models\Drive;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;
use Vaulter\Testing\Fixtures\TestUser;

beforeEach(function (): void {
    $this->actingAs((new TestUser)->forceFill(['id' => 1]));
});

function sheetsDrive(): Drive
{
    return Vaulter::drive(DriveTestHelpers::host())->model();
}

it('registers vaulter/spreadsheet via VaulterSheetsServiceProvider and SheetsModule', function (): void {
    $registry = app(DocumentTypeRegistry::class);

    expect($registry->has(SpreadsheetDocumentType::KEY))->toBeTrue()
        ->and($registry->get(SpreadsheetDocumentType::KEY))->toBeInstanceOf(SpreadsheetDocumentType::class);
});

it('creates a spreadsheet document from its type key and round-trips opaque workbook content', function (): void {
    $drive = sheetsDrive()->getKey();

    $workbook = ['id' => 'wb1', 'sheets' => ['s1' => ['name' => 'Sheet1', 'cellData' => []]]];

    $created = $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Budget.xlsx',
        'type' => 'vaulter/spreadsheet',
        'content' => $workbook,
    ])->assertCreated();

    $created->assertJsonPath('data.presentation.document_type', 'vaulter/spreadsheet')
        ->assertJsonPath('data.presentation.viewer.key', 'vaulter/univer')
        ->assertJsonPath('data.presentation.capabilities.collaborative', false);
    $nodeId = (string) $created->json('data.id');

    $node = app(DriveOptions::class)->model('node')::query()->findOrFail($nodeId);
    expect($node->mime_type)->toBe(CreateDocumentInput::NODE_MIME);

    $this->getJson(V1::url('documents/'.$nodeId.'/content'))
        ->assertOk()
        ->assertJsonPath('data.content.id', 'wb1')
        ->assertJsonPath('data.content.sheets.s1.name', 'Sheet1');
});

it('autosaves an opaque workbook and rejects stale ETag with 412 Precondition Failed', function (): void {
    $drive = sheetsDrive()->getKey();

    $nodeId = (string) $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Budget.xlsx',
        'type' => 'vaulter/spreadsheet',
    ])->assertCreated()->json('data.id');

    $initialGet = $this->getJson(V1::url('documents/'.$nodeId.'/content'))->assertOk();
    $initialEtag = (string) $initialGet->headers->get('ETag');
    expect($initialEtag)->not->toBe('');

    $workbook = ['id' => 'wb2', 'sheets' => ['s1' => ['name' => 'Q3', 'cellData' => []]]];

    $updated = $this->putJson(
        V1::url('documents/'.$nodeId.'/content'),
        ['content' => $workbook],
        ['If-Match' => $initialEtag],
    )->assertOk()
        ->assertJsonPath('data.content.sheets.s1.name', 'Q3');

    $nextEtag = (string) $updated->headers->get('ETag');
    expect($nextEtag)->not->toBe($initialEtag);

    $this->getJson(V1::url('documents/'.$nodeId.'/content'))
        ->assertOk()
        ->assertJsonPath('data.content.sheets.s1.name', 'Q3');

    // Stale ETag must produce 412 Precondition Failed.
    $this->putJson(
        V1::url('documents/'.$nodeId.'/content'),
        ['content' => ['id' => 'wb2', 'sheets' => ['s1' => ['name' => 'Stale']]]],
        ['If-Match' => $initialEtag],
    )->assertStatus(412);
});

it('still creates a rich-text node and enforces {"type":"doc"} when no type is given', function (): void {
    $drive = sheetsDrive()->getKey();

    $nodeId = (string) $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Notes',
        'content' => ['type' => 'doc', 'content' => []],
    ])
        ->assertCreated()
        ->assertJsonPath('data.presentation.document_type', 'vaulter/rich-text')
        ->json('data.id');

    $etag = (string) $this->getJson(V1::url('documents/'.$nodeId.'/content'))->assertOk()->headers->get('ETag');

    $this->putJson(
        V1::url('documents/'.$nodeId.'/content'),
        ['content' => ['id' => 'wb1']],
        ['If-Match' => $etag],
    )->assertStatus(422);
});
