<?php

declare(strict_types=1);

use Illuminate\Support\Arr;
use Illuminate\Testing\TestResponse;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;
use Vaulter\Testing\Fixtures\TestUser;

// vaulter-sheets.commands switches workbook commands on and off. The catalog and
// the commit endpoint must agree on it, including when a host config omits the key.

beforeEach(function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->actingAs((new TestUser)->forceFill(['id' => 1]));
    $drive = Vaulter::drive(DriveTestHelpers::host())->model()->getKey();
    $workbook = app(SpreadsheetDocumentType::class)->defaultContent()->toArray();
    $id = $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Switch.xlsx', 'type' => 'vaulter/spreadsheet', 'content' => $workbook,
    ])->assertCreated()->json('data.id');
    $this->url = '/api/vaulter-sheets/v1/workbooks/'.$id;
    $this->sheet = $workbook['native']['sheetOrder'][0];
    if (config('vaulter-sheets.runtime_command') === ['vaulter-sheets-runtime']) {
        config(['vaulter-sheets.runtime_command' => ['node', dirname(__DIR__, 3).'/runtime/src/cli.ts']]);
    }
});

function switchTestCommit($test): TestResponse
{
    $head = $test->getJson($test->url)->assertOk();

    return $test->postJson($test->url.'/commands', [
        'command_id' => 'switch-'.uniqid(),
        'expected_generation' => $head->json('data.marker.generation'),
        'policy' => 'exact_base',
        'commands' => [['kind' => 'set_number', 'sheet_id' => $test->sheet, 'row' => 1, 'column' => 1, 'expected' => null, 'value' => 7]],
    ], ['If-Match' => $head->headers->get('ETag')]);
}

it('hides the command list and refuses commits when commands are switched off', function (): void {
    config(['vaulter-sheets.commands' => false]);

    expect($this->getJson($this->url)->assertOk()->json('data.commands'))->toBe([]);
    switchTestCommit($this)->assertStatus(422)->assertJsonPath('code', 'unsupported_content');
});

it('enables commands when the host config omits the switch', function (): void {
    $sheets = config('vaulter-sheets');
    config(['vaulter-sheets' => Arr::except($sheets, 'commands')]);

    expect($this->getJson($this->url)->assertOk()->json('data.commands'))->toContain('set_number', 'fill_formula');
    switchTestCommit($this)->assertOk();
});

it('refuses a switch that is not a boolean instead of reading a string as true', function (): void {
    config(['vaulter-sheets.commands' => 'false']);

    $this->withoutExceptionHandling();
    expect(fn () => $this->getJson($this->url))->toThrow(InvalidArgumentException::class);
});
