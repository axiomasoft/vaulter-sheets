<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Media\Contracts\Cas\BlobStore;
use Vaulter\Media\ValueObjects\Cas\BlobScope;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Console\RecoverWorkbookJobs;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\NodeWorkbookRuntime;
use Vaulter\Testing\Fixtures\TestUser;

beforeEach(function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->actor = (new TestUser)->forceFill(['id' => 1]);
    $this->actingAs($this->actor);
    $this->driveHandle = Vaulter::drive(DriveTestHelpers::host());
    $this->drive = $this->driveHandle->model()->getKey();
    $fixture = json_decode(file_get_contents(dirname(__DIR__, 3).'/runtime/tests/fixtures/apply-request.json'), true);
    $fixture['workbook']['profile'] = WorkbookCodec::profile();
    $fixture['workbook']['tables'] = [[
        'table_id' => 'items', 'sheet_id' => 'detail', 'header_row' => 1,
        'columns' => [['column_id' => 'price', 'column' => 3]],
        'rows' => [['row_id' => 'apples', 'row' => 2], ['row_id' => 'pears', 'row' => 3]],
    ]];
    $this->workbook = $fixture['workbook'];
    $this->runtimeCommand = config('vaulter-sheets.runtime_command');
    if ($this->runtimeCommand === ['vaulter-sheets-runtime']) {
        config(['vaulter-sheets.runtime_command' => ['node', dirname(__DIR__, 3).'/runtime/src/cli.ts']]);
    }
});

function createWorkbookTestUrl($test, ?array $workbook = null): string
{
    $id = $test->postJson(V1::url('drives/'.$test->drive.'/documents'), [
        'name' => 'Budget '.Str::uuid(), 'type' => 'vaulter/spreadsheet',
        'content' => $workbook ?? $test->workbook,
    ])->assertCreated()->json('data.id');

    return '/api/vaulter-sheets/v1/workbooks/'.$id;
}

function workbookTestPlan(int $generation, string $id, array $command, string $policy = 'rebase_cells'): array
{
    return ['command_id' => $id, 'policy' => $policy, 'expected_generation' => $generation, 'commands' => [$command]];
}

it('commits and reopens large numeric literals and formula results', function (): void {
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $saved = $this->postJson($url.'/commands', [
        'command_id' => 'large-numbers',
        'expected_generation' => $head->json('data.marker.generation'),
        'policy' => 'rebase_cells',
        'commands' => [
            ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 6, 'column' => 1, 'expected' => null, 'value' => 1e16],
            ['kind' => 'set_formula', 'sheet_id' => 'detail', 'row' => 6, 'column' => 2, 'expected' => null, 'formula' => '=-A6'],
        ],
    ], ['If-Match' => $head->headers->get('ETag')])->assertOk();

    $reopened = $this->getJson($url)->assertOk()->assertHeader('ETag', $saved->headers->get('ETag'));
    expect((float) $reopened->json('data.workbook.native.sheets.detail.cellData.5.0.v'))->toBe(1e16)
        ->and((float) $reopened->json('data.workbook.native.sheets.detail.cellData.5.1.v'))->toBe(-1e16);
    $range = $this->getJson($url.'/ranges?sheet_id=detail&range=A6:B6')->assertOk();
    expect((float) $range->json('data.0.cells.0.value'))->toBe(1e16)
        ->and((float) $range->json('data.0.cells.1.value'))->toBe(-1e16);
});

it('rejects a row insertion over the cell budget as a terminal command', function (): void {
    $workbook = $this->workbook;
    $workbook['tables'] = [];
    $workbook['native']['sheets']['detail']['columnCount'] = 100;
    $url = createWorkbookTestUrl($this, $workbook);
    $head = $this->getJson($url)->assertOk();
    $this->postJson($url.'/commands', workbookTestPlan($head->json('data.marker.generation'), 'over-budget', [
        'kind' => 'insert_row_before', 'sheet_id' => 'detail', 'row' => 2, 'count' => 101,
    ], 'exact_base'), ['If-Match' => $head->headers->get('ETag')])
        ->assertStatus(413)->assertJsonPath('data.error.code', 'limit_exceeded');

    $this->getJson($url.'/commands/over-budget')
        ->assertStatus(413)->assertJsonPath('data.state', 'rejected');
    $this->getJson($url)->assertHeader('ETag', $head->headers->get('ETag'));
});

it('commits v1.1 commands, preserves ruRU locale & hyperlinks, updates table bindings, and enforces exact_base', function (): void {
    $blank = WorkbookCodec::blank('ruRU')->value();
    $sheetId = $blank->native->sheetOrder[0];
    $blank->native->resources[] = (object) ['name' => 'SHEET_HYPER_LINK_PLUGIN', 'data' => '{}'];
    $blank->native->sheets->{$sheetId}->cellData = (object) [
        '0' => (object) ['0' => (object) ['v' => 'Flag', 't' => 1], '1' => (object) ['v' => 'A', 't' => 1], '2' => (object) ['v' => 'B', 't' => 1]],
        '1' => (object) ['0' => (object) ['v' => 0, 't' => 3], '1' => (object) ['v' => 10, 't' => 2], '2' => (object) ['v' => 25, 't' => 2]],
        '2' => (object) ['0' => (object) ['v' => 1, 't' => 3], '1' => (object) ['v' => 5, 't' => 2], '2' => (object) ['v' => 15, 't' => 2]],
    ];
    $blank->tables = [(object) [
        'table_id' => 't1', 'sheet_id' => $sheetId, 'header_row' => 1,
        'columns' => [(object) ['column_id' => 'flag', 'column' => 1], (object) ['column_id' => 'a', 'column' => 2], (object) ['column_id' => 'b', 'column' => 3]],
        'rows' => [(object) ['row_id' => 'r1', 'row' => 2], (object) ['row_id' => 'r2', 'row' => 3]],
    ]];
    $url = createWorkbookTestUrl($this, json_decode(json_encode($blank, JSON_THROW_ON_ERROR), true));
    $head = $this->getJson($url)->assertOk();
    expect($head->json('data.commands'))->toContain('set_boolean', 'set_format', 'merge_cells', 'set_freeze', 'add_sheet', 'delete_row', 'insert_column_before');

    // Structural command with rebase_cells must be rejected (422 invalid_command).
    $this->postJson($url.'/commands', workbookTestPlan($head->json('data.marker.generation'), 'bad-policy', [
        'kind' => 'delete_row', 'sheet_id' => $sheetId, 'row' => 3, 'count' => 1,
    ], 'rebase_cells'), ['If-Match' => $head->headers->get('ETag')])->assertStatus(422);

    $gen = $head->json('data.marker.generation');
    $etag = $head->headers->get('ETag');
    $committed = $this->postJson($url.'/commands', [
        'command_id' => 'v11-batch-2',
        'expected_generation' => $gen,
        'policy' => 'exact_base',
        'commands' => [
            ['kind' => 'set_boolean', 'sheet_id' => $sheetId, 'row' => 2, 'column' => 1, 'expected' => ['boolean' => false], 'value' => true],
            ['kind' => 'set_format', 'sheet_id' => $sheetId, 'start_row' => 1, 'start_column' => 1, 'end_row' => 2, 'end_column' => 2, 'format' => ['font' => ['bold' => true], 'fill' => '#FFEEAA']],
            ['kind' => 'merge_cells', 'sheet_id' => $sheetId, 'start_row' => 4, 'start_column' => 1, 'end_row' => 5, 'end_column' => 2],
            ['kind' => 'set_freeze', 'sheet_id' => $sheetId, 'row_count' => 1, 'column_count' => 1],
            ['kind' => 'delete_row', 'sheet_id' => $sheetId, 'row' => 3, 'count' => 1],
            ['kind' => 'add_sheet', 'sheet_id' => 's2', 'name' => 'Summary'],
            ['kind' => 'rename_sheet', 'sheet_id' => 's2', 'name' => 'Summary2'],
            ['kind' => 'delete_sheet', 'sheet_id' => 's2'],
        ],
    ], ['If-Match' => $etag])->assertOk();

    $reopened = $this->getJson($url)->assertOk()->assertHeader('ETag', $committed->headers->get('ETag'));
    expect($reopened->json('data.workbook.native.locale'))->toBe('ruRU')
        ->and($reopened->json('data.workbook.tables.0.rows'))->toBe([['row' => 2, 'row_id' => 'r1']])
        ->and($reopened->json('data.workbook.native.sheetOrder'))->toBe([$sheetId]);

    $this->postJson($url.'/commands', [
        'command_id' => 'fill-add',
        'expected_generation' => $reopened->json('data.marker.generation'),
        'policy' => 'revalidate_by_id',
        'commands' => [[
            'kind' => 'fill_formula',
            'sheet_id' => $sheetId,
            'table_id' => 't1',
            'scope' => 'fixed_members',
            'row_ids' => ['r1'],
            'destination_column_id' => 'b',
            'expression' => ['op' => 'add', 'left_column_id' => 'a', 'right_column_id' => 'b'],
            'expected_destination' => [['number' => 25]],
        ]],
    ])->assertOk();
});

it('withholds cells after revocation during workbook range calculation', function (): void {
    $system = $this->driveHandle->asSystem('workbook reader test setup');
    $reader = (new TestUser)->forceFill(['id' => 2]);
    $url = createWorkbookTestUrl($this);
    $node = basename($url);

    config(['vaulter-drive.access.permission_driver' => 'database']);
    $grant = $system->access()->grant($node, new GrantInput(subject: Subject::ofModel($reader), role: RoleRegistry::READER));
    $this->actingAs($reader);
    $range = $url.'/ranges?sheet_id=detail&range=C3';

    $revoke = static fn () => $system->access()->revoke($node, $grant);
    $runtime = new class(app(WorkbookRuntime::class), $revoke) implements WorkbookRuntime
    {
        public bool $calculated = false;

        public function __construct(private readonly WorkbookRuntime $runtime, private readonly Closure $revoke) {}

        public function exchange(stdClass $request): stdClass
        {
            $result = $this->runtime->exchange($request);
            ($this->revoke)();
            $this->calculated = true;

            return $result;
        }
    };
    app()->instance(WorkbookRuntime::class, $runtime);
    $response = $this->getJson($range);
    expect($runtime->calculated)->toBeTrue();
    $response->assertNotFound()->assertJsonPath('code', 'resource_unavailable')->assertJsonMissingPath('data');
});

it('publishes a single receipt and refuses a stale positional edit after insertion', function (): void {
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $generation = $head->json('data.marker.generation');
    $tag = $head->headers->get('ETag');
    $change = ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 7];
    $body = workbookTestPlan($generation, 'edit', $change);
    $receipt = $this->postJson($url.'/commands', $body, ['If-Match' => $tag])->assertOk();
    $this->postJson($url.'/commands', $body, ['If-Match' => $tag])->assertOk()
        ->assertJsonPath('data.receipt_id', $receipt->json('data.receipt_id'));
    $this->getJson($url.'/commands/edit')->assertOk()->assertJsonPath('data.receipt_id', $receipt->json('data.receipt_id'));
    $this->getJson($url.'/ranges?sheet_id=summary&range=B2&limit=1&fields=value')
        ->assertOk()->assertJsonPath('data.0.cells.0.value', 41)->assertJsonMissingPath('data.0.cells.0.formula');
    $this->getJson($url.'/ranges?sheet_id=summary&range=B2:B3&limit=1')->assertStatus(413);
    $body['commands'][0]['value'] = 19;
    $this->postJson($url.'/commands', $body, ['If-Match' => $tag])->assertStatus(409)->assertJsonPath('code', 'idempotency_conflict');

    $insert = workbookTestPlan($generation, 'insert', ['kind' => 'insert_row_before', 'sheet_id' => 'detail', 'row' => 3, 'count' => 1], 'exact_base');
    $nextTag = $receipt->headers->get('ETag');
    $insertReceipt = $this->postJson($url.'/commands', $insert, ['If-Match' => $nextTag])->assertOk();
    $change['expected'] = ['number' => 7];
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'stale', $change), ['If-Match' => $nextTag])
        ->assertStatus(409)->assertJsonPath('data.error.code', 'version_conflict');
    $this->getJson($url)->assertHeader('ETag', $insertReceipt->headers->get('ETag'))
        ->assertJsonPath('data.workbook.tables.0.rows.2.row', 4)
        ->assertJsonPath('data.workbook.tables.0.rows.2.row_id', 'pears');
});

it('leaves the workbook unchanged after an unavailable runtime and retries the same intent', function (): void {
    $runtime = new class(app(NodeWorkbookRuntime::class)) implements WorkbookRuntime
    {
        public bool $unavailable = false;

        public function __construct(private readonly NodeWorkbookRuntime $runtime) {}

        public function exchange(stdClass $request): stdClass
        {
            if ($this->unavailable) {
                throw new WorkbookProblem('calculation_pending', 503);
            }

            return $this->runtime->exchange($request);
        }
    };
    app()->instance(WorkbookRuntime::class, $runtime);
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $etag = $head->headers->get('ETag');
    $body = workbookTestPlan($head->json('data.marker.generation'), 'recover', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 7,
    ]);

    $runtime->unavailable = true;
    $this->postJson($url.'/commands', $body, ['If-Match' => $etag])->assertStatus(503);
    $this->getJson($url)->assertHeader('ETag', $etag);
    $runtime->unavailable = false;
    $this->postJson($url.'/commands', $body, ['If-Match' => $etag])->assertOk();
});

it('offloads large snapshots and retains a revision pin across a later write', function (): void {
    $workbook = $this->workbook;
    $workbook['native']['sheets']['detail']['cellData'][8][0] = ['t' => 1, 'v' => str_repeat('large-cell ', 50_000)];
    $url = createWorkbookTestUrl($this, $workbook);
    $node = basename($url);
    $head = $this->getJson($url)->assertOk();
    $etag = $head->headers->get('ETag');
    $original = $this->getJson(V1::url('documents/'.$node.'/content'))->assertOk();
    $original->assertJsonPath('data.content.storage', 'media_blob');
    $revision = $original->json('data.revision_id');
    $body = workbookTestPlan($head->json('data.marker.generation'), 'large', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 7,
    ]);
    $this->postJson($url.'/commands', $body, ['If-Match' => $etag])->assertOk();
    expect(app(BlobPins::class)->countByOwner()['sheets.revision'] ?? 0)->toBeGreaterThan(0);
    $this->postJson(V1::url('documents/'.$node.'/revisions/'.$revision.'/restore'), [], [
        'If-Match' => $this->getJson($url)->headers->get('ETag'),
    ])->assertSuccessful();
    $this->getJson($url)->assertOk()
        ->assertJsonPath('data.workbook.native.sheets.detail.cellData.2.2.v', 5);
    $nodeUrl = V1::url('nodes/'.$node);
    $nodeTag = $this->getJson($nodeUrl)->assertOk()->headers->get('ETag');
    $trash = $this->postJson($nodeUrl.'/trash', [], ['If-Match' => $nodeTag])->assertSuccessful();
    $this->deleteJson($nodeUrl, [], ['If-Match' => $trash->headers->get('ETag')])->assertSuccessful();
    $this->getJson($url)->assertNotFound();
    expect(app(BlobPins::class)->countByOwner()['sheets.revision'] ?? 0)->toBe(0);
});

it('records a no-op with its original ETag and rejects a tampered runtime digest', function (): void {
    $runtime = new class(app(WorkbookRuntime::class)) implements WorkbookRuntime
    {
        public bool $tamper = false;

        public function __construct(private readonly WorkbookRuntime $runtime) {}

        public function exchange(stdClass $request): stdClass
        {
            $response = $this->runtime->exchange($request);
            if ($this->tamper) {
                $response->workbook->native->name = 'altered after digest calculation';
            }

            return $response;
        }
    };
    app()->instance(WorkbookRuntime::class, $runtime);
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $tag = $head->headers->get('ETag');
    $change = ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 5];
    $receipt = $this->postJson($url.'/commands', workbookTestPlan($head->json('data.marker.generation'), 'noop', $change), ['If-Match' => $tag])
        ->assertOk()->assertHeader('ETag', $tag)->assertJsonPath('data.changed_ranges', []);
    $this->getJson($url.'/commands/noop')->assertOk()->assertJsonPath('data.receipt_id', $receipt->json('data.receipt_id'));
    $runtime->tamper = true;
    $change['value'] = 7;
    $this->postJson($url.'/commands', workbookTestPlan($head->json('data.marker.generation'), 'tampered', $change), ['If-Match' => $tag])
        ->assertStatus(503)->assertJsonPath('code', 'runtime_failed');
    $this->getJson($url)->assertHeader('ETag', $tag)
        ->assertJsonPath('data.workbook.native.sheets.detail.cellData.2.2.v', 5);
});

it('rebases unrelated cells and refuses a changed literal precondition', function (): void {
    $url = createWorkbookTestUrl($this);
    $initial = $this->getJson($url)->assertOk();
    $tag = $initial->headers->get('ETag');
    $generation = $initial->json('data.marker.generation');
    $change = ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 7];
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'price', $change), ['If-Match' => $tag])->assertOk();
    $unrelated = ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 2, 'expected' => ['number' => 3], 'value' => 4];
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'count', $unrelated), ['If-Match' => $tag])->assertOk();
    $change['value'] = 9;
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'stale-price', $change), ['If-Match' => $tag])
        ->assertStatus(409)->assertJsonPath('data.error.code', 'version_conflict');
    $this->getJson($url.'/ranges?sheet_id=summary&range=B2')->assertOk()->assertJsonPath('data.0.cells.0.value', 48);
});

it('revalidates logical row IDs after insertion and rejects a changed table membership', function (): void {
    $workbook = $this->workbook;
    $workbook['tables'][0]['columns'][] = ['column_id' => 'quantity', 'column' => 2];
    $workbook['tables'][0]['columns'][] = ['column_id' => 'difference', 'column' => 5];
    $url = createWorkbookTestUrl($this, $workbook);
    $head = $this->getJson($url)->assertOk();
    $generation = $head->json('data.marker.generation');
    $insert = workbookTestPlan($generation, 'add-member', ['kind' => 'insert_row_before', 'sheet_id' => 'detail', 'row' => 3, 'count' => 1], 'exact_base');
    $this->postJson($url.'/commands', $insert, ['If-Match' => $head->headers->get('ETag')])->assertOk();

    $formula = [
        'kind' => 'fill_formula', 'sheet_id' => 'detail', 'table_id' => 'items', 'scope' => 'current_rows',
        'row_ids' => ['apples', 'pears'], 'destination_column_id' => 'difference',
        'expression' => ['op' => 'subtract', 'left_column_id' => 'quantity', 'right_column_id' => 'price'],
        'expected_destination' => [null, null],
    ];
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'full-table', $formula, 'revalidate_by_id'))
        ->assertStatus(409)->assertJsonPath('data.error.code', 'scope_changed');
    $formula['scope'] = 'fixed_members';
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'same-rows', $formula, 'revalidate_by_id'))
        ->assertOk()->assertJsonPath('data.checks.cells.1.formula', '=B4-C4');
    $this->getJson($url.'/ranges?sheet_id=detail&range=E3:E4')->assertOk()
        ->assertJsonPath('data.0.cells.0.value', null)->assertJsonPath('data.0.cells.1.value', -2);
});

it('slices WorkbookOperations::readTable before enforcing the 64-range limit', function (): void {
    $workbook = $this->workbook;
    $rows = [];
    $cellData = [
        '0' => ['0' => ['t' => 1, 'v' => 'Row'], '1' => ['t' => 1, 'v' => 'Qty'], '2' => ['t' => 1, 'v' => 'Price']],
    ];
    for ($i = 1; $i <= 22; $i++) {
        $rowNum = $i + 1;
        $rows[] = ['row_id' => 'row_'.$i, 'row' => $rowNum];
        $cellData[(string) ($rowNum - 1)] = [
            '0' => ['t' => 1, 'v' => 'Item '.$i],
            '1' => ['t' => 2, 'v' => $i],
            '2' => ['t' => 2, 'v' => $i * 10],
        ];
    }
    $workbook['native']['sheets']['detail']['cellData'] = $cellData;
    $workbook['tables'] = [[
        'table_id' => 'items',
        'sheet_id' => 'detail',
        'header_row' => 1,
        'columns' => [
            ['column_id' => 'quantity', 'column' => 2],
            ['column_id' => 'price', 'column' => 3],
            ['column_id' => 'difference', 'column' => 4],
        ],
        'rows' => $rows,
    ]];
    $url = createWorkbookTestUrl($this, $workbook);
    $nodeId = basename($url);
    $ops = app(WorkbookOperations::class);
    $ctx = DriveContext::system($this->driveHandle->model(), 'readTable slicing test');

    expect(fn (): array => $ops->readTable($ctx, $nodeId, 'items'))
        ->toThrow(WorkbookProblem::class, 'limit_exceeded');

    $sliced = $ops->readTable($ctx, $nodeId, 'items', ['quantity', 'price'], ['row_15']);
    expect($sliced['table']->rows)->toHaveCount(22)
        ->and($sliced['ranges'])->toHaveCount(2)
        ->and($sliced['ranges'][0]->cells[0]->value)->toBe(15)
        ->and($sliced['ranges'][1]->cells[0]->value)->toBe(150);
});

it('durably rejects fill_formula when expected_inputs changed and keeps rejection across replay after input restoration', function (): void {
    $workbook = $this->workbook;
    $workbook['tables'][0]['columns'][] = ['column_id' => 'quantity', 'column' => 2];
    $workbook['tables'][0]['columns'][] = ['column_id' => 'difference', 'column' => 5];
    $url = createWorkbookTestUrl($this, $workbook);
    $head = $this->getJson($url)->assertOk();
    $generation = $head->json('data.marker.generation');
    $etag = $head->headers->get('ETag');

    // Human changes B2 from 2 to 9 after agent prepared expected_inputs with quantity=2, price=10.
    $changed = workbookTestPlan($generation, 'human-edit', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 2, 'column' => 2,
        'expected' => ['number' => 2], 'value' => 9,
    ]);
    $afterEdit = $this->postJson($url.'/commands', $changed, ['If-Match' => $etag])->assertOk();

    $formula = [
        'kind' => 'fill_formula', 'sheet_id' => 'detail', 'table_id' => 'items', 'scope' => 'fixed_members',
        'row_ids' => ['apples', 'pears'], 'destination_column_id' => 'difference',
        'expression' => ['op' => 'subtract', 'left_column_id' => 'quantity', 'right_column_id' => 'price'],
        'expected_destination' => [null, null],
        'expected_inputs' => [
            ['left' => ['content' => ['number' => 2], 'value' => 2], 'right' => ['content' => ['number' => 10], 'value' => 10]],
            ['left' => ['content' => ['number' => 3], 'value' => 3], 'right' => ['content' => ['number' => 5], 'value' => 5]],
        ],
    ];
    $plan = workbookTestPlan($generation, 'stale-inputs', $formula, 'revalidate_by_id');

    $this->postJson($url.'/commands', $plan)
        ->assertStatus(409)->assertJsonPath('data.error.code', 'version_conflict');
    $this->getJson($url.'/commands/stale-inputs')
        ->assertStatus(409)->assertJsonPath('data.state', 'rejected')->assertJsonPath('data.error.code', 'version_conflict');

    // Restore B2 back to 2 and retry the same command_id: durable rejection prevents stale write.
    $restore = workbookTestPlan($generation, 'human-restore', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 2, 'column' => 2,
        'expected' => ['number' => 9], 'value' => 2,
    ]);
    $this->postJson($url.'/commands', $restore, ['If-Match' => $afterEdit->headers->get('ETag')])->assertOk();

    $this->postJson($url.'/commands', $plan)
        ->assertStatus(409)->assertJsonPath('data.state', 'rejected')->assertJsonPath('data.error.code', 'version_conflict');
    $this->getJson($url.'/ranges?sheet_id=detail&range=E2:E3')->assertOk()
        ->assertJsonPath('data.0.cells.0.value', null)->assertJsonPath('data.0.cells.1.value', null);
});

it('expires a committed command and unpins its evidence blob', function (): void {
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $generation = $head->json('data.marker.generation');
    $change = ['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 6];
    $this->postJson($url.'/commands', workbookTestPlan($generation, 'expire-evidence', $change), ['If-Match' => $head->headers->get('ETag')])->assertOk();
    $plain = $this->postJson($url.'/commands', workbookTestPlan($generation, 'expire-plain', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 2, 'expected' => ['number' => 3], 'value' => 4,
    ]), ['If-Match' => $this->getJson($url)->headers->get('ETag')])->assertOk();
    expect($plain->json('data.state'))->toBe('committed');

    $commands = app(SchemaHelpers::class)->table('sheets_commands');
    $row = DB::table($commands)->where('command_id', 'expire-evidence')->first();
    expect($row)->not->toBeNull();
    $stream = fopen('php://memory', 'r+');
    expect(is_resource($stream))->toBeTrue();
    fwrite($stream, 'command-evidence');
    rewind($stream);
    $blob = app(BlobStore::class)->commit($stream, BlobScope::unshared());

    app(VaulterDatabase::class)->transaction(function () use ($commands, $row, $blob): void {
        DB::table($commands)->where('command_id', 'expire-evidence')->update([
            'created_at' => '2020-01-01 00:00:00',
            'replay_until' => '2020-01-01 00:01:00',
            'evidence_blob_id' => $blob->id,
        ]);
        DB::table($commands)->where('command_id', 'expire-plain')->update([
            'created_at' => '2020-01-01 00:00:00',
            'replay_until' => '2020-01-01 00:01:00',
        ]);
        app(BlobPins::class)->pin($blob->id, RecoverWorkbookJobs::EVIDENCE_PIN_OWNER, (string) $row->id);
    });
    expect(app(BlobPins::class)->countByOwner()[RecoverWorkbookJobs::EVIDENCE_PIN_OWNER] ?? 0)->toBe(1);

    $this->artisan(RecoverWorkbookJobs::class)->assertSuccessful();

    $expired = DB::table($commands)->where('command_id', 'expire-evidence')->first();
    $plainRow = DB::table($commands)->where('command_id', 'expire-plain')->first();
    expect($expired->state)->toBe('expired')
        ->and($expired->evidence)->toBeNull()
        ->and($expired->evidence_blob_id)->toBeNull()
        ->and($expired->intent)->toBeNull()
        ->and($expired->error_code)->toBeNull()
        ->and($expired->finished_at)->not->toBeNull()
        ->and($plainRow->state)->toBe('expired')
        ->and($plainRow->evidence_blob_id)->toBeNull()
        ->and(app(BlobPins::class)->countByOwner()[RecoverWorkbookJobs::EVIDENCE_PIN_OWNER] ?? 0)->toBe(0);
});

it('bounds a command body and the range query, and answers a malformed range as the caller\'s error', function (): void {
    $url = createWorkbookTestUrl($this);
    $post = fn (string $body) => $this->call('POST', $url.'/commands', server: ['CONTENT_TYPE' => 'application/json'], content: $body);

    // JSON whitespace pads a body to exactly the 1 MiB it may have; one byte more is refused unread.
    $post(str_pad('{}', 1024 * 1024))->assertUnprocessable()->assertJsonPath('code', 'invalid_command');
    $post(str_pad('{}', 1024 * 1024 + 1))->assertStatus(413)->assertJsonPath('code', 'limit_exceeded');

    $this->getJson($url.'/ranges?sheet_id=summary&range=B2&limit=10000')->assertOk();
    foreach ([
        'range above 32 characters' => 'sheet_id=summary&range='.str_repeat('B', 32).'2',
        'cell that is not A1' => 'sheet_id=summary&range=nonsense',
        'row zero' => 'sheet_id=summary&range=A0',
        'four column letters' => 'sheet_id=summary&range=ZZZZ1',
        'reversed range' => 'sheet_id=summary&range=B2:A1',
        'empty sheet id' => 'sheet_id=&range=A1',
        'sheet id above 255 characters' => 'sheet_id='.str_repeat('s', 256).'&range=B2',
        'limit in exponent notation' => 'sheet_id=summary&range=B2&limit=1e3',
        'zero limit' => 'sheet_id=summary&range=B2&limit=0',
        'limit above 10000' => 'sheet_id=summary&range=B2&limit=10001',
        'unknown field' => 'sheet_id=summary&range=B2&fields=value,owner',
        'fields as a list' => 'sheet_id=summary&range=B2&fields[]=value',
    ] as $label => $query) {
        $response = $this->getJson($url.'/ranges?'.$query);
        expect([$response->status(), $response->json('code')])->toBe([422, 'invalid_command'], $label);
    }
});
