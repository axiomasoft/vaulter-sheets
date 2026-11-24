<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Support;

/**
 * @internal
 */
final class StrongEtag
{
    public static function format(string $node, int $generation, int $position): string
    {
        return '"'.$node.'.'.$generation.'.'.$position.'"';
    }

    public static function parsePosition(?string $etag, string $node, int $generation): ?int
    {
        if ($etag === null || $etag === '') {
            return null;
        }

        $pattern = '/^"'.preg_quote($node, '/').'\.'.preg_quote((string) $generation, '/').'\.(0|[1-9][0-9]*)"$/D';
        if (preg_match($pattern, $etag, $matches) !== 1) {
            return null;
        }

        return (int) $matches[1];
    }
}
