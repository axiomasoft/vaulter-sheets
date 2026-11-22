<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\ManagedDocumentCodec;
use Vaulter\Documents\Exceptions\InvalidDocumentContentException;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Media\Contracts\Cas\BlobPins;
use Vaulter\Media\Contracts\Cas\BlobStore;
use Vaulter\Media\ValueObjects\Cas\BlobScope;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;

final readonly class WorkbookCodec implements ManagedDocumentCodec
{
    public const string PROFILE = 'univer-oss-basic-1';

    private const array PLUGINS = [
        'data-validation', 'docs', 'engine-formula', 'engine-render', 'sheets',
        'sheets-conditional-formatting', 'sheets-data-validation', 'sheets-filter',
        'sheets-formula', 'sheets-hyper-link', 'sheets-numfmt',
    ];

    public function __construct(private BlobStore $blobs, private BlobPins $pins) {}

    public static function profile(): stdClass
    {
        return (object) [
            'id' => self::PROFILE,
            'engine' => '@univerjs/core@1.5.2',
            'plugins' => array_map(static fn (string $name): stdClass => (object) [
                'name' => '@univerjs/'.$name, 'version' => '1.5.2',
            ], self::PLUGINS),
        ];
    }

    public static function blank(): WorkbookContent
    {
        $id = (string) Str::uuid();
        $sheet = (string) Str::uuid();

        return new WorkbookContent((object) [
            'format_version' => 2,
            'profile' => self::profile(),
            'native' => (object) [
                'id' => $id, 'name' => 'Workbook', 'appVersion' => '1.5.2', 'locale' => 'enUS',
                'styles' => new stdClass, 'resources' => [], 'sheetOrder' => [$sheet],
                'sheets' => (object) [$sheet => (object) [
                    'id' => $sheet, 'name' => 'Sheet1', 'rowCount' => 1000, 'columnCount' => 26,
                    'cellData' => new stdClass,
                ]],
            ],
            'tables' => [],
        ]);
    }

    public function maxSizeBytes(): int
    {
        return (int) config('vaulter-sheets.max_snapshot_bytes', 7 * 1024 * 1024);
    }

    public function decode(array $raw, int $schemaVersion): WorkbookContent
    {
        $workbook = $this->shape($raw);
        if ($schemaVersion !== 2 || !$this->hasProfile($workbook)
            || !($workbook->native ?? null) instanceof stdClass || property_exists($workbook, 'storage')) {
            throw InvalidDocumentContentException::malformedNode('workbook', 'format_version/profile/native');
        }
        $native = $workbook->native;
        if (!is_string($native->id ?? null) || !($native->sheets ?? null) instanceof stdClass
            || !is_array($native->sheetOrder ?? null) || !is_array($native->resources ?? null)
            || array_keys(get_object_vars($workbook)) !== array_keys(array_intersect_key(get_object_vars($workbook), array_flip(['format_version', 'profile', 'native', 'tables'])))) {
            throw InvalidDocumentContentException::malformedNode('workbook', 'native');
        }
        $this->validateBindings($workbook);

        return new WorkbookContent($workbook);
    }

    public function decodeStored(array $raw, int $schemaVersion): DocumentContent
    {
        if (($raw['storage'] ?? null) !== 'media_blob') {
            return $this->decode($raw, $schemaVersion);
        }
        $manifest = $this->shape($raw);
        if ($schemaVersion !== 2 || !$this->hasProfile($manifest) || self::blobId($raw) === null
            || preg_match('/^[a-f0-9]{64}$/D', (string) ($raw['sha256'] ?? '')) !== 1) {
            throw InvalidDocumentContentException::malformedNode('workbook', 'manifest');
        }

        return new WorkbookContent($manifest);
    }

    public function storagePayload(DocumentContent $content): array
    {
        return (array) $this->requireContent($content)->value();
    }

    public function prepare(DocumentContent $content, DriveContext $context): DocumentContent
    {
        if (self::blobId($content->toArray()) !== null || $content->sizeInBytes() <= (int) config('vaulter-sheets.inline_snapshot_bytes', 512 * 1024)) {
            return $content;
        }
        $bytes = $this->requireContent($content)->canonicalBytes();
        if (strlen($bytes) > $this->maxSizeBytes()) {
            throw InvalidDocumentContentException::tooLargeBytes(strlen($bytes), $this->maxSizeBytes());
        }
        $stream = fopen('php://temp', 'w+b');
        try {
            fwrite($stream, gzencode($bytes, 6));
            rewind($stream);
            $blob = $this->blobs->commit($stream, BlobScope::forUpload(
                'tenant', $context->operation->tenant->id, $context->operation->scope->id,
            ));
        } finally {
            fclose($stream);
        }
        $workbook = $this->requireContent($content)->value();

        return new WorkbookContent((object) [
            'format_version' => 2, 'profile' => $workbook->profile, 'storage' => 'media_blob',
            'blob_id' => (string) $blob->id, 'sha256' => $content->contentHash(), 'tables' => $workbook->tables,
        ]);
    }

    public function snapshot(DocumentContent $content): stdClass
    {
        $raw = $content->toArray();
        $id = self::blobId($raw);
        if ($id === null) {
            return $this->requireContent($content)->value();
        }
        $stream = $this->blobs->read($id);
        if (!is_resource($stream)) {
            throw new WorkbookProblem('snapshot_unavailable', 503);
        }
        try {
            $compressed = stream_get_contents($stream, $this->maxSizeBytes() + 65_536);
            $bytes = is_string($compressed) ? @gzdecode($compressed, $this->maxSizeBytes()) : false;
        } finally {
            fclose($stream);
        }
        if ($bytes === false || !hash_equals($content->contentHash(), hash('sha256', $bytes))) {
            throw new WorkbookProblem('snapshot_unavailable', 503);
        }

        return StrictJson::decode($bytes);
    }

    public function replacePayloadReference(string $kind, string $id, ?array $previous, ?array $next): void
    {
        $old = self::blobId($previous);
        $new = self::blobId($next);
        if ($old === $new) {
            return;
        }
        if ($new !== null) {
            $this->pins->pin($new, 'sheets.'.$kind, $id);
        }
        if ($old !== null) {
            $this->pins->unpin($old, 'sheets.'.$kind, $id);
        }
    }

    private function requireContent(DocumentContent $content): WorkbookContent
    {
        if (!$content instanceof WorkbookContent) {
            throw new WorkbookProblem('unsupported_content', 422);
        }

        return $content;
    }

    private static function blobId(?array $payload): ?string
    {
        $id = $payload['blob_id'] ?? null;

        return ($payload['storage'] ?? null) === 'media_blob' && is_string($id) && $id !== '' ? $id : null;
    }

    private function hasProfile(stdClass $workbook): bool
    {
        return ($workbook->format_version ?? null) === 2 && is_array($workbook->tables ?? null)
            && CanonicalJson::encode($workbook->profile ?? null) === CanonicalJson::encode(self::profile());
    }

    private function shape(array $raw): stdClass
    {
        // Documents receives associative JSON. Recover the native map shapes at the boundary.
        $workbook = json_decode(json_encode((object) $raw, JSON_THROW_ON_ERROR), false, 256, JSON_THROW_ON_ERROR);
        if (isset($workbook->native) && $workbook->native instanceof stdClass) {
            $native = $workbook->native;
            $native->styles = (object) ($native->styles ?? []);
            $native->sheets = (object) ($native->sheets ?? []);
            foreach ($native->sheets as $sheet) {
                if (!$sheet instanceof stdClass) {
                    throw InvalidDocumentContentException::malformedNode('workbook', 'sheets');
                }
                foreach (['rowData', 'columnData', 'cellData'] as $map) {
                    if (isset($sheet->{$map})) {
                        $sheet->{$map} = (object) $sheet->{$map};
                    }
                }
                if (isset($sheet->cellData)) {
                    foreach ($sheet->cellData as $index => $row) {
                        $sheet->cellData->{$index} = (object) $row;
                    }
                }
            }
        }
        return $workbook;
    }

    private function validateBindings(stdClass $workbook): void
    {
        $sheets = $workbook->native->sheets;
        $tables = [];
        foreach ($workbook->native->sheetOrder as $id) {
            if (!is_string($id) || !isset($sheets->{$id}) || $sheets->{$id}->id !== $id) {
                throw InvalidDocumentContentException::malformedNode('workbook', 'sheetOrder');
            }
        }
        foreach ($workbook->tables as $table) {
            if (!$table instanceof stdClass || !is_string($table->table_id ?? null) || $table->table_id === ''
                || isset($tables[$table->table_id]) || !is_string($table->sheet_id ?? null)
                || !isset($sheets->{$table->sheet_id}) || !is_int($table->header_row ?? null) || $table->header_row < 1
                || !is_array($table->rows ?? null) || !is_array($table->columns ?? null)) {
                throw InvalidDocumentContentException::malformedNode('workbook', 'tables');
            }
            $tables[$table->table_id] = true;
            $this->validateAxis($table->rows, 'row', $table->header_row + 1);
            $this->validateAxis($table->columns, 'column', 1);
        }
    }

    private function validateAxis(array $bindings, string $axis, int $minimum): void
    {
        $ids = [];
        $positions = [];
        foreach ($bindings as $binding) {
            $id = $binding->{$axis.'_id'} ?? null;
            $position = $binding->{$axis} ?? null;
            if (!is_string($id) || $id === '' || isset($ids[$id]) || !is_int($position)
                || $position < $minimum || $position > 9_007_199_254_740_991 || isset($positions[$position])) {
                throw InvalidDocumentContentException::malformedNode('workbook', $axis.' bindings');
            }
            $ids[$id] = true;
            $positions[$position] = true;
        }
    }
}
