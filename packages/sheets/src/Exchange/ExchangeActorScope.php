<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

use Vaulter\Drive\Operations\DriveContext;

/** Actor and project shared by exchange authorization, idempotency and admission. */
final readonly class ExchangeActorScope
{
    private function __construct(
        private int|string $tenant,
        private string $project,
        private string $subjectType,
        private int|string $subjectId,
    ) {}

    public static function from(DriveContext $context): self
    {
        $actor = $context->actor->ref();
        $project = $context->operation->scope;

        return new self(
            $context->operation->tenant->id ?? 0,
            $project->kind.':'.$project->id,
            $actor->type ?? 'user',
            $actor->id ?? 0,
        );
    }

    /** @return array{tenant_id: int|string, project_scope: string, subject_type: string, subject_id: int|string} */
    public function columns(): array
    {
        return [
            'tenant_id' => $this->tenant,
            'project_scope' => $this->project,
            'subject_type' => $this->subjectType,
            'subject_id' => $this->subjectId,
        ];
    }
}
