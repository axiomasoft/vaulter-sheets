<?php

declare(strict_types=1);

use Illuminate\Foundation\Application as Laravel;
use Illuminate\Foundation\Bootstrap\LoadConfiguration;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;
use Orchestra\Testbench\Foundation\Application;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\VaulterDocumentsServiceProvider;
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

$app = Application::create(resolvingCallback: static function (Laravel $app): void {
    $app->afterBootstrapping(LoadConfiguration::class, static function (Laravel $app): void {
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
        $app['config']->set('cache.default', 'array');
        $app['config']->set('database.default', 'testing');
        $app['config']->set('database.connections.testing', SuiteDatabaseConnection::resolve());
        $app['config']->set('vaulter.ids.strategy', 'bigint');
        $app['config']->set('vaulter.routes.middleware.authenticated', []);
        $app['config']->set('vaulter-drive.access.permission_driver', 'null');
    });
}, options: ['providers' => [
    VaulterServiceProvider::class, VaulterMediaServiceProvider::class, VaulterDriveServiceProvider::class,
    VaulterDocumentsServiceProvider::class, VaulterSheetsServiceProvider::class,
]]);

if (PHP_SAPI === 'cli') {
    $exit = Artisan::call('migrate:fresh', [
        '--force' => true, '--realpath' => true, '--path' => SuiteDatabaseConnection::migrationPaths($app),
    ]);
    echo Artisan::output();
    exit($exit);
}

$fixtureActor = (new TestUser)->forceFill(['id' => 1]);
$app['config']->set('auth.guards.sanctum', ['driver' => 'session', 'provider' => 'users']);
Auth::setUser($fixtureActor);
Auth::guard('sanctum')->setUser($fixtureActor);
Route::get('/api/test/ready', static fn () => response()->json(['ready' => true]));
Route::post('/api/test/workbooks', static function () {
    $handle = DriveTestHelpers::drive();
    $fixture = json_decode(file_get_contents(dirname(__DIR__, 2).'/packages/runtime/tests/fixtures/apply-request.json'), true)['workbook'];
    $fixture['profile'] = WorkbookCodec::profile();
    $actor = DriveTestHelpers::actor($handle, 1);
    $node = app(DocumentsManager::class)->in($handle->actingAs($actor))->create('Browser workbook', 'vaulter/spreadsheet', $fixture);
    return response()->json($node);
});
$app->handleRequest(Request::capture());
