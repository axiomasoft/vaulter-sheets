<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Operations;

use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\DocumentsManager;
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

final readonly class LaravelWorkbookOperations implements WorkbookOperations
{
    public function __construct(
        private DocumentsManager $documents,
        private WorkbookCodec $codec,
        private WorkbookRuntime $runtime,
        private CommitWorkbookCommand $commitCommand,
        private NodeEditAccess $access,
        private WorkbookExchange $exchange,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function catalog(DriveContext $context, string $node): array
    {
        $catalog = $this->loadCatalog($context, $node);
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
    private function loadCatalog(DriveContext $context, string $node): array
    {
        $state = $this->documents->forContext($context)->content($node);
        if (!$state->content instanceof WorkbookContent) {
            throw new WorkbookProblem($state->type === 'vaulter/spreadsheet' ? 'unsupported_content' : 'resource_unavailable', $state->type === 'vaulter/spreadsheet' ? 422 : 404);
        }
        $marker = new WorkbookMarker($state->epoch, $state->stateVersion, $state->content->contentHash());

        return [
            'marker' => $marker, 'etag' => $marker->etag($node), 'profile' => WorkbookCodec::profile(),
            'workbook' => $this->codec->snapshot($state->content),
            'commands' => config()->boolean('vaulter-sheets.commands', true) && $this->access->canEdit($context, $node) && $state->editable && $state->collabProtocol === null
                ? [
                    'set_number', 'set_text', 'set_boolean', 'set_formula', 'set_values',
                    'insert_row_before', 'delete_row', 'insert_column_before', 'delete_column',
                    'add_sheet', 'rename_sheet', 'delete_sheet',
                    'set_format', 'merge_cells', 'unmerge_cells', 'set_freeze', 'fill_formula',
                ] : [],
            'exchange' => $this->exchange->capabilitiesForState($context, $node, $state),
        ];
    }

    /**
     * @return list<stdClass>
     */
    public function readRange(DriveContext $context, string $node, string $sheet, string $range, int $limit): array
    {
        $catalog = $this->loadCatalog($context, $node);

        return $this->read($context, $node, $catalog, [(object) ['sheet_id' => $sheet, 'range' => $range]], $limit);
    }

    /**
     * @param  list<string>|null    $columns
     * @param  list<string>|null    $rowIds
     * @return array<string, mixed>
     */
    public function readTable(DriveContext $context, string $node, string $table, ?array $columns = null, ?array $rowIds = null): array
    {
        $catalog = $this->loadCatalog($context, $node);
        $binding = $this->table($catalog, $table);

        $bindingColumns = self::objectList($binding->columns ?? null);
        $selectedColumns = $bindingColumns;
        if ($columns !== null) {
            /** @var array<string, stdClass> $availableColumns */
            $availableColumns = [];
            foreach ($bindingColumns as $column) {
                if (is_string($column->column_id ?? null)) {
                    $availableColumns[$column->column_id] = $column;
                }
            }
            $columnSet = [];
            foreach ($columns as $columnId) {
                if ($columnId === '' || !isset($availableColumns[$columnId])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
                $columnSet[$columnId] = true;
            }
            $selectedColumns = array_values(array_filter(
                $bindingColumns,
                static fn (stdClass $column): bool => is_string($column->column_id ?? null) && isset($columnSet[$column->column_id]),
            ));
        }

        $bindingRows = self::objectList($binding->rows ?? null);
        $selectedRows = $bindingRows;
        if ($rowIds !== null) {
            /** @var array<string, stdClass> $availableRows */
            $availableRows = [];
            foreach ($bindingRows as $row) {
                if (is_string($row->row_id ?? null)) {
                    $availableRows[$row->row_id] = $row;
                }
            }
            $rowSet = [];
            foreach ($rowIds as $rowId) {
                if ($rowId === '' || !isset($availableRows[$rowId])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
                $rowSet[$rowId] = true;
            }
            $selectedRows = array_values(array_filter(
                $bindingRows,
                static fn (stdClass $row): bool => is_string($row->row_id ?? null) && isset($rowSet[$row->row_id]),
            ));
        }

        $sheetId = is_string($binding->sheet_id ?? null) ? $binding->sheet_id : '';
        $ranges = [];
        foreach ($selectedRows as $row) {
            if (!is_int($row->row ?? null)) {
                continue;
            }
            foreach ($selectedColumns as $column) {
                if (!is_int($column->column ?? null)) {
                    continue;
                }
                $ranges[] = (object) ['sheet_id' => $sheetId, 'range' => self::address($column->column, $row->row)];
            }
        }

        return ['marker' => $catalog['marker'], 'table' => $binding, 'ranges' => $this->read($context, $node, $catalog, $ranges)];
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
        $catalog = $this->loadCatalog($context, $node);
        $binding = $this->table($catalog, $table);
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
        $native = ($catalog['workbook']->native ?? null) instanceof stdClass ? $catalog['workbook']->native : new stdClass;
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

        return ['marker' => $catalog['marker'], 'command' => (object) [
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
     * @param  array{marker: WorkbookMarker, etag: string, profile: stdClass, workbook: stdClass, commands: list<string>, exchange: array{formats: list<'csv'|'xlsx'>, import: list<'csv'|'xlsx'>, export: list<'csv'|'xlsx'>}} $catalog
     * @param  list<stdClass>                                                                                                                                                                                                   $ranges
     * @return list<stdClass>
     */
    private function read(DriveContext $context, string $node, array $catalog, array $ranges, int $limit = 10_000): array
    {
        if (count($ranges) > 64) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        if ($ranges === []) {
            $result = [];
        } else {
            $exchange = $this->runtime->exchange((object) [
                'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'read',
                'base' => (object) get_object_vars($catalog['marker']), 'profile_id' => WorkbookCodec::PROFILE,
                'workbook' => $catalog['workbook'], 'selector' => (object) ['ranges' => $ranges],
                'limits' => (object) ['max_cells_per_command' => $limit],
            ]);
            $data = $exchange->data ?? null;
            $rawRanges = $data instanceof stdClass ? ($data->ranges ?? null) : null;
            $result = self::objectList($rawRanges);
        }
        $this->authorizeDelivery($context, $node);

        return $result;
    }

    private function authorizeDelivery(DriveContext $context, string $node): void
    {
        // Reuse Documents' View check with its content-egress policy.
        try {
            $state = $this->documents->forContext($context)->content($node);
        } catch (NodeNotFoundException|PermissionDeniedException|ProfileRestrictionException) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
        if (!$state->content instanceof WorkbookContent) {
            throw new WorkbookProblem('resource_unavailable', 404);
        }
    }

    /**
     * @param array{marker: WorkbookMarker, etag: string, profile: stdClass, workbook: stdClass, commands: list<string>, exchange: array{formats: list<'csv'|'xlsx'>, import: list<'csv'|'xlsx'>, export: list<'csv'|'xlsx'>}} $catalog
     */
    private function table(array $catalog, string $id): stdClass
    {
        foreach (self::objectList($catalog['workbook']->tables ?? null) as $table) {
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

    private static function address(int $column, int $row): string
    {
        $letters = '';
        while ($column > 0) {
            $column--;
            $letters = chr(65 + $column % 26).$letters;
            $column = intdiv($column, 26);
        }

        return $letters.$row;
    }
}
