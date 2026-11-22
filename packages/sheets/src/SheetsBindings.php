<?php

declare(strict_types=1);

namespace Vaulter\Sheets;

use Illuminate\Contracts\Foundation\Application;
use Vaulter\Modules\ModuleBindings;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Operations\LaravelWorkbookRecoveryContext;
use Vaulter\Sheets\Operations\LaravelWorkbookOperations;
use Vaulter\Sheets\Runtime\HttpWorkbookRuntime;
use Vaulter\Sheets\Runtime\NodeWorkbookRuntime;

final class SheetsBindings implements ModuleBindings
{
    public function register(Application $app): void
    {
        $app['config']->set('queue.connections.sheets-commands', $app['config']->get('queue.connections.sheets-commands') ?? [
            'driver' => 'database', 'table' => 'jobs', 'queue' => 'sheets-commands', 'retry_after' => 75, 'after_commit' => true,
        ]);
        $app->bind(WorkbookOperations::class, LaravelWorkbookOperations::class);
        if (!$app->bound(WorkbookRecoveryContext::class)) {
            $app->bind(WorkbookRecoveryContext::class, LaravelWorkbookRecoveryContext::class);
        }
        $app->bind(WorkbookRuntime::class, static fn (Application $app): WorkbookRuntime => $app->make(
            config('vaulter-sheets.runtime_url') ? HttpWorkbookRuntime::class : NodeWorkbookRuntime::class,
        ));
    }

    public function boot(Application $app): void {}
}
