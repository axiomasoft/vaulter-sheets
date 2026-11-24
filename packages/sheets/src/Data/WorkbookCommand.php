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
        $supported = [
            'set_number', 'set_text', 'set_boolean', 'set_formula', 'set_values',
            'insert_row_before', 'delete_row', 'insert_column_before', 'delete_column',
            'add_sheet', 'rename_sheet', 'delete_sheet',
            'set_format', 'merge_cells', 'unmerge_cells', 'set_freeze', 'fill_formula',
        ];
        $structural = [
            'insert_row_before', 'delete_row', 'insert_column_before', 'delete_column',
            'add_sheet', 'rename_sheet', 'delete_sheet',
        ];
        $normalized = [];
        foreach ($commands as $command) {
            if (!$command instanceof stdClass || !is_string($command->sheet_id ?? null)
                || !in_array($command->kind ?? null, $supported, true)
                || property_exists($command, 'new_row_ids')
                || ($policy === 'revalidate_by_id') !== ($command->kind === 'fill_formula')
                || ($policy === 'rebase_cells' && in_array($command->kind, $structural, true))
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
                && self::validExpression($expression)
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
            $op = $expression instanceof stdClass ? ($expression->op ?? null) : null;
            $isBinary = in_array($op, ['subtract', 'add', 'multiply', 'divide'], true);

            return array_all($expectedInputs, static fn (mixed $rowInputs): bool => self::validRowInputs($rowInputs, $isBinary));
        }
        if ($command->kind === 'add_sheet') {
            $extra = array_diff(array_keys(get_object_vars($command)), ['kind', 'sheet_id', 'name', 'index', 'row_count', 'column_count']);

            return $extra === []
                && is_string($command->name ?? null) && $command->name !== '' && strlen($command->name) <= 255
                && (!property_exists($command, 'index') || (is_int($command->index) && $command->index >= 0 && $command->index <= 9_007_199_254_740_991))
                && (!property_exists($command, 'row_count') || self::coordinate($command->row_count))
                && (!property_exists($command, 'column_count') || self::coordinate($command->column_count));
        }
        if ($command->kind === 'rename_sheet') {
            $extra = array_diff(array_keys(get_object_vars($command)), ['kind', 'sheet_id', 'name', 'expected_name']);

            return $extra === []
                && is_string($command->name ?? null) && $command->name !== '' && strlen($command->name) <= 255
                && (!property_exists($command, 'expected_name') || (is_string($command->expected_name) && $command->expected_name !== '' && strlen($command->expected_name) <= 255));
        }
        if ($command->kind === 'delete_sheet') {
            return array_diff(array_keys(get_object_vars($command)), ['kind', 'sheet_id']) === [];
        }
        if ($command->kind === 'set_freeze') {
            return array_diff(array_keys(get_object_vars($command)), ['kind', 'sheet_id', 'row_count', 'column_count']) === []
                && is_int($command->row_count ?? null) && $command->row_count >= 0 && $command->row_count <= 9_007_199_254_740_991
                && is_int($command->column_count ?? null) && $command->column_count >= 0 && $command->column_count <= 9_007_199_254_740_991;
        }
        if (in_array($command->kind, ['merge_cells', 'unmerge_cells', 'set_format'], true)) {
            $allowed = $command->kind === 'merge_cells'
                ? ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column', 'strategy']
                : ($command->kind === 'set_format'
                    ? ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column', 'format']
                    : ['kind', 'sheet_id', 'start_row', 'start_column', 'end_row', 'end_column']);
            if (array_diff(array_keys(get_object_vars($command)), $allowed) !== []
                || !self::coordinate($command->start_row ?? null) || !self::coordinate($command->start_column ?? null)
                || !self::coordinate($command->end_row ?? null) || !self::coordinate($command->end_column ?? null)
                || $command->end_row < $command->start_row || $command->end_column < $command->start_column) {
                return false;
            }
            if ($command->kind === 'merge_cells') {
                return !property_exists($command, 'strategy') || in_array($command->strategy, ['default', 'across', 'vertically'], true);
            }
            if ($command->kind === 'set_format') {
                return self::validFormat($command->format ?? null);
            }

            return true;
        }
        if (in_array($command->kind, ['insert_column_before', 'delete_column'], true)) {
            return array_diff(array_keys(get_object_vars($command)), ['kind', 'sheet_id', 'column', 'count']) === []
                && self::coordinate($command->column ?? null) && self::coordinate($command->count ?? null);
        }
        if (!self::coordinate($command->row ?? null)) {
            return false;
        }
        if ($command->kind === 'insert_row_before' || $command->kind === 'delete_row') {
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
            'set_boolean' => is_bool($command->value ?? null),
            'set_formula' => is_string($command->formula ?? null) && str_starts_with($command->formula, '='),
            default => false,
        };
    }

    private static function validExpression(mixed $expression): bool
    {
        if (!$expression instanceof stdClass || !is_string($expression->op ?? null)) {
            return false;
        }
        $op = $expression->op;
        if (in_array($op, ['subtract', 'add', 'multiply', 'divide'], true)) {
            return array_diff(array_keys(get_object_vars($expression)), ['op', 'left_column_id', 'right_column_id']) === []
                && is_string($expression->left_column_id ?? null) && $expression->left_column_id !== ''
                && is_string($expression->right_column_id ?? null) && $expression->right_column_id !== '';
        }
        if (in_array($op, ['sum', 'average'], true)) {
            $cols = $expression->column_ids ?? null;

            return array_diff(array_keys(get_object_vars($expression)), ['op', 'column_ids']) === []
                && is_array($cols) && array_is_list($cols) && $cols !== [] && count($cols) <= 64
                && array_all($cols, static fn (mixed $c): bool => is_string($c) && $c !== '');
        }
        if ($op === 'if') {
            $cond = $expression->condition ?? null;
            if (array_diff(array_keys(get_object_vars($expression)), ['op', 'condition', 'then_column_id', 'then_value', 'else_column_id', 'else_value']) !== []
                || !$cond instanceof stdClass
                || array_diff(array_keys(get_object_vars($cond)), ['left_column_id', 'comparator', 'right_column_id', 'right_value']) !== []
                || !is_string($cond->left_column_id ?? null) || $cond->left_column_id === ''
                || !in_array($cond->comparator ?? null, ['=', '<>', '>', '>=', '<', '<='], true)
                || (property_exists($cond, 'right_column_id') === property_exists($cond, 'right_value'))
                || (property_exists($expression, 'then_column_id') === property_exists($expression, 'then_value'))
                || (property_exists($expression, 'else_column_id') === property_exists($expression, 'else_value'))) {
                return false;
            }
            $validScalar = static fn (mixed $v): bool => is_bool($v) || ((is_int($v) || is_float($v)) && is_finite((float) $v))
                || (is_string($v) && preg_match('/[\x00-\x1f]/', $v) !== 1);
            $validRight = property_exists($cond, 'right_column_id') ? (is_string($cond->right_column_id) && $cond->right_column_id !== '') : $validScalar($cond->right_value);
            $validThen = property_exists($expression, 'then_column_id') ? (is_string($expression->then_column_id) && $expression->then_column_id !== '') : $validScalar($expression->then_value);
            $validElse = property_exists($expression, 'else_column_id') ? (is_string($expression->else_column_id) && $expression->else_column_id !== '') : $validScalar($expression->else_value);

            return $validRight && $validThen && $validElse;
        }
        if ($op === 'template') {
            $tpl = $expression->template ?? null;
            $params = $expression->params ?? null;
            if (array_diff(array_keys(get_object_vars($expression)), ['op', 'template', 'params']) !== []
                || !is_string($tpl) || strlen($tpl) < 2 || strlen($tpl) > 255 || !str_starts_with($tpl, '=')
                || preg_match('/[\x00-\x1f"\[\];!]/', $tpl) === 1
                || !$params instanceof stdClass) {
                return false;
            }
            $paramMap = get_object_vars($params);
            foreach ($paramMap as $colId) {
                if (!is_string($colId) || $colId === '') {
                    return false;
                }
            }
            $missing = false;
            $stripped = preg_replace_callback('/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/', static function (array $m) use ($paramMap, &$missing): string {
                if (!array_key_exists($m[1], $paramMap)) {
                    $missing = true;
                }

                return '1';
            }, $tpl);
            if ($missing || !is_string($stripped) || str_contains($stripped, '{') || str_contains($stripped, '}')
                || preg_match('/^=[A-Za-z0-9_+\-*\/(),.<>\s]+$/', $stripped) !== 1) {
                return false;
            }
            $allowedFns = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ROUND', 'ABS', 'IF', 'AND', 'OR', 'NOT'];
            if (preg_match_all('/([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/', $stripped, $matches, PREG_SET_ORDER) !== false) {
                foreach ($matches as $m) {
                    $ident = strtoupper($m[1]);
                    $isCall = isset($m[2]);
                    if ($isCall && !in_array($ident, $allowedFns, true)) {
                        return false;
                    }
                    if (!$isCall && !in_array($ident, ['TRUE', 'FALSE'], true)) {
                        return false;
                    }
                }
            }

            return true;
        }

        return false;
    }

    private static function validFormat(mixed $format): bool
    {
        if (!$format instanceof stdClass) {
            return false;
        }
        $keys = array_keys(get_object_vars($format));
        if ($keys === [] || array_diff($keys, ['font', 'fill', 'borders', 'alignment', 'numFmt']) !== []) {
            return false;
        }
        $hex = static fn (mixed $v): bool => is_string($v) && preg_match('/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/D', $v) === 1;
        if (property_exists($format, 'font')) {
            $font = $format->font;
            if (!$font instanceof stdClass || get_object_vars($font) === []
                || array_diff(array_keys(get_object_vars($font)), ['bold', 'italic', 'size', 'color']) !== []
                || (property_exists($font, 'bold') && !is_bool($font->bold))
                || (property_exists($font, 'italic') && !is_bool($font->italic))
                || (property_exists($font, 'size') && (!(is_int($font->size) || is_float($font->size)) || $font->size < 1 || $font->size > 409))
                || (property_exists($font, 'color') && $font->color !== null && !$hex($font->color))) {
                return false;
            }
        }
        if (property_exists($format, 'fill') && $format->fill !== null && !$hex($format->fill)) {
            return false;
        }
        if (property_exists($format, 'borders')) {
            $borders = $format->borders;
            if (!$borders instanceof stdClass || get_object_vars($borders) === []
                || array_diff(array_keys(get_object_vars($borders)), ['all', 'top', 'right', 'bottom', 'left']) !== []) {
                return false;
            }
            foreach (get_object_vars($borders) as $side) {
                if ($side !== null && (!$side instanceof stdClass
                    || array_diff(array_keys(get_object_vars($side)), ['style', 'color']) !== []
                    || !in_array($side->style ?? null, ['none', 'thin', 'medium', 'thick', 'dashed', 'dotted', 'double'], true)
                    || (property_exists($side, 'color') && !$hex($side->color)))) {
                    return false;
                }
            }
        }
        if (property_exists($format, 'alignment')) {
            $align = $format->alignment;
            if (!$align instanceof stdClass || get_object_vars($align) === []
                || array_diff(array_keys(get_object_vars($align)), ['horizontal', 'vertical', 'wrap']) !== []
                || (property_exists($align, 'horizontal') && $align->horizontal !== null && !in_array($align->horizontal, ['left', 'center', 'right'], true))
                || (property_exists($align, 'vertical') && $align->vertical !== null && !in_array($align->vertical, ['top', 'middle', 'bottom'], true))
                || (property_exists($align, 'wrap') && !is_bool($align->wrap))) {
                return false;
            }
        }
        if (property_exists($format, 'numFmt') && $format->numFmt !== null
            && (!is_string($format->numFmt) || $format->numFmt === '' || strlen($format->numFmt) > 255)) {
            return false;
        }

        return true;
    }

    private static function validRowInputs(mixed $rowInputs, bool $allowLeftRight): bool
    {
        if (!$rowInputs instanceof stdClass) {
            return false;
        }
        $vars = get_object_vars($rowInputs);
        if ($allowLeftRight && array_diff(array_keys($vars), ['left', 'right']) === []
            && property_exists($rowInputs, 'left') && property_exists($rowInputs, 'right')) {
            return self::validOperandExpectation($rowInputs->left) && self::validOperandExpectation($rowInputs->right);
        }

        return $vars !== [] && array_all($vars, static fn (mixed $op): bool => self::validOperandExpectation($op));
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
            || is_bool($cell->boolean ?? null)
            || (!$literal && is_string($cell->formula ?? null) && str_starts_with($cell->formula, '='));
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
