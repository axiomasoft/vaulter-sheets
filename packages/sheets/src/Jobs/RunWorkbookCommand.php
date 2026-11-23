<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Jobs;

use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use stdClass;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Actions\CommitWorkbookCommand;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Runtime\StrictJson;

final class RunWorkbookCommand implements ShouldBeUnique, ShouldQueue
{
    use Queueable;

    public int $timeout = 45;

    public int $uniqueFor = 60;

    public function __construct(public readonly string $record)
    {
        $connection = config('vaulter-sheets.queue_connection', 'sheets-commands');
        $this->onConnection(is_string($connection) ? $connection : 'sheets-commands');
        $this->onQueue('sheets-commands');
    }

    public function uniqueId(): string
    {
        return $this->record;
    }

    public function handle(SchemaHelpers $schema, WorkbookRecoveryContext $resolver, CommitWorkbookCommand $commit): void
    {
        $row = $schema->dbConnection()->table($schema->table('sheets_commands'))->where('id', $this->record)->where('state', 'running')->first();
        if (!$row instanceof stdClass || !is_string($row->intent ?? null)) {
            return;
        }
        $intent = StrictJson::decode($row->intent);
        if (!$intent instanceof stdClass) {
            return;
        }
        $tenantId = is_string($row->tenant_id ?? null) || is_int($row->tenant_id ?? null) ? (string) $row->tenant_id : '';
        $projectScope = is_string($row->project_scope ?? null) ? $row->project_scope : '';
        $subjectType = is_string($row->subject_type ?? null) ? $row->subject_type : '';
        $subjectId = is_string($row->subject_id ?? null) || is_int($row->subject_id ?? null) ? (string) $row->subject_id : '';
        $nodeId = is_string($intent->node_id ?? null) ? $intent->node_id : '';
        $ifMatch = is_string($intent->if_match ?? null) ? $intent->if_match : null;
        if ($nodeId === '') {
            return;
        }
        $resolver->run($tenantId, $projectScope, $subjectType, $subjectId, $nodeId,
            static function (DriveContext $context) use ($tenantId, $projectScope, $subjectType, $subjectId, $nodeId, $ifMatch, $intent, $commit): void {
                $actor = $context->actor->ref();
                $ctxTenant = $context->operation->tenant->id ?? '0';
                if ((string) $ctxTenant !== $tenantId
                    || $context->operation->scope->kind.':'.$context->operation->scope->id !== $projectScope
                    || $actor->type !== $subjectType || (string) ($actor->id ?? 0) !== $subjectId) {
                    return;
                }
                $commit->execute($context, $nodeId, WorkbookCommand::fromWire($intent, $ifMatch));
            });
    }
}
