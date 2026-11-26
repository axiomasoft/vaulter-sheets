<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use JsonException;
use PDOException;
use stdClass;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Contracts\AtomicDocumentMutation;
use Vaulter\Documents\Contracts\LockedDocumentMutation;
use Vaulter\Documents\Data\Snapshots\DocumentSnapshot;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Drive\Contracts\DriveHandle;
use Vaulter\Drive\Data\FileStream;
use Vaulter\Drive\Enums\Access\Ability;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Exceptions\Profiles\ProfileRestrictionException;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Drive\Vaulter;
use Vaulter\Exceptions\Database\ConcurrentUpdateException;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Media\Contracts\Cas\BlobStore;
use Vaulter\Media\ValueObjects\Cas\BlobScope;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Contracts\WorkbookExchangeRuntime;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Jobs\RunWorkbookExchange;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;
use Vaulter\Sheets\Support\WorkbookClock;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final readonly class WorkbookExchange
{
    private const int DEFAULT_ACTIVE_LIMIT = 8;

    public const string SOURCE_PIN_OWNER = 'sheets.exchange_source';

    public const string OUTPUT_PIN_OWNER = 'sheets.exchange_output';

    public function __construct(
        private VaulterDatabase $database,
        private DocumentsManager $documents,
        private AtomicDocumentMutation $mutations,
        private Vaulter $vaulter,
        private BlobStore $blobs,
        private BlobPins $pins,
        private WorkbookCodec $codec,
        private SchemaHelpers $schema,
        private NodeEditAccess $access,
        private WorkbookExchangeRuntime $runtime,
        private ZipArchiveGuard $zipGuard,
    ) {}

    /**
     * @return list<'csv'|'xlsx'>
     */
    public function enabledFormats(): array
    {
        $configured = config('vaulter-sheets.exchange.formats', []);
        if (!is_array($configured)) {
            return [];
        }
        $formats = [];
        foreach ($configured as $item) {
            if (!is_string($item)) {
                continue;
            }
            $norm = strtolower(trim($item));
            if (($norm === 'csv' || $norm === 'xlsx') && !in_array($norm, $formats, true)) {
                $formats[] = $norm;
            }
        }

        return $formats;
    }

    /**
     * @return array{formats: list<'csv'|'xlsx'>, import: list<'csv'|'xlsx'>, export: list<'csv'|'xlsx'>}
     */
    public function capabilities(DriveContext $context, string $node): array
    {
        $state = $this->loadWorkbook($context, $node);

        return $this->capabilitiesForState($context, $node, $state);
    }

    /**
     * @return array{formats: list<'csv'|'xlsx'>, import: list<'csv'|'xlsx'>, export: list<'csv'|'xlsx'>}
     */
    public function capabilitiesForState(DriveContext $context, string $node, DocumentSnapshot $state): array
    {
        $formats = $this->enabledFormats();
        if ($formats === []) {
            return ['formats' => [], 'import' => [], 'export' => []];
        }
        $canImport = $this->access->canEdit($context, $node) && $state->editable && $state->collabProtocol === null;
        $abilities = $this->driveHandle($context, $context->operation->scope->id)->nodes()->abilities($node)->flags;
        $canExport = ($abilities[Ability::Download->value] ?? false) === true;

        return [
            'formats' => $formats,
            'import' => $canImport ? $formats : [],
            'export' => $canExport ? $formats : [],
        ];
    }

    /**
     * @return array{created: bool, job: array<string, mixed>}
     */
    public function register(DriveContext $context, string $node, stdClass $body, ?DriveContext $sourceContext = null): array
    {
        $requestKey = $body->request_key ?? null;
        $kind = $body->kind ?? null;
        $format = $body->format ?? null;
        $source = $body->source ?? null;
        $optionsRaw = property_exists($body, 'options') ? $body->options : new stdClass;

        if (!is_string($requestKey) || preg_match('/^[A-Za-z0-9._:@\/-]{1,255}$/', $requestKey) !== 1
            || ($kind !== 'import' && $kind !== 'export')
            || ($format !== 'csv' && $format !== 'xlsx')
            || !$source instanceof stdClass
            || !$optionsRaw instanceof stdClass) {
            throw new WorkbookProblem('invalid_command', 422);
        }

        foreach (array_keys(get_object_vars($optionsRaw)) as $optKey) {
            if (str_starts_with((string) $optKey, '_')) {
                throw new WorkbookProblem('invalid_command', 422);
            }
        }

        if (!in_array($format, $this->enabledFormats(), true)) {
            throw new WorkbookProblem('format_disabled', 422, ['format' => $format]);
        }

        $wbState = $this->loadWorkbook($context, $node);
        $actor = ExchangeActorScope::from($context);
        $scope = $actor->columns() + ['document_id' => $wbState->documentId, 'request_key' => $requestKey];

        $maxActive = $this->intConfig('vaulter-sheets.exchange.max_active_per_actor', self::DEFAULT_ACTIVE_LIMIT);
        if ($kind === 'import') {
            if (!$this->access->canEdit($context, $node)) {
                throw new WorkbookProblem('permission_denied', 403);
            }
            if (!$wbState->editable || $wbState->collabProtocol !== null) {
                throw new WorkbookProblem('unsupported_content', 422);
            }
            $this->assertCapacity($this->database->connection(), $actor, $scope, $maxActive);
            $file = $this->openImportSource($context, $wbState, $source, $sourceContext);
            try {
                $maxBytes = $this->intConfig('vaulter-sheets.exchange.max_import_bytes', 32 * 1024 * 1024);
                if ($file->size > $maxBytes) {
                    throw new WorkbookProblem('limit_exceeded', 413);
                }
                $fingerprint = CanonicalJson::sha256((object) [
                    'kind' => 'import', 'format' => $format,
                    'source' => (object) [
                        'node_id' => self::str($source->node_id),
                        'revision_id' => isset($source->revision_id) ? self::str($source->revision_id) : $file->revision->id,
                        'source_sha256' => $file->sha256,
                    ],
                    'options' => $optionsRaw,
                ]);
                $db = $this->database->connection();
                $existing = $this->records($db)->where($scope)->first();
                if ($existing instanceof stdClass) {
                    return $this->replay($db, $existing, $fingerprint);
                }
                $bytes = stream_get_contents($file->stream, $maxBytes + 1);
                if ($bytes === false) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                if (strlen($bytes) > $maxBytes) {
                    throw new WorkbookProblem('limit_exceeded', 413);
                }
                if (!hash_equals($file->sha256, hash('sha256', $bytes))) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                $prepared = new ExchangeSource($wbState->epoch, $wbState->stateVersion, $bytes, $file->sha256, $fingerprint);
            } finally {
                fclose($file->stream);
            }
        } else {
            $abilities = $this->driveHandle($context, $context->operation->scope->id)->nodes()->abilities($node)->flags;
            if (($abilities[Ability::Download->value] ?? false) !== true) {
                throw new WorkbookProblem('permission_denied', 403);
            }
            $sourceIdentity = $this->exportSourceIdentity($source);
            $shaExpected = $source->sha256 ?? null;
            $findReplay = fn (): ?array => $this->findExportReplay($scope, $format, $sourceIdentity, $shaExpected, $optionsRaw);
            $replay = $findReplay();
            if ($replay !== null) {
                return $replay;
            }
            $this->assertCapacity($this->database->connection(), $actor, $scope, $maxActive);
            try {
                $prepared = $this->prepareExportSource($context, $node, $wbState, $format, $sourceIdentity, $shaExpected, $optionsRaw);
            } catch (WorkbookProblem $problem) {
                if ($problem->status === 409 && ($replay = $findReplay()) !== null) {
                    return $replay;
                }
                throw $problem;
            }
        }

        $storedOptions = clone $optionsRaw;
        $storedOptions->_node_id = $node;
        if ($kind === 'export') {
            $storedOptions->_source_sha256 = $prepared->sha256;
        }

        $keepSeconds = $this->intConfig('vaulter-sheets.exchange.keep_seconds', 7 * 86_400);
        $jobId = (string) Str::uuid7();

        /** @return array{created: bool, job: array<string, mixed>} */
        $admit = function (Connection $db) use (
            $context,
            $actor,
            $scope,
            $kind,
            $format,
            $prepared,
            $storedOptions,
            $keepSeconds,
            $maxActive,
            $jobId,
        ): array {
            // An actual write fences stale snapshots at REPEATABLE READ before bytes reach Media.
            // Link the admission to its retained job before committing; deletion then reclaims the actor row.
            $actorColumns = $actor->columns();
            $admissions = $db->table($this->schema->table('sheets_exchange_admissions'));
            $admissions->upsert($actorColumns + ['job_id' => null], array_keys($actorColumns), ['job_id']);
            $existing = $this->records($db)->where($scope)->lockForUpdate()->first();
            if ($existing instanceof stdClass) {
                $admissions->where($actorColumns)->update(['job_id' => $existing->id]);

                return $this->replay($db, $existing, $prepared->fingerprint);
            }
            $this->assertCapacity($db, $actor, $scope, $maxActive);

            $blobId = $this->commitBlobBytes($context, $prepared->bytes);
            $insertedRows = $this->records($db)->insertOrIgnoreReturning($scope + [
                'id' => $jobId,
                'fingerprint' => $prepared->fingerprint,
                'kind' => $kind,
                'format' => $format,
                'generation' => $prepared->generation,
                'source_position' => $prepared->position,
                'options' => CanonicalJson::encode($storedOptions),
                'state' => 'queued',
                'result_receipt_id' => null,
                'source_blob_id' => $blobId,
                'output_blob_id' => null,
                'report' => null,
                'error_code' => null,
                'worker_token' => null,
                'lease_until' => null,
                'finished_at' => null,
                'keep_until' => WorkbookClock::futureTimestamp($db, $keepSeconds),
            ], uniqueBy: array_keys($scope));
            $inserted = $insertedRows[0] ?? null;
            if (!$inserted instanceof stdClass) {
                $existing = $this->records($db)->where($scope)->lockForUpdate()->first();
                if (!$existing instanceof stdClass) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                $admissions->where($actorColumns)->update(['job_id' => $existing->id]);

                return $this->replay($db, $existing, $prepared->fingerprint);
            }
            $admissions->where($actorColumns)->update(['job_id' => $jobId]);
            $this->pins->pin($blobId, self::SOURCE_PIN_OWNER, $jobId);

            $this->database->afterCommit(static function () use ($jobId): void {
                dispatch(new RunWorkbookExchange($jobId));
            });

            return ['created' => true, 'job' => $this->presentJob($inserted)];
        };

        try {
            // Each accepted writer can invalidate one concurrent PostgreSQL snapshot.
            // Bound retries while allowing all default slots to fill before rejecting the next job.
            return $this->database->transaction($admit, attempts: self::DEFAULT_ACTIVE_LIMIT + 1);
        } catch (ConcurrentUpdateException|PDOException $error) {
            if ($this->database->connection()->transactionLevel() !== 0
                || ($error instanceof PDOException && (string) $error->getCode() !== '40001')) {
                throw $error;
            }

            throw new WorkbookProblem('contention', 503);
        }
    }

    /**
     * @param  array<string, int|string>                            $scope
     * @return array{created: bool, job: array<string, mixed>}|null
     */
    private function findExportReplay(array $scope, string $format, stdClass $source, mixed $shaExpected, stdClass $options): ?array
    {
        return $this->database->transaction(function (Connection $db) use ($scope, $format, $source, $shaExpected, $options): ?array {
            $job = $this->records($db)->where($scope)->lockForUpdate()->first();
            if (!$job instanceof stdClass) {
                return null;
            }
            if ($job->kind !== 'export' || $job->format !== $format) {
                throw new WorkbookProblem('idempotency_conflict', 409);
            }
            // The pinned snapshot also supplies the source digest for jobs registered before this change.
            $metadata = is_string($job->options) ? StrictJson::decode($job->options) : null;
            $sourceSha = $metadata instanceof stdClass && is_string($metadata->_source_sha256 ?? null)
                ? $metadata->_source_sha256
                : hash('sha256', $this->readBlobBytes(self::str($job->source_blob_id), $this->codec->maxSizeBytes()));
            if (!isset($source->revision_id) && $shaExpected !== null
                && (!is_string($shaExpected) || !hash_equals($sourceSha, $shaExpected))) {
                throw new WorkbookProblem('idempotency_conflict', 409);
            }
            $fingerprint = $this->exportFingerprint(
                $format, self::intVal($job->generation), self::intVal($job->source_position), $sourceSha, $source, $options,
            );

            return $this->replay($db, $job, $fingerprint);
        });
    }

    /** @return array{created: bool, job: array<string, mixed>} */
    private function replay(Connection $db, stdClass $existing, string $fingerprint): array
    {
        if (!hash_equals(self::str($existing->fingerprint), $fingerprint)) {
            throw new WorkbookProblem('idempotency_conflict', 409);
        }
        if (!WorkbookClock::future($db, self::str($existing->keep_until))) {
            throw new WorkbookProblem('idempotency_window_expired', 410);
        }

        return ['created' => false, 'job' => $this->presentJob($existing)];
    }

    public function process(string $jobId, ?DriveContext $context = null): void
    {
        if (!$this->isUuid($jobId)) {
            return;
        }
        $token = (string) Str::uuid();
        $leaseSeconds = $this->intConfig('vaulter-sheets.exchange.lease_seconds', 60);

        /** @var stdClass|null $claimed */
        $claimed = $this->database->transaction(function (Connection $db) use ($jobId, $token, $leaseSeconds): ?stdClass {
            $row = $this->records($db)->where('id', $jobId)->lockForUpdate()->first();
            if (!$row instanceof stdClass) {
                return null;
            }
            $state = is_string($row->state ?? null) ? $row->state : '';
            if ($state === 'succeeded' || $state === 'failed') {
                return null;
            }
            $leaseUntil = is_string($row->lease_until ?? null) ? $row->lease_until : null;
            if ($state === 'running' && WorkbookClock::future($db, $leaseUntil)) {
                return null;
            }
            $affected = $this->records($db)
                ->where('id', $jobId)
                ->whereIn('state', ['queued', 'running'])
                ->update([
                    'state' => 'running',
                    'worker_token' => $token,
                    'lease_until' => WorkbookClock::futureTimestamp($db, $leaseSeconds),
                ]);
            if ($affected !== 1) {
                return null;
            }

            return $this->records($db)->where('id', $jobId)->first();
        });

        if (!$claimed instanceof stdClass) {
            return;
        }

        try {
            $rawOptions = is_string($claimed->options ?? null) ? StrictJson::decode($claimed->options) : new stdClass;
            if (!$rawOptions instanceof stdClass) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            $node = $rawOptions->_node_id ?? null;
            if (!is_string($node) || $node === '') {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            $userOptions = new stdClass;
            foreach (get_object_vars($rawOptions) as $key => $value) {
                $keyStr = (string) $key;
                if (!str_starts_with($keyStr, '_')) {
                    $userOptions->{$keyStr} = $value;
                }
            }

            $format = self::str($claimed->format ?? null);
            if (!in_array($format, $this->enabledFormats(), true)) {
                throw new WorkbookProblem('format_disabled', 422, ['format' => $format]);
            }

            if ($context === null) {
                throw new WorkbookProblem('runtime_failed', 503);
            }

            $wbState = $this->loadWorkbook($context, $node);
            if (self::str($claimed->document_id ?? null) !== $wbState->documentId) {
                throw new WorkbookProblem('resource_unavailable', 404);
            }

            if ($claimed->kind === 'import') {
                if (!$this->access->canEdit($context, $node)) {
                    throw new WorkbookProblem('permission_denied', 403);
                }
                if (!$wbState->editable || $wbState->collabProtocol !== null) {
                    throw new WorkbookProblem('unsupported_content', 422);
                }
                $this->executeImport($context, $node, $claimed, $userOptions, $token);
            } else {
                $abilities = $this->driveHandle($context, $context->operation->scope->id)->nodes()->abilities($node)->flags;
                if (($abilities[Ability::Download->value] ?? false) !== true) {
                    throw new WorkbookProblem('permission_denied', 403);
                }
                $this->executeExport($context, $claimed, $userOptions, $token);
            }
        } catch (WorkbookProblem|InvalidDocumentContentException|WireException $error) {
            $problem = $error instanceof WorkbookProblem
                ? $error
                : new WorkbookProblem('unsupported_content', 422);
            if ($problem->status >= 500) {
                $this->releaseLease($jobId, $token);
                throw $problem;
            }
            $this->failJob($jobId, $token, $problem);
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function status(DriveContext $context, string $node, string $exchangeId): array
    {
        if (!$this->isUuid($exchangeId)) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $wbState = $this->loadWorkbook($context, $node);
        $db = $this->schema->dbConnection();
        $row = $this->records($db)
            ->where(ExchangeActorScope::from($context)->columns() + ['document_id' => $wbState->documentId, 'id' => $exchangeId])
            ->first();
        if (!$row instanceof stdClass) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }

        return $this->presentJob($row);
    }

    /**
     * @return array{stream: resource, filename: string, mime: string, sha256: string}
     */
    public function download(DriveContext $context, string $node, string $exchangeId): array
    {
        if (!$this->isUuid($exchangeId)) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        $wbState = $this->loadWorkbook($context, $node);
        $abilities = $this->driveHandle($context, $context->operation->scope->id)->nodes()->abilities($node)->flags;
        if (($abilities[Ability::Download->value] ?? false) !== true) {
            throw new WorkbookProblem('permission_denied', 403);
        }

        $db = $this->schema->dbConnection();
        $row = $this->records($db)
            ->where(ExchangeActorScope::from($context)->columns() + ['document_id' => $wbState->documentId, 'id' => $exchangeId])
            ->first();
        if (!$row instanceof stdClass) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if ($row->kind !== 'export') {
            throw new WorkbookProblem('invalid_command', 422);
        }
        if ($row->state === 'queued' || $row->state === 'running') {
            throw new WorkbookProblem('exchange_not_ready', 409);
        }
        $outputBlobId = self::str($row->output_blob_id ?? null);
        if ($row->state !== 'succeeded' || $outputBlobId === '') {
            throw new WorkbookProblem('unsupported_content', 422);
        }

        $stream = $this->blobs->read($outputBlobId);
        if (!is_resource($stream)) {
            throw new WorkbookProblem('snapshot_unavailable', 503);
        }

        $format = self::str($row->format ?? null);
        $mime = $format === 'csv'
            ? 'text/csv; charset=UTF-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        $sha = '';
        if (is_string($row->report ?? null)) {
            try {
                $reportObj = StrictJson::decode($row->report);
                if ($reportObj instanceof stdClass && is_string($reportObj->output_sha256 ?? null)) {
                    $sha = $reportObj->output_sha256;
                }
            } catch (WireException) {
                // Report checksum is optional when streaming.
            }
        }

        $nodeSnap = $this->driveHandle($context, $context->operation->scope->id)->nodes()->find($node);
        $baseName = pathinfo($nodeSnap->name, PATHINFO_FILENAME);
        $safeBase = preg_replace('/[^A-Za-z0-9._-]+/', '_', $baseName !== '' ? $baseName : 'workbook') ?? 'workbook';

        return [
            'stream' => $stream,
            'filename' => $safeBase.'.'.$format,
            'mime' => $mime,
            'sha256' => $sha,
        ];
    }

    private function openImportSource(
        DriveContext $context,
        DocumentSnapshot $wbState,
        stdClass $source,
        ?DriveContext $sourceContext,
    ): FileStream {
        $sourceNodeId = $source->node_id ?? null;
        if ((!is_string($sourceNodeId) && !is_int($sourceNodeId)) || (string) $sourceNodeId === '') {
            throw new WorkbookProblem('invalid_command', 422);
        }
        $revisionRaw = property_exists($source, 'revision_id') ? $source->revision_id : null;
        if ($revisionRaw !== null && (!is_string($revisionRaw) && !is_int($revisionRaw) || (string) $revisionRaw === '')) {
            throw new WorkbookProblem('invalid_command', 422);
        }
        if (property_exists($source, 'expected_generation')) {
            if (!is_int($source->expected_generation) || $source->expected_generation < 0) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            if ($source->expected_generation !== $wbState->epoch) {
                throw new WorkbookProblem('generation_changed', 409);
            }
        }

        $sourceDriveId = $sourceContext->operation->scope->id ?? $context->operation->scope->id;
        try {
            return $this->driveHandle($context, $sourceDriveId)->files()->read(
                (string) $sourceNodeId,
                $revisionRaw === null ? null : (string) $revisionRaw,
            );
        } catch (NodeNotFoundException) {
            throw new WorkbookProblem('resource_unavailable', 404);
        } catch (PermissionDeniedException|ProfileRestrictionException) {
            throw new WorkbookProblem('permission_denied', 403);
        }
    }

    private function exportSourceIdentity(stdClass $source): stdClass
    {
        $revRaw = $source->revision_id ?? null;
        if ($revRaw !== null) {
            if ((!is_string($revRaw) && !is_int($revRaw)) || (string) $revRaw === '') {
                throw new WorkbookProblem('invalid_command', 422);
            }

            return (object) ['revision_id' => (string) $revRaw];
        }
        $generation = $source->generation ?? null;
        $position = $source->position ?? null;
        if (!is_int($generation) || $generation < 0 || !is_int($position) || $position < 0) {
            throw new WorkbookProblem('invalid_command', 422);
        }

        return (object) ['generation' => $generation, 'position' => $position];
    }

    private function prepareExportSource(
        DriveContext $context,
        string $node,
        DocumentSnapshot $headState,
        string $format,
        stdClass $sourceIdentity,
        mixed $shaExpected,
        stdClass $optionsRaw,
    ): ExchangeSource {
        if (isset($sourceIdentity->revision_id)) {
            $targetState = $this->loadWorkbook($context, $node, self::str($sourceIdentity->revision_id));
            $generation = $targetState->revision->epoch ?? $targetState->epoch;
            $position = $targetState->revision->stateVersion ?? $targetState->stateVersion;
        } else {
            $generation = self::intVal($sourceIdentity->generation);
            $position = self::intVal($sourceIdentity->position);
            if ($generation !== $headState->epoch) {
                throw new WorkbookProblem('generation_changed', 409);
            }
            if ($position !== $headState->stateVersion) {
                throw new WorkbookProblem('version_conflict', 409);
            }
            if ($shaExpected !== null) {
                if (!is_string($shaExpected) || !hash_equals($headState->content->contentHash(), $shaExpected)) {
                    throw new WorkbookProblem('version_conflict', 409);
                }
            }
            $targetState = $headState;
        }

        $snapshotObj = $this->codec->snapshot($targetState->content);
        $canonical = CanonicalJson::encode($snapshotObj);
        if (strlen($canonical) > $this->codec->maxSizeBytes()) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }

        $digest = hash('sha256', $canonical);

        return new ExchangeSource(
            $generation,
            $position,
            $canonical,
            $digest,
            $this->exportFingerprint($format, $generation, $position, $digest, $sourceIdentity, $optionsRaw),
        );
    }

    private function exportFingerprint(string $format, int $generation, int $position, string $sourceSha, stdClass $sourceIdentity, stdClass $options): string
    {
        return CanonicalJson::sha256((object) [
            'kind' => 'export',
            'format' => $format,
            'generation' => $generation,
            'source_position' => $position,
            'source_sha256' => $sourceSha,
            'source' => $sourceIdentity,
            'options' => $options,
        ]);
    }

    private function executeImport(
        DriveContext $context,
        string $node,
        stdClass $job,
        stdClass $userOptions,
        string $token,
    ): void {
        $jobId = self::str($job->id ?? null);
        $format = self::str($job->format ?? null);
        $maxImportBytes = $this->intConfig('vaulter-sheets.exchange.max_import_bytes', 32 * 1024 * 1024);
        $sourceBytes = $this->readBlobBytes(self::str($job->source_blob_id ?? null), $maxImportBytes);

        if ($format === 'xlsx') {
            $this->zipGuard->assertSafe($sourceBytes);
        }

        $response = $this->runtime->exchange((object) [
            'version' => 1,
            'request_id' => (string) Str::uuid(),
            'operation' => 'import',
            'format' => $format,
            'profile_id' => WorkbookCodec::PROFILE,
            'input_b64' => base64_encode($sourceBytes),
            'input_sha256' => hash('sha256', $sourceBytes),
            'options' => $userOptions,
        ]);

        $workbookJson = ExchangeWire::decodeOutput($response);
        $decodedObj = StrictJson::decode($workbookJson);
        if (!$decodedObj instanceof stdClass) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $decodedRaw = [];
        foreach (get_object_vars($decodedObj) as $k => $v) {
            $decodedRaw[(string) $k] = $v;
        }
        $content = $this->codec->decode($decodedRaw, 2);
        if ($content->sizeInBytes() > $this->codec->maxSizeBytes()) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        $prepared = $this->codec->prepare($content, $context);

        $receiptId = (string) Str::uuid7();
        $replaySeconds = $this->intConfig('vaulter-sheets.replay_seconds', 86_400);
        $evidenceSeconds = $this->intConfig('vaulter-sheets.evidence_seconds', 86_400);

        $this->mutations->run($context, $node, function (LockedDocumentMutation $locked) use (
            $job,
            $jobId,
            $token,
            $content,
            $prepared,
            $response,
            $receiptId,
            $replaySeconds,
            $evidenceSeconds,
        ): void {
            $db = $locked->connection();
            $currentJob = $this->records($db)->where('id', $jobId)->lockForUpdate()->first();
            if (!$currentJob instanceof stdClass
                || $currentJob->state !== 'running'
                || $currentJob->worker_token !== $token
                || !WorkbookClock::future($db, is_string($currentJob->lease_until ?? null) ? $currentJob->lease_until : null)) {
                throw new WorkbookProblem('lease_lost', 503);
            }

            $lockedState = $locked->snapshot();
            if ($lockedState->type !== SpreadsheetDocumentType::KEY
                || $lockedState->writeMode !== 'snapshot'
                || $lockedState->protocol !== null
                || $lockedState->pending) {
                throw new WorkbookProblem('unsupported_content', 422);
            }
            $expectedGen = self::intVal($job->generation ?? null);
            if ($lockedState->generation !== $expectedGen) {
                throw new WorkbookProblem('generation_changed', 409);
            }
            $expectedPosition = self::intVal($job->source_position ?? null);
            if ($lockedState->position !== $expectedPosition) {
                throw new WorkbookProblem('version_conflict', 409);
            }

            $oldSheets = [];
            if ($lockedState->content instanceof WorkbookContent) {
                $oldNative = $lockedState->content->value()->native ?? null;
                $oldSheetsObj = $oldNative instanceof stdClass ? ($oldNative->sheets ?? null) : null;
                if ($oldSheetsObj instanceof stdClass) {
                    $oldSheets = array_map(static fn (int|string $k): string => (string) $k, array_keys(get_object_vars($oldSheetsObj)));
                }
            }
            $newNative = $content->value()->native ?? null;
            $newSheetsObj = $newNative instanceof stdClass ? ($newNative->sheets ?? null) : null;
            $newSheets = $newSheetsObj instanceof stdClass
                ? array_map(static fn (int|string $k): string => (string) $k, array_keys(get_object_vars($newSheetsObj)))
                : [];
            $structuralSheets = array_values(array_unique([...$oldSheets, ...$newSheets]));

            $next = $locked->replace($prepared, $expectedPosition);
            if ($next->generation !== $expectedGen) {
                throw new WorkbookProblem('generation_changed', 409);
            }
            $marker = new WorkbookMarker($next->generation, $next->position, $next->content->contentHash());
            $commandId = 'exchange.'.$jobId;
            $now = WorkbookClock::nowExpr($db);
            $evidenceUntil = WorkbookClock::futureTimestamp($db, $evidenceSeconds);
            $replayUntil = WorkbookClock::futureTimestamp($db, $replaySeconds);

            $evidence = [
                'state' => 'committed',
                'command_id' => $commandId,
                'receipt_id' => $receiptId,
                'marker' => $marker,
                'etag' => $marker->etag($lockedState->nodeId),
                'structural_sheets' => $structuralSheets,
                'changed_ranges' => [],
            ];

            $db->table($this->schema->table('sheets_commands'))->insert([
                'id' => (string) Str::uuid7(),
                'document_id' => $job->document_id,
                'tenant_id' => $job->tenant_id,
                'project_scope' => $job->project_scope,
                'subject_type' => $job->subject_type,
                'subject_id' => $job->subject_id,
                'command_id' => $commandId,
                'fingerprint' => $job->fingerprint,
                'generation' => $next->generation,
                'base_position' => $lockedState->position,
                'state' => 'committed',
                'intent' => CanonicalJson::encode((object) [
                    'kind' => 'exchange_import',
                    'exchange_id' => $jobId,
                    'format' => $job->format,
                    'source_blob_id' => $job->source_blob_id,
                ]),
                'worker_token' => null,
                'lease_until' => null,
                'receipt_id' => $receiptId,
                'committed_position' => $next->position,
                'error_code' => null,
                'evidence' => json_encode($evidence, JSON_THROW_ON_ERROR),
                'evidence_blob_id' => null,
                'finished_at' => $now,
                'evidence_until' => $evidenceUntil,
                'replay_until' => $replayUntil,
            ]);

            $updated = $this->records($db)
                ->where('id', $jobId)
                ->where('state', 'running')
                ->where('worker_token', $token)
                ->where('lease_until', '>', $now)
                ->update([
                    'state' => 'succeeded',
                    'result_receipt_id' => $receiptId,
                    'report' => json_encode($response->report, JSON_THROW_ON_ERROR),
                    'worker_token' => null,
                    'lease_until' => null,
                    'finished_at' => $now,
                ]);
            if ($updated !== 1) {
                throw new WorkbookProblem('lease_lost', 503);
            }
        });
    }

    private function executeExport(
        DriveContext $context,
        stdClass $job,
        stdClass $userOptions,
        string $token,
    ): void {
        $jobId = self::str($job->id ?? null);
        $format = self::str($job->format ?? null);
        $maxExportBytes = $this->intConfig('vaulter-sheets.exchange.max_export_bytes', 32 * 1024 * 1024);
        $sourceBytes = $this->readBlobBytes(self::str($job->source_blob_id ?? null), $this->codec->maxSizeBytes());

        $response = $this->runtime->exchange((object) [
            'version' => 1,
            'request_id' => (string) Str::uuid(),
            'operation' => 'export',
            'format' => $format,
            'profile_id' => WorkbookCodec::PROFILE,
            'input_b64' => base64_encode($sourceBytes),
            'input_sha256' => hash('sha256', $sourceBytes),
            'options' => $userOptions,
        ]);

        $outputBytes = ExchangeWire::decodeOutput($response);
        if (strlen($outputBytes) > $maxExportBytes) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }

        $outputBlobId = $this->commitBlobBytes($context, $outputBytes);

        $this->database->transaction(function (Connection $db) use ($jobId, $token, $outputBlobId, $response): void {
            $currentJob = $this->records($db)->where('id', $jobId)->lockForUpdate()->first();
            if (!$currentJob instanceof stdClass
                || $currentJob->state !== 'running'
                || $currentJob->worker_token !== $token
                || !WorkbookClock::future($db, is_string($currentJob->lease_until ?? null) ? $currentJob->lease_until : null)) {
                throw new WorkbookProblem('lease_lost', 503);
            }

            // Lock order per BlobPins contract: owner row lock first, then Media pin.
            $this->pins->pin($outputBlobId, self::OUTPUT_PIN_OWNER, $jobId);

            $now = WorkbookClock::nowExpr($db);
            $updated = $this->records($db)
                ->where('id', $jobId)
                ->where('state', 'running')
                ->where('worker_token', $token)
                ->where('lease_until', '>', $now)
                ->update([
                    'state' => 'succeeded',
                    'output_blob_id' => $outputBlobId,
                    'report' => json_encode($response->report, JSON_THROW_ON_ERROR),
                    'worker_token' => null,
                    'lease_until' => null,
                    'finished_at' => $now,
                ]);
            if ($updated !== 1) {
                throw new WorkbookProblem('lease_lost', 503);
            }
        });
    }

    private function failJob(string $jobId, string $token, WorkbookProblem $problem): void
    {
        $report = $problem->detail['report'] ?? null;
        $this->database->transaction(function (Connection $db) use ($jobId, $token, $problem, $report): void {
            $now = WorkbookClock::nowExpr($db);
            $this->records($db)
                ->where('id', $jobId)
                ->where('state', 'running')
                ->where('worker_token', $token)
                ->where('lease_until', '>', $now)
                ->update([
                    'state' => 'failed',
                    'error_code' => $problem->problem,
                    'report' => $report instanceof stdClass ? json_encode($report, JSON_THROW_ON_ERROR) : null,
                    'worker_token' => null,
                    'lease_until' => null,
                    'finished_at' => $now,
                ]);
        });
    }

    private function releaseLease(string $jobId, string $token): void
    {
        $this->database->transaction(function (Connection $db) use ($jobId, $token): void {
            $this->records($db)
                ->where('id', $jobId)
                ->where('state', 'running')
                ->where('worker_token', $token)
                ->update([
                    'state' => 'queued',
                    'worker_token' => null,
                    'lease_until' => null,
                ]);
        });
    }

    private function loadWorkbook(DriveContext $context, string $node, ?string $revisionId = null): DocumentSnapshot
    {
        try {
            $state = $this->documents->forContext($context)->content($node, $revisionId);
        } catch (NodeNotFoundException|PermissionDeniedException|ProfileRestrictionException) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if (!$state->content instanceof WorkbookContent) {
            throw new WorkbookProblem(
                $state->type === SpreadsheetDocumentType::KEY ? 'unsupported_content' : 'resource_unavailable',
                $state->type === SpreadsheetDocumentType::KEY ? 422 : 404,
            );
        }

        return $state;
    }

    private function driveHandle(DriveContext $context, string $driveId): DriveHandle
    {
        $handle = $this->vaulter->findDriveById($driveId);
        if ($handle === null) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if ($context->actor->isSystem()) {
            return $handle->asSystem('vaulter-sheets.exchange');
        }
        $user = $context->actor->authorizable();
        if ($user === null) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }

        return $handle->actingAs($user);
    }

    private function commitBlobBytes(DriveContext $context, string $bytes): string
    {
        $stream = fopen('php://temp', 'w+b');
        if (!is_resource($stream)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        try {
            fwrite($stream, $bytes);
            rewind($stream);
            $blob = $this->blobs->commit($stream, BlobScope::forUpload(
                'tenant',
                $context->operation->tenant->id,
                $context->operation->scope->id,
            ));

            return $blob->id;
        } finally {
            fclose($stream);
        }
    }

    private function readBlobBytes(string $blobId, int $maxBytes): string
    {
        $stream = $this->blobs->read($blobId);
        if (!is_resource($stream)) {
            throw new WorkbookProblem('snapshot_unavailable', 503);
        }
        try {
            $buf = '';
            while (!feof($stream)) {
                $chunk = fread($stream, 65_536);
                if ($chunk === false) {
                    throw new WorkbookProblem('snapshot_unavailable', 503);
                }
                if ($chunk === '') {
                    continue;
                }
                $buf .= $chunk;
                if (strlen($buf) > $maxBytes) {
                    throw new WorkbookProblem('limit_exceeded', 413);
                }
            }

            return $buf;
        } finally {
            fclose($stream);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function presentJob(stdClass $row): array
    {
        $report = null;
        if (is_string($row->report ?? null)) {
            try {
                $report = json_decode($row->report, true, 256, JSON_THROW_ON_ERROR);
            } catch (JsonException) {
                $report = null;
            }
        }
        $options = [];
        if (is_string($row->options ?? null)) {
            try {
                $decoded = json_decode($row->options, true, 64, JSON_THROW_ON_ERROR);
                if (is_array($decoded)) {
                    foreach ($decoded as $k => $v) {
                        $keyStr = (string) $k;
                        if (!str_starts_with($keyStr, '_')) {
                            $options[$keyStr] = $v;
                        }
                    }
                }
            } catch (JsonException) {
                $options = [];
            }
        }

        return [
            'exchange_id' => self::str($row->id ?? null),
            'request_key' => self::str($row->request_key ?? null),
            'kind' => self::str($row->kind ?? null),
            'format' => self::str($row->format ?? null),
            'state' => self::str($row->state ?? null),
            'generation' => self::intVal($row->generation ?? null),
            'source_position' => self::intVal($row->source_position ?? null),
            'result_receipt_id' => $row->result_receipt_id ?? null,
            'output_blob_id' => $row->output_blob_id ?? null,
            'source_blob_id' => self::str($row->source_blob_id ?? null),
            'options' => $options,
            'report' => $report,
            'error_code' => $row->error_code ?? null,
        ];
    }

    /** @param array{tenant_id: int|string, project_scope: string, subject_type: string, subject_id: int|string, document_id: string, request_key: string} $scope */
    private function assertCapacity(Connection $db, ExchangeActorScope $actor, array $scope, int $limit): void
    {
        $active = $this->records($db)->where($actor->columns())->whereIn('state', ['queued', 'running']);
        if ($active->count() >= $limit && !$this->records($db)->where($scope)->exists()) {
            throw new WorkbookProblem('too_many_exchanges', 429, ['limit' => $limit]);
        }
    }

    private function records(Connection $db): Builder
    {
        return $db->table($this->schema->table('sheets_exchange_jobs'));
    }

    private function intConfig(string $key, int $default): int
    {
        $value = config($key, $default);

        return is_int($value) && $value > 0 ? $value : $default;
    }

    private function isUuid(string $value): bool
    {
        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iD', $value) === 1;
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
