<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Jobs;

use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use stdClass;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Exchange\WorkbookExchange;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

final class RunWorkbookExchange implements ShouldBeUnique, ShouldQueue
{
    use Queueable;

    public int $timeout = 60;

    public int $uniqueFor = 60;

    public function __construct(public readonly string $record)
    {
        $connection = config('vaulter-sheets.exchange.queue_connection', 'sheets-exchange');
        $this->onConnection(is_string($connection) && $connection !== '' ? $connection : 'sheets-exchange');
        $this->onQueue('sheets-exchange');
    }

    public function uniqueId(): string
    {
        return $this->record;
    }

    public function handle(SchemaHelpers $schema, WorkbookRecoveryContext $resolver, WorkbookExchange $exchange): void
    {
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iD', $this->record) !== 1) {
            return;
        }
        $row = $schema->dbConnection()
            ->table($schema->table('sheets_exchange_jobs'))
            ->where('id', $this->record)
            ->whereIn('state', ['queued', 'running'])
            ->first();
        if (!$row instanceof stdClass || !is_string($row->options ?? null)) {
            return;
        }
        try {
            $options = StrictJson::decode($row->options);
        } catch (WireException) {
            return;
        }
        $node = $options instanceof stdClass ? ($options->_node_id ?? null) : null;
        if (!is_string($node) || $node === '') {
            return;
        }

        $jobId = self::str($row->id ?? null);
        $tenantId = self::str($row->tenant_id ?? null);
        $projectScope = self::str($row->project_scope ?? null);
        $subjectType = self::str($row->subject_type ?? null);
        $subjectId = self::str($row->subject_id ?? null);
        if ($jobId === '' || $tenantId === '' || $projectScope === '' || $subjectType === '' || $subjectId === '') {
            return;
        }

        $resolver->run(
            $tenantId,
            $projectScope,
            $subjectType,
            $subjectId,
            $node,
            static function (DriveContext $context) use ($jobId, $tenantId, $projectScope, $subjectType, $subjectId, $exchange): void {
                $actor = $context->actor->ref();
                if (($context->operation->tenant->id ?? '0') !== $tenantId
                    || $context->operation->scope->kind.':'.$context->operation->scope->id !== $projectScope
                    || ($actor->type ?? '') !== $subjectType
                    || (string) ($actor->id ?? 0) !== $subjectId) {
                    return;
                }
                $exchange->process($jobId, $context);
            },
        );
    }

    private static function str(mixed $value): string
    {
        return is_string($value) || is_int($value) ? (string) $value : '';
    }
}
