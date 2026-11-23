<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Data;

use stdClass;
use Vaulter\Sheets\Runtime\CanonicalJson;

final readonly class WorkbookCommand
{
    /** @var list<stdClass> */
    public array $commands;

    /**
     * @param array<int|string, mixed> $commands
     */
    public function __construct(
        public string $id,
        public string $policy,
        public int $generation,
        public ?string $ifMatch,
        array $commands,
    ) {
        if (preg_match('/^[A-Za-z0-9._-]{1,255}$/D', $id) !== 1 || $generation < 0 || $generation > 9_007_199_254_740_991
            || !in_array($policy, ['exact_base', 'rebase_cells', 'revalidate_by_id'], true)
            || ($policy === 'revalidate_by_id') !== ($ifMatch === null) || $commands === [] || !array_is_list($commands)) {
            throw new WorkbookProblem('invalid_command', 422);
        }
        if (count($commands) > 64) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        $normalized = [];
        foreach ($commands as $command) {
            if (!$command instanceof stdClass || !is_string($command->sheet_id ?? null)
                || !in_array($command->kind ?? null, ['set_number', 'set_text', 'set_formula', 'set_values', 'insert_row_before', 'fill_formula'], true)
                || property_exists($command, 'new_row_ids')
                || ($policy === 'revalidate_by_id') !== ($command->kind === 'fill_formula')
                || ($policy === 'rebase_cells' && $command->kind === 'insert_row_before')
                || !self::validCommand($command)) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            $normalized[] = $command;
        }
        $this->commands = $normalized;
    }

    private static function validCommand(stdClass $command): bool
    {
        if (!is_string($command->sheet_id ?? null) || $command->sheet_id === '' || strlen($command->sheet_id) > 255) {
            return false;
        }
        if ($command->kind === 'fill_formula') {
            $expression = $command->expression ?? null;
            $rows = $command->row_ids ?? null;
            $expected = $command->expected_destination ?? null;

            $valid = is_string($command->table_id ?? null) && $command->table_id !== ''
                && is_string($command->destination_column_id ?? null) && $command->destination_column_id !== ''
                && in_array($command->scope ?? null, ['fixed_members', 'current_rows'], true)
                && $expression instanceof stdClass && ($expression->op ?? null) === 'subtract'
                && is_string($expression->left_column_id ?? null) && $expression->left_column_id !== ''
                && is_string($expression->right_column_id ?? null) && $expression->right_column_id !== ''
                && is_array($rows) && array_is_list($rows) && $rows !== []
                && is_array($expected) && array_is_list($expected) && count($rows) === count($expected);
            if (!$valid) {
                return false;
            }
            $validRows = [];
            foreach ($rows as $rowId) {
                if (!is_string($rowId) || $rowId === '') {
                    return false;
                }
                $validRows[] = $rowId;
            }
            if (count(array_unique($validRows)) !== count($validRows)
                || !array_all($expected, static fn (mixed $cell): bool => self::validContent($cell))) {
                return false;
            }

            if (!property_exists($command, 'expected_inputs')) {
                return true;
            }

            $expectedInputs = $command->expected_inputs;
            if (!is_array($expectedInputs) || !array_is_list($expectedInputs) || count($expectedInputs) !== count($validRows)) {
                return false;
            }

            return array_all($expectedInputs, static fn (mixed $rowInputs): bool => self::validRowInputs($rowInputs));
        }
        if (!self::coordinate($command->row ?? null)) {
            return false;
        }
        if ($command->kind === 'insert_row_before') {
            return self::coordinate($command->count ?? null);
        }
        if (!self::coordinate($command->column ?? null) || !property_exists($command, 'expected')) {
            return false;
        }
        if ($command->kind === 'set_values') {
            $values = $command->values ?? null;
            $expected = $command->expected;
            if (!is_array($values) || !is_array($expected) || $values === [] || count($values) !== count($expected)
                || !is_array($values[0]) || $values[0] === []) {
                return false;
            }
            $width = count($values[0]);
            foreach ($values as $index => $row) {
                if (!is_array($row) || !is_array($expected[$index]) || count($row) !== $width
                    || count($expected[$index]) !== $width
                    || !array_all($row, static fn (mixed $cell): bool => self::validContent($cell, literal: true))
                    || !array_all($expected[$index], static fn (mixed $cell): bool => self::validContent($cell))) {
                    return false;
                }
            }

            return true;
        }

        return self::validContent($command->expected) && match ($command->kind) {
            'set_number' => is_int($command->value ?? null) || is_float($command->value ?? null),
            'set_text' => is_string($command->value ?? null),
            'set_formula' => is_string($command->formula ?? null) && str_starts_with($command->formula, '='),
            default => false,
        };
    }

    private static function validRowInputs(mixed $rowInputs): bool
    {
        if (!$rowInputs instanceof stdClass || array_diff(array_keys(get_object_vars($rowInputs)), ['left', 'right']) !== []
            || !property_exists($rowInputs, 'left') || !property_exists($rowInputs, 'right')) {
            return false;
        }

        return self::validOperandExpectation($rowInputs->left) && self::validOperandExpectation($rowInputs->right);
    }

    private static function validOperandExpectation(mixed $operand): bool
    {
        if (!$operand instanceof stdClass || !property_exists($operand, 'content')
            || array_diff(array_keys(get_object_vars($operand)), ['content', 'value']) !== []
            || !self::validContent($operand->content)) {
            return false;
        }

        return !property_exists($operand, 'value')
            || ((is_int($operand->value) || is_float($operand->value)) && is_finite((float) $operand->value));
    }

    private static function coordinate(mixed $value): bool
    {
        return is_int($value) && $value > 0 && $value <= 9_007_199_254_740_991;
    }

    private static function validContent(mixed $cell, bool $literal = false): bool
    {
        if ($cell === null) {
            return true;
        }
        if (!$cell instanceof stdClass || count(get_object_vars($cell)) !== 1) {
            return false;
        }

        return ((is_int($cell->number ?? null) || is_float($cell->number ?? null)) && is_finite((float) $cell->number))
            || is_string($cell->text ?? null)
            || (!$literal && (is_bool($cell->boolean ?? null) || (is_string($cell->formula ?? null) && str_starts_with($cell->formula, '='))));
    }

    public static function fromWire(stdClass $body, ?string $tag): self
    {
        if (!is_string($body->command_id ?? null) || !is_string($body->policy ?? null)
            || !is_int($body->expected_generation ?? null) || !is_array($body->commands ?? null)) {
            throw new WorkbookProblem('invalid_command', 422);
        }

        return new self($body->command_id, $body->policy, $body->expected_generation, $tag, $body->commands);
    }

    public function fingerprint(): string
    {
        return CanonicalJson::sha256((object) [
            'policy' => $this->policy, 'expected_generation' => $this->generation,
            'if_match' => $this->ifMatch, 'commands' => $this->commands,
        ]);
    }
}
