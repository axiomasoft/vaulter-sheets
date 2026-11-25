<?php

declare(strict_types=1);

namespace Vaulter\Sheets;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Foundation\Application;
use Vaulter\Modules\ModuleBindings;
use Vaulter\Sheets\Contracts\WorkbookExchangeRuntime;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Exchange\HttpWorkbookExchangeRuntime;
use Vaulter\Sheets\Exchange\NodeWorkbookExchangeRuntime;
use Vaulter\Sheets\Operations\LaravelWorkbookOperations;
use Vaulter\Sheets\Operations\LaravelWorkbookRecoveryContext;
use Vaulter\Sheets\Runtime\HttpWorkbookRuntime;
use Vaulter\Sheets\Runtime\NodeWorkbookRuntime;

final class SheetsBindings implements ModuleBindings
{
    public function register(Application $app): void
    {
        $config = $app->make(Repository::class);
        $config->set('queue.connections.sheets-commands', $config->get('queue.connections.sheets-commands') ?? [
            'driver' => 'database', 'table' => 'jobs', 'queue' => 'sheets-commands', 'retry_after' => 75, 'after_commit' => true,
        ]);
        $config->set('queue.connections.sheets-exchange', $config->get('queue.connections.sheets-exchange') ?? [
            'driver' => 'database', 'table' => 'jobs', 'queue' => 'sheets-exchange', 'retry_after' => 90, 'after_commit' => true,
        ]);
        $app->bind(WorkbookOperations::class, LaravelWorkbookOperations::class);
        if (!$app->bound(WorkbookRecoveryContext::class)) {
            $app->bind(WorkbookRecoveryContext::class, LaravelWorkbookRecoveryContext::class);
        }
        $app->bind(WorkbookRuntime::class, static fn (Application $app): WorkbookRuntime => $app->make(
            self::usesHttpRuntime($app) ? HttpWorkbookRuntime::class : NodeWorkbookRuntime::class,
        ));
        $app->bind(WorkbookExchangeRuntime::class, static fn (Application $app): WorkbookExchangeRuntime => $app->make(
            self::usesHttpRuntime($app) ? HttpWorkbookExchangeRuntime::class : NodeWorkbookExchangeRuntime::class,
        ));
    }

    /** The HTTP calculator is used whenever a runtime URL is configured; otherwise the CLI runtime is spawned. */
    private static function usesHttpRuntime(Application $app): bool
    {
        $url = $app->make(Repository::class)->get('vaulter-sheets.runtime_url');

        return is_string($url) && $url !== '';
    }

    public function boot(Application $app): void {}
}
