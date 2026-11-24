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
            $op = is_string($expr->op ?? null) ? $expr->op : '';
            $isBinary = in_array($op, ['subtract', 'add', 'multiply', 'divide'], true);
            $destId = is_string($command->destination_column_id ?? null) ? $command->destination_column_id : '';
            $dest = $columns[$destId] ?? null;
            if ($dest === null) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $refCols = self::referencedColumns($expr);
            foreach ($refCols as $colId) {
                if (!isset($columns[$colId])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
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
                if ($isBinary) {
                    $leftId = is_string($expr->left_column_id ?? null) ? $expr->left_column_id : '';
                    $rightId = is_string($expr->right_column_id ?? null) ? $expr->right_column_id : '';
                    $leftContent = self::content(($row->{(string) ($columns[$leftId] - 1)} ?? null) instanceof stdClass ? $row->{(string) ($columns[$leftId] - 1)} : null);
                    $rightContent = self::content(($row->{(string) ($columns[$rightId] - 1)} ?? null) instanceof stdClass ? $row->{(string) ($columns[$rightId] - 1)} : null);
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
                } else {
                    $rowInputs = [];
                    foreach ($refCols as $colId) {
                        $cellObj = $row->{(string) ($columns[$colId] - 1)} ?? null;
                        $rowInputs[$colId] = self::content($cellObj instanceof stdClass ? $cellObj : null);
                    }
                    if (is_array($expectedInputs)) {
                        $expectedRow = $expectedInputs[$index] ?? null;
                        if (!$expectedRow instanceof stdClass) {
                            throw new WorkbookProblem('version_conflict', 409, ['reason' => 'input_precondition_failed', 'row_id' => $id]);
                        }
                        foreach (get_object_vars($expectedRow) as $colId => $exp) {
                            if (!isset($columns[$colId])) {
                                throw new WorkbookProblem('unknown_target', 422);
                            }
                            $actualCell = $row->{(string) ($columns[$colId] - 1)} ?? null;
                            $actualContent = self::content($actualCell instanceof stdClass ? $actualCell : null);
                            $expContent = $exp instanceof stdClass ? ($exp->content ?? null) : null;
                            if (!self::matchesContent($actualContent, $expContent)) {
                                throw new WorkbookProblem('version_conflict', 409, ['reason' => 'input_precondition_failed', 'row_id' => $id]);
                            }
                        }
                    }
                    $content[] = [$id, $rowInputs];
                }
            }
        }

        return CanonicalJson::sha256($content);
    }

    /**
     * @return list<string>
     */
    private static function referencedColumns(stdClass $expr): array
    {
        $op = is_string($expr->op ?? null) ? $expr->op : '';
        if (in_array($op, ['subtract', 'add', 'multiply', 'divide'], true)) {
            return [
                is_string($expr->left_column_id ?? null) ? $expr->left_column_id : '',
                is_string($expr->right_column_id ?? null) ? $expr->right_column_id : '',
            ];
        }
        if (in_array($op, ['sum', 'average'], true)) {
            $cols = [];
            foreach (is_array($expr->column_ids ?? null) ? $expr->column_ids : [] as $colId) {
                if (is_string($colId)) {
                    $cols[] = $colId;
                }
            }

            return array_values(array_unique($cols));
        }
        if ($op === 'if') {
            $cols = [];
            $cond = ($expr->condition ?? null) instanceof stdClass ? $expr->condition : new stdClass;
            if (is_string($cond->left_column_id ?? null)) {
                $cols[] = $cond->left_column_id;
            }
            if (is_string($cond->right_column_id ?? null)) {
                $cols[] = $cond->right_column_id;
            }
            if (is_string($expr->then_column_id ?? null)) {
                $cols[] = $expr->then_column_id;
            }
            if (is_string($expr->else_column_id ?? null)) {
                $cols[] = $expr->else_column_id;
            }

            return array_values(array_unique($cols));
        }
        if ($op === 'template' && ($expr->params ?? null) instanceof stdClass) {
            $cols = [];
            foreach (get_object_vars($expr->params) as $colId) {
                if (is_string($colId)) {
                    $cols[] = $colId;
                }
            }

            return array_values(array_unique($cols));
        }

        return [];
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
