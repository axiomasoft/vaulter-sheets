<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Vaulter\Configuration\RoutesOptions;
use Vaulter\Sheets\Realtime\WorkbookRealtimeController;

$prefix = config('vaulter-sheets.prefix', 'api/vaulter-sheets/v1');
$prefix = is_string($prefix) ? $prefix : 'api/vaulter-sheets/v1';
$routes = app(RoutesOptions::class);

Route::prefix($prefix)->name('vaulter.sheets.realtime.')
    ->middleware($routes->authenticatedMiddleware())->where(['node' => '[A-Za-z0-9_-]+'])
    ->group(static function (): void {
        Route::post('workbooks/{node}/realtime/session', [WorkbookRealtimeController::class, 'session'])->name('session');
        Route::put('workbooks/{node}/realtime/profile', [WorkbookRealtimeController::class, 'profile'])->name('profile');
    });

Route::prefix($prefix.'/realtime/owner')->name('vaulter.sheets.realtime.owner.')
    ->middleware($routes->hubMiddleware())->group(static function (): void {
        Route::post('ready', [WorkbookRealtimeController::class, 'ready'])->name('ready');
        Route::post('{action}', [WorkbookRealtimeController::class, 'owner'])
            ->whereIn('action', ['acquire', 'renew', 'release', 'read', 'append'])->name('call');
    });
