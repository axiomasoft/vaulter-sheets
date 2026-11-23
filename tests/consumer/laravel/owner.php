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
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\VaulterDocumentsServiceProvider;
use Vaulter\Drive\Access\Roles\RoleRegistry;
use Vaulter\Drive\Access\ValueObjects\Subject;
use Vaulter\Drive\Data\Access\GrantInput;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\VaulterDriveServiceProvider;
use Vaulter\Media\VaulterMediaServiceProvider;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\VaulterSheetsServiceProvider;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\Testing\Support\SuiteDatabaseConnection;
use Vaulter\VaulterServiceProvider;

require dirname(__DIR__, 3).'/vendor/autoload.php';

if (getenv('APP_ENV') !== 'testing' || !in_array($_SERVER['REMOTE_ADDR'] ?? '127.0.0.1', ['127.0.0.1', '::1'], true)) {
    http_response_code(404);
    exit;
}

$configure = static function (Laravel $app): void {
    $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
    $app['config']->set('app.debug', false);
    $app['config']->set('cache.default', 'array');
    $app['config']->set('database.default', 'testing');
    $app['config']->set('database.connections.testing', SuiteDatabaseConnection::resolve());
    $app['config']->set('vaulter.ids.strategy', 'bigint');
    $app['config']->set('vaulter.routes.middleware.authenticated', []);
    $app['config']->set('vaulter-drive.access.permission_driver', 'database');
    $app['config']->set('auth.providers.users.model', TestUser::class);
    $app['config']->set('vaulter-sheets.runtime_command', ['node', dirname(__DIR__, 3).'/packages/runtime/dist/cli.js']);
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
            '--path' => dirname(__DIR__, 3).'/vendor/orchestra/testbench-core/laravel/migrations',
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
        (new TestUser)->forceFill(['id' => 1, 'name' => 'Book Owner', 'email' => 'owner@vaulter.test', 'password' => 'secret'])->save();
        (new TestUser)->forceFill(['id' => 2, 'name' => 'Text Reader', 'email' => 'reader@vaulter.test', 'password' => 'secret'])->save();
        DriveTestHelpers::actor(DriveTestHelpers::drive(), 1);
    }
    exit($exit);
}

$actorId = ($_SERVER['HTTP_X_FIXTURE_ACTOR'] ?? '') === '2' ? 2 : 1;
$fixtureActor = (new TestUser)->forceFill(['id' => $actorId]);
$app['config']->set('auth.guards.sanctum', ['driver' => 'session', 'provider' => 'users']);
Auth::setUser($fixtureActor);
Auth::guard('sanctum')->setUser($fixtureActor);

Route::get('/api/test/ready', static fn () => response()->json(['ready' => true]));
Route::post('/api/test/reference', static function () {
    $handle = DriveTestHelpers::drive();
    $actor = DriveTestHelpers::actor($handle, 1);
    $workbook = json_decode((string) file_get_contents(dirname(__DIR__, 3).'/packages/runtime/tests/fixtures/apply-request.json'), true);
    $workbook = is_array($workbook) ? ($workbook['workbook'] ?? null) : null;
    if (!is_array($workbook)) {
        return response()->json(['code' => 'resource_unavailable'], 404);
    }
    $workbook['profile'] = WorkbookCodec::profile();
    $name = 'Secret Budget Title '.Str::uuid();
    $node = app(DocumentsManager::class)->in($handle->actingAs($actor))->create($name, 'vaulter/spreadsheet', $workbook);

    return response()->json(['id' => $node->id, 'name' => $name, 'sheet_id' => 'detail', 'range' => 'D2:D4']);
});
Route::post('/api/test/reference-access', static function (Request $request) {
    $node = $request->input('node');
    $role = $request->input('role');
    if (!is_string($node) || $node === '' || ($role !== null && $role !== 'reader' && $role !== 'previewer' && $role !== 'none')) {
        return response()->json(['code' => 'invalid_command'], 422);
    }
    $handle = DriveTestHelpers::drive();
    $reader = (new TestUser)->forceFill(['id' => 2]);
    $reader->exists = true;
    foreach ($handle->access()->grants($node) as $grant) {
        if ((string) $grant->subject->id === '2') {
            $handle->access()->revoke($node, $grant);
        }
    }
    if ($role === null || $role === 'none') {
        return response()->json(['access' => 'none']);
    }
    $handle->access()->grant($node, new GrantInput(
        subject: Subject::ofModel($reader),
        role: $role === 'previewer' ? RoleRegistry::PREVIEWER : RoleRegistry::READER,
    ));

    return response()->json(['access' => $role]);
});
require __DIR__.'/routes/web.php';
$app->handleRequest(Request::capture());
