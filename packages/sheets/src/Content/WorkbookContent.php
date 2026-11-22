<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use stdClass;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;

final readonly class WorkbookContent implements DocumentContent
{
    private string $bytes;

    private string $hash;

    public function __construct(stdClass $payload)
    {
        $this->bytes = CanonicalJson::encode($payload);
        $this->hash = ($payload->storage ?? null) === 'media_blob' ? $payload->sha256 : hash('sha256', $this->bytes);
    }

    public function toArray(): array
    {
        return array_map(self::arrayValue(...), (array) $this->value());
    }

    public function value(): stdClass
    {
        /** @var stdClass $payload */
        $payload = StrictJson::decode($this->bytes);

        return $payload;
    }

    public function canonicalBytes(): string
    {
        return $this->bytes;
    }

    public function contentHash(): string
    {
        return $this->hash;
    }

    public function sizeInBytes(): int
    {
        return strlen($this->bytes);
    }

    private static function arrayValue(mixed $value): mixed
    {
        return is_array($value) || $value instanceof stdClass
            ? array_map(self::arrayValue(...), (array) $value)
            : $value;
    }
}
