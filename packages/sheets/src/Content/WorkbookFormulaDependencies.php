<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use stdClass;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;

final class WorkbookFormulaDependencies
{
    public static function digest(stdClass $workbook, array $commands): string
    {
        $tables = array_column($workbook->tables, null, 'table_id');
        $content = [];
        foreach ($commands as $command) {
            $table = $tables[$command->table_id] ?? null;
            if ($table === null || $table->sheet_id !== $command->sheet_id) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            if ($command->scope === 'current_rows') {
                $ordered = $table->rows;
                usort($ordered, static fn (stdClass $left, stdClass $right): int => $left->row <=> $right->row);
                $rows = array_column($ordered, 'row_id');
                if ($rows !== $command->row_ids) {
                    throw new WorkbookProblem('scope_changed', 409, ['expected' => $command->row_ids, 'actual' => $rows]);
                }
            }
            $rows = array_column($table->rows, 'row', 'row_id');
            $columns = array_column($table->columns, 'column', 'column_id');
            $left = $columns[$command->expression->left_column_id] ?? null;
            $right = $columns[$command->expression->right_column_id] ?? null;
            $dest = $columns[$command->destination_column_id] ?? null;
            if ($left === null || $right === null || $dest === null) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $sheet = $workbook->native->sheets->{$command->sheet_id};
            $expectedInputs = $command->expected_inputs ?? null;
            foreach ($command->row_ids as $index => $id) {
                if (!isset($rows[$id])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
                $row = $sheet->cellData->{(string) ($rows[$id] - 1)} ?? new stdClass;
                $leftContent = self::content($row->{(string) ($left - 1)} ?? null);
                $rightContent = self::content($row->{(string) ($right - 1)} ?? null);
                if (is_array($expectedInputs)) {
                    $expectedRow = $expectedInputs[$index] ?? null;
                    if (!$expectedRow instanceof stdClass
                        || !self::matchesContent($leftContent, $expectedRow->left->content ?? null)
                        || !self::matchesContent($rightContent, $expectedRow->right->content ?? null)) {
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
        if (is_string($cell->f ?? null) && $cell->f !== '') {
            return (object) ['formula' => $cell->f];
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
