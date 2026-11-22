<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

use stdClass;
use Vaulter\Sheets\Data\WorkbookProblem;

final class RuntimeWire
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
        return (int) config('vaulter-sheets.max_message_bytes', 8 * 1024 * 1024);
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
        if (!$response instanceof stdClass || ($response->version ?? null) !== 1
            || ($response->request_id ?? null) !== $request->request_id || !is_bool($response->ok ?? null)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        if (!$response->ok) {
            if (!self::only($response, ['version', 'request_id', 'ok', 'error'])
                || !($response->error ?? null) instanceof stdClass
                || !self::only($response->error, ['code', 'message', 'detail']) || !is_string($response->error->code ?? null)
                || !is_string($response->error->message ?? null)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            [$code, $status] = match ($response->error->code) {
                'precondition_failed' => ['version_conflict', 409],
                'scope_changed' => ['scope_changed', 409],
                'unknown_target' => ['unknown_target', 422],
                'identity_required' => ['invalid_command', 422],
                'profile_mismatch', 'unsupported_command', 'unsupported_content' => ['unsupported_content', 422],
                'limit_exceeded' => ['limit_exceeded', 413],
                'calculation_timeout' => ['calculation_pending', 503],
                default => ['runtime_failed', 503],
            };
            throw new WorkbookProblem($code, $status, (array) ($response->error->detail ?? []));
        }
        $outcomeFields = $request->operation === 'read' ? ['data'] : ['workbook', 'candidate_sha256', 'changed_ranges', 'checks'];
        if (!self::only($response, ['version', 'request_id', 'ok', 'operation', 'base_sha256', 'calculation', ...$outcomeFields])
            || !($response->calculation ?? null) instanceof stdClass
            || !self::only($response->calculation, ['state', 'source_sha256'])
            || ($response->operation ?? null) !== $request->operation || ($response->base_sha256 ?? null) !== $request->base->sha256
            || ($response->calculation->state ?? null) !== 'ready') {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        if ($request->operation === 'read') {
            if (($response->calculation->source_sha256 ?? null) !== $request->base->sha256
                || !($response->data ?? null) instanceof stdClass || !self::only($response->data, ['ranges'])
                || !is_array($response->data->ranges ?? null)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }
        } elseif (!($response->workbook ?? null) instanceof stdClass || !is_string($response->candidate_sha256 ?? null)
            || !($response->checks ?? null) instanceof stdClass || !self::only($response->checks, ['cells', 'resources_preserved'])
            || !is_array($response->checks->cells ?? null) || !is_array($response->checks->resources_preserved ?? null)
            || !is_array($response->changed_ranges ?? null)) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        return $response;
    }

    private static function only(stdClass $object, array $allowed): bool
    {
        return array_diff(array_keys(get_object_vars($object)), $allowed) === [];
    }
}
