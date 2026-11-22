<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Queries;

use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Operations\LaravelWorkbookOperations;

final readonly class ReadWorkbookRange
{
    public function __construct(private LaravelWorkbookOperations $workbooks) {}

    public function execute(DriveContext $context, string $node, string $sheet, string $range, int $limit, array $fields): array
    {
        $data = $this->workbooks->readRange($context, $node, $sheet, $range, $limit);
        if ($fields !== []) {
            $selected = array_fill_keys(['sheet_id', 'a1', 'row', 'column', ...$fields], true);
            foreach ($data as $part) {
                $part->cells = array_map(static fn (\stdClass $cell): array => array_intersect_key((array) $cell, $selected), $part->cells);
            }
        }

        return $data;
    }
}
