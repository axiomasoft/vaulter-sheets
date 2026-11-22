<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Operations;

use Closure;
use Illuminate\Support\Facades\Context;
use Vaulter\Drive\Operations\NodeJobContext;
use Vaulter\Sheets\Contracts\WorkbookRecoveryContext;
use Vaulter\ValueObjects\Access\ActorRef;

final readonly class LaravelWorkbookRecoveryContext implements WorkbookRecoveryContext
{
    public function __construct(private NodeJobContext $contexts) {}

    public function run(string $tenant, string $scope, string $actorType, string $actorId, string $node, Closure $operation): void
    {
        if (!str_starts_with($scope, 'drive:') || $actorType === ActorRef::SYSTEM_TYPE) {
            return;
        }
        Context::scope(
            fn () => $this->contexts->run(substr($scope, 6), $tenant === '0' ? null : $tenant, new ActorRef($actorType, $actorId), $node, $operation),
            ['vaulter.tenant_id' => $tenant, 'vaulter.scope.kind' => 'drive'],
        );
    }
}
