<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Jobs;

use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
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
        $this->onConnection(config('vaulter-sheets.queue_connection', 'sheets-commands'));
        $this->onQueue('sheets-commands');
    }

    public function uniqueId(): string
    {
        return $this->record;
    }

    public function handle(SchemaHelpers $schema, WorkbookRecoveryContext $resolver, CommitWorkbookCommand $commit): void
    {
        $row = $schema->dbConnection()->table($schema->table('sheets_commands'))->where('id', $this->record)->where('state', 'running')->first();
        if ($row === null) {
            return;
        }
        $intent = StrictJson::decode($row->intent);
        $resolver->run((string) $row->tenant_id, $row->project_scope, $row->subject_type, (string) $row->subject_id, $intent->node_id,
            static function (DriveContext $context) use ($row, $intent, $commit): void {
                $actor = $context->actor->ref();
                if (($context->operation->tenant->id ?? '0') !== (string) $row->tenant_id
                    || $context->operation->scope->kind.':'.$context->operation->scope->id !== $row->project_scope
                    || $actor->type !== $row->subject_type || (string) ($actor->id ?? 0) !== (string) $row->subject_id) {
                    return;
                }
                $commit->execute($context, $intent->node_id, WorkbookCommand::fromWire($intent, $intent->if_match));
            });
    }
}
