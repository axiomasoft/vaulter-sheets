<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Console;

use Illuminate\Console\Command;
use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Exchange\WorkbookExchange;
use Vaulter\Sheets\Jobs\RunWorkbookCommand;
use Vaulter\Sheets\Jobs\RunWorkbookExchange;

final class RecoverWorkbookJobs extends Command
{
    /** Owner of a command evidence pin. The reference key is the command row id. */
    public const string EVIDENCE_PIN_OWNER = 'sheets.command_evidence';

    protected $signature = 'vaulter-sheets:recover';

    protected $description = 'Reclaim interrupted workbook commands/exchange jobs and expire old outcomes';

    public function handle(VaulterDatabase $database, SchemaHelpers $schema, BlobPins $pins): int
    {
        $recovery = app()->bound(WorkbookRecoveryContext::class);
        $commandsTable = $schema->table('sheets_commands');
        $exchangeTable = $schema->table('sheets_exchange_jobs');

        $database->transaction(function (Connection $db) use ($database, $commandsTable, $exchangeTable, $recovery, $pins): void {
            $now = $db->raw($db->getDriverName() === 'pgsql' ? 'clock_timestamp()' : "strftime('%Y-%m-%d %H:%M:%f', 'now')");

            $ledger = $db->table($commandsTable);
            $expiredCommands = (clone $ledger)->whereIn('state', ['committed', 'rejected'])
                ->where('replay_until', '<=', $now)->orderBy('replay_until')->limit(100)
                ->lockForUpdate()->get(['id', 'evidence_blob_id']);
            if ($expiredCommands->isNotEmpty()) {
                foreach ($expiredCommands as $row) {
                    $commandId = self::str($row->id ?? null);
                    $blobId = self::str($row->evidence_blob_id ?? null);
                    if ($commandId !== '' && $blobId !== '') {
                        $pins->unpin($blobId, self::EVIDENCE_PIN_OWNER, $commandId);
                    }
                }
                (clone $ledger)->whereIn('id', $expiredCommands->pluck('id'))->whereIn('state', ['committed', 'rejected'])
                    ->where('replay_until', '<=', $now)->update([
                        'state' => 'expired', 'intent' => null, 'evidence' => null,
                        'evidence_blob_id' => null, 'error_code' => null,
                    ]);
            }

            $expiredExchangeRows = $db->table($exchangeTable)
                ->whereIn('state', ['succeeded', 'failed'])
                ->where('keep_until', '<=', $now)
                ->orderBy('keep_until')
                ->limit(100)
                ->lockForUpdate()
                ->get(['id', 'source_blob_id', 'output_blob_id']);

            if ($expiredExchangeRows->isNotEmpty()) {
                $deleteIds = [];
                foreach ($expiredExchangeRows as $row) {
                    $jobId = self::str($row->id ?? null);
                    $sourceBlobId = self::str($row->source_blob_id ?? null);
                    if ($jobId === '' || $sourceBlobId === '') {
                        continue;
                    }
                    $pins->unpin($sourceBlobId, WorkbookExchange::SOURCE_PIN_OWNER, $jobId);
                    $outputBlobId = self::str($row->output_blob_id ?? null);
                    if ($outputBlobId !== '') {
                        $pins->unpin($outputBlobId, WorkbookExchange::OUTPUT_PIN_OWNER, $jobId);
                    }
                    $deleteIds[] = $jobId;
                }
                if ($deleteIds !== []) {
                    $db->table($exchangeTable)->whereIn('id', $deleteIds)->delete();
                }
            }

            if ($recovery) {
                $commandIds = (clone $ledger)->where('state', 'running')
                    ->where(static function (Builder $q) use ($now): void {
                        $q->whereNull('lease_until')->orWhere('lease_until', '<=', $now);
                    })
                    ->orderBy('created_at')->limit(100)->pluck('id');

                $exchangeIds = $db->table($exchangeTable)
                    ->where(static function (Builder $q) use ($now): void {
                        $q->where('state', 'queued')
                            ->orWhere(static function (Builder $running) use ($now): void {
                                $running->where('state', 'running')
                                    ->where(static function (Builder $lease) use ($now): void {
                                        $lease->whereNull('lease_until')->orWhere('lease_until', '<=', $now);
                                    });
                            });
                    })
                    ->orderBy('created_at')
                    ->limit(100)
                    ->pluck('id');

                $database->afterCommit(static function () use ($commandIds, $exchangeIds): void {
                    foreach ($commandIds as $id) {
                        if (is_string($id)) {
                            dispatch(new RunWorkbookCommand($id));
                        }
                    }
                    foreach ($exchangeIds as $id) {
                        if (is_string($id)) {
                            dispatch(new RunWorkbookExchange($id));
                        }
                    }
                });
            }
        });

        return self::SUCCESS;
    }

    private static function str(mixed $value): string
    {
        return is_string($value) || is_int($value) ? (string) $value : '';
    }
}
