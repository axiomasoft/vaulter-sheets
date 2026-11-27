<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Projections;

use Illuminate\Database\Connection;
use Illuminate\Database\Query\Builder;
use stdClass;
use Vaulter\Database\VaulterDatabase;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

/**
 * @phpstan-type ProjectionHead array{id: string, marker: WorkbookMarker, protocol: ?string}
 * @phpstan-type Rectangle array{int, int, int, int}
 */
final readonly class ReadCellProjection
{
    public const int VERSION = 1;

    public function __construct(private VaulterDatabase $database, private SchemaHelpers $schema) {}

    /** @return ProjectionHead|null */
    public function ready(string $document): ?array
    {
        $db = $this->database->connection();
        $head = $db->table($this->schema->table('sheets_projection_heads').' as head')->useWritePdo()
            ->join($this->schema->table('sheets_projection_builds').' as build', 'build.id', '=', 'head.build_id')
            ->join($this->schema->table('documents').' as document', 'document.id', '=', 'head.document_id')
            ->join($this->schema->table('document_payloads').' as payload', 'payload.document_id', '=', 'document.id')
            ->leftJoin($this->schema->table('document_sync_states').' as sync_state', 'sync_state.document_id', '=', 'document.id')
            ->where('head.document_id', $document)->where('build.state', 'ready')
            ->where('build.projector_version', self::VERSION)->where('build.profile_id', WorkbookCodec::PROFILE)
            ->where('document.type', SpreadsheetDocumentType::KEY)->where('document.schema_version', 2)
            ->whereColumn('build.generation', 'document.collab_epoch')
            ->whereColumn('build.source_position', 'document.state_version')
            ->whereColumn('build.source_sha256', 'payload.content_hash')
            ->whereColumn('build.calculated_position', 'build.source_position')
            ->whereNull('sync_state.pending_generation')->whereNotNull('build.snapshot')
            ->first(['build.id', 'build.generation', 'build.source_position', 'build.source_sha256', 'sync_state.collab_protocol']);
        if ($head === null || !is_string($head->id) || !is_numeric($head->generation)
            || !is_numeric($head->source_position) || !is_string($head->source_sha256)) {
            return null;
        }

        return [
            'id' => $head->id,
            'marker' => new WorkbookMarker((int) $head->generation, (int) $head->source_position, $head->source_sha256),
            'protocol' => is_string($head->collab_protocol) ? $head->collab_protocol : null,
        ];
    }

    public function snapshot(string $build): ?stdClass
    {
        $bytes = $this->query('builds')->where('id', $build)->value('snapshot');
        $snapshot = is_string($bytes) ? StrictJson::decode($bytes) : null;

        return $snapshot instanceof stdClass ? $snapshot : null;
    }

    public function binding(string $build, string $id): stdClass
    {
        $table = $this->query('tables')->where('build_id', $build)->where('table_id', $id)
            ->first(['sheet_id', 'header_row']);
        if ($table === null || !is_string($table->sheet_id) || !is_numeric($table->header_row)) {
            throw new WorkbookProblem('unknown_target', 422);
        }
        $binding = (object) ['table_id' => $id, 'sheet_id' => $table->sheet_id, 'header_row' => (int) $table->header_row];
        foreach (['column', 'row'] as $axis) {
            $records = $this->query($axis.'s')->where('build_id', $build)->where('table_id', $id)
                ->orderBy('ordinal')->get([$axis.'_id', $axis.'_no']);
            $binding->{$axis.'s'} = $records->map(static fn (stdClass $record): stdClass => (object) [
                $axis.'_id' => $record->{$axis.'_id'}, $axis => self::int($record->{$axis.'_no'}),
            ])->all();
        }

        return $binding;
    }

    /**
     * @param  ProjectionHead           $head
     * @param  array<string, Rectangle> $ranges
     * @param  list<int>                $rows
     * @param  list<int>                $columns
     * @return list<stdClass>
     */
    public function ranges(array $head, string $sheet, array $ranges, int $limit, array $rows = [], array $columns = []): array
    {
        if ($ranges === []) {
            return [];
        }
        $build = $head['id'];
        $dimensions = $this->query('sheets')->where('build_id', $build)->where('sheet_id', $sheet)
            ->first(['row_count', 'column_count', 'empty_formats']);
        $maxRow = self::int($dimensions->row_count ?? null);
        $maxColumn = self::int($dimensions->column_count ?? null);
        $rawFormats = $dimensions->empty_formats ?? null;
        $formats = is_string($rawFormats) ? json_decode($rawFormats, flags: JSON_THROW_ON_ERROR) : null;
        $rowFormats = $formats instanceof stdClass && ($formats->row ?? null) instanceof stdClass ? $formats->row : new stdClass;
        $columnFormats = $formats instanceof stdClass && ($formats->column ?? null) instanceof stdClass ? $formats->column : new stdClass;
        $defaultFormat = $formats instanceof stdClass ? ($formats->default ?? null) : null;
        foreach ($ranges as [$firstRow, $firstColumn, $lastRow, $lastColumn]) {
            if (($lastRow - $firstRow + 1) * ($lastColumn - $firstColumn + 1) > $limit) {
                throw new WorkbookProblem('limit_exceeded', 413);
            }
            if ($lastRow > $maxRow || $lastColumn > $maxColumn) {
                throw new WorkbookProblem('unknown_target', 422);
            }
        }

        $query = $this->query('cells')->where('build_id', $build)->where('sheet_id', $sheet);
        if (count($ranges) === 1) {
            [$firstRow, $firstColumn, $lastRow, $lastColumn] = reset($ranges);
            $query->whereBetween('row_no', [$firstRow, $lastRow])->whereBetween('column_no', [$firstColumn, $lastColumn]);
        } else {
            $query->whereIntegerInRaw('row_no', $rows)->whereIntegerInRaw('column_no', $columns);
        }
        $cells = [];
        foreach ($query->get() as $cell) {
            $cells[self::int($cell->row_no)][self::int($cell->column_no)] = $cell;
        }

        $result = [];
        foreach ($ranges as $range => [$firstRow, $firstColumn, $lastRow, $lastColumn]) {
            $readback = [];
            for ($row = $firstRow; $row <= $lastRow; $row++) {
                for ($column = $firstColumn; $column <= $lastColumn; $column++) {
                    $cell = $cells[$row][$column] ?? null;
                    $literal = self::scalar($cell->literal ?? null);
                    $format = $cell === null ? ($rowFormats->{(string) $row} ?? $columnFormats->{(string) $column} ?? $defaultFormat)
                        : ($cell->number_format ?? null);
                    $readback[] = (object) [
                        'sheet_id' => $sheet, 'a1' => self::address($column, $row), 'row' => $row, 'column' => $column,
                        'formula' => $cell->formula ?? null,
                        'value' => $cell->calc_error ?? self::scalar($cell->calculated ?? null) ?? $literal,
                        'literal' => $literal, 'calc_error' => $cell->calc_error ?? null,
                        'number_format' => is_string($format) ? $format : null, 'display_text' => $cell->display_text ?? '',
                        'calculated_position' => $head['marker']->position,
                    ];
                }
            }
            $result[] = (object) ['sheet_id' => $sheet, 'range' => $range, 'cells' => $readback];
        }

        return $result;
    }

    /** @return Rectangle|null */
    public static function bounds(string $range): ?array
    {
        if (preg_match('/^([A-Z]{1,3})([1-9]\d{0,6})(?::([A-Z]{1,3})([1-9]\d{0,6}))?$/D', $range, $parts) !== 1) {
            return null;
        }
        $firstRow = (int) $parts[2];
        $firstColumn = self::columnNumber($parts[1]);
        $lastRow = (int) ($parts[4] ?? $parts[2]);
        $lastColumn = self::columnNumber($parts[3] ?? $parts[1]);

        return $lastRow >= $firstRow && $lastColumn >= $firstColumn
            ? [$firstRow, $firstColumn, $lastRow, $lastColumn] : null;
    }

    public static function address(int $column, int $row): string
    {
        $letters = '';
        while ($column > 0) {
            $column--;
            $letters = chr(65 + $column % 26).$letters;
            $column = intdiv($column, 26);
        }

        return $letters.$row;
    }

    private static function columnNumber(string $letters): int
    {
        $column = 0;
        foreach (str_split($letters) as $letter) {
            $column = $column * 26 + ord($letter) - 64;
        }

        return $column;
    }

    private function query(string $entity): Builder
    {
        return $this->table($this->database->connection(), $entity)->useWritePdo();
    }

    public function table(Connection $db, string $entity): Builder
    {
        return $db->table($this->schema->table('sheets_projection_'.$entity));
    }

    private static function int(mixed $value): int
    {
        return is_numeric($value) ? (int) $value : 0;
    }

    private static function scalar(mixed $value): bool|float|int|string|null
    {
        $decoded = is_string($value) ? json_decode($value, flags: JSON_THROW_ON_ERROR) : $value;

        return is_scalar($decoded) ? $decoded : null;
    }
}
