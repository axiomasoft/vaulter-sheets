<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Contracts;

use Closure;
use Vaulter\Drive\Operations\DriveContext;

interface WorkbookRecoveryContext
{
    /**
     * Restore the host's tenant and original actor before invoking the operation with a DriveContext.
     *
     * @param Closure(DriveContext): void $operation
     */
    public function run(string $tenant, string $scope, string $actorType, string $actorId, string $node, Closure $operation): void;
}
