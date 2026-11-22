<?php

declare(strict_types=1);

use Illuminate\Container\Container;
use Vaulter\Schema\VaulterMigration;
use Vaulter\Sheets\Schema\SheetsSchema;

return new class extends VaulterMigration
{
    public function up(): void
    {
        Container::getInstance()->make(SheetsSchema::class)->create('sheets_projection_builds');
    }

    public function down(): void
    {
        Container::getInstance()->make(SheetsSchema::class)->drop('sheets_projection_builds');
    }
};
