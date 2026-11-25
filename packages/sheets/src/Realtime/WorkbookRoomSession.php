<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Illuminate\Support\Str;
use stdClass;
use Vaulter\Collaboration\CollaborationCall;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\Persistence\NativeJournal;
use Vaulter\Collaboration\RoomTokens;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Access\CollaborationAccessPolicy;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\Enums\Documents\DocumentWriteMode;
use Vaulter\Documents\State\CollaborativeState;
use Vaulter\Documents\State\CollaborativeStateTransition;
use Vaulter\Documents\State\LockedDocumentState;
use Vaulter\Drive\Enums\DriveStatus;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;
use Vaulter\Support\Identity;
use Vaulter\ValueObjects\Access\Actor;

final readonly class WorkbookRoomSession
{
    public function __construct(
        private VaulterDatabase $database,
        private CollaborativeState $state,
        private NativeJournal $journal,
        private WorkbookCodec $codec,
        private CollaborationAccessPolicy $policy,
        private WorkbookRoomDriver $driver,
        private NodeEditAccess $edit,
        private HostUserResolver $users,
        private RoomTokens $tokens,
        private DocumentsManager $documents,
        private SchemaHelpers $schema,
    ) {}

    public function issue(DriveContext $context, string $node): CollaborationSession
    {
        return $this->database->transaction(function () use ($context, $node): CollaborationSession {
            $document = $this->state->lock($node);
            if ($document->writeMode !== 'journal') {
                // A reader must still have access before learning whether a profile is active.
                $this->documents->forContext($context)->content($node);
            }
            $this->assertJournal($document);
            $grant = $this->policy->evaluate($context, $node)->grant;
            $session = $this->driver->issueSession($grant);
            $session->assertGrant($grant, WorkbookRoomDriver::VERSION);

            return $session;
        });
    }

    /** @return array{generation:int, position:int, mode:string} */
    public function switchProfile(DriveContext $context, string $node, DocumentWriteMode $mode, string $ifMatch): array
    {
        return $this->database->transaction(function () use ($context, $node, $mode, $ifMatch): array {
            $document = $this->state->lock($node);
            if ($document->type !== SpreadsheetDocumentType::KEY || !$this->edit->canEdit($context, $node)) {
                throw new WorkbookProblem('resource_unavailable', 404);
            }
            $content = $this->codec->decodeStored($document->content, $document->schemaVersion);
            $marker = new WorkbookMarker($document->generation, $document->stateVersion, $content->contentHash());
            if ($marker->etag($node) !== $ifMatch || $document->pending !== null) {
                throw new WorkbookProblem('version_conflict', 409);
            }
            if ($document->writeMode === $mode->value) {
                return ['generation' => $document->generation, 'position' => $document->stateVersion, 'mode' => $mode->value];
            }
            if ($mode === DocumentWriteMode::Journal) {
                $this->driver->endpoint();
            }
            $checkpoint = $mode === DocumentWriteMode::Journal
                ? CanonicalJson::encode((object) ['workbook' => $this->codec->snapshot($content), 'update_id' => null])
                : null;
            $result = $this->state->transition($document, new CollaborativeStateTransition(
                $document->binding, $document->stateVersion, $document->type, $document->schemaVersion,
                $checkpoint === null ? null : SpreadsheetDocumentType::COLLABORATION_PROTOCOL,
                $checkpoint === null ? null : SpreadsheetDocumentType::COLLABORATION_FORMAT,
                $content, $checkpoint, $context->actor->ref(), $context->correlationId, $mode,
            ));
            if (!$result->published) {
                throw new WorkbookProblem('version_conflict', 409);
            }
            if ($mode === DocumentWriteMode::Journal) {
                $this->journal->initialize($this->state->lock($node), WorkbookRoomDriver::VERSION);
            }

            return ['generation' => $result->generation, 'position' => $result->stateVersion, 'mode' => $mode->value];
        });
    }

    public function credential(?string $token, string $room): CollaborationCall
    {
        $call = $this->tokens->verify($token, WorkbookRoomDriver::VERSION);
        if ($call === null || $call->room !== $room || $call->profile !== 'strict' || $call->expiresAt <= time()) {
            throw new WorkbookProblem('room_credential_invalid', 401);
        }

        return $call;
    }

    public function context(CollaborationCall $call): DriveContext
    {
        $user = $this->users->find($call->principal);
        if ($user === null) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $actor = Actor::user($user);
        if ($actor->ref()->type !== $call->principal->type || Identity::stringify($actor->ref()->id) !== Identity::stringify($call->principal->id)) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }

        return $this->policy->referenceContext($actor, $call->ref->driveId, $call->ref->nodeId, $call->tenant, (string) Str::uuid());
    }

    public function check(DriveContext $context, LockedDocumentState $document, CollaborationCall $call, bool $write): void
    {
        if ($document->nodeId !== $call->ref->nodeId || $document->driveId !== $call->ref->driveId || $document->tenantId !== $call->tenant) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $this->assertJournal($document);
        if ($document->generation !== $call->ref->epoch) {
            throw new WorkbookProblem('generation_changed', 409);
        }
        if ($document->schemaVersion !== $call->schemaVersion || $document->binding?->stateFormat !== $call->stateFormat
            || $document->binding->protocol !== $call->protocol) {
            throw new WorkbookProblem('incompatible_binding', 412);
        }
        if ($call->expiresAt <= time() || !$this->tokens->isCurrent($call)) {
            throw new WorkbookProblem('room_credential_invalid', 401);
        }
        $ceiling = $call->mayStore() ? CollaborationMode::Write : CollaborationMode::Read;
        $grant = $this->policy->evaluate($context, $document->nodeId, $ceiling, $call->schemaVersion)->grant;
        if ($write && $grant->mode !== CollaborationMode::Write) {
            throw new WorkbookProblem('room_read_only', 403);
        }
    }

    public function assertJournal(LockedDocumentState $document): void
    {
        if ($document->type !== SpreadsheetDocumentType::KEY || $document->trashed || $document->driveStatus !== DriveStatus::Active) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if ($document->writeMode !== 'journal' || $document->collabState === null || $document->binding === null) {
            throw new WorkbookProblem('room_not_active', 409);
        }
    }

    /** @return array<string, mixed> */
    public function owner(DriveContext $context, CollaborationCall $call, string $action, string $owner, ?int $fence, ?int $after, bool $includeState): array
    {
        return $this->database->transaction(function () use ($context, $call, $action, $owner, $fence, $after, $includeState): array {
            $document = $this->state->lock($call->ref->nodeId);
            $this->check($context, $document, $call, write: false);
            if ($action === 'release' && $fence !== null) {
                $this->journal->release($document, $owner, $fence);

                return ['released' => true];
            }
            if ($action === 'acquire') {
                $this->journal->initialize($document, WorkbookRoomDriver::VERSION);
                $lease = $this->journal->acquire($document, $owner);
            } elseif ($action === 'renew' && $fence !== null) {
                return $this->journal->renew($document, $owner, $fence);
            } elseif ($action === 'read') {
                $lease = [];
            } else {
                throw new WorkbookProblem('invalid_command', 422);
            }
            $log = $this->journal->snapshot($document);
            if ($action === 'read' && !$includeState && $after === $log->headSeq) {
                return ['unchanged' => true];
            }
            $content = $this->codec->decodeStored($document->content, $document->schemaVersion);
            $marker = new WorkbookMarker($document->generation, $document->stateVersion, $content->contentHash());
            if ($action === 'read' && !$includeState && $after !== null && $after < $log->headSeq && ($log->headSeq - $after) <= 64) {
                $tail = $this->deltaTail($document, $after, $log->headSeq);
                if ($tail !== null) {
                    return [
                        'generation' => $log->generation, 'head_seq' => $log->headSeq, 'checkpoint_seq' => $after,
                        'checkpoint' => null, 'tail' => $tail, 'etag' => $marker->etag($document->nodeId),
                        'marker' => $marker, 'insertions' => $this->insertions($document, $after, $log->headSeq),
                    ];
                }
            }
            $checkpointBytes = $log->checkpoint ?? throw new WorkbookProblem('room_unavailable', 503);
            $checkpointSeq = $log->checkpointSeq;
            $tail = $log->tail;
            $decodedCheckpoint = json_decode($checkpointBytes, false);
            if ($decodedCheckpoint instanceof stdClass && ($decodedCheckpoint->kind ?? null) === 'snapshot_ref') {
                $checkpointBytes = CanonicalJson::encode((object) ['workbook' => $this->codec->snapshot($content), 'update_id' => null]);
                $checkpointSeq = $log->headSeq;
                $tail = [];
            }

            return $lease + [
                'generation' => $log->generation, 'head_seq' => $log->headSeq, 'checkpoint_seq' => $checkpointSeq,
                'checkpoint' => base64_encode($checkpointBytes),
                'tail' => $tail, 'etag' => $marker->etag($document->nodeId), 'marker' => $marker,
                'insertions' => $after === null ? [] : $this->insertions($document, $after, $log->headSeq),
            ];
        });
    }

    /** @return list<mixed>|null null when the history cannot rebase an open draft */
    private function insertions(LockedDocumentState $document, int $after, int $head): ?array
    {
        if ($after > $head || $head - $after > 64) {
            return null;
        }
        $db = $this->database->connection();
        $links = $this->schema->table('sheets_realtime_links');
        $commands = $this->schema->table('sheets_commands');
        $rows = $db->table($links)->join($commands, $links.'.receipt_id', '=', $commands.'.receipt_id')
            ->where($links.'.document_id', $document->documentId)->where($links.'.generation', $document->generation)
            ->whereBetween($links.'.seq', [$after + 1, $head])->orderBy($links.'.seq')->pluck($commands.'.evidence');
        if ($rows->count() !== $head - $after) {
            return null;
        }
        $insertions = [];
        foreach ($rows as $bytes) {
            $evidence = is_string($bytes) ? StrictJson::decode($bytes) : null;
            if (!$evidence instanceof stdClass || !is_array($evidence->insertions ?? null)) {
                return null;
            }
            array_push($insertions, ...array_values($evidence->insertions));
        }

        return $insertions;
    }

    /** @return list<array{seq: int, update_id: string, payload: string, sha256: string}>|null */
    private function deltaTail(LockedDocumentState $document, int $after, int $head): ?array
    {
        $rows = $this->database->connection()->table($this->schema->table('collaboration_updates'))
            ->where('document_id', Identity::key($document->documentId))
            ->where('generation', $document->generation)
            ->where('seq', '>', $after)
            ->where('seq', '<=', $head)
            ->orderBy('seq')
            ->get(['seq', 'update_id', 'payload', 'sha256']);
        if ($rows->count() !== $head - $after) {
            return null;
        }
        $tail = [];
        foreach ($rows as $row) {
            $payload = is_resource($row->payload ?? null) ? stream_get_contents($row->payload) : ($row->payload ?? '');
            $tail[] = [
                'seq' => is_int($row->seq) ? $row->seq : (is_numeric($row->seq) ? (int) $row->seq : 0),
                'update_id' => Identity::stringify($row->update_id),
                'payload' => is_string($payload) ? $payload : '',
                'sha256' => Identity::stringify($row->sha256),
            ];
        }

        return $tail;
    }
}
