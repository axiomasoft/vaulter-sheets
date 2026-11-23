<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Data;

final class WorkbookProblem extends \RuntimeException
{
    /**
     * @param array<string, mixed> $detail
     */
    public function __construct(
        public readonly string $problem,
        public readonly int $status,
        public readonly array $detail = [],
    ) {
        parent::__construct($problem);
    }
}
