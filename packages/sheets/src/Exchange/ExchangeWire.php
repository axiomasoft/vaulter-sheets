<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

use stdClass;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

final class ExchangeWire
{
    public static function request(stdClass $request): string
    {
        $line = CanonicalJson::encode($request)."\n";
        if (strlen($line) > self::limit()) {
            throw new WorkbookProblem('limit_exceeded', 413);
        }

        return $line;
    }

    public static function limit(): int
    {
        $limit = config('vaulter-sheets.max_message_bytes', 8 * 1024 * 1024);

        return is_int($limit) && $limit > 0 ? $limit : 8 * 1024 * 1024;
    }

    public static function response(string $line, stdClass $request): stdClass
    {
        if (strlen($line) > self::limit() || preg_match('/^[^\r\n]+\n$/D', $line) !== 1) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        try {
            $response = StrictJson::decode(substr($line, 0, -1));
        } catch (WireException) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $reqId = is_string($request->request_id ?? null) ? $request->request_id : '';
        if (!$response instanceof stdClass || ($response->version ?? null) !== 1
            || ($response->request_id ?? null) !== $reqId || !is_bool($response->ok ?? null)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $operation = is_string($request->operation ?? null) ? $request->operation : '';
        $format = is_string($request->format ?? null) ? $request->format : '';
        if (!$response->ok) {
            if (!self::only($response, ['version', 'request_id', 'ok', 'error'])
                || !($response->error ?? null) instanceof stdClass
                || !self::only($response->error, ['code', 'message', 'detail'])
                || !is_string($response->error->code ?? null)
                || !is_string($response->error->message ?? null)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            /** @var array<string, mixed> $detail */
            $detail = [];
            if (($response->error->detail ?? null) instanceof stdClass) {
                foreach (get_object_vars($response->error->detail) as $k => $v) {
                    $detail[(string) $k] = $v;
                }
            }
            [$code, $status] = match ($response->error->code) {
                'format_disabled' => ['format_disabled', 422],
                'unsafe_archive' => ['unsafe_archive', 422],
                'unknown_target' => ['unknown_target', 422],
                'invalid_message' => ['invalid_command', 422],
                'unsupported_content', 'unsupported_version', 'profile_mismatch' => ['unsupported_content', 422],
                'limit_exceeded' => ['limit_exceeded', 413],
                'calculation_timeout' => ['calculation_pending', 503],
                default => ['runtime_failed', 503],
            };
            if ($operation === 'import' && $code === 'unsupported_content' && ($detail['reason'] ?? null) === 'strict_profile_loss' && isset($detail['report'])) {
                if (!$detail['report'] instanceof stdClass) {
                    throw new WorkbookProblem('runtime_failed', 503);
                }
                self::assertValidReport($detail['report'], $operation, $format, published: false);
            } else {
                unset($detail['report']);
            }
            throw new WorkbookProblem($code, $status, $detail);
        }
        if (!self::only($response, ['version', 'request_id', 'ok', 'operation', 'format', 'output_b64', 'output_sha256', 'report'])
            || ($response->operation ?? null) !== $operation
            || ($response->format ?? null) !== $format
            || !is_string($response->output_b64 ?? null)
            || !is_string($response->output_sha256 ?? null)
            || preg_match('/^[0-9a-f]{64}$/D', $response->output_sha256) !== 1
            || !($response->report ?? null) instanceof stdClass) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        self::assertValidReport($response->report, $operation, $format);

        return $response;
    }

    public static function decodeOutput(stdClass $response): string
    {
        $b64 = is_string($response->output_b64 ?? null) ? $response->output_b64 : '';
        $expectedSha = is_string($response->output_sha256 ?? null) ? $response->output_sha256 : '';
        if ($b64 === '') {
            $decoded = '';
        } else {
            if (preg_match('/^[A-Za-z0-9+\/]+={0,2}$/D', $b64) !== 1 || (strlen($b64) % 4) !== 0) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            $decoded = base64_decode($b64, true);
            if ($decoded === false) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
        }
        if (!hash_equals($expectedSha, hash('sha256', $decoded))) {
            throw new WorkbookProblem('runtime_failed', 503);
        }

        return $decoded;
    }

    private static function assertValidReport(stdClass $report, string $operation, string $format, ?bool $published = null): void
    {
        foreach (['format', 'operation', 'source_sha256', 'sheets', 'defined_names', 'losses', 'diagnostics', 'unknown_parts', 'editable_published'] as $key) {
            if (!property_exists($report, $key)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
        }
        if ($report->format !== $format || $report->operation !== $operation
            || !is_string($report->source_sha256 ?? null)
            || ($published === null && !is_string($report->output_sha256 ?? null))
            || ($published !== null && $report->editable_published !== $published)
            || !is_array($report->sheets ?? null)
            || !($report->defined_names ?? null) instanceof stdClass
            || !is_array($report->losses ?? null)
            || !is_array($report->diagnostics ?? null)
            || !is_array($report->unknown_parts ?? null)
            || !is_bool($report->editable_published ?? null)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
    }

    /**
     * @param list<string> $allowed
     */
    private static function only(stdClass $object, array $allowed): bool
    {
        $keys = array_map(static fn (int|string $key): string => (string) $key, array_keys(get_object_vars($object)));

        return array_diff($keys, $allowed) === [];
    }
}
