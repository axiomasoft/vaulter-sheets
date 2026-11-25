<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Data\UploadSource;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Console\RecoverWorkbookJobs;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Contracts\WorkbookExchangeRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Exchange\ExchangeWire;
use Vaulter\Sheets\Exchange\WorkbookExchange;
use Vaulter\Sheets\Exchange\ZipArchiveGuard;
use Vaulter\Sheets\Jobs\RunWorkbookExchange;
use Vaulter\Testing\Fixtures\TestUser;

beforeEach(function (): void {
    $this->artisan('migrate:fresh')->assertSuccessful();
    $this->artisan('migrate', [
        '--realpath' => true,
        '--path' => dirname(__DIR__, 4).'/vendor/orchestra/testbench-core/laravel/migrations',
    ])->assertSuccessful();

    if (!Schema::hasTable('test_users')) {
        Schema::create('test_users', static function (Blueprint $table): void {
            $table->id();
            $table->string('name');
            $table->string('email')->nullable();
            $table->string('password')->nullable();
        });
    }

    config(['auth.providers.users.model' => TestUser::class]);
    $this->actor = new TestUser;
    $this->actor->forceFill([
        'id' => 1,
        'name' => 'Owner User',
        'email' => 'owner@vaulter.test',
        'password' => 'secret',
    ])->save();
    $this->reader = new TestUser;
    $this->reader->forceFill([
        'id' => 2,
        'name' => 'Reader User',
        'email' => 'reader@vaulter.test',
        'password' => 'secret',
    ])->save();
    $this->actingAs($this->actor);

    $this->driveHandle = Vaulter::drive(DriveTestHelpers::host())->actingAs($this->actor);
    $this->drive = $this->driveHandle->model()->getKey();

    $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3).'/runtime/tests/fixtures/apply-request.json'), true);
    $fixture['workbook']['profile'] = WorkbookCodec::profile();
    $this->workbook = $fixture['workbook'];

    if (config('vaulter-sheets.runtime_command') === ['vaulter-sheets-runtime']) {
        config(['vaulter-sheets.runtime_command' => ['node', dirname(__DIR__, 3).'/runtime/src/cli.ts']]);
    }
    if (config('vaulter-sheets.exchange.command') === ['vaulter-sheets-exchange']) {
        config(['vaulter-sheets.exchange.command' => ['node', dirname(__DIR__, 3).'/runtime/src/exchange/cli.ts']]);
    }
    config(['vaulter-sheets.exchange.formats' => ['csv', 'xlsx']]);
    config(['vaulter-sheets.exchange.queue_connection' => 'sheets-exchange']);
});

function createExchangeWorkbookUrl($test, ?array $workbook = null): string
{
    $id = $test->postJson(V1::url('drives/'.$test->drive.'/documents'), [
        'name' => 'ExchangeBudget '.Str::uuid(),
        'type' => 'vaulter/spreadsheet',
        'content' => $workbook ?? $test->workbook,
    ])->assertCreated()->json('data.id');

    return '/api/vaulter-sheets/v1/workbooks/'.$id;
}

function makeTestZipBytes(array $entries, int $symlinkIndex = -1): string
{
    $parts = [];
    $central = [];
    $offset = 0;

    foreach ($entries as $idx => $entry) {
        $name = $entry['name'];
        $data = $entry['data'];
        $crc = crc32($data) & 0xFFFFFFFF;
        $compressed = gzdeflate($data, 6);
        $method = 8;
        $compLen = strlen($compressed);
        $uncompLen = strlen($data);
        $nameLen = strlen($name);

        $lfh = pack('VvvvvvVVVvv', 0x04034B50, 20, 0, $method, 0, 0, $crc, $compLen, $uncompLen, $nameLen, 0).$name;
        $extAttrs = $idx === $symlinkIndex ? (0120777 << 16) : (0100644 << 16);
        $cd = pack('VvvvvvvVVVvvvvvVV', 0x02014B50, (3 << 8) | 20, 20, 0, $method, 0, 0, $crc, $compLen, $uncompLen, $nameLen, 0, 0, 0, 0, $extAttrs, $offset).$name;

        $parts[] = $lfh.$compressed;
        $central[] = $cd;
        $offset += strlen($lfh) + $compLen;
    }

    $cdBuf = implode('', $central);
    $eocd = pack('VvvvvVVv', 0x06054B50, 0, 0, count($entries), count($entries), strlen($cdBuf), $offset, 0);

    return implode('', $parts).$cdBuf.$eocd;
}

it('reports disabled format capabilities in API and rejects disabled format requests', function (): void {
    $url = createExchangeWorkbookUrl($this);

    config(['vaulter-sheets.exchange.formats' => []]);
    $this->getJson($url)->assertOk()
        ->assertJsonPath('data.exchange.formats', [])
        ->assertJsonPath('data.exchange.import', [])
        ->assertJsonPath('data.exchange.export', []);

    $this->postJson($url.'/exchanges', [
        'request_key' => 'disabled-both',
        'kind' => 'export',
        'format' => 'xlsx',
        'source' => ['generation' => 0, 'position' => 1],
    ])->assertStatus(422)->assertJsonPath('code', 'format_disabled');

    config(['vaulter-sheets.exchange.formats' => ['csv']]);
    $this->getJson($url)->assertOk()
        ->assertJsonPath('data.exchange.formats', ['csv'])
        ->assertJsonPath('data.exchange.import', ['csv'])
        ->assertJsonPath('data.exchange.export', ['csv']);

    $this->postJson($url.'/exchanges', [
        'request_key' => 'disabled-xlsx',
        'kind' => 'export',
        'format' => 'xlsx',
        'source' => ['generation' => 0, 'position' => 1],
    ])->assertStatus(422)->assertJsonPath('code', 'format_disabled');

    config(['vaulter-sheets.exchange.formats' => ['xlsx']]);
    $this->getJson($url)->assertOk()
        ->assertJsonPath('data.exchange.formats', ['xlsx'])
        ->assertJsonPath('data.exchange.import', ['xlsx'])
        ->assertJsonPath('data.exchange.export', ['xlsx']);

    $this->postJson($url.'/exchanges', [
        'request_key' => 'disabled-csv',
        'kind' => 'export',
        'format' => 'csv',
        'source' => ['generation' => 0, 'position' => 1],
    ])->assertStatus(422)->assertJsonPath('code', 'format_disabled');
});

it('imports 1900 and 1904 XLSX fixtures through Media and queue, verifies loss reports, inserts rows and round-trips export', function (): void {
    $fixtureDir = dirname(__DIR__, 4).'/tests/fixtures/exchange';
    $xlsx1900 = (string) file_get_contents($fixtureDir.'/budget-1900.xlsx');
    $xlsx1904 = (string) file_get_contents($fixtureDir.'/budget-1904.xlsx');
    $xlsxEditable = (string) file_get_contents($fixtureDir.'/budget-editable.xlsx');

    $file1900 = $this->driveHandle->files()->upload(UploadSource::fromString($xlsx1900, 'budget-1900.xlsx'));
    $url = createExchangeWorkbookUrl($this);
    $node = basename($url);
    $preImportEtag = (string) $this->getJson($url)->assertOk()->headers->get('ETag');

    $queued = $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-1900',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1900->id],
    ])->assertStatus(202);
    $jobId = (string) $queued->json('data.exchange_id');
    expect($queued->json('data.state'))->toBe('queued')
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::SOURCE_PIN_OWNER] ?? 0)->toBeGreaterThanOrEqual(1);

    // Idempotent replay with same payload stays 202 while queued, whereas conflict throws 409
    $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-1900',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1900->id],
    ])->assertStatus(202)->assertJsonPath('data.exchange_id', $jobId);

    $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-1900',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1900->id],
        'options' => ['strict_profile' => true],
    ])->assertStatus(409)->assertJsonPath('code', 'idempotency_conflict');

    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $status = $this->getJson($url.'/exchanges/'.$jobId)->assertOk();
    $status->assertJsonPath('data.state', 'succeeded')
        ->assertJsonPath('data.report.date_system', '1900')
        ->assertJsonPath('data.report.unknown_parts.0', 'xl/drawings/drawing1.xml')
        ->assertJsonPath('data.report.defined_names.preserved', 1)
        ->assertJsonPath('data.report.sheets.0.validations', 1)
        ->assertJsonPath('data.report.sheets.0.conditional_formatting', 1);
    expect($status->json('data.result_receipt_id'))->not->toBeNull();

    $afterImport = $this->getJson($url)->assertOk();
    expect($afterImport->headers->get('ETag'))->not->toBe($preImportEtag);
    // Stale 999 cached in C2 was recalculated via CalculationMode.FORCED using TaxRate (0.2) -> 180; E2 external ref -> #REF!
    expect((float) $afterImport->json('data.workbook.native.sheets.sheet_1.cellData.1.2.v'))->toBe(180.0)
        ->and($afterImport->json('data.workbook.native.sheets.sheet_1.cellData.1.4.v'))->toBe('#REF!')
        ->and($afterImport->json('data.workbook.native.sheets.sheet_1.cellData.1.0.v'))->toBe(60);

    // Pre-import rebase_cells command on old 'detail' sheet must conflict due to structural_sheets receipt
    $this->postJson($url.'/commands', [
        'command_id' => 'stale-after-import',
        'expected_generation' => 0,
        'policy' => 'rebase_cells',
        'commands' => [['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 2, 'column' => 2, 'expected' => ['number' => 2], 'value' => 9]],
    ], ['If-Match' => $preImportEtag])->assertStatus(409)->assertJsonPath('data.error.code', 'version_conflict');

    // Replay of completed job returns 200 with report and receipt
    $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-1900',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1900->id],
    ])->assertOk()->assertJsonPath('data.state', 'succeeded');

    // strict_profile refuses lossy XLSX
    $strictFail = $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-strict-fail',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1900->id],
        'options' => ['strict_profile' => true],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $this->getJson($url.'/exchanges/'.$strictFail)->assertOk()
        ->assertJsonPath('data.state', 'failed')
        ->assertJsonPath('data.error_code', 'unsupported_content')
        ->assertJsonPath('data.report.editable_published', false)
        ->assertJsonPath('data.report.date_system', '1900')
        ->assertJsonPath('data.report.unknown_parts.0', 'xl/drawings/drawing1.xml')
        ->assertJsonFragment(['target' => 'xl/drawings/drawing1.xml', 'reason' => 'unsupported_ooxml_part', 'status' => 'lost']);

    // Editable XLSX -> post-import insert_row_before -> export exact version -> re-import
    $fileEditable = $this->driveHandle->files()->upload(UploadSource::fromString($xlsxEditable, 'budget-editable.xlsx'));
    $urlEdit = createExchangeWorkbookUrl($this);
    $impEditId = (string) $this->postJson($urlEdit.'/exchanges', [
        'request_key' => 'imp-editable',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $fileEditable->id],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $headEdit = $this->getJson($urlEdit)->assertOk();
    $inserted = $this->postJson($urlEdit.'/commands', [
        'command_id' => 'row-shift',
        'expected_generation' => $headEdit->json('data.marker.generation'),
        'policy' => 'exact_base',
        'commands' => [['kind' => 'insert_row_before', 'sheet_id' => 'sheet_1', 'row' => 2, 'count' => 1]],
    ], ['If-Match' => $headEdit->headers->get('ETag')])->assertOk();

    // Queue an export of the post-insert marker, THEN mutate workbook again; worker must export the pinned marker
    $exportGen = (int) $inserted->json('data.marker.generation');
    $exportPos = (int) $inserted->json('data.marker.position');
    $expJobId = (string) $this->postJson($urlEdit.'/exchanges', [
        'request_key' => 'exp-pinned',
        'kind' => 'export',
        'format' => 'xlsx',
        'source' => ['generation' => $exportGen, 'position' => $exportPos],
    ])->assertStatus(202)->json('data.exchange_id');

    $this->postJson($urlEdit.'/commands', [
        'command_id' => 'later-edit',
        'expected_generation' => $exportGen,
        'policy' => 'exact_base',
        'commands' => [['kind' => 'set_number', 'sheet_id' => 'sheet_1', 'row' => 3, 'column' => 2, 'expected' => ['number' => 100], 'value' => 999]],
    ], ['If-Match' => $inserted->headers->get('ETag')])->assertOk();

    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $expStatus = $this->getJson($urlEdit.'/exchanges/'.$expJobId)->assertOk()
        ->assertJsonPath('data.state', 'succeeded');
    expect($expStatus->json('data.output_blob_id'))->not->toBeNull();

    $download = $this->get($urlEdit.'/exchanges/'.$expJobId.'/download')->assertOk();
    $download->assertHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        ->assertHeader('X-Content-Type-Options', 'nosniff');
    $exportedBytes = $download->streamedContent();

    // Re-import exported XLSX into a fresh workbook and confirm row 3 has original 100 / 110 (not 999 from later edit!)
    $reup = $this->driveHandle->files()->upload(UploadSource::fromString($exportedBytes, 'roundtrip.xlsx'));
    $urlReimp = createExchangeWorkbookUrl($this);
    $reimpId = (string) $this->postJson($urlReimp.'/exchanges', [
        'request_key' => 'reimp-xlsx',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $reup->id],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $reimpHead = $this->getJson($urlReimp)->assertOk();
    expect((float) $reimpHead->json('data.workbook.native.sheets.sheet_1.cellData.2.1.v'))->toBe(100.0)
        ->and(round((float) $reimpHead->json('data.workbook.native.sheets.sheet_1.cellData.2.2.v'), 6))->toBe(110.0);

    // 1904 date system import -> +1462 serial shift -> export as date_system='1904' -> re-import preserves calendar date
    $file1904 = $this->driveHandle->files()->upload(UploadSource::fromString($xlsx1904, 'budget-1904.xlsx'));
    $url1904 = createExchangeWorkbookUrl($this);
    $imp1904Id = (string) $this->postJson($url1904.'/exchanges', [
        'request_key' => 'imp-1904',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $file1904->id],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $this->getJson($url1904.'/exchanges/'.$imp1904Id)->assertOk()
        ->assertJsonPath('data.report.date_system', '1904');
    $head1904 = $this->getJson($url1904)->assertOk();
    expect((float) $head1904->json('data.workbook.native.sheets.sheet_1.cellData.1.0.v'))->toBe(45659.0)
        ->and(round((float) $head1904->json('data.workbook.native.sheets.sheet_1.cellData.1.2.v'), 6))->toBe(220.0);

    $exp1904Id = (string) $this->postJson($url1904.'/exchanges', [
        'request_key' => 'exp-1904',
        'kind' => 'export',
        'format' => 'xlsx',
        'source' => ['generation' => $head1904->json('data.marker.generation'), 'position' => $head1904->json('data.marker.position')],
        'options' => ['date_system' => '1904'],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $this->getJson($url1904.'/exchanges/'.$exp1904Id)->assertOk()
        ->assertJsonPath('data.report.date_system', '1904');
});

it('imports and exports CSV with dialect fidelity, safe literal "=" handling, formula injection defense and post-import edits', function (): void {
    $fixtureDir = dirname(__DIR__, 4).'/tests/fixtures/exchange';
    $csvBytes = (string) file_get_contents($fixtureDir.'/ledger.csv');
    $csvFile = $this->driveHandle->files()->upload(UploadSource::fromString($csvBytes, 'ledger.csv'));
    $url = createExchangeWorkbookUrl($this);

    $impId = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-csv',
        'kind' => 'import',
        'format' => 'csv',
        'source' => ['node_id' => $csvFile->id],
        'options' => ['delimiter' => ';', 'quote' => '"', 'line_ending' => "\r\n"],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $this->getJson($url.'/exchanges/'.$impId)->assertOk()
        ->assertJsonPath('data.state', 'succeeded')
        ->assertJsonPath('data.report.dialect.delimiter', ';');

    $opened = $this->getJson($url)->assertOk();
    expect($opened->json('data.workbook.native.sheets.sheet_1.cellData.1.0.v'))->toBe('00123')
        ->and($opened->json('data.workbook.native.sheets.sheet_1.cellData.1.1.v'))->toBe("line1\nline2")
        ->and($opened->json('data.workbook.native.sheets.sheet_1.cellData.1.2.v'))->toBe(-42)
        ->and($opened->json('data.workbook.native.sheets.sheet_1.cellData.1.3.v'))->toBe('=1+1')
        ->and($opened->json('data.workbook.native.sheets.sheet_1.cellData.1.3.f'))->toBeNull()
        ->and($opened->json('data.workbook.native.sheets.sheet_1.cellData.2.0.v'))->toBe('9007199254740993');

    $updated = $this->postJson($url.'/commands', [
        'command_id' => 'add-formula-after-csv',
        'expected_generation' => $opened->json('data.marker.generation'),
        'policy' => 'exact_base',
        'commands' => [['kind' => 'set_formula', 'sheet_id' => 'sheet_1', 'row' => 2, 'column' => 5, 'expected' => null, 'formula' => '=C2*2']],
    ], ['If-Match' => $opened->headers->get('ETag')])->assertOk();

    $expCsvId = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'exp-csv',
        'kind' => 'export',
        'format' => 'csv',
        'source' => ['generation' => $updated->json('data.marker.generation'), 'position' => $updated->json('data.marker.position')],
        'options' => ['delimiter' => ';', 'line_ending' => "\r\n"],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $csvDownload = $this->get($url.'/exchanges/'.$expCsvId.'/download')->assertOk();
    $csvDownload->assertHeader('X-Content-Type-Options', 'nosniff');
    $exportedText = $csvDownload->streamedContent();
    expect($exportedText)->toContain("00123;\"line1\nline2\";-42;'=1+1;-84\r\n")
        ->and($exportedText)->toContain("9007199254740993;\"plain;text\";100;'@tag");
});

it('blocks unsafe ZIP archives including traversal, symlinks, zip-bombs, XXE and disallowed external rels before execution', function (): void {
    $guard = app(ZipArchiveGuard::class);
    $okXml = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';

    expect(fn () => $guard->assertSafe(makeTestZipBytes([['name' => '../evil.xml', 'data' => $okXml]])))
        ->toThrow(WorkbookProblem::class, 'unsafe_archive')
        ->and(fn () => $guard->assertSafe(makeTestZipBytes([['name' => '/xl/workbook.xml', 'data' => $okXml]])))
        ->toThrow(WorkbookProblem::class, 'unsafe_archive')
        ->and(fn () => $guard->assertSafe(makeTestZipBytes([['name' => 'xl/link.xml', 'data' => '/etc/passwd']], 0)))
        ->toThrow(WorkbookProblem::class, 'unsafe_archive')
        ->and(fn () => $guard->assertSafe(makeTestZipBytes([['name' => 'xl/bomb.xml', 'data' => str_repeat('A', 2 * 1024 * 1024)]])))
        ->toThrow(WorkbookProblem::class, 'limit_exceeded')
        ->and(fn () => $guard->assertSafe(makeTestZipBytes([['name' => 'xl/workbook.xml', 'data' => '<!DOCTYPE foo [<!ENTITY xxe "bar">]><workbook/>']])))
        ->toThrow(WorkbookProblem::class, 'unsafe_archive')
        ->and(fn () => $guard->assertSafe(makeTestZipBytes([['name' => 'xl/_rels/workbook.xml.rels', 'data' => '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.invalid/a.dotm" TargetMode="External"/></Relationships>']])))
        ->toThrow(WorkbookProblem::class, 'unsafe_archive');

    // Drive upload guard rejects central-directory symlink ZIPs; upload a ZIP with XXE/external rels so our ZipArchiveGuard rejects in worker
    expect(fn () => $this->driveHandle->files()->upload(UploadSource::fromString(
        makeTestZipBytes([['name' => 'xl/workbook.xml', 'data' => '/etc/passwd']], 0),
        'symlink.xlsx',
    )))->toThrow(ValidationException::class);

    $xxeZip = makeTestZipBytes([[
        'name' => 'xl/workbook.xml',
        'data' => '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><workbook/>',
    ]]);
    $xxeNode = $this->driveHandle->files()->upload(UploadSource::fromString($xxeZip, 'xxe.xlsx'));
    $url = createExchangeWorkbookUrl($this);
    $beforeTag = (string) $this->getJson($url)->assertOk()->headers->get('ETag');

    $badJobId = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'imp-bad-xxe',
        'kind' => 'import',
        'format' => 'xlsx',
        'source' => ['node_id' => $xxeNode->id],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $this->getJson($url.'/exchanges/'.$badJobId)->assertOk()
        ->assertJsonPath('data.state', 'failed')
        ->assertJsonPath('data.error_code', 'unsafe_archive');
    $this->getJson($url)->assertOk()->assertHeader('ETag', $beforeTag);
});

it('checks later ZIP metadata before opening earlier entry streams', function (): void {
    $archive = new class extends ZipArchive
    {
        public int $streamsOpened = 0;

        public function getStreamIndex(int $index, int $flags = 0)
        {
            $this->streamsOpened++;

            return parent::getStreamIndex($index, $flags);
        }
    };
    $path = tempnam(sys_get_temp_dir(), 'sheets-zip-test-');
    file_put_contents($path, makeTestZipBytes([
        ['name' => 'xl/workbook.xml', 'data' => '<workbook/>'],
        ['name' => '../invalid.xml', 'data' => '<invalid/>'],
    ]));
    try {
        expect($archive->open($path, ZipArchive::RDONLY))->toBeTrue();
        try {
            $inspect = new ReflectionMethod(ZipArchiveGuard::class, 'inspectArchive');
            expect(fn (): mixed => $inspect->invoke(app(ZipArchiveGuard::class), $archive))
                ->toThrow(WorkbookProblem::class, 'unsafe_archive');
            expect($archive->streamsOpened)->toBe(0);
        } finally {
            $archive->close();
        }
    } finally {
        unlink($path);
    }
});

it('fences import publication at registration and replays a retained export after an edit', function (): void {
    $url = createExchangeWorkbookUrl($this);
    $head = $this->getJson($url)->assertOk();
    $generation = $head->json('data.marker.generation');
    $export = [
        'request_key' => 'head-export',
        'kind' => 'export',
        'format' => 'csv',
        'source' => [
            'generation' => $generation,
            'position' => $head->json('data.marker.position'),
            'sha256' => $head->json('data.marker.sha256'),
        ],
    ];
    $exportId = $this->postJson($url.'/exchanges', $export)->assertStatus(202)->json('data.exchange_id');
    $file = $this->driveHandle->files()->upload(UploadSource::fromString("a,b\n1,2\n", 'fence.csv'));
    $importId = $this->postJson($url.'/exchanges', [
        'request_key' => 'head-import', 'kind' => 'import', 'format' => 'csv',
        'source' => ['node_id' => $file->id],
    ])->assertStatus(202)->json('data.exchange_id');

    $edited = $this->postJson($url.'/commands', [
        'command_id' => 'intervening-edit',
        'expected_generation' => $generation,
        'policy' => 'rebase_cells',
        'commands' => [['kind' => 'set_number', 'sheet_id' => 'detail', 'row' => 2, 'column' => 2, 'expected' => ['number' => 2], 'value' => 9]],
    ], ['If-Match' => $head->headers->get('ETag')])->assertOk();

    $this->postJson($url.'/exchanges', $export)->assertStatus(202)->assertJsonPath('data.exchange_id', $exportId);
    $incorrectSource = array_replace($export['source'], ['sha256' => str_repeat('0', 64)]);
    $this->postJson($url.'/exchanges', array_replace($export, ['source' => $incorrectSource]))
        ->assertStatus(409)->assertJsonPath('code', 'idempotency_conflict');
    $this->postJson($url.'/exchanges', array_replace($export, ['options' => ['delimiter' => ';']]))
        ->assertStatus(409)->assertJsonPath('code', 'idempotency_conflict');
    $this->postJson($url.'/exchanges', array_replace($export, ['request_key' => 'new-head-export']))
        ->assertStatus(409)->assertJsonPath('code', 'version_conflict');

    app()->call([new RunWorkbookExchange($importId), 'handle']);
    $this->getJson($url.'/exchanges/'.$importId)->assertOk()
        ->assertJsonPath('data.state', 'failed')->assertJsonPath('data.error_code', 'version_conflict');
    $this->getJson($url)->assertOk()->assertHeader('ETag', $edited->headers->get('ETag'))
        ->assertJsonPath('data.workbook.native.sheets.detail.cellData.1.1.v', 9);
});

it('resolves a competing registration that inserts after the first request checks for a row', function (bool $sameOptions): void {
    $url = createExchangeWorkbookUrl($this);
    $head = $this->getJson($url)->assertOk();
    $request = [
        'request_key' => 'competing-export', 'kind' => 'export', 'format' => 'csv',
        'source' => ['generation' => $head->json('data.marker.generation'), 'position' => $head->json('data.marker.position')],
    ];
    $schema = app(SchemaHelpers::class);
    $connection = $schema->dbConnection();
    $table = $schema->table('sheets_exchange_jobs');
    $separateConnection = $connection->getDriverName() === 'pgsql';
    if ($separateConnection) {
        config(['database.connections.sheets_competitor' => $connection->getConfig()]);
    }
    $competingId = null;
    $interleaved = false;
    $competingRequest = $sameOptions ? $request : $request + ['options' => ['delimiter' => ';']];
    $connection->beforeExecuting(function (string $sql) use ($table, $url, $competingRequest, $separateConnection, &$interleaved, &$competingId): void {
        if (!$interleaved && str_starts_with($sql, 'insert into "'.$table.'"')) {
            $interleaved = true;
            $register = fn () => $this->postJson($url.'/exchanges', $competingRequest)->assertStatus(202)->json('data.exchange_id');
            $competingId = $separateConnection ? DB::usingConnection('sheets_competitor', $register) : $register();
        }
    });

    $outer = $this->postJson($url.'/exchanges', $request);
    if ($sameOptions) {
        $outer->assertStatus(202)->assertJsonPath('data.exchange_id', $competingId);
    } else {
        $outer->assertStatus(409)->assertJsonPath('code', 'idempotency_conflict');
    }
    expect($interleaved)->toBeTrue()->and($competingId)->toBeString();
    // The in-memory SQLite test's competing request shares the outer transaction's rollback.
    $expected = $separateConnection || $sameOptions ? 1 : 0;
    expect($connection->table($table)->count())->toBe($expected)
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::SOURCE_PIN_OWNER] ?? 0)->toBe($expected);
})->with(['identical options' => [true], 'different options' => [false]]);

it('releases a transient failure back to queued and drops exchange pins on document purge', function (): void {
    $url = createExchangeWorkbookUrl($this);
    $head = $this->getJson($url)->assertOk();
    $jobId = $this->postJson($url.'/exchanges', [
        'request_key' => 'retry-and-purge', 'kind' => 'export', 'format' => 'csv',
        'source' => ['generation' => $head->json('data.marker.generation'), 'position' => $head->json('data.marker.position')],
    ])->assertStatus(202)->json('data.exchange_id');

    $runtime = app(WorkbookExchangeRuntime::class);
    $this->app->instance(WorkbookExchangeRuntime::class, new class($runtime) implements WorkbookExchangeRuntime
    {
        private bool $failOnce = true;

        public function __construct(private readonly WorkbookExchangeRuntime $runtime) {}

        public function exchange(stdClass $request): stdClass
        {
            if ($this->failOnce) {
                $this->failOnce = false;
                throw new WorkbookProblem('runtime_failed', 503);
            }

            return $this->runtime->exchange($request);
        }
    });
    $run = fn () => app()->call([new RunWorkbookExchange($jobId), 'handle']);
    expect($run)->toThrow(WorkbookProblem::class, 'runtime_failed');
    $this->getJson($url.'/exchanges/'.$jobId)->assertOk()->assertJsonPath('data.state', 'queued');
    $run();
    $this->getJson($url.'/exchanges/'.$jobId)->assertOk()->assertJsonPath('data.state', 'succeeded');

    $otherUrl = createExchangeWorkbookUrl($this);
    $other = $this->getJson($otherUrl)->assertOk();
    $this->postJson($otherUrl.'/exchanges', [
        'request_key' => 'keep-other-pin', 'kind' => 'export', 'format' => 'csv',
        'source' => ['generation' => $other->json('data.marker.generation'), 'position' => $other->json('data.marker.position')],
    ])->assertStatus(202);

    $node = basename($url);
    $this->driveHandle->nodes()->trash($node);
    $this->driveHandle->trash()->purge($node);
    expect(app(BlobPins::class)->countByOwner()[WorkbookExchange::SOURCE_PIN_OWNER] ?? 0)->toBe(1)
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::OUTPUT_PIN_OWNER] ?? 0)->toBe(0);
    $table = app(SchemaHelpers::class)->table('sheets_exchange_jobs');
    expect(DB::table($table)->where('id', $jobId)->exists())->toBeFalse();
});

it('reclaims expired leases via vaulter-sheets:recover, keeps replay idempotent and unpins blobs after retention GC', function (): void {
    $fixtureDir = dirname(__DIR__, 4).'/tests/fixtures/exchange';
    $csvFile = $this->driveHandle->files()->upload(UploadSource::fromString((string) file_get_contents($fixtureDir.'/ledger.csv'), 'ledger.csv'));
    $url = createExchangeWorkbookUrl($this);

    $head = $this->getJson($url)->assertOk();
    $jobId = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'exp-recover',
        'kind' => 'export',
        'format' => 'csv',
        'source' => ['generation' => $head->json('data.marker.generation'), 'position' => $head->json('data.marker.position')],
    ])->assertStatus(202)->json('data.exchange_id');

    $table = app(SchemaHelpers::class)->table('sheets_exchange_jobs');
    // Simulate a crashed worker that left the row running with an expired lease
    DB::table($table)->where('id', $jobId)->update([
        'state' => 'running',
        'worker_token' => (string) Str::uuid(),
        'lease_until' => '2020-01-01 00:00:00',
    ]);

    $this->artisan(RecoverWorkbookJobs::class)->assertSuccessful();
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    $this->getJson($url.'/exchanges/'.$jobId)->assertOk()->assertJsonPath('data.state', 'succeeded');
    expect(app(BlobPins::class)->countByOwner()[WorkbookExchange::SOURCE_PIN_OWNER] ?? 0)->toBeGreaterThanOrEqual(1)
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::OUTPUT_PIN_OWNER] ?? 0)->toBeGreaterThanOrEqual(1);

    // Repeating RunWorkbookExchange on an already-succeeded job is a safe no-op
    app()->call([new RunWorkbookExchange($jobId), 'handle']);
    $this->getJson($url.'/exchanges/'.$jobId)->assertOk()->assertJsonPath('data.state', 'succeeded');

    // Expire keep_until and run recover GC -> unpins source & output blobs and removes job row
    DB::table($table)->where('id', $jobId)->update([
        'created_at' => '2020-01-01 00:00:00',
        'keep_until' => '2020-01-01 00:01:00',
    ]);
    $this->artisan(RecoverWorkbookJobs::class)->assertSuccessful();
    expect(DB::table($table)->where('id', $jobId)->exists())->toBeFalse()
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::SOURCE_PIN_OWNER] ?? 0)->toBe(0)
        ->and(app(BlobPins::class)->countByOwner()[WorkbookExchange::OUTPUT_PIN_OWNER] ?? 0)->toBe(0);
});

it('enforces ACL isolation and re-checks download ability on export status and download', function (): void {
    $url = createExchangeWorkbookUrl($this);
    $node = basename($url);
    $head = $this->getJson($url)->assertOk();

    $readerCsv = $this->driveHandle->files()->upload(UploadSource::fromString("a,b\n1,2\n", 'r.csv'));

    config(['vaulter-drive.access.permission_driver' => 'database']);
    $system = $this->driveHandle->asSystem('exchange acl test');
    // Grant Owner full role and Reader read+download role under database permission driver
    $system->access()->grant($node, new GrantInput(subject: Subject::ofModel($this->actor), role: RoleRegistry::OWNER));
    $readerGrant = $system->access()->grant($node, new GrantInput(subject: Subject::ofModel($this->reader), role: RoleRegistry::READER));

    // Owner exports a CSV first
    $ownerJob = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'owner-export',
        'kind' => 'export',
        'format' => 'csv',
        'source' => ['generation' => $head->json('data.marker.generation'), 'position' => $head->json('data.marker.position')],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();

    // Reader cannot enumerate Owner's exchange job (404), nor import without Edit (403)
    $this->actingAs($this->reader);
    $this->getJson($url.'/exchanges/'.$ownerJob)->assertNotFound()->assertJsonPath('code', 'resource_unavailable');
    $this->getJson($url.'/exchanges/'.$ownerJob.'/download')->assertNotFound()->assertJsonPath('code', 'resource_unavailable');
    $this->getJson($url)->assertOk()->assertJsonPath('data.exchange.import', [])->assertJsonPath('data.exchange.export', ['csv', 'xlsx']);

    $this->postJson($url.'/exchanges', [
        'request_key' => 'reader-import-denied',
        'kind' => 'import',
        'format' => 'csv',
        'source' => ['node_id' => $readerCsv->id],
    ])->assertStatus(403)->assertJsonPath('code', 'permission_denied');

    // Reader registers their own export while holding Reader grant
    $readerJob = (string) $this->postJson($url.'/exchanges', [
        'request_key' => 'reader-export',
        'kind' => 'export',
        'format' => 'csv',
        'source' => ['generation' => $head->json('data.marker.generation'), 'position' => $head->json('data.marker.position')],
    ])->assertStatus(202)->json('data.exchange_id');
    $this->artisan('queue:work', ['connection' => 'sheets-exchange', '--once' => true])->assertSuccessful();
    $this->get($url.'/exchanges/'.$readerJob.'/download')->assertOk();

    // Downgrade Reader to Previewer (View without Download) -> download blocked (403)
    $system->access()->revoke($node, $readerGrant);
    $viewerGrant = $system->access()->grant($node, new GrantInput(subject: Subject::ofModel($this->reader), role: RoleRegistry::PREVIEWER));
    $this->getJson($url)->assertOk()->assertJsonPath('data.exchange.export', []);
    $this->getJson($url.'/exchanges/'.$readerJob.'/download')->assertStatus(403)->assertJsonPath('code', 'permission_denied');

    // Complete revocation -> 404 resource_unavailable
    $system->access()->revoke($node, $viewerGrant);
    $this->getJson($url.'/exchanges/'.$readerJob)->assertNotFound()->assertJsonPath('code', 'resource_unavailable');
    $this->getJson($url.'/exchanges/'.$readerJob.'/download')->assertNotFound()->assertJsonPath('code', 'resource_unavailable');
});

it('packs and unpacks > 5 MiB VX01 exchange frames and enforces ZipArchiveGuard::inspectStream', function (): void {
    $payload = str_repeat('A', 5 * 1024 * 1024 + 1024);
    $frame = ExchangeWire::streamRequest((object) [
        'version' => 1,
        'request_id' => 'big_php_1',
        'operation' => 'import',
        'format' => 'xlsx',
        'profile_id' => WorkbookCodec::PROFILE,
        'input_b64' => base64_encode($payload),
        'input_sha256' => hash('sha256', $payload),
        'options' => (object) [],
    ]);
    expect(str_starts_with($frame, 'VX01'))->toBeTrue();
    expect(strlen($frame))->toBeGreaterThan(5 * 1024 * 1024);

    $stream = fopen('php://temp', 'r+b');
    expect($stream)->not->toBeFalse();
    fwrite($stream, str_repeat('B', 2048));
    rewind($stream);
    expect(fn () => ZipArchiveGuard::inspectStream($stream, 1024))
        ->toThrow(WorkbookProblem::class);
    fclose($stream);
});
