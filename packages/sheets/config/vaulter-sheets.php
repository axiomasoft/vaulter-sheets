<?php

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
];
