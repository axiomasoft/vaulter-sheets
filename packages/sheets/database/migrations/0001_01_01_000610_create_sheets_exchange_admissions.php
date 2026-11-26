<?php

declare(strict_types=1);

use Illuminate\Container\Container;
use Illuminate\Database\Connection;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Schema\VaulterMigration;
use Vaulter\Sheets\Schema\SheetsSchema;

return new class extends VaulterMigration
{
    public function up(): void
    {
        Container::getInstance()->make(VaulterDatabase::class)->transaction(function (Connection $db): void {
            Container::getInstance()->make(SheetsSchema::class)->create('sheets_exchange_admissions');
            $grammar = $db->getQueryGrammar();
            $jobs = $grammar->wrapTable($this->table('sheets_exchange_jobs'));
            $index = $grammar->wrap($this->table('sheets_exchange_actor_active_idx'));
            $db->statement("CREATE INDEX {$index} ON {$jobs}
                (tenant_id, project_scope, subject_type, subject_id) WHERE state IN ('queued', 'running')");
        });
    }

    public function down(): void
    {
        Container::getInstance()->make(VaulterDatabase::class)->transaction(function (Connection $db): void {
            $index = $db->getQueryGrammar()->wrap($this->table('sheets_exchange_actor_active_idx'));
            $db->statement("DROP INDEX {$index}");
            Container::getInstance()->make(SheetsSchema::class)->drop('sheets_exchange_admissions');
        });
    }
};
