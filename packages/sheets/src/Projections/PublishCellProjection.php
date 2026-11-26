<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Projections;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Str;
use stdClass;
use Vaulter\Contracts\Observability\MetricsRecorder;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Documents\Enums\DocumentEventType;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Documents\Events\Revisions\DocumentRestored;
use Vaulter\Events\EventTypeContract;
use Vaulter\Events\Outbox\ConsumeResult;
use Vaulter\Events\Outbox\DeliveryClass;
use Vaulter\Events\Outbox\DeliveryControl;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Events\Outbox\OutboxEnvelope;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Support\WorkbookClock;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final readonly class PublishCellProjection implements OutboxConsumer
{
    public const string ID = 'sheets.cell_projection';

    public function __construct(
        private VaulterDatabase $database,
        private SchemaHelpers $schema,
        private WorkbookCodec $codec,
        private WorkbookRuntime $runtime,
        private ReadCellProjection $projections,
        private MetricsRecorder $metrics,
    ) {}

    public function id(): string
    {
        return self::ID;
    }

    public function deliveryClass(): DeliveryClass
    {
        return DeliveryClass::Durable;
    }

    public function subscribes(EventTypeContract $type): bool
    {
        return $type === DocumentEventType::DocumentUpdated || $type === DocumentEventType::DocumentRestored;
    }

    public function handle(DocumentContentUpdated|DocumentRestored $event): void
    {
        if ($event->version->type === SpreadsheetDocumentType::KEY) {
            $this->publish($event->node->id, $event->epoch, $event->stateVersion);
        }
    }

    public function consume(OutboxEnvelope $envelope, DeliveryControl $control): ConsumeResult
    {
        $subject = $envelope->payload['subject'] ?? null;
        $data = $envelope->payload['data'] ?? null;
        if (!is_array($subject) || ($subject['type'] ?? null) !== 'node' || !is_string($subject['id'] ?? null)
            || !is_array($data) || !is_int($data['epoch'] ?? null) || !is_int($data['state_version'] ?? null)) {
            return ConsumeResult::dead('invalid_document_event');
        }

        $this->publish($subject['id'], $data['epoch'], $data['state_version']);

        return ConsumeResult::done();
    }

    public function canPublish(WorkbookMarker $source, WorkbookMarker $current): bool
    {
        return $source->generation === $current->generation
            && $source->position === $current->position
            && hash_equals($source->sha256, $current->sha256);
    }

    public function publish(string $node, int $generation, int $position): bool
    {
        $db = $this->database->connection();
        $source = $this->source($db, 'node_id', $node);
        if ($source === null || $source['marker']->generation !== $generation || $source['marker']->position !== $position) {
            return false;
        }
        $document = $source['document'];
        $marker = $source['marker'];
        $ready = $this->projections->ready($document);
        if ($ready !== null) {
            return $this->canPublish($marker, $ready['marker']);
        }

        return $this->metrics->timing('projection_build', function () use ($db, $document, $marker): bool {
            $payload = $db->table($this->schema->table('document_payloads'))->useWritePdo()
                ->where('document_id', $document)->where('content_hash', $marker->sha256)->value('content');
            $raw = is_string($payload) ? StrictJson::decode($payload) : null;
            if (!$raw instanceof stdClass) {
                return false;
            }
            $content = $this->codec->decodeStored(get_object_vars($raw), 2);
            if (!hash_equals($marker->sha256, $content->contentHash())) {
                return false;
            }
            $snapshot = $this->codec->snapshot($content);
            $native = self::object($snapshot->native ?? null);
            $locale = is_string($native->locale ?? null) ? $native->locale : 'enUS';
            $build = (string) Str::uuid7();

            // Commit the FK to the document before any bulk work. Child inserts then only lock their build.
            $this->database->transaction(fn (Connection $db): bool => $this->projections->table($db, 'builds')->insert([
                'id' => $build, 'document_id' => $document, 'generation' => $marker->generation,
                'source_position' => $marker->position, 'source_sha256' => $marker->sha256,
                'projector_version' => ReadCellProjection::VERSION, 'profile_id' => WorkbookCodec::PROFILE,
                'locale' => $locale, 'state' => 'building',
            ]));

            try {
                $this->build($build, $snapshot, $native, $marker);
                $published = $this->database->transaction(function (Connection $db) use ($document, $build, $marker): bool {
                    // This is the same document row locked by writers. Read the marker after acquiring it.
                    $locked = $db->table($this->schema->table('documents'))->where('id', $document)->lockForUpdate()->first(['id']);
                    $current = $locked === null ? null : $this->source($db, 'id', $document);
                    if ($current === null || !$this->canPublish($marker, $current['marker'])) {
                        return false;
                    }
                    if ($this->projections->ready($document) !== null) {
                        return true;
                    }
                    $now = WorkbookClock::nowExpr($db);
                    $updated = $this->projections->table($db, 'builds')->where('id', $build)->where('state', 'building')->update([
                        'state' => 'ready', 'completed_at' => $now, 'calculated_position' => $marker->position,
                    ]);
                    if ($updated !== 1) {
                        return false;
                    }
                    $this->projections->table($db, 'heads')->upsert([
                        'document_id' => $document, 'build_id' => $build, 'build_state' => 'ready', 'published_at' => $now,
                    ], ['document_id'], ['build_id', 'build_state', 'published_at']);

                    return true;
                });
            } finally {
                $this->database->transaction(function (Connection $db) use ($document, $build): void {
                    $this->projections->table($db, 'builds')->where('id', $build)->where('state', 'building')->delete();
                    // The head's FK also protects the live build from accidental deletion.
                    $this->projections->table($db, 'builds')->where('document_id', $document)
                        ->whereNotIn('id', $this->projections->table($db, 'heads')->select('build_id')->where('document_id', $document))
                        ->where(static fn (Builder $query): Builder => $query->where('state', 'ready')
                            ->orWhere(static fn (Builder $orphan): Builder => $orphan->where('state', 'building')
                                ->where('created_at', '<', WorkbookClock::futureTimestamp($db, -86_400))))
                        ->delete();
                });
            }

            return $published;
        });
    }

    /** @return array{document: string, marker: WorkbookMarker}|null */
    private function source(Connection $db, string $by, string $id): ?array
    {
        $row = $db->table($this->schema->table('documents').' as document')->useWritePdo()
            ->join($this->schema->table('document_payloads').' as payload', 'payload.document_id', '=', 'document.id')
            ->leftJoin($this->schema->table('document_sync_states').' as sync_state', 'sync_state.document_id', '=', 'document.id')
            ->where('document.'.$by, $id)->where('document.type', SpreadsheetDocumentType::KEY)
            ->where('document.schema_version', 2)->whereNull('sync_state.pending_generation')
            ->first(['document.id', 'document.collab_epoch', 'document.state_version', 'payload.content_hash']);
        if ($row === null || (!is_string($row->id) && !is_int($row->id)) || !is_string($row->content_hash)
            || !is_numeric($row->collab_epoch) || !is_numeric($row->state_version)) {
            return null;
        }

        return ['document' => (string) $row->id, 'marker' => new WorkbookMarker((int) $row->collab_epoch, (int) $row->state_version, $row->content_hash)];
    }

    private function build(string $build, stdClass $snapshot, stdClass $native, WorkbookMarker $marker): void
    {
        $sheets = self::object($native->sheets ?? null);
        $styles = self::object($native->styles ?? null);
        $order = is_array($native->sheetOrder ?? null) ? array_values($native->sheetOrder) : [];
        $sheetRows = [];
        $selectors = [];
        foreach ($order as $index => $id) {
            $id = self::string($id);
            $sheet = self::object($sheets->{$id} ?? null);
            $rows = self::integer($sheet->rowCount ?? null);
            $columns = self::integer($sheet->columnCount ?? null);
            $sheetRows[] = [
                'build_id' => $build, 'sheet_id' => $id, 'ordinal' => $index + 1,
                'title' => self::string($sheet->name ?? $id), 'row_count' => $rows, 'column_count' => $columns,
                'empty_formats' => self::emptyFormats($sheet, $styles),
            ];
            $selectors[] = self::selector($id, 1, 1, min($rows, 9_999_999), min($columns, 18_278));
        }
        $this->database->transaction(function (Connection $db) use ($build, $snapshot, $sheetRows): void {
            $this->insert($db, 'sheets', $sheetRows);
            $this->bindings($db, $build, $snapshot);
            // The catalog's browser contract includes the complete native workbook and resources.
            $this->projections->table($db, 'builds')->where('id', $build)->update(['snapshot' => CanonicalJson::encode($snapshot)]);
        });

        if ($selectors !== []) {
            $this->cells($build, $snapshot, $marker, $selectors);
        }
    }

    private static function emptyFormats(stdClass $sheet, stdClass $styles): string
    {
        $formats = ['default' => self::pattern($sheet->defaultStyle ?? null, $styles)];
        foreach (['row', 'column'] as $axis) {
            $items = new stdClass;
            foreach (get_object_vars(self::object($sheet->{$axis.'Data'} ?? null)) as $index => $entry) {
                $pattern = self::pattern(self::object($entry)->s ?? null, $styles);
                if ($pattern !== null) {
                    $items->{(string) ((int) $index + 1)} = $pattern;
                }
            }
            $formats[$axis] = $items;
        }

        return json_encode($formats, JSON_THROW_ON_ERROR);
    }

    private static function pattern(mixed $style, stdClass $styles): string|false|null
    {
        $style = self::object(is_string($style) ? ($styles->{$style} ?? null) : $style);
        if (!property_exists($style, 'n')) {
            return null;
        }
        $pattern = self::object($style->n)->pattern ?? null;

        return is_string($pattern) && $pattern !== '' ? $pattern : false;
    }

    private function bindings(Connection $db, string $build, stdClass $snapshot): void
    {
        $tables = [];
        $axes = ['column' => [], 'row' => []];
        foreach (self::objects($snapshot->tables ?? null) as $table) {
            $tableId = self::string($table->table_id ?? null);
            $keys = ['build_id' => $build, 'table_id' => $tableId];
            $tables[] = $keys + [
                'sheet_id' => self::string($table->sheet_id ?? null), 'title' => $tableId,
                'header_row' => self::integer($table->header_row ?? null),
            ];
            foreach ($axes as $axis => $_rows) {
                foreach (self::objects($table->{$axis.'s'} ?? null) as $index => $binding) {
                    $id = self::string($binding->{$axis.'_id'} ?? null);
                    $axes[$axis][] = $keys + [
                        $axis.'_id' => $id, $axis.'_no' => self::integer($binding->{$axis} ?? null), 'ordinal' => $index + 1,
                    ] + ($axis === 'column' ? ['title' => $id] : []);
                }
            }
        }
        $this->insert($db, 'tables', $tables);
        $this->insert($db, 'columns', $axes['column']);
        $this->insert($db, 'rows', $axes['row']);
    }

    /** @param non-empty-list<array{sheet_id: string, range: string}> $selectors */
    private function cells(string $build, stdClass $snapshot, WorkbookMarker $marker, array $selectors): void
    {
        try {
            $response = $this->runtime->exchange((object) [
                'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'read',
                'base' => (object) get_object_vars($marker), 'profile_id' => WorkbookCodec::PROFILE,
                'workbook' => $snapshot, 'selector' => (object) [
                    'ranges' => array_map(static fn (array $selector): stdClass => (object) $selector, $selectors),
                    'sparse' => true,
                ],
            ]);
        } catch (WorkbookProblem $problem) {
            $parts = $problem->problem === 'limit_exceeded' ? self::split($selectors) : [];
            if ($parts === []) {
                throw $problem;
            }
            foreach ($parts as $part) {
                $this->cells($build, $snapshot, $marker, $part);
            }

            return;
        }
        $ranges = self::objects(self::object($response->data ?? null)->ranges ?? null);
        if (count($ranges) !== count($selectors)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $rows = [];
        foreach ($ranges as $index => $range) {
            $selector = $selectors[$index];
            if (($range->sheet_id ?? null) !== $selector['sheet_id'] || ($range->range ?? null) !== $selector['range']
                || !is_array($range->cells ?? null)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            foreach ($range->cells as $cell) {
                if (!$cell instanceof stdClass || ($cell->sheet_id ?? null) !== $selector['sheet_id']
                    || !is_string($cell->display_text ?? null)) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                $formula = is_string($cell->formula ?? null) ? $cell->formula : null;
                $value = $cell->value ?? null;
                $error = is_string($cell->calc_error ?? null) ? $cell->calc_error : null;
                $rows[] = [
                    'build_id' => $build, 'sheet_id' => $selector['sheet_id'],
                    'row_no' => self::integer($cell->row ?? null), 'column_no' => self::integer($cell->column ?? null),
                    'kind' => $formula !== null ? 'formula' : ($value === null ? 'blank' : 'literal'),
                    'formula' => $formula, 'literal' => $formula === null && $value !== null ? json_encode($value, JSON_THROW_ON_ERROR) : null,
                    'calculated' => $formula !== null && $error === null ? json_encode($value, JSON_THROW_ON_ERROR) : null,
                    'calc_error' => $error, 'display_text' => $cell->display_text,
                    'number_format' => is_string($cell->number_format ?? null) ? $cell->number_format : null,
                ];
            }
        }
        $this->database->transaction(fn (Connection $db) => $this->insert($db, 'cells', $rows));
    }

    /**
     * @param  non-empty-list<array{sheet_id: string, range: string}>       $selectors
     * @return list<non-empty-list<array{sheet_id: string, range: string}>>
     */
    private static function split(array $selectors): array
    {
        if (count($selectors) > 1) {
            return array_chunk($selectors, max(1, intdiv(count($selectors) + 1, 2)));
        }
        $selector = $selectors[0];
        $bounds = ReadCellProjection::bounds($selector['range']);
        if ($bounds === null) {
            return [];
        }
        [$row, $column, $lastRow, $lastColumn] = $bounds;
        if ($lastRow - $row >= $lastColumn - $column && $lastRow > $row) {
            $middle = intdiv($row + $lastRow, 2);

            return [[self::selector($selector['sheet_id'], $row, $column, $middle, $lastColumn)],
                [self::selector($selector['sheet_id'], $middle + 1, $column, $lastRow, $lastColumn)]];
        }
        if ($lastColumn > $column) {
            $middle = intdiv($column + $lastColumn, 2);

            return [[self::selector($selector['sheet_id'], $row, $column, $lastRow, $middle)],
                [self::selector($selector['sheet_id'], $row, $middle + 1, $lastRow, $lastColumn)]];
        }

        return [];
    }

    /** @return array{sheet_id: string, range: string} */
    private static function selector(string $sheet, int $row, int $column, int $lastRow, int $lastColumn): array
    {
        return ['sheet_id' => $sheet, 'range' => ReadCellProjection::address($column, $row).':'.ReadCellProjection::address($lastColumn, $lastRow)];
    }

    /** @param list<array<string, mixed>> $rows */
    private function insert(Connection $db, string $entity, array $rows): void
    {
        foreach (array_chunk($rows, $db->getDriverName() === 'pgsql' ? 1_000 : 80) as $chunk) {
            $this->projections->table($db, $entity)->insert($chunk);
        }
    }

    private static function object(mixed $value): stdClass
    {
        return $value instanceof stdClass ? $value : new stdClass;
    }

    /** @return list<stdClass> */
    private static function objects(mixed $value): array
    {
        return is_array($value) ? array_values(array_filter($value, static fn (mixed $item): bool => $item instanceof stdClass)) : [];
    }

    private static function string(mixed $value): string
    {
        return is_string($value) ? $value : throw new WorkbookProblem('unsupported_content', 422);
    }

    private static function integer(mixed $value): int
    {
        return is_int($value) && $value > 0 && $value <= 2_147_483_647 ? $value : throw new WorkbookProblem('unsupported_content', 422);
    }
}
