<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use stdClass;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;

final class WorkbookContent implements DocumentContent
{
    private readonly string $bytes;

    private readonly string $hash;

    private ?stdClass $decoded = null;

    /** @var array<string, mixed>|null */
    private ?array $decodedArray = null;

    public function __construct(stdClass $payload)
    {
        $this->bytes = CanonicalJson::encode($payload);
        $this->hash = ($payload->storage ?? null) === 'media_blob' && is_string($payload->sha256 ?? null)
            ? $payload->sha256
            : hash('sha256', $this->bytes);
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        if ($this->decodedArray !== null) {
            return $this->decodedArray;
        }
        $out = [];
        foreach (get_object_vars($this->value()) as $key => $val) {
            $out[(string) $key] = self::arrayValue($val);
        }

        return $this->decodedArray = $out;
    }

    public function value(): stdClass
    {
        if ($this->decoded === null) {
            /** @var stdClass $payload */
            $payload = StrictJson::decode($this->bytes);
            $this->decoded = $payload;
        }

        return $this->decoded;
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
