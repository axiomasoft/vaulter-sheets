<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

/** An authorized source prepared for an exchange and persisted only upon admission. */
final readonly class ExchangeSource
{
    public function __construct(
        public int $generation,
        public int $position,
        public string $bytes,
        public string $sha256,
        public string $fingerprint,
    ) {}
}
