<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Contracts;

use Packman\Attributes\Api;
use Vaulter\Drive\Operations\DriveContext;
use Vaulter\Sheets\Data\WorkbookCommand;

#[Api]
interface WorkbookOperations
{
    public function catalog(DriveContext $context, string $node): array;

    public function readTable(DriveContext $context, string $node, string $table): array;

    public function prepareFormula(DriveContext $context, string $node, string $table, string $destination, string $left, string $right, string $scope): array;

    public function commit(DriveContext $context, string $node, WorkbookCommand $command): array;

    public function status(DriveContext $context, string $node, string $command): array;

    public function verify(DriveContext $context, string $node, string $command): array;
}
