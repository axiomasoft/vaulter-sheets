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
            if ($left === null || $right === null) {
                throw new WorkbookProblem('unknown_target', 422);
            }
            $sheet = $workbook->native->sheets->{$command->sheet_id};
            foreach ($command->row_ids as $id) {
                if (!isset($rows[$id])) {
                    throw new WorkbookProblem('unknown_target', 422);
                }
                $row = $sheet->cellData->{(string) ($rows[$id] - 1)} ?? new stdClass;
                $content[] = [$id, self::content($row->{(string) ($left - 1)} ?? null), self::content($row->{(string) ($right - 1)} ?? null)];
            }
        }

        return CanonicalJson::sha256($content);
    }

    private static function content(?stdClass $cell): mixed
    {
        if (isset($cell->f)) {
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
