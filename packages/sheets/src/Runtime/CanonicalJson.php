<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

use stdClass;

final class CanonicalJson
{
    public static function encode(mixed $value): string
    {
        return match (true) {
            $value === null => 'null',
            $value === true => 'true',
            $value === false => 'false',
            is_int($value) => self::integer($value),
            is_float($value) => self::number($value),
            is_string($value) => json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR),
            is_array($value) && array_is_list($value) => '['.implode(',', array_map(self::encode(...), $value)).']',
            $value instanceof stdClass => self::object(get_object_vars($value)),
            default => throw new WireException('invalid_message', 'value cannot be canonicalized (associative PHP array or resource)'),
        };
    }

    public static function sha256(mixed $value): string
    {
        return hash('sha256', self::encode($value));
    }

    private static function integer(int $value): string
    {
        if (abs($value) > 9007199254740991) {
            throw new WireException('invalid_message', 'integer outside safe range');
        }

        return (string) $value;
    }

    /** @param array<int|string, mixed> $members */
    private static function object(array $members): string
    {
        $keys = array_map(strval(...), array_keys($members));
        // RFC 8785 §3.2.3: order by UTF-16 code units; big-endian UTF-16 bytes compare the same way.
        usort($keys, static fn (string $a, string $b): int => strcmp(mb_convert_encoding($a, 'UTF-16BE', 'UTF-8'), mb_convert_encoding($b, 'UTF-16BE', 'UTF-8')));
        $parts = [];
        foreach ($keys as $key) {
            $parts[] = self::encode($key).':'.self::encode($members[$key]);
        }

        return '{'.implode(',', $parts).'}';
    }

    /** ECMAScript Number::toString: shortest round-trip digits, ES exponent rules. */
    private static function number(float $value): string
    {
        if (!is_finite($value)) {
            throw new WireException('invalid_message', 'non-finite number');
        }
        if ($value === 0.0) {
            return '0';
        }
        $sign = $value < 0 ? '-' : '';
        $abs = abs($value);
        for ($precision = 1; $precision <= 17; $precision++) {
            $repr = sprintf('%.'.($precision - 1).'e', $abs);
            if ((float) $repr === $abs) {
                break;
            }
        }
        [$mantissa, $exponent] = explode('e', $repr);
        $digits = rtrim(str_replace('.', '', $mantissa), '0');
        $k = strlen($digits);
        $n = (int) $exponent + 1;
        if ($k <= $n && $n <= 21) {
            return $sign.$digits.str_repeat('0', $n - $k);
        }
        if ($n > 0 && $n <= 21) {
            return $sign.substr($digits, 0, $n).'.'.substr($digits, $n);
        }
        if ($n > -6 && $n <= 0) {
            return $sign.'0.'.str_repeat('0', -$n).$digits;
        }
        $e = $n - 1;
        $exp = 'e'.($e < 0 ? '-' : '+').abs($e);

        return $sign.($k === 1 ? $digits : $digits[0].'.'.substr($digits, 1)).$exp;
    }
}
