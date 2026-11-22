<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Operations;

use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\DocumentsManager;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Actions\CommitWorkbookCommand;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;

final readonly class LaravelWorkbookOperations implements WorkbookOperations
{
    public function __construct(
        private DocumentsManager $documents,
        private WorkbookCodec $codec,
        private WorkbookRuntime $runtime,
        private CommitWorkbookCommand $commitCommand,
        private \Vaulter\Drive\Operations\NodeEditAccess $access,
    ) {}

    public function catalog(DriveContext $context, string $node): array
    {
        $state = $this->documents->forContext($context)->content($node);
        if (!$state->content instanceof WorkbookContent) {
            throw new WorkbookProblem($state->type === 'vaulter/spreadsheet' ? 'unsupported_content' : 'resource_unavailable', $state->type === 'vaulter/spreadsheet' ? 422 : 404);
        }
        $marker = new WorkbookMarker($state->epoch, $state->stateVersion, $state->content->contentHash());
        return [
            'marker' => $marker, 'etag' => $marker->etag($node), 'profile' => WorkbookCodec::profile(),
            'workbook' => $this->codec->snapshot($state->content),
            'commands' => config('vaulter-sheets.commands') && $this->access->canEdit($context, $node) && $state->editable && $state->collabProtocol === null
                ? ['set_number', 'set_text', 'set_formula', 'set_values', 'insert_row_before', 'fill_formula'] : [],
        ];
    }

    public function readRange(DriveContext $context, string $node, string $sheet, string $range, int $limit): array
    {
        $catalog = $this->catalog($context, $node);
        return $this->read($catalog, [(object) ['sheet_id' => $sheet, 'range' => $range]], $limit);
    }

    public function readTable(DriveContext $context, string $node, string $table): array
    {
        $catalog = $this->catalog($context, $node);
        $binding = $this->table($catalog, $table);
        $ranges = [];
        foreach ($binding->rows as $row) {
            foreach ($binding->columns as $column) {
                $ranges[] = (object) ['sheet_id' => $binding->sheet_id, 'range' => self::address($column->column, $row->row)];
            }
        }
        return ['marker' => $catalog['marker'], 'table' => $binding, 'ranges' => $ranges === [] ? [] : $this->read($catalog, $ranges)];
    }

    public function prepareFormula(DriveContext $context, string $node, string $table, string $destination, string $left, string $right, string $scope): array
    {
        $catalog = $this->catalog($context, $node);
        $binding = $this->table($catalog, $table);
        $columns = array_column($binding->columns, 'column', 'column_id');
        if (!isset($columns[$destination], $columns[$left], $columns[$right]) || !in_array($scope, ['fixed_members', 'current_rows'], true)) {
            throw new WorkbookProblem('unknown_target', 422);
        }
        $cells = $catalog['workbook']->native->sheets->{$binding->sheet_id}->cellData ?? new stdClass;
        $expected = [];
        foreach ($binding->rows as $row) {
            $cell = $cells->{(string) ($row->row - 1)}->{(string) ($columns[$destination] - 1)} ?? null;
            $value = $cell->v ?? null;
            $expected[] = match (true) {
                isset($cell->f) => (object) ['formula' => $cell->f],
                is_int($value), is_float($value) => (object) ['number' => $value],
                is_bool($value) => (object) ['boolean' => $value],
                is_string($value) => (object) ['text' => $value],
                default => null,
            };
        }
        return ['marker' => $catalog['marker'], 'command' => (object) [
            'kind' => 'fill_formula', 'sheet_id' => $binding->sheet_id, 'table_id' => $table, 'scope' => $scope,
            'row_ids' => array_column($binding->rows, 'row_id'), 'destination_column_id' => $destination,
            'expression' => (object) ['op' => 'subtract', 'left_column_id' => $left, 'right_column_id' => $right],
            'expected_destination' => $expected,
        ]];
    }

    public function commit(DriveContext $context, string $node, WorkbookCommand $command): array
    {
        return $this->commitCommand->execute($context, $node, $command);
    }

    public function status(DriveContext $context, string $node, string $command): array
    {
        return $this->commitCommand->status($context, $node, $command);
    }

    public function verify(DriveContext $context, string $node, string $command): array
    {
        $outcome = $this->status($context, $node, $command);
        if ($outcome['state'] !== 'committed' || !isset($outcome['checks'])) {
            throw new WorkbookProblem('evidence_unavailable', 410);
        }
        return $outcome;
    }

    private function read(array $catalog, array $ranges, int $limit = 10_000): array
    {
        if (count($ranges) > 64) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        $response = $this->runtime->exchange((object) [
            'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'read',
            'base' => (object) get_object_vars($catalog['marker']), 'profile_id' => WorkbookCodec::PROFILE,
            'workbook' => $catalog['workbook'], 'selector' => (object) ['ranges' => $ranges],
            'limits' => (object) ['max_cells_per_command' => $limit],
        ]);
        return $response->data->ranges;
    }

    private function table(array $catalog, string $id): stdClass
    {
        foreach ($catalog['workbook']->tables as $table) {
            if ($table->table_id === $id) {
                return $table;
            }
        }
        throw new WorkbookProblem('unknown_target', 422);
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
