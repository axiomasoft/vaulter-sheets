<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Actions;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\Contracts\AtomicDocumentMutation;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\LockedDocumentMutation;
use Vaulter\Documents\Data\Documents\DocumentMutationState;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Content\WorkbookFormulaDependencies;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Support\StrongEtag;
use Vaulter\Sheets\Support\WorkbookClock;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final readonly class CommitWorkbookCommand
{
    public function __construct(
        private AtomicDocumentMutation $mutations,
        private DocumentsManager $documents,
        private WorkbookCommandCandidate $candidate,
        private WorkbookCodec $codec,
        private SchemaHelpers $schema,
        private NodeEditAccess $access,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function execute(DriveContext $context, string $node, WorkbookCommand $command): array
    {
        if (!config()->boolean('vaulter-sheets.commands', true)) {
            throw new WorkbookProblem('unsupported_content', 422);
        }
        $fingerprint = $command->fingerprint();
        $token = (string) Str::uuid();
        $leaseSeconds = $this->intConfig('vaulter-sheets.lease_seconds', 60);
        $replaySeconds = $this->intConfig('vaulter-sheets.replay_seconds', 86_400);

        /** @var array{0: string, 1: array<string, mixed>|null} $claimResult */
        $claimResult = $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use ($context, $command, $fingerprint, $token, $node, $leaseSeconds, $replaySeconds): array {
            $state = $locked->snapshot();
            $db = $locked->connection();
            $scope = $this->scope($context, $state->documentId, $command->id);
            $previous = $this->records($db)->where($scope)->lockForUpdate()->first();
            if ($previous instanceof stdClass) {
                $prevFingerprint = is_string($previous->fingerprint ?? null) ? $previous->fingerprint : '';
                if (!hash_equals($prevFingerprint, $fingerprint)) {
                    throw new WorkbookProblem('idempotency_conflict', 409);
                }
                $prevId = self::str($previous->id ?? null);
                $prevLease = is_string($previous->lease_until ?? null) ? $previous->lease_until : null;
                if (($previous->state ?? null) !== 'running') {
                    return [$prevId, $this->outcome($previous, $db)];
                }
                if ($prevLease !== null && WorkbookClock::future($db, $prevLease)) {
                    return [$prevId, $this->outcome($previous, $db)];
                }
                $this->records($db)->where('id', $prevId)->update([
                    'worker_token' => $token,
                    'lease_until' => WorkbookClock::futureTimestamp($db, $leaseSeconds),
                ]);

                return [$prevId, null];
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
                'lease_until' => WorkbookClock::futureTimestamp($db, $leaseSeconds),
                'replay_until' => WorkbookClock::futureTimestamp($db, $replaySeconds),
            ]);

            return [$id, null];
        });
        [$id, $outcome] = $claimResult;
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
                [$prepared, , $response] = $this->candidate->apply($context, $base->content, $workbook, $baseMarker, $command, $id);
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
            $structural = [];
            foreach ($command->commands as $item) {
                if (in_array($item->kind ?? null, [
                    'insert_row_before', 'delete_row', 'insert_column_before', 'delete_column',
                    'add_sheet', 'rename_sheet', 'delete_sheet',
                ], true) && is_string($item->sheet_id ?? null)) {
                    $structural[] = $item->sheet_id;
                }
            }
            $structural = array_values(array_unique($structural));
            $result = $this->finalize($context, $node, $id, $token, $baseMarker, null, $prepared, $response, $receipt, $structural);
            if ($result !== null) {
                return $result;
            }
        }
        $this->release($context, $node, $id, $token);
        throw new WorkbookProblem('contention', 503);
    }

    /**
     * @return array<string, mixed>
     */
    public function status(DriveContext $context, string $node, string $command): array
    {
        $snapshot = $this->documents->forContext($context)->content($node);
        if (!$this->access->canEdit($context, $node) || $snapshot->type !== SpreadsheetDocumentType::KEY) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $db = $this->schema->dbConnection();
        $row = $this->records($db)->where($this->scope($context, $snapshot->documentId, $command))->first();
        if (!$row instanceof stdClass) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }

        return $this->outcome($row, $db);
    }

    /**
     * @param  list<string>              $structural
     * @return array<string, mixed>|null
     */
    private function finalize(
        DriveContext $context,
        string $node,
        string $id,
        string $token,
        WorkbookMarker $base,
        ?WorkbookProblem $problem,
        ?DocumentContent $content,
        ?stdClass $response,
        string $receipt,
        array $structural,
    ): ?array {
        $replaySeconds = $this->intConfig('vaulter-sheets.replay_seconds', 86_400);
        $evidenceSeconds = $this->intConfig('vaulter-sheets.evidence_seconds', 86_400);

        /** @var array<string, mixed>|null $finalized */
        $finalized = $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use ($id, $token, $base, $problem, $content, $response, $receipt, $structural, $replaySeconds, $evidenceSeconds): ?array {
            $state = $locked->snapshot();
            $db = $locked->connection();
            $row = $this->records($db)->where('id', $id)->lockForUpdate()->first();
            if (!$row instanceof stdClass) {
                throw new WorkbookProblem('resource_unavailable', 404);
            }
            $rowLease = is_string($row->lease_until ?? null) ? $row->lease_until : null;
            if (($row->state ?? null) !== 'running' || ($row->worker_token ?? null) !== $token || !WorkbookClock::future($db, $rowLease)) {
                return $this->outcome($row, $db);
            }
            if ($state->generation !== $base->generation || $state->position !== $base->position
                || !hash_equals($state->content->contentHash(), $base->sha256)) {
                return null;
            }
            $this->assertWritable($state);
            if ($problem === null) {
                if (!$content instanceof DocumentContent || !$response instanceof stdClass) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                $next = $locked->replace($content, $state->position);
            } else {
                $next = $state;
            }
            $marker = new WorkbookMarker($next->generation, $next->position, $next->content->contentHash());
            $commandId = self::str($row->command_id ?? null);
            $errorPayload = $problem === null ? null : ['code' => $problem->problem, 'status' => $problem->status, 'detail' => $problem->detail];
            $outcome = $errorPayload === null ? [
                'state' => 'committed', 'command_id' => $commandId, 'receipt_id' => $receipt,
                'marker' => $marker, 'etag' => $marker->etag($state->nodeId), 'structural_sheets' => $structural,
                'changed_ranges' => $response->changed_ranges ?? [], 'checks' => $response->checks ?? new stdClass,
            ] : [
                'state' => 'rejected', 'command_id' => $commandId,
                'error' => $errorPayload,
            ];
            $now = WorkbookClock::nowExpr($db);
            $updates = [
                'state' => $outcome['state'], 'worker_token' => null, 'lease_until' => null,
                'finished_at' => $now,
                'replay_until' => WorkbookClock::futureTimestamp($db, $replaySeconds),
            ];
            if ($errorPayload === null) {
                $updates += [
                    'receipt_id' => $receipt, 'committed_position' => $next->position,
                    'evidence' => json_encode($outcome, JSON_THROW_ON_ERROR),
                    'evidence_until' => WorkbookClock::futureTimestamp($db, $evidenceSeconds),
                ];
            } else {
                $intent = StrictJson::decode(self::str($row->intent ?? ''));
                if (!$intent instanceof stdClass) {
                    $intent = new stdClass;
                }
                $intent->rejection = (object) $errorPayload;
                $updates += ['error_code' => $errorPayload['code'], 'intent' => json_encode($intent, JSON_THROW_ON_ERROR)];
            }
            $updated = $this->records($db)->where('id', $id)->where('state', 'running')
                ->where('worker_token', $token)->where('lease_until', '>', $now)->update($updates);
            if ($updated !== 1) {
                throw new WorkbookProblem('lease_lost', 503);
            }

            return $outcome;
        });

        return $finalized;
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
        if ($command->policy !== 'rebase_cells') {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $position = StrongEtag::parsePosition($command->ifMatch, $node, $marker->generation);
        if ($position === null || $position >= $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $sheets = [];
        foreach ($command->commands as $item) {
            if (is_string($item->sheet_id ?? null)) {
                $sheets[] = $item->sheet_id;
            }
        }
        $db = $this->schema->dbConnection();
        $cursor = $position;
        $receipts = $this->records($db)->where('document_id', $document)->where('generation', $marker->generation)
            ->where('committed_position', '>', $position)->where('committed_position', '<=', $marker->position)
            ->where('state', 'committed')->orderBy('committed_position')->cursor();
        foreach ($receipts as $row) {
            $receiptPosition = self::intVal($row->committed_position ?? null);
            $evidence = is_string($row->evidence ?? null) ? StrictJson::decode($row->evidence) : null;
            $structuralRaw = $evidence instanceof stdClass ? ($evidence->structural_sheets ?? null) : null;
            $structuralList = [];
            if (is_array($structuralRaw)) {
                foreach ($structuralRaw as $sheetName) {
                    if (is_string($sheetName)) {
                        $structuralList[] = $sheetName;
                    }
                }
            }
            if ($receiptPosition > $cursor + 1 || !$evidence instanceof stdClass || !is_array($structuralRaw)
                || array_intersect($structuralList, $sheets) !== []) {
                throw new WorkbookProblem('version_conflict', 409, ['structural_receipts' => [$row->receipt_id ?? '']]);
            }
            $cursor = $receiptPosition;
        }
        if ($cursor !== $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }
    }

    /**
     * @return array{tenant_id: int|string, project_scope: string, subject_type: string, subject_id: int|string, document_id: string, command_id: string}
     */
    private function scope(DriveContext $context, string $document, string $command): array
    {
        $actor = $context->actor->ref();

        return [
            'tenant_id' => $context->operation->tenant->id ?? 0,
            'project_scope' => $context->operation->scope->kind.':'.$context->operation->scope->id,
            'subject_type' => $actor->type ?? 'user',
            'subject_id' => $actor->id ?? 0,
            'document_id' => $document, 'command_id' => $command,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function outcome(stdClass $row, Connection $db): array
    {
        $replayUntil = is_string($row->replay_until ?? null) ? $row->replay_until : null;
        if (($row->state ?? null) === 'expired' || (($row->state ?? null) !== 'running' && !WorkbookClock::future($db, $replayUntil))) {
            throw new WorkbookProblem('idempotency_window_expired', 410);
        }
        $commandId = self::str($row->command_id ?? null);

        return match ($row->state ?? null) {
            'committed' => $this->receipt($row, $db),
            'rejected' => $this->rejectedOutcome($row, $commandId),
            default => ['state' => 'running', 'command_id' => $commandId],
        };
    }

    /**
     * @return array{state: string, command_id: string, error: mixed}
     */
    private function rejectedOutcome(stdClass $row, string $commandId): array
    {
        $decoded = is_string($row->intent ?? null) ? json_decode($row->intent, true, 256, JSON_THROW_ON_ERROR) : [];
        $rejection = is_array($decoded) ? ($decoded['rejection'] ?? null) : null;

        return ['state' => 'rejected', 'command_id' => $commandId, 'error' => $rejection];
    }

    /**
     * @return array<string, mixed>
     */
    private function receipt(stdClass $row, Connection $db): array
    {
        $decoded = is_string($row->evidence ?? null) ? json_decode($row->evidence, true, 256, JSON_THROW_ON_ERROR) : [];
        /** @var array<string, mixed> $receipt */
        $receipt = is_array($decoded) ? $decoded : [];
        $evidenceUntil = is_string($row->evidence_until ?? null) ? $row->evidence_until : null;
        if (!WorkbookClock::future($db, $evidenceUntil)) {
            unset($receipt['checks']);
        }

        return $receipt;
    }

    private function records(Connection $db): Builder
    {
        return $db->table($this->schema->table('sheets_commands'));
    }

    private function intConfig(string $key, int $default): int
    {
        $value = config($key, $default);

        return is_int($value) && $value > 0 ? $value : $default;
    }

    private static function str(mixed $value): string
    {
        return is_string($value) || is_int($value) ? (string) $value : '';
    }

    private static function intVal(mixed $value): int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && is_numeric($value)) {
            return (int) $value;
        }

        return 0;
    }
}
