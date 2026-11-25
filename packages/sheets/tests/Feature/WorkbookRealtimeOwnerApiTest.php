<?php

declare(strict_types=1);

use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Sheets\Realtime\WorkbookRoomDriver;
use Vaulter\Sheets\Tests\RealtimeTestCase;
use Vaulter\Testing\Fixtures\TestUser;

/*
 * The owner API is the room process's private port to PHP: every call needs the shared owner key and a room token of the
 * room it names, and its body is checked before anything is read or written.
 */

uses(RealtimeTestCase::class);

const OWNER_PORT = '/api/vaulter-sheets/v1/realtime/owner/';

/** A workbook in journal mode and a room session on it, as the acting user. @return array{url: string, session: array<string, mixed>} */
function journalWorkbook(string $name = 'Owner API'): array
{
    $drive = Vaulter::drive(DriveTestHelpers::host())->model()->getKey();
    $node = test()->postJson(V1::url('drives/'.$drive.'/documents'), ['name' => $name, 'type' => 'vaulter/spreadsheet'])->assertCreated()->json('data.id');
    $url = '/api/vaulter-sheets/v1/workbooks/'.$node;
    $tag = test()->getJson($url)->assertOk()->headers->get('ETag');
    test()->putJson($url.'/realtime/profile', ['mode' => 'journal'], ['If-Match' => $tag])->assertOk();

    return ['url' => $url, 'session' => test()->postJson($url.'/realtime/session')->assertOk()->json('data')];
}

/** @param array<string, mixed> $body */
function ownerCall(string $action, array $body, ?string $token, ?string $key = RealtimeTestCase::OWNER_KEY): TestResponse
{
    $headers = array_filter(['X-Vaulter-Sheets-Owner' => $key, 'Authorization' => $token === null ? null : 'Bearer '.$token]);

    return test()->postJson(OWNER_PORT.$action, $body, $headers);
}

beforeEach(function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->actingAs($this->user);
});

it('answers only a caller holding the owner key, and only while the key file holds a usable key', function (): void {
    $this->postJson(OWNER_PORT.'ready', [], ['X-Vaulter-Sheets-Owner' => RealtimeTestCase::OWNER_KEY])
        ->assertOk()->assertJsonPath('protocol', WorkbookRoomDriver::VERSION);
    $this->postJson(OWNER_PORT.'ready')->assertUnauthorized()->assertJsonPath('code', 'owner_credential_invalid');
    $this->postJson(OWNER_PORT.'ready', [], ['X-Vaulter-Sheets-Owner' => RealtimeTestCase::OWNER_KEY.'x'])
        ->assertUnauthorized()->assertJsonPath('code', 'owner_credential_invalid');

    // A key shorter than 32 bytes or an unreadable file is no key at all, even for a caller presenting the same bytes.
    $short = tempnam(sys_get_temp_dir(), 'sheets-owner-');
    file_put_contents($short, 'short-key');
    config(['vaulter-sheets.realtime.owner_token_file' => $short]);
    $this->postJson(OWNER_PORT.'ready', [], ['X-Vaulter-Sheets-Owner' => 'short-key'])->assertUnauthorized();
    // Nor is a key above 4096 bytes, of which only the first 4097 are ever read.
    file_put_contents($short, str_repeat('k', 4097));
    $this->postJson(OWNER_PORT.'ready', [], ['X-Vaulter-Sheets-Owner' => str_repeat('k', 4097)])->assertUnauthorized();
    unlink($short);
    config(['vaulter-sheets.realtime.owner_token_file' => $short]);
    $this->postJson(OWNER_PORT.'ready', [], ['X-Vaulter-Sheets-Owner' => ''])->assertUnauthorized();
});

it('refuses a room token of another room, a missing one, and an owner call without the owner key', function (): void {
    $first = journalWorkbook('First');
    $second = journalWorkbook('Second');
    $room = $first['session']['options']['room'];
    $body = ['room' => $room, 'owner_id' => (string) Str::uuid()];

    ownerCall('acquire', $body, $second['session']['token'])->assertUnauthorized()->assertJsonPath('code', 'room_credential_invalid');
    ownerCall('acquire', $body, null)->assertUnauthorized()->assertJsonPath('code', 'room_credential_invalid');
    ownerCall('acquire', $body, $first['session']['token'], key: null)->assertUnauthorized()->assertJsonPath('code', 'owner_credential_invalid');
    ownerCall('acquire', $body, $first['session']['token'])->assertOk();
});

it('checks the body before it reads or writes anything', function (): void {
    $workbook = journalWorkbook();
    $token = $workbook['session']['token'];
    $room = $workbook['session']['options']['room'];
    $owner = ['room' => $room, 'owner_id' => (string) Str::uuid()];

    ownerCall('acquire', ['room' => $room, 'owner_id' => 'not-a-uuid'], $token)->assertUnprocessable()->assertJsonPath('code', 'invalid_command');
    ownerCall('acquire', ['owner_id' => $owner['owner_id']], $token)->assertUnprocessable();
    ownerCall('renew', $owner, $token)->assertUnprocessable();
    ownerCall('renew', $owner + ['owner_fence' => 0], $token)->assertUnprocessable();
    ownerCall('release', $owner + ['owner_fence' => '1'], $token)->assertUnprocessable();
    ownerCall('read', $owner + ['after_seq' => -1], $token)->assertUnprocessable();
    ownerCall('append', $owner + ['owner_fence' => 1, 'base_seq' => 0, 'intent' => 'set A1'], $token)->assertUnprocessable();

    $this->call('POST', OWNER_PORT.'read', server: [
        'HTTP_X_VAULTER_SHEETS_OWNER' => RealtimeTestCase::OWNER_KEY, 'HTTP_AUTHORIZATION' => 'Bearer '.$token, 'CONTENT_TYPE' => 'application/json',
    ], content: '{"room": ')->assertUnprocessable();
    $this->call('POST', OWNER_PORT.'read', server: [
        'HTTP_X_VAULTER_SHEETS_OWNER' => RealtimeTestCase::OWNER_KEY, 'HTTP_AUTHORIZATION' => 'Bearer '.$token, 'CONTENT_TYPE' => 'application/json',
    ], content: json_encode($owner + ['pad' => str_repeat('x', 1_048_576)], JSON_THROW_ON_ERROR))->assertStatus(413)->assertJsonPath('code', 'limit_exceeded');

    // Exactly 1 MiB of body is read; whitespace keeps it valid JSON.
    $this->call('POST', OWNER_PORT.'acquire', server: [
        'HTTP_X_VAULTER_SHEETS_OWNER' => RealtimeTestCase::OWNER_KEY, 'HTTP_AUTHORIZATION' => 'Bearer '.$token, 'CONTENT_TYPE' => 'application/json',
    ], content: str_pad(json_encode($owner, JSON_THROW_ON_ERROR), 1_048_576))->assertOk();
    // A fence must stay within the integers a JavaScript room process can hold exactly.
    ownerCall('renew', $owner + ['owner_fence' => 9_007_199_254_740_992], $token)->assertUnprocessable()->assertJsonPath('code', 'invalid_command');

    $this->postJson(OWNER_PORT.'steal', $owner, ['X-Vaulter-Sheets-Owner' => RealtimeTestCase::OWNER_KEY, 'Authorization' => 'Bearer '.$token])->assertNotFound();
    ownerCall('acquire', $owner, $token)->assertOk();
});

it('lets only an editor switch the realtime profile, and only against the current ETag; a reader sees no such resource', function (): void {
    $drive = Vaulter::drive(DriveTestHelpers::host());
    $node = $this->postJson(V1::url('drives/'.$drive->model()->getKey().'/documents'), ['name' => 'Profile', 'type' => 'vaulter/spreadsheet'])->assertCreated()->json('data.id');
    $url = '/api/vaulter-sheets/v1/workbooks/'.$node;
    $tag = $this->getJson($url)->assertOk()->headers->get('ETag');

    $this->putJson($url.'/realtime/profile', ['mode' => 'journal'])->assertUnprocessable();
    $this->putJson($url.'/realtime/profile', ['mode' => 'live'], ['If-Match' => $tag])->assertUnprocessable();
    $this->putJson($url.'/realtime/profile', ['mode' => 'journal'], ['If-Match' => '"0.0.0"'])->assertConflict()->assertJsonPath('code', 'version_conflict');

    config(['vaulter-drive.access.permission_driver' => 'database']);
    $reader = (new TestUser)->forceFill(['id' => 2]);
    $drive->asSystem('profile fixture')->access()->grant($node, new GrantInput(subject: Subject::ofModel($reader), role: RoleRegistry::READER));
    $this->actingAs($reader);
    $this->getJson($url)->assertOk();
    $this->putJson($url.'/realtime/profile', ['mode' => 'journal'], ['If-Match' => $tag])->assertNotFound()->assertJsonPath('code', 'resource_unavailable');
});
