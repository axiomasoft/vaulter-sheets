<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use Packman\Attributes\Internal;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use stdClass;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\Persistence\NativeJournal;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Collaboration\Persistence\UpdateEnvelope;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\State\CheckpointPublication;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Actions\WorkbookCommandCandidate;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;

/** Owner port for a typed Sheets intent, shared by browser writes and in-process callers. */
#[Spi(SpiKind::Call)]
final readonly class AppendWorkbookMutation
{
    #[Internal]
    public function __construct(
        private VaulterDatabase $database,
        private CollaborativeState $state,
        private NativeJournal $journal,
        private WorkbookRoomSession $rooms,
        private WorkbookCodec $codec,
        private WorkbookCommandCandidate $candidate,
        private SchemaHelpers $schema,
        private NodeEditAccess $access,
    ) {}

    /** @return array<string, mixed> */
    public function execute(DriveContext $context, string $node, string $owner, int $fence, int $base, WorkbookCommand $command, ?CollaborationCall $call = null): array
    {
        if (!config('vaulter-sheets.commands', true)) {
            throw new WorkbookProblem('room_unavailable', 503);
        }
        $id = (string) Str::uuid7();
        $prepared = $this->database->transaction(function (Connection $db) use ($context, $node, $owner, $fence, $base, $command, $call, $id): array {
            $document = $this->lockWritable($context, $node, $call);
            $this->assertGeneration($document, $command);
            $head = $this->journal->assertOwner($document, $owner, $fence);
            $scope = $this->scope($context, $document, $command);
            $replay = $this->receipt($db, $scope, $command);
            if ($replay !== null) {
                return ['replay' => $replay];
            }
            if ($base !== $head) {
                throw new RoomWriteConflict('base_moved');
            }
            $content = $this->codec->decodeStored($document->content, $document->schemaVersion);
            $marker = new WorkbookMarker($document->generation, $document->stateVersion, $content->contentHash());
            try {
                $effective = $this->rebase($db, $document, $command, $marker);
            } catch (WorkbookProblem $problem) {
                $this->reject($db, $scope, $id, $command, $marker, $problem);

                return ['rejection' => $problem];
            }

            return ['content' => $content, 'marker' => $marker, 'command' => $effective];
        });
        if (isset($prepared['replay'])) {
            return $prepared['replay'];
        }
        if (isset($prepared['rejection'])) {
            throw $prepared['rejection'];
        }
        $marker = $prepared['marker'];
        $effective = $prepared['command'];
        $receiptId = (string) Str::uuid7();
        $workbook = $this->codec->snapshot($prepared['content']);
        try {
            [$projection, $native, $runtime] = $this->candidate->apply($context, $prepared['content'], $workbook, $marker, $effective, $id);
        } catch (WorkbookProblem $problem) {
            if ($problem->status >= 500) {
                throw $problem;
            }
            $replay = $this->database->transaction(function (Connection $db) use ($context, $node, $owner, $fence, $base, $command, $call, $id, $marker, $problem): ?array {
                $document = $this->lockWritable($context, $node, $call);
                $this->assertGeneration($document, $command);
                $head = $this->journal->assertOwner($document, $owner, $fence);
                $scope = $this->scope($context, $document, $command);
                $replay = $this->receipt($db, $scope, $command);
                if ($replay !== null) {
                    return $replay;
                }
                if ($head !== $base || $document->stateVersion !== $marker->position) {
                    throw new RoomWriteConflict('base_moved');
                }
                $this->reject($db, $scope, $id, $command, $marker, $problem);

                return null;
            });

            return $replay ?? throw $problem;
        }
        $snapshot = $native->value();
        $checkpoint = CanonicalJson::encode((object) ['workbook' => $snapshot, 'update_id' => $id]);
        $payload = CanonicalJson::encode((object) ['workbook' => $snapshot, 'commands' => $effective->commands, 'update_id' => $id]);
        $update = new UpdateEnvelope($command->generation, $id, $payload, hash('sha256', $payload));
        $insertions = array_values(array_filter($effective->commands, static fn (stdClass $item): bool => $item->kind === 'insert_row_before'));

        return $this->database->transaction(function (Connection $db) use ($context, $node, $owner, $fence, $base, $command, $call, $id, $receiptId, $marker, $runtime, $native, $projection, $checkpoint, $update, $insertions): array {
            $document = $this->lockWritable($context, $node, $call);
            $this->assertGeneration($document, $command);
            $head = $this->journal->assertOwner($document, $owner, $fence);
            $scope = $this->scope($context, $document, $command);
            $replay = $this->receipt($db, $scope, $command);
            if ($replay !== null) {
                return $replay;
            }
            if ($head !== $base || $document->stateVersion !== $marker->position) {
                throw new RoomWriteConflict('base_moved');
            }
            $seq = $base + 1;
            $position = $this->journal->append($document, $owner, $fence, $base, $update, new CheckpointPublication(
                $document->binding ?? throw new WorkbookProblem('room_unavailable', 503), $marker->position, $seq,
                $checkpoint, [], $context->actor->ref(), preparedContent: $projection,
            ));
            $next = new WorkbookMarker($document->generation, $position, $native->contentHash());
            $evidence = [
                'state' => 'committed', 'command_id' => $command->id, 'receipt_id' => $receiptId,
                'marker' => $next, 'etag' => $next->etag($node), 'seq' => $seq, 'insertions' => $insertions,
                'structural_sheets' => array_values(array_unique(array_map(static fn (stdClass $item): mixed => $item->sheet_id, $insertions), SORT_REGULAR)),
                'changed_ranges' => $runtime->changed_ranges ?? [], 'checks' => $runtime->checks ?? new stdClass,
            ];
            // Use the DB clock for the receipt windows, including after a lock wait.
            $now = $this->now($db);
            $this->commands($db)->insert($scope + [
                'id' => $id, 'generation' => $command->generation, 'fingerprint' => $command->fingerprint(),
                'base_position' => $marker->position, 'committed_position' => $position, 'state' => 'committed',
                'receipt_id' => $receiptId, 'finished_at' => $db->raw($now),
                'replay_until' => $this->deadline($db, 'replay_seconds'),
                'evidence_until' => $this->deadline($db, 'evidence_seconds'),
                'evidence' => json_encode($evidence, JSON_THROW_ON_ERROR),
            ]);
            $db->table($this->schema->table('sheets_realtime_links'))->insert([
                'document_id' => $document->documentId, 'generation' => $document->generation,
                'seq' => $seq, 'source_position' => $position, 'receipt_id' => $receiptId, 'fence' => $fence,
            ]);

            return $evidence;
        });
    }

    private function lockWritable(DriveContext $context, string $node, ?CollaborationCall $call): LockedDocumentState
    {
        $document = $this->state->lock($node);
        if ($call !== null) {
            $this->rooms->check($context, $document, $call, write: true);
        } else {
            $this->rooms->assertJournal($document);
        }
        if (!$this->access->canEdit($context, $node)) {
            throw new WorkbookProblem('room_read_only', 403);
        }

        return $document;
    }

    private function assertGeneration(LockedDocumentState $document, WorkbookCommand $command): void
    {
        if ($document->generation !== $command->generation) {
            throw new WorkbookProblem('generation_changed', 409);
        }
    }

    private function rebase(Connection $db, LockedDocumentState $document, WorkbookCommand $command, WorkbookMarker $marker): WorkbookCommand
    {
        if ($command->policy === 'revalidate_by_id' || $command->ifMatch === $marker->etag($document->nodeId)) {
            return $command;
        }
        $tag = '/^"'.preg_quote($document->nodeId, '/').'\.'.preg_quote((string) $marker->generation, '/').'\.(0|[1-9][0-9]*)"$/D';
        if ($command->policy !== 'rebase_cells' || preg_match($tag, $command->ifMatch ?? '', $matches) !== 1
            || ($cursor = (int) $matches[1]) >= $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $items = array_map(static fn (stdClass $item): stdClass => clone $item, $command->commands);
        $history = $this->commands($db)->where('document_id', $document->documentId)->where('generation', $document->generation)
            ->where('state', 'committed')->whereBetween('committed_position', [$cursor + 1, $marker->position])->orderBy('committed_position')->cursor();
        foreach ($history as $row) {
            $evidence = is_string($row->evidence ?? null) ? StrictJson::decode($row->evidence) : null;
            if ((string) ($cursor + 1) !== self::string($row->committed_position ?? null) || !$evidence instanceof stdClass || !is_array($evidence->insertions ?? null)) {
                throw new WorkbookProblem('version_conflict', 409);
            }
            foreach ($evidence->insertions as $insertion) {
                $this->shiftRows($items, $insertion);
            }
            ++$cursor;
        }
        if ($cursor !== $marker->position) {
            throw new WorkbookProblem('version_conflict', 409);
        }

        return new WorkbookCommand($command->id, $command->policy, $command->generation, $marker->etag($document->nodeId), $items);
    }

    /** @param list<stdClass> $items */
    private function shiftRows(array $items, mixed $insertion): void
    {
        if (!$insertion instanceof stdClass || !is_int($insertion->row ?? null) || !is_int($insertion->count ?? null)) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        foreach ($items as $item) {
            // Without parsing explicit cross-sheet references, a stale formula cannot be moved safely.
            if (($item->kind ?? null) === 'set_formula') {
                throw new WorkbookProblem('version_conflict', 409, ['reason' => 'formula_rebase']);
            }
            if ($item->sheet_id !== $insertion->sheet_id || !is_int($item->row ?? null)) {
                continue;
            }
            if ($item->row >= $insertion->row) {
                $item->row += $insertion->count;
            } elseif (is_array($item->values ?? null) && $item->row + count($item->values) > $insertion->row) {
                throw new WorkbookProblem('version_conflict', 409, ['reason' => 'split_range']);
            }
        }
    }

    /** @return array{tenant_id: int|string, project_scope: string, subject_type: string, subject_id: int|string, document_id: string, command_id: string} */
    private function scope(DriveContext $context, LockedDocumentState $document, WorkbookCommand $command): array
    {
        $actor = $context->actor->ref();

        return [
            'tenant_id' => $context->operation->tenant->id ?? 0,
            'project_scope' => $context->operation->scope->kind.':'.$context->operation->scope->id,
            'subject_type' => $actor->type ?? 'user', 'subject_id' => $actor->id ?? 0,
            'document_id' => $document->documentId, 'command_id' => $command->id,
        ];
    }

    /** @param array<string,int|string> $scope */
    private function reject(Connection $db, array $scope, string $id, WorkbookCommand $command, WorkbookMarker $marker, WorkbookProblem $problem): void
    {
        $this->commands($db)->insert($scope + [
            'id' => $id, 'generation' => $command->generation, 'fingerprint' => $command->fingerprint(),
            'base_position' => $marker->position, 'state' => 'rejected', 'error_code' => $problem->problem,
            'intent' => json_encode(['rejection' => ['code' => $problem->problem, 'status' => $problem->status, 'detail' => $problem->detail]], JSON_THROW_ON_ERROR),
            'finished_at' => $db->raw($this->now($db)), 'replay_until' => $this->deadline($db, 'replay_seconds'),
        ]);
    }

    /** @param array<string,int|string> $scope
     * @return array<string, mixed>|null
     */
    private function receipt(Connection $db, array $scope, WorkbookCommand $command): ?array
    {
        $row = $this->commands($db)->where($scope)->first();
        if (!$row instanceof stdClass) {
            return null;
        }
        if (!hash_equals(self::string($row->fingerprint ?? null), $command->fingerprint())) {
            throw new WorkbookProblem('idempotency_conflict', 409);
        }
        $now = $this->now($db);
        if (($row->state ?? null) === 'expired' || !$this->commands($db)->where($scope)->where('replay_until', '>', $db->raw($now))->exists()) {
            throw new WorkbookProblem('idempotency_window_expired', 410);
        }
        if (($row->state ?? null) === 'rejected' && is_string($row->intent ?? null)) {
            $stored = StrictJson::decode($row->intent);
            $rejection = $stored instanceof stdClass ? ($stored->rejection ?? null) : null;
            if ($rejection instanceof stdClass && is_string($rejection->code ?? null) && is_int($rejection->status ?? null)) {
                $detail = [];
                foreach ((array) ($rejection->detail ?? []) as $key => $value) {
                    $detail[(string) $key] = $value;
                }
                throw new WorkbookProblem($rejection->code, $rejection->status, $detail);
            }
        }
        if (($row->state ?? null) !== 'committed' || !is_string($row->evidence ?? null)) {
            throw new WorkbookProblem('version_conflict', 409);
        }
        $receipt = json_decode($row->evidence, true, 256, JSON_THROW_ON_ERROR);
        if (!is_array($receipt)) {
            throw new WorkbookProblem('room_unavailable', 503);
        }
        if (!$this->commands($db)->where($scope)->where('evidence_until', '>', $db->raw($now))->exists()) {
            unset($receipt['checks']);
        }

        /** @var array<string,mixed> $receipt */
        return $receipt;
    }

    private function commands(Connection $db): Builder
    {
        return $db->table($this->schema->table('sheets_commands'));
    }

    /** @return literal-string */
    private function now(Connection $db): string
    {
        return $db->getDriverName() === 'pgsql' ? 'clock_timestamp()' : "strftime('%Y-%m-%d %H:%M:%f', 'now')";
    }

    private function deadline(Connection $db, string $key): string
    {
        $value = config('vaulter-sheets.'.$key);
        $seconds = is_int($value) && $value > 0 ? $value : 86_400;

        $row = $db->getDriverName() === 'pgsql'
            ? $db->selectOne('SELECT (clock_timestamp() + make_interval(secs => ?))::text AS deadline', [$seconds])
            : $db->selectOne("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', ?) AS deadline", ['+'.$seconds.' seconds']);

        return $row instanceof stdClass && is_string($row->deadline ?? null)
            ? $row->deadline : throw new WorkbookProblem('room_unavailable', 503);
    }

    private static function string(mixed $value): string
    {
        return is_string($value) || is_int($value) ? (string) $value : '';
    }
}
