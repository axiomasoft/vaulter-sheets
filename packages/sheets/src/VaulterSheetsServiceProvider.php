<?php

declare(strict_types=1);

namespace Vaulter\Sheets;

use Illuminate\Support\ServiceProvider;
use Override;
use Packman\Attributes\Api;
use Vaulter\Modules\OffersModules;

/**
 * Vaulter Sheets — registers the spreadsheet document type module with Vaulter's kernel.
 */
#[Api(since: '1.0')]
final class VaulterSheetsServiceProvider extends ServiceProvider
{
    use OffersModules;

    #[Override]
    public function register(): void
    {
        if ($this->moduleProviderRegistered()) {
            return;
        }

        $this->offerModule(SheetsModule::class);
    }

    public function boot(): void
    {
        if ($this->moduleProviderBooted()) {
            return;
        }

        $this->markModuleProviderBooted();
    }
}
