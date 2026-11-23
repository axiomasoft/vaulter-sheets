<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use stdClass;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;

final class WorkbookFormulaDependencies
{
    /**
     * @param list<stdClass> $commands
     */
    public static function digest(stdClass $workbook, array $commands): string
    {
        $rawTables = is_array($workbook->tables ?? null) ? $workbook->tables : [];
        /** @var array<string, stdClass> $tables */
        $tables = [];
        foreach ($rawTables as $entry) {
            if ($entry instanceof stdClass && is_string($entry->table_id ?? null)) {
                $tables[$entry->table_id] = $entry;
            }
        }
        $native = $workbook->native ?? null;
        $sheets = $native instanceof stdClass && ($native->sheets ?? null) instanceof stdClass ? $native->sheets : new stdClass;

        $content = [];
        foreach ($commands as $command) {
            $tableId = is_string($command->table_id ?? null) ? $command->table_id : '';
            $sheetId = is_string($command->sheet_id ?? null) ? $command->sheet_id : '';
            $table = $tables[$tableId] ?? null;
            if (!$table instanceof stdClass || $table->sheet_id !== $sheetId) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            /** @var list<array{row_id: string, row: int}> $tableRows */
            $tableRows = [];
            foreach (is_array($table->rows ?? null) ? $table->rows : [] as $item) {
                if ($item instanceof stdClass && is_string($item->row_id ?? null) && is_int($item->row ?? null)) {
                    $tableRows[] = ['row_id' => $item->row_id, 'row' => $item->row];
                }
            }
            $commandRowIds = [];
            foreach (is_array($command->row_ids ?? null) ? $command->row_ids : [] as $rowId) {
                if (is_string($rowId)) {
                    $commandRowIds[] = $rowId;
                }
            }
            if (($command->scope ?? null) === 'current_rows') {
                $ordered = $tableRows;
                usort($ordered, static fn (array $left, array $right): int => $left['row'] <=> $right['row']);
                $rows = array_map(static fn (array $item): string => $item['row_id'], $ordered);
                if ($rows !== $commandRowIds) {
                    throw new WorkbookProblem('scope_changed', 409, ['expected' => $commandRowIds, 'actual' => $rows]);
                }
            }
            /** @var array<string, int> $rows */
            $rows = [];
            foreach ($tableRows as $item) {
                $rows[$item['row_id']] = $item['row'];
            }
            /** @var array<string, int> $columns */
            $columns = [];
            foreach (is_array($table->columns ?? null) ? $table->columns : [] as $item) {
                if ($item instanceof stdClass && is_string($item->column_id ?? null) && is_int($item->column ?? null)) {
                    $columns[$item->column_id] = $item->column;
                }
            }
            $expr = ($command->expression ?? null) instanceof stdClass ? $command->expression : new stdClass;
            $leftId = is_string($expr->left_column_id ?? null) ? $expr->left_column_id : '';
            $rightId = is_string($expr->right_column_id ?? null) ? $expr->right_column_id : '';
            $destId = is_string($command->destination_column_id ?? null) ? $command->destination_column_id : '';
            $left = $columns[$leftId] ?? null;
            $right = $columns[$rightId] ?? null;
            $dest = $columns[$destId] ?? null;
            if ($left === null || $right === null || $dest === null) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $sheet = $sheets->{$sheetId} ?? null;
            $cellData = $sheet instanceof stdClass && ($sheet->cellData ?? null) instanceof stdClass ? $sheet->cellData : new stdClass;
            $expectedInputs = $command->expected_inputs ?? null;
            foreach ($commandRowIds as $index => $id) {
                if (!isset($rows[$id])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
                $rowObj = $cellData->{(string) ($rows[$id] - 1)} ?? null;
                $row = $rowObj instanceof stdClass ? $rowObj : new stdClass;
                $leftCell = $row->{(string) ($left - 1)} ?? null;
                $rightCell = $row->{(string) ($right - 1)} ?? null;
                $leftContent = self::content($leftCell instanceof stdClass ? $leftCell : null);
                $rightContent = self::content($rightCell instanceof stdClass ? $rightCell : null);
                if (is_array($expectedInputs)) {
                    $expectedRow = $expectedInputs[$index] ?? null;
                    $expLeft = $expectedRow instanceof stdClass && ($expectedRow->left ?? null) instanceof stdClass ? ($expectedRow->left->content ?? null) : null;
                    $expRight = $expectedRow instanceof stdClass && ($expectedRow->right ?? null) instanceof stdClass ? ($expectedRow->right->content ?? null) : null;
                    if (!$expectedRow instanceof stdClass
                        || !self::matchesContent($leftContent, $expLeft)
                        || !self::matchesContent($rightContent, $expRight)) {
                        throw new WorkbookProblem('version_conflict', 409, ['reason' => 'input_precondition_failed', 'row_id' => $id]);
                    }
                }
                $content[] = [$id, $leftContent, $rightContent];
            }
        }

        return CanonicalJson::sha256($content);
    }

    private static function matchesContent(mixed $actual, mixed $expected): bool
    {
        return CanonicalJson::encode($actual) === CanonicalJson::encode($expected);
    }

    private static function content(?stdClass $cell): mixed
    {
        if ($cell === null) {
            return null;
        }
        $formula = $cell->f ?? null;
        if (is_string($formula) && $formula !== '') {
            return (object) ['formula' => $formula];
        }
        $value = $cell->v ?? null;

        return match (true) {
            is_bool($value), ($cell->t ?? null) === 3 => (object) ['boolean' => (bool) $value],
            is_int($value), is_float($value) => (object) ['number' => $value],
            is_string($value) => (object) ['text' => $value],
            default => null,
        };
    }
}
