<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

final class WireException extends \RuntimeException
{
    public function __construct(public readonly string $wireCode, string $message)
    {
        parent::__construct($message);
    }
}
