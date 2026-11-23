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
        $limit = config('vaulter-sheets.max_snapshot_bytes', 7 * 1024 * 1024);

        return is_int($limit) && $limit > 0 ? $limit : 7 * 1024 * 1024;
    }

    /**
     * @param array<string, mixed> $raw
     */
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

    /**
     * @param array<string, mixed> $raw
     */
    public function decodeStored(array $raw, int $schemaVersion): DocumentContent
    {
        if (($raw['storage'] ?? null) !== 'media_blob') {
            return $this->decode($raw, $schemaVersion);
        }
        $manifest = $this->shape($raw);
        $sha = is_string($raw['sha256'] ?? null) ? $raw['sha256'] : '';
        if ($schemaVersion !== 2 || !$this->hasProfile($manifest) || self::blobId($raw) === null
            || preg_match('/^[a-f0-9]{64}$/D', $sha) !== 1) {
            throw InvalidDocumentContentException::malformedNode('workbook', 'manifest');
        }

        return new WorkbookContent($manifest);
    }

    /**
     * @return array<string, mixed>
     */
    public function storagePayload(DocumentContent $content): array
    {
        $out = [];
        foreach (get_object_vars($this->requireContent($content)->value()) as $key => $val) {
            $out[(string) $key] = $val;
        }

        return $out;
    }

    public function prepare(DocumentContent $content, DriveContext $context): DocumentContent
    {
        $inlineRaw = config('vaulter-sheets.inline_snapshot_bytes', 512 * 1024);
        $inlineLimit = is_int($inlineRaw) && $inlineRaw > 0 ? $inlineRaw : 512 * 1024;
        if (self::blobId($content->toArray()) !== null || $content->sizeInBytes() <= $inlineLimit) {
            return $content;
        }
        $bytes = $this->requireContent($content)->canonicalBytes();
        if (strlen($bytes) > $this->maxSizeBytes()) {
            throw InvalidDocumentContentException::tooLargeBytes(strlen($bytes), $this->maxSizeBytes());
        }
        $compressed = gzencode($bytes, 6);
        $stream = fopen('php://temp', 'w+b');
        if (!is_string($compressed) || !is_resource($stream)) {
            if (is_resource($stream)) {
                fclose($stream);
            }
            throw new WorkbookProblem('runtime_failed', 503);
        }
        try {
            fwrite($stream, $compressed);
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
            'blob_id' => $blob->id, 'sha256' => $content->contentHash(), 'tables' => $workbook->tables,
        ]);
    }

    public function snapshot(DocumentContent $content): stdClass
    {
        $value = $this->requireContent($content)->value();
        $id = self::blobId($this->objectMap($value));
        if ($id === null) {
            return $value;
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
        $decoded = StrictJson::decode($bytes);
        if (!$decoded instanceof stdClass) {
            throw new WorkbookProblem('snapshot_unavailable', 503);
        }

        return $decoded;
    }

    /**
     * @param array<string, mixed>|null $previous
     * @param array<string, mixed>|null $next
     */
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

    /**
     * @return array<string, mixed>
     */
    private function objectMap(stdClass $obj): array
    {
        $out = [];
        foreach (get_object_vars($obj) as $k => $v) {
            $out[(string) $k] = $v;
        }

        return $out;
    }

    private function requireContent(DocumentContent $content): WorkbookContent
    {
        if (!$content instanceof WorkbookContent) {
            throw new WorkbookProblem('unsupported_content', 422);
        }

        return $content;
    }

    /**
     * @param array<string, mixed>|null $payload
     */
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

    /**
     * @param array<string, mixed> $raw
     */
    private function shape(array $raw): stdClass
    {
        // Documents receives associative JSON. Recover the native map shapes at the boundary.
        $workbook = StrictJson::decode(json_encode((object) $raw, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR));
        if (!$workbook instanceof stdClass) {
            throw InvalidDocumentContentException::malformedNode('workbook', 'root');
        }
        if (isset($workbook->native) && $workbook->native instanceof stdClass) {
            $native = $workbook->native;
            $native->styles = (object) ($native->styles ?? []);
            $native->sheets = (object) ($native->sheets ?? []);
            foreach (get_object_vars($native->sheets) as $sheet) {
                if (!$sheet instanceof stdClass) {
                    throw InvalidDocumentContentException::malformedNode('workbook', 'sheets');
                }
                foreach (['rowData', 'columnData', 'cellData'] as $map) {
                    if (isset($sheet->{$map})) {
                        $sheet->{$map} = (object) $sheet->{$map};
                    }
                }
                if (isset($sheet->cellData) && $sheet->cellData instanceof stdClass) {
                    foreach (get_object_vars($sheet->cellData) as $index => $row) {
                        $sheet->cellData->{$index} = (object) $row;
                    }
                }
            }
        }

        return $workbook;
    }

    private function validateBindings(stdClass $workbook): void
    {
        $native = ($workbook->native ?? null) instanceof stdClass ? $workbook->native : new stdClass;
        $sheets = ($native->sheets ?? null) instanceof stdClass ? $native->sheets : new stdClass;
        $sheetOrder = is_array($native->sheetOrder ?? null) ? $native->sheetOrder : [];
        $tablesRaw = is_array($workbook->tables ?? null) ? $workbook->tables : [];
        $tables = [];
        foreach ($sheetOrder as $id) {
            if (!is_string($id) || !isset($sheets->{$id}) || !$sheets->{$id} instanceof stdClass || ($sheets->{$id}->id ?? null) !== $id) {
                throw InvalidDocumentContentException::malformedNode('workbook', 'sheetOrder');
            }
        }
        foreach ($tablesRaw as $table) {
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

    /**
     * @param array<int|string, mixed> $bindings
     */
    private function validateAxis(array $bindings, string $axis, int $minimum): void
    {
        $ids = [];
        $positions = [];
        foreach ($bindings as $binding) {
            if (!$binding instanceof stdClass) {
                throw InvalidDocumentContentException::malformedNode('workbook', $axis.' bindings');
            }
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
