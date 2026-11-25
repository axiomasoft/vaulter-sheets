<?php

declare(strict_types=1);

/**
 * Process-environment coordinates for the suite database.
 *
 * php-cli-server often leaves $_ENV empty (variables_order without E), and
 * Laravel's Env repository then falls back to SQLite :memory:. HTTP requests
 * would miss the schema the CLI migrate wrote on the server engine.
 *
 * @return array<string, string>
 */
function vaulter_sheets_capture_suite_database_env(): array
{
    $captured = [];
    foreach (['DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD'] as $key) {
        $value = getenv($key);
        if (!is_string($value) || $value === '') {
            continue;
        }
        $captured[$key] = $value;
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
        putenv($key.'='.$value);
    }

    return $captured;
}

/**
 * @param  array<string, string> $captured
 * @return array<string, string|bool|null>
 */
function vaulter_sheets_suite_database_connection(array $captured): array
{
    foreach ($captured as $key => $value) {
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
        putenv($key.'='.$value);
    }

    $resolved = Vaulter\Testing\Support\SuiteDatabaseConnection::resolve();
    $wanted = $captured['DB_CONNECTION'] ?? '';
    if ($wanted !== '' && $wanted !== 'sqlite' && ($resolved['driver'] ?? '') === 'sqlite') {
        return vaulter_sheets_suite_database_connection_from_env($captured);
    }

    return $resolved;
}

/**
 * @param  array<string, string> $captured
 * @return array<string, string|bool|null>
 */
function vaulter_sheets_suite_database_connection_from_env(array $captured): array
{
    $driver = $captured['DB_CONNECTION'] ?? '';
    if (!in_array($driver, ['pgsql', 'mysql', 'mariadb'], true)) {
        throw new RuntimeException('Unsupported test DB_CONNECTION ['.$driver.']; use sqlite, pgsql, mysql or mariadb.');
    }
    $database = $captured['DB_DATABASE'] ?? 'vaulter_test';
    if (!str_ends_with($database, '_test')) {
        throw new RuntimeException('Test database must end with _test: '.$database);
    }
    if ($driver !== 'pgsql') {
        return [
            'driver' => $driver,
            'host' => $captured['DB_HOST'] ?? '127.0.0.1',
            'port' => $captured['DB_PORT'] ?? '3306',
            'database' => $database,
            'username' => $captured['DB_USERNAME'] ?? 'vaulter',
            'password' => $captured['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
            'prefix' => '',
            'strict' => true,
        ];
    }

    return [
        'driver' => 'pgsql',
        'host' => $captured['DB_HOST'] ?? '127.0.0.1',
        'port' => $captured['DB_PORT'] ?? '5432',
        'database' => $database,
        'username' => $captured['DB_USERNAME'] ?? 'vaulter',
        'password' => $captured['DB_PASSWORD'] ?? '',
        'charset' => 'utf8',
        'prefix' => '',
        'prefix_indexes' => true,
        'search_path' => 'public',
        'sslmode' => 'prefer',
    ];
}
