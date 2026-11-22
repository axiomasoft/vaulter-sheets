<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Actions;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\Contracts\AtomicDocumentMutation;
use Vaulter\Documents\Contracts\LockedDocumentMutation;
use Vaulter\Documents\Data\Documents\DocumentMutationState;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Content\WorkbookFormulaDependencies;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final readonly class CommitWorkbookCommand
{
    public function __construct(
        private AtomicDocumentMutation $mutations,
        private DocumentsManager $documents,
        private WorkbookRuntime $runtime,
        private WorkbookCodec $codec,
        private SchemaHelpers $schema,
        private \Vaulter\Drive\Operations\NodeEditAccess $access,
    ) {}

    public function execute(DriveContext $context, string $node, WorkbookCommand $command): array
    {
        if (!config('vaulter-sheets.commands', true)) {
            throw new WorkbookProblem('unsupported_content', 422);
        }
        $fingerprint = $command->fingerprint();
        $token = (string) Str::uuid();
        [$id, $outcome] = $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use ($context, $command, $fingerprint, $token, $node): array {
            $state = $locked->snapshot();
            $db = $locked->connection();
            $scope = $this->scope($context, $state->documentId, $command->id);
            $previous = $this->records($db)->where($scope)->lockForUpdate()->first();
            if ($previous !== null) {
                if (!hash_equals($previous->fingerprint, $fingerprint)) {
                    throw new WorkbookProblem('idempotency_conflict', 409);
                }
                if ($previous->state !== 'running') {
                    return [$previous->id, $this->outcome($previous, $db)];
                }
                if ($previous->lease_until !== null && $this->future($db, $previous->lease_until)) {
                    return [$previous->id, $this->outcome($previous, $db)];
                }
                $this->records($db)->where('id', $previous->id)->update([
                    'worker_token' => $token,
                    'lease_until' => $this->deadline($db, (int) config('vaulter-sheets.lease_seconds', 60)),
                ]);
                return [$previous->id, null];
            }
            $this->assertWritable($state);
            $id = (string) Str::uuid7();
            $this->records($db)->insert($scope + [
                'id' => $id, 'fingerprint' => $fingerprint, 'generation' => $command->generation,
                'base_position' => $state->position, 'state' => 'running',
                'intent' => CanonicalJson::encode((object) [
                    'node_id' => $node, 'command_id' => $command->id,
                    'policy' => $command->policy, 'expected_generation' => $command->generation,
                    'if_match' => $command->ifMatch, 'commands' => $command->commands,
                ]),
                'worker_token' => $token,
                'lease_until' => $this->deadline($db, (int) config('vaulter-sheets.lease_seconds', 60)),
                'replay_until' => $this->deadline($db, (int) config('vaulter-sheets.replay_seconds', 86_400)),
            ]);
            return [$id, null];
        });
        if ($outcome !== null) {
            return $outcome;
        }
        $receipt = (string) Str::uuid7();
        $dependencies = null;
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $base = $this->documents->forContext($context)->content($node);
            $baseMarker = new WorkbookMarker($base->epoch, $base->stateVersion, $base->content->contentHash());
            try {
                $this->assertBase($base->documentId, $node, $baseMarker, $command);
                $workbook = $this->codec->snapshot($base->content);
                if ($command->policy === 'revalidate_by_id') {
                    $digest = WorkbookFormulaDependencies::digest($workbook, $command->commands);
                    if ($dependencies !== null && !hash_equals($dependencies, $digest)) {
                        throw new WorkbookProblem('version_conflict', 409, ['reason' => 'formula_dependencies_changed']);
                    }
                    $dependencies = $digest;
                }
                [$commands, $bindings] = $this->allocateRowIds($workbook, $command, $id);
                $response = $this->runtime->exchange((object) [
                    'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'apply',
                    'base' => (object) get_object_vars($baseMarker), 'profile_id' => WorkbookCodec::PROFILE,
                    'workbook' => $workbook, 'commands' => $commands,
                ]);
                $candidate = $this->verifyCandidate($response, $workbook, $baseMarker, $bindings);
                $prepared = $response->changed_ranges === [] ? $base->content : $this->codec->prepare($candidate, $context);
            } catch (WorkbookProblem|InvalidDocumentContentException $error) {
                $problem = $error instanceof WorkbookProblem ? $error : new WorkbookProblem('runtime_failed', 503);
                if ($problem->status >= 500) {
                    $this->release($context, $node, $id, $token);
                    throw $problem;
                }
                $result = $this->finalize($context, $node, $id, $token, $baseMarker, $problem, null, null, $receipt, []);
                if ($result !== null) {
                    return $result;
                }
                continue;
            }
            $structural = array_values(array_unique(array_map(
                static fn (stdClass $item): string => $item->sheet_id,
                array_filter($command->commands, static fn (stdClass $item): bool => $item->kind === 'insert_row_before'),
            )));
            $result = $this->finalize($context, $node, $id, $token, $baseMarker, null, $prepared, $response, $receipt, $structural);
            if ($result !== null) {
                return $result;
            }
        }
        $this->release($context, $node, $id, $token);
        throw new WorkbookProblem('contention', 503);
    }

    public function status(DriveContext $context, string $node, string $command): array
    {
        $snapshot = $this->documents->forContext($context)->content($node);
        if (!$this->access->canEdit($context, $node) || $snapshot->type !== SpreadsheetDocumentType::KEY) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $db = $this->schema->dbConnection();
        $row = $this->records($db)->where($this->scope($context, $snapshot->documentId, $command))->first();
        if ($row === null) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        return $this->outcome($row, $db);
    }

    private function finalize(
        DriveContext $context,
        string $node,
        string $id,
        string $token,
        WorkbookMarker $base,
        ?WorkbookProblem $problem,
        ?\Vaulter\Documents\Contracts\DocumentContent $content,
        ?stdClass $response,
        string $receipt,
        array $structural,
    ): ?array {
        return $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use ($id, $token, $base, $problem, $content, $response, $receipt, $structural): ?array {
            $state = $locked->snapshot();
            $db = $locked->connection();
            $row = $this->records($db)->where('id', $id)->lockForUpdate()->first();
            if ($row === null) {
                throw new WorkbookProblem('resource_unavailable', 404);
            }
            if ($row->state !== 'running' || $row->worker_token !== $token || !$this->future($db, $row->lease_until)) {
                return $this->outcome($row, $db);
            }
            if ($state->generation !== $base->generation || $state->position !== $base->position
                || !hash_equals($state->content->contentHash(), $base->sha256)) {
                return null;
            }
            $this->assertWritable($state);
            $next = $problem === null ? $locked->replace($content, $state->position) : $state;
            $marker = new WorkbookMarker($next->generation, $next->position, $next->content->contentHash());
            $outcome = $problem === null ? [
                'state' => 'committed', 'command_id' => $row->command_id, 'receipt_id' => $receipt,
                'marker' => $marker, 'etag' => $marker->etag($state->nodeId), 'structural_sheets' => $structural,
                'changed_ranges' => $response->changed_ranges, 'checks' => $response->checks,
            ] : [
                'state' => 'rejected', 'command_id' => $row->command_id,
                'error' => ['code' => $problem->problem, 'status' => $problem->status, 'detail' => $problem->detail],
            ];
            $updates = [
                'state' => $outcome['state'], 'worker_token' => null, 'lease_until' => null,
                'finished_at' => $this->deadline($db, 0),
                'replay_until' => $this->deadline($db, (int) config('vaulter-sheets.replay_seconds', 86_400)),
            ];
            if ($problem === null) {
                $updates += [
                    'receipt_id' => $receipt, 'committed_position' => $next->position,
                    'evidence' => json_encode($outcome, JSON_THROW_ON_ERROR),
                    'evidence_until' => $this->deadline($db, (int) config('vaulter-sheets.evidence_seconds', 86_400)),
                ];
            } else {
                $intent = StrictJson::decode($row->intent);
                $intent->rejection = (object) $outcome['error'];
                $updates += ['error_code' => $problem->problem, 'intent' => json_encode($intent, JSON_THROW_ON_ERROR)];
            }
            $updated = $this->records($db)->where('id', $id)->where('state', 'running')
                ->where('worker_token', $token)->where('lease_until', '>', $this->deadline($db, 0))->update($updates);
            if ($updated !== 1) {
                throw new WorkbookProblem('lease_lost', 503);
            }
            return $outcome;
        });
    }

    private function release(DriveContext $context, string $node, string $id, string $token): void
    {
        $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use ($id, $token): void {
            $this->records($locked->connection())->where('id', $id)->where('state', 'running')
                ->where('worker_token', $token)->update(['worker_token' => null, 'lease_until' => null]);
        });
    }

    private function assertWritable(DocumentMutationState $state): void
    {
        if ($state->type !== SpreadsheetDocumentType::KEY) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if ($state->writeMode !== 'snapshot' || $state->protocol !== null || $state->pending || !$state->content instanceof WorkbookContent) {
            throw new WorkbookProblem('unsupported_content', 422);
        }
    }

    private function assertBase(string $document, string $node, WorkbookMarker $marker, WorkbookCommand $command): void
    {
        if ($command->generation !== $marker->generation) {
            throw new WorkbookProblem('generation_changed', 409);
        }
        if ($command->policy === 'revalidate_by_id' || $command->ifMatch === $marker->etag($node)) {
            return;
        }
        if ($command->policy !== 'rebase_cells'
            || preg_match('/^"'.preg_quote($node, '/').'\.'.preg_quote((string) $marker->generation, '/').'\.(0|[1-9][0-9]*)"$/D', $command->ifMatch ?? '', $tag) !== 1) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $position = (int) $tag[1];
        if ($position >= $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $sheets = array_column($command->commands, 'sheet_id');
        $db = $this->schema->dbConnection();
        $cursor = $position;
        $receipts = $this->records($db)->where('document_id', $document)->where('generation', $marker->generation)
            ->where('committed_position', '>', $position)->where('committed_position', '<=', $marker->position)
            ->where('state', 'committed')->orderBy('committed_position')->cursor();
        foreach ($receipts as $row) {
            $receiptPosition = (int) $row->committed_position;
            $evidence = $row->evidence === null ? null : StrictJson::decode($row->evidence);
            if ($receiptPosition > $cursor + 1 || $evidence === null
                || array_intersect($evidence->structural_sheets, $sheets) !== []) {
                throw new WorkbookProblem('version_conflict', 409, ['structural_receipts' => [$row->receipt_id]]);
            }
            $cursor = $receiptPosition;
        }
        if ($cursor !== $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }
    }

    private function verifyCandidate(stdClass $response, stdClass $base, WorkbookMarker $marker, array $bindings): WorkbookContent
    {
        $candidate = $response->workbook ?? null;
        if (!$candidate instanceof stdClass || !($candidate->native ?? null) instanceof stdClass
            || !is_array($candidate->native->resources ?? null) || ($response->base_sha256 ?? null) !== $marker->sha256
            || ($response->calculation->state ?? null) !== 'ready'
            || CanonicalJson::encode($candidate->profile ?? null) !== CanonicalJson::encode($base->profile)
            || ($candidate->native->id ?? null) !== $base->native->id
            || ($candidate->native->sheetOrder ?? null) !== $base->native->sheetOrder
            || CanonicalJson::encode($candidate->tables ?? null) !== CanonicalJson::encode($bindings)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $currentResources = array_column($base->native->resources, 'name');
        $candidateResources = array_column($candidate->native->resources ?? [], 'name');
        if (array_diff($currentResources, $candidateResources) !== []) {
            throw new WorkbookProblem('unsupported_content', 422, ['reason' => 'resource_lost']);
        }
        $digest = CanonicalJson::sha256($candidate);
        if (($response->candidate_sha256 ?? null) !== $digest || ($response->calculation->source_sha256 ?? null) !== $digest) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $content = $this->codec->decode((array) $candidate, 2);
        if ($content->sizeInBytes() > $this->codec->maxSizeBytes()) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        if ($content->contentHash() !== $digest) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        return $content;
    }

    private function allocateRowIds(stdClass $workbook, WorkbookCommand $command, string $id): array
    {
        $commands = [];
        $tables = StrictJson::decode(CanonicalJson::encode($workbook->tables));
        foreach ($command->commands as $index => $source) {
            $item = clone $source;
            if ($item->kind === 'insert_row_before' && is_int($item->row ?? null) && is_int($item->count ?? null)
                && $item->count > 0 && $item->count <= 10_000) {
                $assigned = new stdClass;
                foreach ($tables as $table) {
                    if ($table->sheet_id !== $item->sheet_id) {
                        continue;
                    }
                    if ($item->row > $table->header_row && $item->row <= max([$table->header_row, ...array_column($table->rows, 'row')])) {
                        $assigned->{$table->table_id} = [];
                        for ($offset = 0; $offset < $item->count; $offset++) {
                            $assigned->{$table->table_id}[] = 'row_'.hash('sha256', $id.':'.$index.':'.$table->table_id.':'.$offset);
                        }
                    }
                    if ($table->header_row >= $item->row) {
                        $table->header_row += $item->count;
                    }
                    foreach ($table->rows as $binding) {
                        if ($binding->row >= $item->row) {
                            $binding->row += $item->count;
                        }
                    }
                    foreach ($assigned->{$table->table_id} ?? [] as $offset => $rowId) {
                        $table->rows[] = (object) ['row_id' => $rowId, 'row' => $item->row + $offset];
                    }
                }
                $item->new_row_ids = $assigned;
            }
            $commands[] = $item;
        }
        usort($tables, static fn (stdClass $left, stdClass $right): int => strcmp(
            mb_convert_encoding($left->table_id, 'UTF-16BE', 'UTF-8'),
            mb_convert_encoding($right->table_id, 'UTF-16BE', 'UTF-8'),
        ));
        foreach ($tables as $table) {
            usort($table->columns, static fn (stdClass $left, stdClass $right): int => $left->column <=> $right->column);
            usort($table->rows, static fn (stdClass $left, stdClass $right): int => $left->row <=> $right->row);
        }
        return [$commands, $tables];
    }

    private function scope(DriveContext $context, string $document, string $command): array
    {
        $actor = $context->actor->ref();
        return [
            'tenant_id' => $context->operation->tenant->id ?? 0,
            'project_scope' => $context->operation->scope->kind.':'.$context->operation->scope->id,
            'subject_type' => $actor->type,
            'subject_id' => $actor->id ?? 0,
            'document_id' => $document, 'command_id' => $command,
        ];
    }

    private function outcome(stdClass $row, Connection $db): array
    {
        if ($row->state === 'expired' || ($row->state !== 'running' && !$this->future($db, $row->replay_until))) {
            throw new WorkbookProblem('idempotency_window_expired', 410);
        }
        return match ($row->state) {
            'committed' => $this->receipt($row, $db),
            'rejected' => ['state' => 'rejected', 'command_id' => $row->command_id, 'error' => json_decode($row->intent, true, 256, JSON_THROW_ON_ERROR)['rejection']],
            default => ['state' => 'running', 'command_id' => $row->command_id],
        };
    }

    private function receipt(stdClass $row, Connection $db): array
    {
        $receipt = json_decode($row->evidence, true, 256, JSON_THROW_ON_ERROR);
        if (!$this->future($db, $row->evidence_until)) {
            unset($receipt['checks']);
        }

        return $receipt;
    }

    private function records(Connection $db): Builder
    {
        return $db->table($this->schema->table('sheets_commands'));
    }

    private function deadline(Connection $db, int $seconds): \Illuminate\Database\Query\Expression
    {
        return $db->raw($db->getDriverName() === 'pgsql'
            ? "clock_timestamp() + interval '{$seconds} seconds'"
            : "strftime('%Y-%m-%d %H:%M:%f', 'now', '{$seconds} seconds')");
    }

    private function future(Connection $db, ?string $time): bool
    {
        if ($time === null) {
            return false;
        }
        $now = $this->deadline($db, 0)->getValue($db->getQueryGrammar());
        $cast = $db->getDriverName() === 'pgsql' ? 'CAST(? AS timestamptz)' : '?';
        return (int) $db->selectOne("SELECT CASE WHEN {$cast} > {$now} THEN 1 ELSE 0 END AS future", [$time])->future === 1;
    }
}
