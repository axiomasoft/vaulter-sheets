<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Actions;

use Illuminate\Support\Str;
use stdClass;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Content\WorkbookCodec;
use Vaulter\Sheets\Content\WorkbookContent;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookMarker;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;

final readonly class WorkbookCommandCandidate
{
    public function __construct(private WorkbookRuntime $runtime, private WorkbookCodec $codec) {}

    /** @return array{DocumentContent, WorkbookContent, stdClass} */
    public function apply(DriveContext $context, DocumentContent $base, stdClass $workbook, WorkbookMarker $marker, WorkbookCommand $command, string $id): array
    {
        [$commands, $bindings] = $this->allocateRowIds($workbook, $command, $id);
        $response = $this->runtime->exchange((object) [
            'version' => 1, 'request_id' => (string) Str::uuid(), 'operation' => 'apply',
            'base' => (object) get_object_vars($marker), 'profile_id' => WorkbookCodec::PROFILE,
            'workbook' => $workbook, 'commands' => $commands,
        ]);
        $candidate = $this->verifyCandidate($response, $workbook, $marker, $bindings);
        $changed = is_array($response->changed_ranges ?? null) && $response->changed_ranges !== [];

        return [$changed ? $this->codec->prepare($candidate, $context) : $base, $changed ? $candidate : new WorkbookContent($workbook), $response];
    }

    /**
     * @param list<stdClass> $bindings
     */
    private function verifyCandidate(stdClass $response, stdClass $base, WorkbookMarker $marker, array $bindings): WorkbookContent
    {
        $candidate = $response->workbook ?? null;
        $baseNative = ($base->native ?? null) instanceof stdClass ? $base->native : new stdClass;
        $calculation = $response->calculation ?? null;
        if (!$candidate instanceof stdClass || !($candidate->native ?? null) instanceof stdClass
            || !is_array($candidate->native->resources ?? null)
            || !is_array($baseNative->resources ?? null)
            || ($response->base_sha256 ?? null) !== $marker->sha256
            || !$calculation instanceof stdClass
            || ($calculation->state ?? null) !== 'ready'
            || CanonicalJson::encode($candidate->profile ?? null) !== CanonicalJson::encode($base->profile ?? null)
            || ($candidate->native->id ?? null) !== ($baseNative->id ?? null)
            || ($candidate->native->sheetOrder ?? null) !== ($baseNative->sheetOrder ?? null)
            || CanonicalJson::encode($candidate->tables ?? null) !== CanonicalJson::encode($bindings)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $currentResources = self::resourceNames($baseNative->resources);
        $candidateResources = self::resourceNames($candidate->native->resources);
        if (array_diff($currentResources, $candidateResources) !== []) {
            throw new WorkbookProblem('unsupported_content', 422, ['reason' => 'resource_lost']);
        }
        $digest = CanonicalJson::sha256($candidate);
        if (($response->candidate_sha256 ?? null) !== $digest || ($calculation->source_sha256 ?? null) !== $digest) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $rawCandidate = [];
        foreach (get_object_vars($candidate) as $key => $val) {
            $rawCandidate[(string) $key] = $val;
        }
        $content = $this->codec->decode($rawCandidate, 2);
        if ($content->sizeInBytes() > $this->codec->maxSizeBytes()) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }
        if ($content->contentHash() !== $digest) {
            throw new WorkbookProblem('runtime_failed', 503);
        }

        return $content;
    }

    /**
     * @return array{0: list<stdClass>, 1: list<stdClass>}
     */
    private function allocateRowIds(stdClass $workbook, WorkbookCommand $command, string $id): array
    {
        $commands = [];
        $tablesRaw = StrictJson::decode(CanonicalJson::encode($workbook->tables ?? []));
        /** @var list<stdClass> $tables */
        $tables = [];
        if (is_array($tablesRaw)) {
            foreach ($tablesRaw as $t) {
                if ($t instanceof stdClass) {
                    $tables[] = $t;
                }
            }
        }
        foreach ($command->commands as $index => $source) {
            $item = clone $source;
            $rowNum = $item->row ?? null;
            $count = $item->count ?? null;
            if (($item->kind ?? null) === 'insert_row_before' && is_int($rowNum) && is_int($count)
                && $count > 0 && $count <= 10_000) {
                $assigned = new stdClass;
                foreach ($tables as $table) {
                    if (($table->sheet_id ?? null) !== ($item->sheet_id ?? null)) {
                        continue;
                    }
                    $tableId = is_string($table->table_id ?? null) ? $table->table_id : '';
                    $headerRow = is_int($table->header_row ?? null) ? $table->header_row : 0;
                    $tableRows = is_array($table->rows ?? null) ? $table->rows : [];
                    $rowNums = [$headerRow];
                    foreach ($tableRows as $binding) {
                        if ($binding instanceof stdClass && is_int($binding->row ?? null)) {
                            $rowNums[] = $binding->row;
                        }
                    }
                    $maxRow = max($rowNums);
                    if ($rowNum > $headerRow && $rowNum <= $maxRow) {
                        $newIds = [];
                        for ($offset = 0; $offset < $count; $offset++) {
                            $newIds[] = 'row_'.hash('sha256', $id.':'.$index.':'.$tableId.':'.$offset);
                        }
                        $assigned->{$tableId} = $newIds;
                    }
                    if ($headerRow >= $rowNum) {
                        $table->header_row = $headerRow + $count;
                    }
                    foreach ($tableRows as $binding) {
                        if ($binding instanceof stdClass && is_int($binding->row ?? null) && $binding->row >= $rowNum) {
                            $binding->row += $count;
                        }
                    }
                    $addedForTable = is_array($assigned->{$tableId} ?? null) ? $assigned->{$tableId} : [];
                    foreach ($addedForTable as $offset => $rowId) {
                        $tableRows[] = (object) ['row_id' => $rowId, 'row' => $rowNum + (int) $offset];
                    }
                    $table->rows = $tableRows;
                }
                $item->new_row_ids = $assigned;
            }
            $commands[] = $item;
        }
        usort($tables, static fn (stdClass $left, stdClass $right): int => strcmp(
            (string) mb_convert_encoding(self::str($left->table_id ?? ''), 'UTF-16BE', 'UTF-8'),
            (string) mb_convert_encoding(self::str($right->table_id ?? ''), 'UTF-16BE', 'UTF-8'),
        ));
        foreach ($tables as $table) {
            $cols = is_array($table->columns ?? null) ? array_values(array_filter($table->columns, static fn (mixed $c): bool => $c instanceof stdClass)) : [];
            usort($cols, static fn (stdClass $left, stdClass $right): int => ($left->column ?? 0) <=> ($right->column ?? 0));
            $table->columns = $cols;

            $rows = is_array($table->rows ?? null) ? array_values(array_filter($table->rows, static fn (mixed $r): bool => $r instanceof stdClass)) : [];
            usort($rows, static fn (stdClass $left, stdClass $right): int => ($left->row ?? 0) <=> ($right->row ?? 0));
            $table->rows = $rows;
        }

        return [$commands, $tables];
    }

    /**
     * @param  array<int|string, mixed> $resources
     * @return list<string>
     */
    private static function resourceNames(array $resources): array
    {
        $names = [];
        foreach ($resources as $resource) {
            if ($resource instanceof stdClass && is_string($resource->name ?? null)) {
                $names[] = $resource->name;
            }
        }

        return $names;
    }

    private static function str(mixed $value): string
    {
        return is_string($value) || is_int($value) ? (string) $value : '';
    }
}
