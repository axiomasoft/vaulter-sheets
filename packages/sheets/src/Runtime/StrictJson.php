<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

final class StrictJson
{
    private const int MAX_SAFE = 9007199254740991;

    private int $i = 0;

    private function __construct(private readonly string $s) {}

    public static function decode(string $text): mixed
    {
        if (!mb_check_encoding($text, 'UTF-8')) {
            throw new WireException('invalid_message', 'message is not valid UTF-8');
        }
        $parser = new self($text);
        $value = $parser->value(0);
        $parser->ws();
        if ($parser->i !== strlen($text)) {
            $parser->fail('trailing data');
        }

        return $value;
    }

    private function fail(string $why): never
    {
        throw new WireException('invalid_message', "{$why} at offset {$this->i}");
    }

    private function ws(): void
    {
        $this->i += strspn($this->s, " \t\n\r", $this->i);
    }

    private function string(): string
    {
        $start = $this->i++;
        $length = strlen($this->s);
        while ($this->i < $length) {
            $this->i += strcspn($this->s, '"\\', $this->i);
            $next = $this->s[$this->i] ?? null;
            if ($next === '"') {
                $token = substr($this->s, $start, ++$this->i - $start);
                try {
                    $decoded = json_decode($token, false, 2, JSON_THROW_ON_ERROR);
                    if (is_string($decoded)) {
                        return $decoded;
                    }
                } catch (\JsonException) {
                    $this->fail('invalid string escape');
                }
                break;
            }
            if ($next !== '\\') {
                break;
            }
            $this->i += 2;
        }
        $this->fail('invalid string');
    }

    private function value(int $depth): mixed
    {
        if ($depth > 256) {
            $this->fail('nesting too deep');
        }
        $this->ws();
        $c = $this->s[$this->i] ?? '';
        if ($c === '{') {
            $this->i++;
            $out = new \stdClass;
            $seen = [];
            $this->ws();
            if (($this->s[$this->i] ?? '') === '}') {
                $this->i++;

                return $out;
            }
            while (true) {
                $this->ws();
                if (($this->s[$this->i] ?? '') !== '"') {
                    $this->fail('expected key');
                }
                $key = $this->string();
                if (isset($seen[$key])) {
                    $this->fail('duplicate key '.json_encode($key, JSON_UNESCAPED_UNICODE));
                }
                $seen[$key] = true;
                $this->ws();
                if (($this->s[$this->i++] ?? '') !== ':') {
                    $this->fail('expected colon');
                }
                $out->{$key} = $this->value($depth + 1);
                $this->ws();
                $sep = $this->s[$this->i++] ?? '';
                if ($sep === '}') {
                    return $out;
                }
                if ($sep !== ',') {
                    $this->fail('expected comma');
                }
            }
        }
        if ($c === '[') {
            $this->i++;
            $out = [];
            $this->ws();
            if (($this->s[$this->i] ?? '') === ']') {
                $this->i++;

                return $out;
            }
            while (true) {
                $out[] = $this->value($depth + 1);
                $this->ws();
                $sep = $this->s[$this->i++] ?? '';
                if ($sep === ']') {
                    return $out;
                }
                if ($sep !== ',') {
                    $this->fail('expected comma');
                }
            }
        }
        if ($c === '"') {
            return $this->string();
        }
        foreach (['true' => true, 'false' => false, 'null' => null] as $word => $literal) {
            if (substr_compare($this->s, $word, $this->i, strlen($word)) === 0) {
                $this->i += strlen($word);

                return $literal;
            }
        }
        if (preg_match('/-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/A', $this->s, $m, 0, $this->i) !== 1) {
            $this->fail('unexpected token');
        }
        $this->i += strlen($m[0]);
        $isInteger = ($m[1] ?? '') === '' && ($m[2] ?? '') === '';
        if ($isInteger) {
            $digits = ltrim($m[0], '-');
            if (strlen($digits) <= 16 && (int) $digits <= self::MAX_SAFE) {
                return (int) $m[0];
            }
            // Same rule as Node: beyond 2^53-1 only the exact ES rendering of a double is accepted.
            $float = (float) $m[0];
            if (!is_finite($float) || CanonicalJson::encode($float) !== $m[0]) {
                $this->fail('integer outside safe range');
            }

            return $float;
        }
        $float = (float) $m[0];
        if (!is_finite($float)) {
            $this->fail('non-finite number');
        }

        return $float;
    }
}
