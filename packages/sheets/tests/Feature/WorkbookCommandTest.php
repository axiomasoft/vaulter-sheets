<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\NodeWorkbookRuntime;
use Vaulter\Testing\Fixtures\TestUser;

beforeEach(function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->actor = (new TestUser)->forceFill(['id' => 1]);
    $this->actingAs($this->actor);
    $this->drive = Vaulter::drive(DriveTestHelpers::host())->model()->getKey();
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
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $etag = $head->headers->get('ETag');
    $body = workbookTestPlan($head->json('data.marker.generation'), 'recover', [
        'kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 7,
    ]);
    $runtime = new class(app(NodeWorkbookRuntime::class)) implements WorkbookRuntime {
        public bool $unavailable = true;

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
    $url = createWorkbookTestUrl($this);
    $head = $this->getJson($url)->assertOk();
    $tag = $head->headers->get('ETag');
    $runtime = new class(app(WorkbookRuntime::class)) implements WorkbookRuntime {
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
