<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Console;

use Illuminate\Console\Command;
use Illuminate\Database\Connection;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Jobs\RunWorkbookCommand;

final class RecoverWorkbookJobs extends Command
{
    protected $signature = 'vaulter-sheets:recover';

    protected $description = 'Reclaim interrupted workbook commands and expire old outcomes';

    public function handle(VaulterDatabase $database, SchemaHelpers $schema): int
    {
        $recovery = app()->bound(WorkbookRecoveryContext::class);
        $table = $schema->table('sheets_commands');
        $database->transaction(function (Connection $db) use ($database, $table, $recovery): void {
            $now = $db->raw($db->getDriverName() === 'pgsql' ? 'clock_timestamp()' : "strftime('%Y-%m-%d %H:%M:%f', 'now')");
            $ledger = $db->table($table);
            $expired = (clone $ledger)->whereIn('state', ['committed', 'rejected'])
                ->where('replay_until', '<=', $now)->orderBy('replay_until')->limit(100)->pluck('id');
            (clone $ledger)->whereIn('id', $expired)->whereIn('state', ['committed', 'rejected'])
                ->where('replay_until', '<=', $now)->update([
                    'state' => 'expired', 'intent' => null, 'evidence' => null, 'error_code' => null,
                ]);
            if ($recovery) {
                $ids = (clone $ledger)->where('state', 'running')->where(static fn ($q) => $q->whereNull('lease_until')->orWhere('lease_until', '<=', $now))
                    ->orderBy('created_at')->limit(100)->pluck('id');
                $database->afterCommit(static function () use ($ids): void {
                    foreach ($ids as $id) {
                        RunWorkbookCommand::dispatch($id);
                    }
                });
            }
        });
        return self::SUCCESS;
    }
}
