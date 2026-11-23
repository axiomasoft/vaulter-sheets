<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Queries;

use stdClass;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Operations\LaravelWorkbookOperations;

final readonly class ReadWorkbookRange
{
    public function __construct(private LaravelWorkbookOperations $workbooks) {}

    /**
     * @param  list<string>   $fields
     * @return list<stdClass>
     */
    public function execute(DriveContext $context, string $node, string $sheet, string $range, int $limit, array $fields): array
    {
        $data = $this->workbooks->readRange($context, $node, $sheet, $range, $limit);
        if ($fields !== []) {
            $selected = array_fill_keys(['sheet_id', 'a1', 'row', 'column', ...$fields], true);
            foreach ($data as $part) {
                $cells = is_array($part->cells ?? null) ? $part->cells : [];
                $filtered = [];
                foreach ($cells as $cell) {
                    if ($cell instanceof stdClass) {
                        $filtered[] = array_intersect_key(get_object_vars($cell), $selected);
                    }
                }
                $part->cells = $filtered;
            }
        }

        return $data;
    }
}
