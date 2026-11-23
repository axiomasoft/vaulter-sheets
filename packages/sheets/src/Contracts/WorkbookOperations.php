<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Contracts;

use Packman\Attributes\Api;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Data\WorkbookCommand;

#[Api]
interface WorkbookOperations
{
    /**
     * @return array<string, mixed>
     */
    public function catalog(DriveContext $context, string $node): array;

    /**
     * @param  list<string>|null    $columns
     * @param  list<string>|null    $rowIds
     * @return array<string, mixed>
     */
    public function readTable(DriveContext $context, string $node, string $table, ?array $columns = null, ?array $rowIds = null): array;

    /**
     * @return array<string, mixed>
     */
    public function prepareFormula(DriveContext $context, string $node, string $table, string $destination, string $left, string $right, string $scope): array;

    /**
     * @return array<string, mixed>
     */
    public function commit(DriveContext $context, string $node, WorkbookCommand $command): array;

    /**
     * @return array<string, mixed>
     */
    public function status(DriveContext $context, string $node, string $command): array;

    /**
     * @return array<string, mixed>
     */
    public function verify(DriveContext $context, string $node, string $command): array;
}
