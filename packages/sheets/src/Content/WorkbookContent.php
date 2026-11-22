<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Content;

use stdClass;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Sheets\Runtime\CanonicalJson;

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
        return json_decode($this->bytes, true, 256, JSON_THROW_ON_ERROR);
    }

    public function value(): stdClass
    {
        return json_decode($this->bytes, false, 256, JSON_THROW_ON_ERROR);
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
}
