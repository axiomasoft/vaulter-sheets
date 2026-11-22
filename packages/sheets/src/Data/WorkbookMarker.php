<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Data;

final readonly class WorkbookMarker
{
    public function __construct(
        public int $generation,
        public int $position,
        public string $sha256,
    ) {}

    public function etag(string $node): string
    {
        return '"'.$node.'.'.$this->generation.'.'.$this->position.'"';
    }
}
