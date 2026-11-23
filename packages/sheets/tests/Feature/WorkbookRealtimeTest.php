<?php

declare(strict_types=1);

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Tests\RealtimeTestCase;
use Vaulter\Testing\Fixtures\TestUser;

it('fences old owners and returns the original receipt after a lost response', function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $user = $this->user;
    $this->actingAs($user);
    $drive = Vaulter::drive(DriveTestHelpers::host())->model()->getKey();
    $fixture = json_decode(file_get_contents(dirname(__DIR__, 3).'/runtime/tests/fixtures/apply-request.json'), true, flags: JSON_THROW_ON_ERROR);
    $fixture['workbook']['profile'] = WorkbookCodec::profile();
    $node = $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Live workbook', 'type' => 'vaulter/spreadsheet', 'content' => $fixture['workbook'],
    ])->assertCreated()->json('data.id');
    $url = '/api/vaulter-sheets/v1/workbooks/'.$node;
    $tag = $this->getJson($url)->assertOk()->headers->get('ETag');
    $this->postJson($url.'/realtime/session')->assertConflict();
    $this->putJson($url.'/realtime/profile', ['mode' => 'journal'], ['If-Match' => $tag])->assertOk();
    $session = $this->postJson($url.'/realtime/session')->assertOk()->json('data');
    $headers = ['X-Vaulter-Sheets-Owner' => RealtimeTestCase::OWNER_KEY, 'Authorization' => 'Bearer '.$session['token']];
    $identity = ['room' => $session['options']['room']];
    $owner = $identity + ['owner_id' => (string) Str::uuid()];
    $other = $identity + ['owner_id' => (string) Str::uuid()];
    $port = '/api/vaulter-sheets/v1/realtime/owner/';
    $this->postJson($port.'acquire', $owner)->assertUnauthorized();
    $load = $this->postJson($port.'acquire', $owner, $headers)->assertOk()->json();
    $this->postJson($port.'acquire', $other, $headers)->assertConflict();
    $lease = $owner + ['owner_fence' => $load['owner_fence']];
    $intent = ['if_match' => $load['etag'], 'base_seq' => 0, 'intent' => [
        'command_id' => 'insert', 'expected_generation' => $session['generation'], 'policy' => 'exact_base',
        'commands' => [['kind' => 'insert_row_before', 'sheet_id' => 'detail', 'row' => 3, 'count' => 1]],
    ]];
    $this->postJson($url.'/commands', $intent['intent'], ['If-Match' => $load['etag']])->assertUnprocessable();
    $result = $this->postJson($port.'append', $lease + $intent, $headers)->assertOk()->json();
    $this->postJson($port.'release', $lease, $headers)->assertOk();
    $handoff = $this->postJson($port.'acquire', $other, $headers)->assertOk()->json();
    expect($handoff['head_seq'])->toBe(1)->and($handoff['owner_fence'])->toBeGreaterThan($load['owner_fence']);
    $this->postJson($port.'append', $lease + $intent, $headers)->assertConflict();
    $replayed = $this->postJson($port.'append', $other + ['owner_fence' => $handoff['owner_fence']] + $intent, $headers)->assertOk()->json();
    expect($replayed['receipt_id'])->toBe($result['receipt_id']);
    expect(DB::table('v_sheets_realtime_links')->count())->toBe(1);
    expect(DB::table('v_collaboration_updates')->count())->toBe(1);
    $unsafe = ['if_match' => $load['etag'], 'base_seq' => 1, 'intent' => [
        'command_id' => 'unsafe-formula', 'expected_generation' => $session['generation'], 'policy' => 'rebase_cells',
        'commands' => [['kind' => 'set_formula', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'formula' => '=B3']],
    ]];
    $newLease = $other + ['owner_fence' => $handoff['owner_fence']];
    $this->postJson($port.'append', $newLease + $unsafe, $headers)->assertConflict()->assertJsonPath('detail.reason', 'formula_rebase');
    expect(DB::table('v_collaboration_updates')->count())->toBe(1);

    $price = ['if_match' => $load['etag'], 'base_seq' => 1, 'intent' => [
        'command_id' => 'price', 'expected_generation' => $session['generation'], 'policy' => 'rebase_cells',
        'commands' => [['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 3, 'column' => 3, 'expected' => ['number' => 5], 'value' => 8]],
    ]];
    config(['vaulter-sheets.inline_snapshot_bytes' => 64]);
    $this->postJson($port.'append', $newLease + $price, $headers)->assertOk()->assertJsonPath('seq', 2);
    $this->postJson($port.'append', $newLease + $unsafe, $headers)->assertConflict()->assertJsonPath('detail.reason', 'formula_rebase');
    $this->getJson($url.'/ranges?sheet_id=detail&range=C4:D4')->assertOk()
        ->assertJsonPath('data.0.cells.0.value', 8)->assertJsonPath('data.0.cells.1.value', 24);
    $head = $this->getJson($url)->assertOk();
    $this->putJson($url.'/realtime/profile', ['mode' => 'snapshot'], ['If-Match' => $head->headers->get('ETag')])->assertOk()
        ->assertJsonPath('data.generation', $session['generation'] + 1);
    $this->postJson($port.'read', $other, $headers)->assertConflict();
    $this->postJson($url.'/realtime/session')->assertConflict();
    $this->getJson($url)->assertOk()->assertJsonPath('data.workbook.native.sheets.detail.cellData.3.2.v', 8);
});

it('checks current rights for every room token and refuses writes using a reader grant', function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->actingAs($this->user);
    $handle = Vaulter::drive(DriveTestHelpers::host());
    $system = $handle->asSystem('realtime revocation fixture');
    $drive = $handle->model()->getKey();
    $node = $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Workbook access', 'type' => 'vaulter/spreadsheet',
    ])->assertCreated()->json('data.id');
    $url = '/api/vaulter-sheets/v1/workbooks/'.$node;
    $tag = $this->getJson($url)->assertOk()->headers->get('ETag');
    $this->putJson($url.'/realtime/profile', ['mode' => 'journal'], ['If-Match' => $tag])->assertOk();

    config(['vaulter-drive.access.permission_driver' => 'database']);
    $reader = (new TestUser)->forceFill(['id' => 2]);
    $grant = $system->access()->grant($node, new GrantInput(subject: Subject::ofModel($reader), role: RoleRegistry::READER));
    $this->actingAs($reader);
    $session = $this->postJson($url.'/realtime/session')->assertOk()->assertJsonPath('data.mode', 'read')->json('data');
    $headers = ['X-Vaulter-Sheets-Owner' => RealtimeTestCase::OWNER_KEY, 'Authorization' => 'Bearer '.$session['token']];
    $owner = ['room' => $session['options']['room'], 'owner_id' => (string) Str::uuid()];
    $port = '/api/vaulter-sheets/v1/realtime/owner/';
    $state = $this->postJson($port.'acquire', $owner, $headers)->assertOk()->json();
    $this->postJson($port.'append', $owner + ['owner_fence' => $state['owner_fence'], 'base_seq' => 0, 'if_match' => $state['etag'], 'intent' => [
        'command_id' => 'blocked', 'expected_generation' => $session['generation'], 'policy' => 'exact_base',
        'commands' => [['kind' => 'set_number', 'sheet_id' => 'sheet-1', 'row' => 1, 'column' => 1, 'expected' => null, 'value' => 1]],
    ]], $headers)->assertForbidden();
    $system->access()->revoke($node, $grant);
    $revoked = $this->postJson($port.'read', $owner, $headers);
    expect($revoked->status())->toBeIn([401, 404]);
    $this->postJson($url.'/realtime/session')->assertNotFound();
    expect(DB::table('v_collaboration_updates')->count())->toBe(0);
});
