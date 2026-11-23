<?php

declare(strict_types=1);

return [
    'prefix' => 'api/vaulter-sheets/v1',
    'inline_snapshot_bytes' => 512 * 1024,
    'max_snapshot_bytes' => 7 * 1024 * 1024,
    'max_message_bytes' => 8 * 1024 * 1024,
    'runtime_command' => ['vaulter-sheets-runtime'],
    'runtime_url' => env('SHEETS_RUNTIME_URL'),
    'runtime_token_file' => env('SHEETS_RUNTIME_TOKEN_FILE'),
    'runtime_timeout_seconds' => 25,
    'lease_seconds' => 60,
    'replay_seconds' => 86_400,
    'evidence_seconds' => 86_400,
    'commands' => true,
    'realtime' => [
        'url' => env('SHEETS_REALTIME_URL'),
        'owner_token_file' => env('SHEETS_REALTIME_OWNER_TOKEN_FILE'),
    ],
    'exchange' => [
        'formats' => array_values(array_filter(array_map(
            static fn (string $v): string => strtolower(trim($v)),
            explode(',', (string) env('SHEETS_EXCHANGE_FORMATS', '')),
        ), static fn (string $v): bool => in_array($v, ['csv', 'xlsx'], true))),
        'max_import_bytes' => 5 * 1024 * 1024,
        'max_export_bytes' => 5 * 1024 * 1024,
        'keep_seconds' => 7 * 86_400,
        'lease_seconds' => 60,
        'queue_connection' => env('SHEETS_EXCHANGE_QUEUE_CONNECTION', 'sheets-exchange'),
        'command' => ['vaulter-sheets-exchange'],
    ],
];
