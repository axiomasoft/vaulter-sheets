<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Support;

use Illuminate\Contracts\Database\Query\Expression as ExpressionContract;
use Illuminate\Database\Connection;
use stdClass;
use Vaulter\Sheets\Data\WorkbookProblem;

/**
 * @internal
 */
final class WorkbookClock
{
    /** @return literal-string */
    public static function nowLiteral(Connection $db): string
    {
        return $db->getDriverName() === 'pgsql'
            ? 'clock_timestamp()'
            : "strftime('%Y-%m-%d %H:%M:%f', 'now')";
    }

    public static function nowExpr(Connection $db): ExpressionContract
    {
        return $db->raw(self::nowLiteral($db));
    }

    public static function tryFutureTimestamp(Connection $db, int $seconds): ?string
    {
        if ($db->getDriverName() === 'pgsql') {
            $row = $db->selectOne('SELECT (clock_timestamp() + make_interval(secs => ?))::text AS ts', [$seconds]);
        } else {
            $modifier = ($seconds >= 0 ? '+' : '').$seconds.' seconds';
            $row = $db->selectOne("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', ?) AS ts", [$modifier]);
        }

        return $row instanceof stdClass && is_string($row->ts ?? null)
            ? $row->ts
            : null;
    }

    public static function futureTimestamp(Connection $db, int $seconds): string
    {
        return self::tryFutureTimestamp($db, $seconds) ?? gmdate('Y-m-d H:i:s', time() + $seconds);
    }

    public static function deadlineTimestamp(Connection $db, string $key): string
    {
        $value = config('vaulter-sheets.'.$key);
        $seconds = is_int($value) && $value > 0 ? $value : 86_400;

        return self::tryFutureTimestamp($db, $seconds)
            ?? throw new WorkbookProblem('room_unavailable', 503);
    }

    public static function future(Connection $db, ?string $time): bool
    {
        if ($time === null || $time === '') {
            return false;
        }

        if ($db->getDriverName() === 'pgsql') {
            $row = $db->selectOne('SELECT CASE WHEN CAST(? AS timestamptz) > clock_timestamp() THEN 1 ELSE 0 END AS future', [$time]);
        } else {
            $row = $db->selectOne("SELECT CASE WHEN ? > strftime('%Y-%m-%d %H:%M:%f', 'now') THEN 1 ELSE 0 END AS future", [$time]);
        }

        return $row instanceof stdClass && is_numeric($row->future ?? null) && (int) $row->future === 1;
    }
}
