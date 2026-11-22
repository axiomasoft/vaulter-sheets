<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Tests;

use Illuminate\Foundation\Application;
use Orchestra\Testbench\TestCase as OrchestraTestCase;
use Vaulter\Documents\VaulterDocumentsServiceProvider;
use Vaulter\Drive\VaulterDriveServiceProvider;
use Vaulter\Media\VaulterMediaServiceProvider;
use Vaulter\Testing\Concerns\RefreshesDatabaseForSchemaVariant;
use Vaulter\Testing\Concerns\UsesSuiteDatabase;
use Vaulter\VaulterServiceProvider;

/**
 * Host without VaulterSheetsServiceProvider — verifies that `vaulter/spreadsheet`
 * is unknown when the private package is not installed.
 */
abstract class WithoutSheetsTestCase extends OrchestraTestCase
{
    use RefreshesDatabaseForSchemaVariant;
    use UsesSuiteDatabase;

    /**
     * @param  Application              $app
     * @return array<int, class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [
            VaulterServiceProvider::class,
            VaulterDriveServiceProvider::class,
            VaulterMediaServiceProvider::class,
            VaulterDocumentsServiceProvider::class,
        ];
    }

    /**
     * @param Application $app
     */
    protected function defineEnvironment($app): void
    {
        $this->pinSuiteConnection($app);
        $this->pinOpenSuite($app);
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
        $app['config']->set('vaulter-drive.access.permission_driver', 'null');
        $types = array_values(array_filter(
            (array) $app['config']->get('vaulter-documents.types', []),
            static fn (mixed $class): bool => $class !== 'Vaulter\\Documents\\Types\\SpreadsheetDocumentType',
        ));
        $app['config']->set('vaulter-documents.types', $types);
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->migrateSuiteDatabase();
    }
}
