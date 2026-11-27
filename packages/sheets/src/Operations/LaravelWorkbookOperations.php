<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Operations;

use Closure;
use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\Data\Documents\DocumentMetadata;
use Vaulter\Documents\Data\Snapshots\DocumentSnapshot;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Documents\Exceptions\NotADocumentException;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Exceptions\Profiles\ProfileRestrictionException;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Sheets\Actions\CommitWorkbookCommand;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Exchange\WorkbookExchange;
use Vaulter\Sheets\Projections\ReadCellProjection;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

/**
 * @phpstan-import-type ProjectionHead from ReadCellProjection
 * @phpstan-import-type Rectangle from ReadCellProjection
 */
final readonly class LaravelWorkbookOperations implements WorkbookOperations
{
    public function __construct(
        private DocumentsManager $documents,
        private WorkbookCodec $codec,
        private WorkbookRuntime $runtime,
        private CommitWorkbookCommand $commitCommand,
        private NodeEditAccess $access,
        private WorkbookExchange $exchange,
        private ReadCellProjection $projections,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function catalog(DriveContext $context, string $node): array
    {
        $catalog = $this->projected($context, $node, function (array $head) use ($context, $node): ?array {
            $snapshot = $this->projections->snapshot($head['id']);

            return $snapshot === null ? null : $this->catalogData($context, $node, $head['marker'], $snapshot, true, $head['protocol']);
        });
        if ($catalog !== null) {
            return $catalog;
        }
        $state = $this->loadWorkbook($context, $node);
        $catalog = $this->catalogData($context, $node, self::marker($state), $this->codec->snapshot($state->content), $state->editable, $state->collabProtocol);
        $this->authorizeDelivery($context, $node);

        return $catalog;
    }

    /**
     * @return array{
     *     marker: WorkbookMarker,
     *     etag: string,
     *     profile: stdClass,
     *     workbook: stdClass,
     *     commands: list<string>,
     *     exchange: array{formats: list<'csv'|'xlsx'>, import: list<'csv'|'xlsx'>, export: list<'csv'|'xlsx'>}
     * }
     */
    private function catalogData(DriveContext $context, string $node, WorkbookMarker $marker, stdClass $snapshot, bool $editable, ?string $protocol): array
    {
        return [
            'marker' => $marker, 'etag' => $marker->etag($node), 'profile' => WorkbookCodec::profile(),
            'workbook' => $snapshot,
            'commands' => config()->boolean('vaulter-sheets.commands', true) && $this->access->canEdit($context, $node) && $editable && $protocol === null
                ? [
                    'set_number', 'set_text', 'set_boolean', 'set_formula', 'set_values',
                    'insert_row_before', 'delete_row', 'insert_column_before', 'delete_column',
                    'add_sheet', 'rename_sheet', 'delete_sheet',
                    'set_format', 'merge_cells', 'unmerge_cells', 'set_freeze', 'fill_formula',
                ] : [],
            'exchange' => $this->exchange->capabilitiesForAccess($context, $node, $editable, $protocol),
        ];
    }

    /**
     * @return list<stdClass>
     */
    public function readRange(DriveContext $context, string $node, string $sheet, string $range, int $limit): array
    {
        $bounds = ReadCellProjection::bounds($range);
        if ($sheet === '' || strlen($sheet) > 255 || $bounds === null) {
            throw new WorkbookProblem('invalid_command', 422);
        }
        $indexed = $this->projected($context, $node, fn (array $head): array => $this->projections->ranges($head, $sheet, [$range => $bounds], $limit));
        if ($indexed !== null) {
            return $indexed;
        }
        $state = $this->loadWorkbook($context, $node);

        return $this->read($context, $node, self::marker($state), $this->codec->snapshot($state->content), $sheet, [$range => $bounds], $limit);
    }

    /**
     * @param  list<string>|null    $columns
     * @param  list<string>|null    $rowIds
     * @return array<string, mixed>
     */
    public function readTable(DriveContext $context, string $node, string $table, ?array $columns = null, ?array $rowIds = null): array
    {
        $indexed = $this->projected($context, $node, function (array $head) use ($table, $columns, $rowIds): array {
            $binding = $this->projections->binding($head['id'], $table);
            $sheet = is_string($binding->sheet_id ?? null) ? $binding->sheet_id : '';
            [$rows, $selectedColumns, $ranges] = self::tableRanges($binding, $columns, $rowIds);

            return ['marker' => $head['marker'], 'table' => $binding,
                'ranges' => $this->projections->ranges($head, $sheet, $ranges, 10_000, $rows, $selectedColumns)];
        });
        if ($indexed !== null) {
            return $indexed;
        }

        $state = $this->loadWorkbook($context, $node);
        $marker = self::marker($state);
        $snapshot = $this->codec->snapshot($state->content);
        $binding = self::table($snapshot, $table);
        $sheet = is_string($binding->sheet_id ?? null) ? $binding->sheet_id : '';
        [, , $ranges] = self::tableRanges($binding, $columns, $rowIds);

        return ['marker' => $marker, 'table' => $binding, 'ranges' => $this->read($context, $node, $marker, $snapshot, $sheet, $ranges)];
    }

    /**
     * @param  list<string>|null                                     $columns
     * @param  list<string>|null                                     $rowIds
     * @return array{list<int>, list<int>, array<string, Rectangle>}
     */
    private static function tableRanges(stdClass $binding, ?array $columns, ?array $rowIds): array
    {
        $rows = self::positions(self::objectList($binding->rows ?? null), 'row', $rowIds);
        $columns = self::positions(self::objectList($binding->columns ?? null), 'column', $columns);
        if (count($rows) * count($columns) > 10_000) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        $ranges = [];
        $columnRuns = self::runs($columns);
        foreach (self::runs($rows) as [$firstRow, $lastRow]) {
            foreach ($columnRuns as [$firstColumn, $lastColumn]) {
                $first = ReadCellProjection::address($firstColumn, $firstRow);
                $last = ReadCellProjection::address($lastColumn, $lastRow);
                $ranges[$first === $last ? $first : $first.':'.$last] = [$firstRow, $firstColumn, $lastRow, $lastColumn];
            }
        }

        return [$rows, $columns, $ranges];
    }

    /**
     * @param  list<stdClass>    $bindings
     * @param  list<string>|null $ids
     * @return list<int>
     */
    private static function positions(array $bindings, string $axis, ?array $ids): array
    {
        $positions = [];
        foreach ($bindings as $binding) {
            $id = $binding->{$axis.'_id'} ?? null;
            $position = $binding->{$axis} ?? null;
            if (is_string($id) && is_int($position)) {
                $positions[$id] = $position;
            }
        }
        if ($ids !== null) {
            $selected = array_fill_keys($ids, true);
            if (array_diff_key($selected, $positions) !== []) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $positions = array_intersect_key($positions, $selected);
        }

        return array_values($positions);
    }

    /**
     * @param  list<int>             $positions
     * @return list<array{int, int}>
     */
    private static function runs(array $positions): array
    {
        $runs = [];
        foreach ($positions as $position) {
            $last = array_key_last($runs);
            if ($last !== null && $runs[$last][1] + 1 === $position) {
                $runs[$last][1] = $position;
            } else {
                $runs[] = [$position, $position];
            }
        }

        return $runs;
    }

    /**
     * @return array<string, mixed>
     */
    public function prepareFormula(
        DriveContext $context,
        string $node,
        string $table,
        string $destination,
        string $left,
        string $right,
        string $scope,
        string $op = 'subtract',
        ?stdClass $expression = null,
    ): array {
        $state = $this->loadWorkbook($context, $node);
        $workbook = $this->codec->snapshot($state->content);
        $binding = self::table($workbook, $table);
        /** @var array<string, int> $columns */
        $columns = [];
        foreach (self::objectList($binding->columns ?? null) as $colObj) {
            if (is_string($colObj->column_id ?? null) && is_int($colObj->column ?? null)) {
                $columns[$colObj->column_id] = $colObj->column;
            }
        }
        if (!isset($columns[$destination]) || !in_array($scope, ['fixed_members', 'current_rows'], true)) {
            throw new WorkbookProblem('unknown_target', 422);
        }
        if ($expression === null) {
            if (!isset($columns[$left], $columns[$right])) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $expression = match ($op) {
                'subtract', 'add', 'multiply', 'divide' => (object) ['op' => $op, 'left_column_id' => $left, 'right_column_id' => $right],
                'sum', 'average' => (object) ['op' => $op, 'column_ids' => array_values(array_unique([$left, $right]))],
                default => throw new WorkbookProblem('invalid_command', 422),
            };
        }
        $sheetId = is_string($binding->sheet_id ?? null) ? $binding->sheet_id : '';
        $native = ($workbook->native ?? null) instanceof stdClass ? $workbook->native : new stdClass;
        $sheets = ($native->sheets ?? null) instanceof stdClass ? $native->sheets : new stdClass;
        $sheet = ($sheets->{$sheetId} ?? null) instanceof stdClass ? $sheets->{$sheetId} : new stdClass;
        $cells = ($sheet->cellData ?? null) instanceof stdClass ? $sheet->cellData : new stdClass;

        $expected = [];
        $rowIds = [];
        foreach (self::objectList($binding->rows ?? null) as $row) {
            if (!is_int($row->row ?? null) || !is_string($row->row_id ?? null)) {
                continue;
            }
            $rowIds[] = $row->row_id;
            $rowObj = $cells->{(string) ($row->row - 1)} ?? null;
            $cell = $rowObj instanceof stdClass ? ($rowObj->{(string) ($columns[$destination] - 1)} ?? null) : null;
            $formula = $cell instanceof stdClass ? ($cell->f ?? null) : null;
            $value = $cell instanceof stdClass ? ($cell->v ?? null) : null;
            $expected[] = match (true) {
                is_string($formula) => (object) ['formula' => $formula],
                is_int($value), is_float($value) => (object) ['number' => $value],
                is_bool($value) => (object) ['boolean' => $value],
                is_string($value) => (object) ['text' => $value],
                default => null,
            };
        }
        $this->authorizeDelivery($context, $node);

        return ['marker' => self::marker($state), 'command' => (object) [
            'kind' => 'fill_formula', 'sheet_id' => $sheetId, 'table_id' => $table, 'scope' => $scope,
            'row_ids' => $rowIds, 'destination_column_id' => $destination,
            'expression' => $expression,
            'expected_destination' => $expected,
        ]];
    }

    /**
     * @return array<string, mixed>
     */
    public function commit(DriveContext $context, string $node, WorkbookCommand $command): array
    {
        return $this->commitCommand->execute($context, $node, $command);
    }

    /**
     * @return array<string, mixed>
     */
    public function status(DriveContext $context, string $node, string $command): array
    {
        return $this->commitCommand->status($context, $node, $command);
    }

    /**
     * @return array<string, mixed>
     */
    public function verify(DriveContext $context, string $node, string $command): array
    {
        $outcome = $this->status($context, $node, $command);
        if (($outcome['state'] ?? null) !== 'committed' || !isset($outcome['checks'])) {
            throw new WorkbookProblem('evidence_unavailable', 410);
        }

        return $outcome;
    }

    /**
     * @param  array<string, Rectangle> $ranges
     * @return list<stdClass>
     */
    private function read(DriveContext $context, string $node, WorkbookMarker $marker, stdClass $snapshot, string $sheet, array $ranges, int $limit = 10_000): array
    {
        if (count($ranges) > 64) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        if ($ranges === []) {
            $result = [];
        } else {
            $exchange = $this->runtime->exchange((object) [
                'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'read',
                'base' => (object) get_object_vars($marker), 'profile_id' => WorkbookCodec::PROFILE,
                'workbook' => $snapshot, 'selector' => (object) ['ranges' => array_map(
                    static fn (string $range): stdClass => (object) ['sheet_id' => $sheet, 'range' => $range],
                    array_keys($ranges),
                )],
                'limits' => (object) ['max_cells_per_command' => $limit],
            ]);
            $data = $exchange->data ?? null;
            $rawRanges = $data instanceof stdClass ? ($data->ranges ?? null) : null;
            $result = self::objectList($rawRanges);
        }
        $this->authorizeDelivery($context, $node);

        return $result;
    }

    private function loadWorkbook(DriveContext $context, string $node): DocumentSnapshot
    {
        $state = $this->documents->forContext($context)->content($node);
        if (!$state->content instanceof WorkbookContent) {
            throw $state->type === SpreadsheetDocumentType::KEY
                ? new WorkbookProblem('unsupported_content', 422)
                : new WorkbookProblem('resource_unavailable', 404);
        }

        return $state;
    }

    private static function marker(DocumentSnapshot $state): WorkbookMarker
    {
        return new WorkbookMarker($state->epoch, $state->stateVersion, $state->content->contentHash());
    }

    /**
     * @template T
     *
     * @param  Closure(ProjectionHead): T $read
     * @return T|null
     */
    private function projected(DriveContext $context, string $node, Closure $read): mixed
    {
        $document = $this->authorizeDelivery($context, $node);
        $head = $this->projections->ready($document->documentId);
        if ($head === null) {
            return null;
        }
        $failure = null;
        try {
            $result = $read($head);
        } catch (WorkbookProblem $failure) {
            $result = null;
        }
        $current = $this->authorizeDelivery($context, $node);
        // GC can remove the old build during a multi-query read. Validate the same head again before delivery.
        if ($current->documentId !== $document->documentId || ($this->projections->ready($current->documentId)['id'] ?? null) !== $head['id']) {
            return null;
        }
        if ($failure !== null) {
            throw $failure;
        }

        return $result;
    }

    private function authorizeDelivery(DriveContext $context, string $node): DocumentMetadata
    {
        // Documents metadata applies the same View, tenant, drive lifecycle and profile checks for document nodes.
        try {
            $document = $this->documents->forContext($context)->metadata($node);
        } catch (NodeNotFoundException|NotADocumentException|PermissionDeniedException|ProfileRestrictionException) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if ($document->type !== SpreadsheetDocumentType::KEY) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }

        return $document;
    }

    private static function table(stdClass $snapshot, string $id): stdClass
    {
        foreach (self::objectList($snapshot->tables ?? null) as $table) {
            if (($table->table_id ?? null) === $id) {
                return $table;
            }
        }
        throw new WorkbookProblem('unknown_target', 422);
    }

    /**
     * @return list<stdClass>
     */
    private static function objectList(mixed $value): array
    {
        if (!is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $item) {
            if ($item instanceof stdClass) {
                $out[] = $item;
            }
        }

        return $out;
    }
}
