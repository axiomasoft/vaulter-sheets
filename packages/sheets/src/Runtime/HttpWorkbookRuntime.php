<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Psr\Http\Message\StreamInterface;
use RuntimeException;
use stdClass;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;

final class HttpWorkbookRuntime implements WorkbookRuntime
{
    /** @var array<string, array{mtime: int, size: int, token: string}> */
    private static array $tokenCache = [];

    public function exchange(stdClass $request): stdClass
    {
        $token = self::readToken(config('vaulter-sheets.runtime_token_file'));
        $urlRaw = config('vaulter-sheets.runtime_url');
        $url = is_string($urlRaw) ? rtrim($urlRaw, '/') : '';
        if ($token === '' || $url === '') {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $timeoutRaw = config('vaulter-sheets.runtime_timeout_seconds', 25);
        $timeout = is_int($timeoutRaw) || is_float($timeoutRaw) ? (float) $timeoutRaw : 25.0;
        try {
            $response = Http::withToken($token)
                ->withHeaders(['Accept-Encoding' => 'gzip'])
                ->withOptions(['allow_redirects' => false, 'stream' => true])
                ->timeout($timeout)
                ->withBody(RuntimeWire::request($request), 'application/json')
                ->post($url.'/v1/operations');
            $stream = $response->toPsrResponse()->getBody();
            try {
                return match ($response->status()) {
                    200 => RuntimeWire::response(self::boundedBody($stream), $request),
                    413 => throw new WorkbookProblem('limit_exceeded', 413),
                    504 => throw new WorkbookProblem('calculation_pending', 503),
                    default => throw new WorkbookProblem('runtime_failed', 503),
                };
            } finally {
                $stream->close();
            }
        } catch (ConnectionException|RuntimeException $error) {
            throw $error instanceof WorkbookProblem ? $error : new WorkbookProblem('runtime_failed', 503);
        }
    }

    private static function readToken(mixed $file): string
    {
        if (!is_string($file) || $file === '') {
            return '';
        }
        clearstatcache(false, $file);
        $mtime = @filemtime($file);
        $size = @filesize($file);
        if ($mtime === false || $size === false) {
            unset(self::$tokenCache[$file]);

            return '';
        }
        $cached = self::$tokenCache[$file] ?? null;
        if ($cached !== null && $cached['mtime'] === $mtime && $cached['size'] === $size) {
            return $cached['token'];
        }
        $raw = is_readable($file) ? file_get_contents($file) : false;
        $token = is_string($raw) ? trim($raw) : '';
        if ($token !== '') {
            self::$tokenCache[$file] = ['mtime' => $mtime, 'size' => $size, 'token' => $token];
        }

        return $token;
    }

    private static function boundedBody(StreamInterface $stream): string
    {
        $result = '';
        while (!$stream->eof()) {
            $chunk = $stream->read(min(65_536, RuntimeWire::limit() + 1 - strlen($result)));
            if ($chunk === '') {
                break;
            }
            $result .= $chunk;
            if (strlen($result) > RuntimeWire::limit()) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
        }

        return $result;
    }
}
