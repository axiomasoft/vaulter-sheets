<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Application as Laravel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Orchestra\Testbench\Foundation\Application;
use Vaulter\Collaboration\VaulterCollaborationServiceProvider;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\VaulterDocumentsServiceProvider;
use Vaulter\Drive\Data\UploadSource;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\VaulterDriveServiceProvider;
use Vaulter\Media\VaulterMediaServiceProvider;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\VaulterSheetsServiceProvider;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\Testing\Support\SuiteDatabaseConnection;
use Vaulter\VaulterServiceProvider;

require dirname(__DIR__, 2).'/vendor/autoload.php';

if (getenv('APP_ENV') !== 'testing' || !in_array($_SERVER['REMOTE_ADDR'] ?? '127.0.0.1', ['127.0.0.1', '::1'], true)) {
    http_response_code(404);
    exit;
}

$realtime = getenv('SHEETS_REALTIME_TEST') === '1';
$configure = static function (Laravel $app) use ($realtime): void {
    $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
    $app['config']->set('cache.default', 'array');
    $app['config']->set('database.default', 'testing');
    $app['config']->set('database.connections.testing', SuiteDatabaseConnection::resolve());
    $app['config']->set('vaulter.ids.strategy', 'bigint');
    $app['config']->set('vaulter.routes.middleware.authenticated', []);
    $app['config']->set('vaulter-drive.access.permission_driver', 'null');
    $app['config']->set('auth.providers.users.model', TestUser::class);
    if ($realtime) {
        $app['config']->set('vaulter.modules.collaboration', true);
        $app['config']->set('vaulter.modules.sheets-realtime', true);
        $app['config']->set('vaulter-collaboration.hub.issuer', 'http://localhost');
        $app['config']->set('vaulter-collaboration.hub.jwt_keys', ['fixture' => str_repeat('j', 32)]);
        $app['config']->set('vaulter-collaboration.hub.jwt_active_kid', 'fixture');
        $app['config']->set('vaulter-collaboration.hub.webhook_secret', str_repeat('w', 32));
        $app['config']->set('vaulter-sheets.realtime.url', getenv('SHEETS_REALTIME_URL'));
        $app['config']->set('vaulter-sheets.realtime.owner_token_file', getenv('SHEETS_REALTIME_OWNER_TOKEN_FILE'));
        $app['config']->set('vaulter-sheets.runtime_command', ['node', dirname(__DIR__, 2).'/packages/runtime/dist/cli.js']);
    }
};

$fixture = new class($configure) extends Application
{
    public function __construct(private readonly Closure $configureOwner)
    {
        parent::__construct();
    }

    protected function defineEnvironment($app): void
    {
        ($this->configureOwner)($app);
    }
};
$app = $fixture->configure(['extra' => ['providers' => [
    VaulterServiceProvider::class, VaulterMediaServiceProvider::class, VaulterDriveServiceProvider::class,
    VaulterDocumentsServiceProvider::class, VaulterSheetsServiceProvider::class,
    ...($realtime ? [VaulterCollaborationServiceProvider::class] : []),
]]])->createApplication();

if (PHP_SAPI === 'cli') {
    try {
        $exit = Artisan::call('migrate:fresh', [
            '--force' => true, '--realpath' => true, '--path' => SuiteDatabaseConnection::migrationPaths($app),
        ]);
    } catch (Throwable $error) {
        fwrite(STDERR, $error->getMessage().PHP_EOL);
        exit(1);
    }
    echo Artisan::output();
    if ($exit === 0) {
        $exit = Artisan::call('migrate', [
            '--force' => true,
            '--realpath' => true,
            '--path' => dirname(__DIR__, 2).'/vendor/orchestra/testbench-core/laravel/migrations',
        ]);
        echo Artisan::output();
    }
    if ($exit === 0) {
        if (!Schema::hasTable('test_users')) {
            Schema::create('test_users', static function (Blueprint $table): void {
                $table->id();
                $table->string('name');
                $table->string('email')->nullable();
                $table->string('password')->nullable();
            });
        }
        (new TestUser)->forceFill([
            'id' => 1,
            'name' => 'Fixture Actor',
            'email' => 'fixture@vaulter.test',
            'password' => 'secret',
        ])->save();
        if ($realtime) {
            (new TestUser)->forceFill(['id' => 2, 'name' => 'Second Fixture Actor'])->save();
        }
    }
    exit($exit);
}

$actorId = $realtime && ($_SERVER['HTTP_X_FIXTURE_ACTOR'] ?? '') === '2' ? 2 : 1;
$fixtureActor = (new TestUser)->forceFill(['id' => $actorId]);
$app['config']->set('auth.guards.sanctum', ['driver' => 'session', 'provider' => 'users']);
Auth::setUser($fixtureActor);
Auth::guard('sanctum')->setUser($fixtureActor);
Route::get('/api/test/ready', static fn () => response()->json(['ready' => true]));
Route::post('/api/test/workbooks', static function () use ($realtime) {
    $handle = DriveTestHelpers::drive();
    $fixture = json_decode(file_get_contents(dirname(__DIR__, 2).'/packages/runtime/tests/fixtures/apply-request.json'), true)['workbook'];
    $fixture['profile'] = WorkbookCodec::profile();
    if ($realtime) {
        $fixture['tables'] = [[
            'table_id' => 'items', 'sheet_id' => 'detail', 'header_row' => 1,
            'columns' => [['column_id' => 'price', 'column' => 3], ['column_id' => 'sum', 'column' => 4]],
            'rows' => [['row_id' => 'apples', 'row' => 2], ['row_id' => 'pears', 'row' => 3]],
        ]];
    }
    $actor = DriveTestHelpers::actor($handle, 1);
    $name = $realtime ? 'Browser workbook '.Str::uuid() : 'Browser workbook';
    $node = app(DocumentsManager::class)->in($handle->actingAs($actor))->create($name, 'vaulter/spreadsheet', $fixture);

    return response()->json($node);
});
Route::post('/api/test/exchange-files', static function (Request $request) use ($fixtureActor) {
    $handle = DriveTestHelpers::drive();
    $name = (string) $request->input('name', 'upload.xlsx');
    $content = base64_decode((string) $request->input('content_b64', ''), true);
    if (!is_string($content)) {
        return response()->json(['error' => 'invalid_base64'], 422);
    }
    $node = $handle->actingAs($fixtureActor)->files()->upload(UploadSource::fromString($content, $name));

    return response()->json(['id' => $node->id, 'sha256' => hash('sha256', $content)], 201);
});
Route::post('/api/test/exchange-work', static function () {
    $exit = Artisan::call('queue:work', [
        'connection' => 'sheets-exchange',
        '--once' => true,
        '--stop-when-empty' => true,
    ]);

    return response()->json(['exit' => $exit, 'output' => trim(Artisan::output())]);
});
$app->handleRequest(Request::capture());
