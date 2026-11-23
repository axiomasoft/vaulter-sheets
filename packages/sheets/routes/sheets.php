<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Vaulter\Configuration\RoutesOptions;
use Vaulter\Sheets\Http\WorkbookController;
use Vaulter\Sheets\Http\WorkbookExchangeController;

$prefix = config('vaulter-sheets.prefix', 'api/vaulter-sheets/v1');

Route::prefix(is_string($prefix) ? $prefix : 'api/vaulter-sheets/v1')
    ->name('vaulter.sheets.v1.')
    ->middleware(app(RoutesOptions::class)->authenticatedMiddleware())
    ->where([
        'node' => '[A-Za-z0-9_-]+',
        'command' => '[A-Za-z0-9._-]+',
        'exchange' => '[0-9a-fA-F-]+',
    ])
    ->group(static function (): void {
        Route::get('workbooks/{node}', [WorkbookController::class, 'show'])->name('show');
        Route::post('workbooks/{node}/commands', [WorkbookController::class, 'commit'])->name('commit');
        Route::get('workbooks/{node}/commands/{command}', [WorkbookController::class, 'status'])->name('status');
        Route::get('workbooks/{node}/ranges', [WorkbookController::class, 'ranges'])->name('ranges');
        Route::post('workbooks/{node}/exchanges', [WorkbookExchangeController::class, 'register'])->name('exchanges.register');
        Route::get('workbooks/{node}/exchanges/{exchange}', [WorkbookExchangeController::class, 'status'])->name('exchanges.status');
        Route::get('workbooks/{node}/exchanges/{exchange}/download', [WorkbookExchangeController::class, 'download'])->name('exchanges.download');
    });
