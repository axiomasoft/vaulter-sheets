<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Psr\Http\Message\StreamInterface;
use stdClass;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;

final class HttpWorkbookRuntime implements WorkbookRuntime
{
    public function exchange(stdClass $request): stdClass
    {
        $file = config('vaulter-sheets.runtime_token_file');
        $raw = is_string($file) && is_readable($file) ? file_get_contents($file) : false;
        $token = is_string($raw) ? trim($raw) : '';
        $urlRaw = config('vaulter-sheets.runtime_url');
        $url = is_string($urlRaw) ? rtrim($urlRaw, '/') : '';
        if ($token === '' || $url === '') {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $timeoutRaw = config('vaulter-sheets.runtime_timeout_seconds', 25);
        $timeout = is_int($timeoutRaw) || is_float($timeoutRaw) ? (float) $timeoutRaw : 25.0;
        try {
            $response = Http::withToken($token)->withOptions(['allow_redirects' => false, 'stream' => true])
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
        } catch (ConnectionException|\RuntimeException $error) {
            throw $error instanceof WorkbookProblem ? $error : new WorkbookProblem('runtime_failed', 503);
        }
    }

    private static function boundedBody(StreamInterface $stream): string
    {
        $result = '';
        while (!$stream->eof()) {
            $chunk = $stream->read(min(65_536, RuntimeWire::limit() + 1 - strlen($result)));
            if ($chunk === '') {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            $result .= $chunk;
            if (strlen($result) > RuntimeWire::limit()) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
        }

        return $result;
    }
}
