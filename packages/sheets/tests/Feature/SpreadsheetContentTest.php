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

it('creates a spreadsheet document from its type key and round-trips schema v2 workbook content', function (): void {
    $drive = sheetsDrive()->getKey();

    $workbook = app(SpreadsheetDocumentType::class)->defaultContent()->toArray();
    $sheet = $workbook['native']['sheetOrder'][0];
    $workbook['native']['id'] = 'wb1';

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
        ->assertJsonPath('data.content.native.id', 'wb1')
        ->assertJsonPath('data.content.native.sheets.'.$sheet.'.name', 'Sheet1');
});

it('requires commands for generic workbook content writes even with a current ETag', function (): void {
    $drive = sheetsDrive()->getKey();
    $node = (string) $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Budget.xlsx',
        'type' => SpreadsheetDocumentType::KEY,
    ])->assertCreated()->json('data.id');
    $url = V1::url('documents/'.$node.'/content');
    $original = $this->getJson($url)->assertOk();
    $etag = $original->headers->get('ETag');

    $this->putJson($url, ['content' => $original->json('data.content')], ['If-Match' => $etag])
        ->assertStatus(409)->assertJsonPath('code', 'document_command_required');
    $this->getJson($url)->assertOk()->assertHeader('ETag', $etag);
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
