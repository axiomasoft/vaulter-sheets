<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Schema;

use InvalidArgumentException;
use LogicException;
use RuntimeException;
use Vaulter\Schema\ModuleSchema;
use Vaulter\Schema\SchemaHelpers;
use Vaulter\Schema\ValueObjects\KeyColumnExpectation;

final readonly class SheetsSchema implements ModuleSchema
{
    public function __construct(private SchemaHelpers $schema) {}

    public function entities(): array
    {
        return [
            'sheets_commands', 'sheets_projection_builds', 'sheets_projection_heads',
            'sheets_projection_sheets', 'sheets_projection_tables', 'sheets_projection_columns',
            'sheets_projection_rows', 'sheets_projection_cells', 'sheets_exchange_jobs',
        ];
    }

    public function keyColumns(): array
    {
        return [
            new KeyColumnExpectation('sheets_commands', 'document_id', 'REF'),
            new KeyColumnExpectation('sheets_commands', 'evidence_blob_id', 'REF'),
            new KeyColumnExpectation('sheets_projection_builds', 'document_id', 'REF'),
            new KeyColumnExpectation('sheets_projection_heads', 'document_id', 'REF'),
            new KeyColumnExpectation('sheets_exchange_jobs', 'document_id', 'REF'),
            new KeyColumnExpectation('sheets_exchange_jobs', 'source_blob_id', 'REF'),
            new KeyColumnExpectation('sheets_exchange_jobs', 'output_blob_id', 'REF'),
        ];
    }

    public function create(string $entity): void
    {
        if ($entity !== 'sheets_realtime_links' && !in_array($entity, $this->entities(), true)) {
            throw new InvalidArgumentException('Unknown Sheets table '.$entity);
        }
        $db = $this->schema->dbConnection();
        $rawSql = file_get_contents(dirname(__DIR__, 2).'/database/sql/'.$entity.'.sql');
        if ($rawSql === false) {
            throw new RuntimeException('Missing Sheets SQL definition '.$entity);
        }
        $sql = $rawSql;
        $postgres = $db->getDriverName() === 'pgsql';
        if ($postgres) {
            $db->statement("SET LOCAL lock_timeout = '2s'");
            $db->statement("SET LOCAL statement_timeout = '15s'");
            foreach ([
                'document_id' => 'documents',
                'evidence_blob_id' => 'blobs',
                'source_blob_id' => 'blobs',
                'output_blob_id' => 'blobs',
            ] as $field => $owner) {
                if (str_contains($sql, $field.' uuid')) {
                    /** @var object{type?: mixed}|null $column */
                    $column = $db->selectOne('SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = to_regclass(?) AND attname = ?', [
                        $this->schema->table($owner), 'id',
                    ]);
                    $type = $column !== null && isset($column->type) && is_string($column->type) ? $column->type : '';
                    if (preg_match('/^(?:uuid|bigint|character(?: varying)?\(\d+\))$/D', $type) !== 1) {
                        throw new LogicException('Unsupported Vaulter owner key type '.$type);
                    }
                    $sql = str_replace($field.' uuid', $field.' '.$type, $sql);
                }
            }
        } elseif ($db->getDriverName() === 'sqlite') {
            $sql = str_replace(
                [' DEFAULT uuidv7()', 'DEFAULT now()', 'octet_length(', 'jsonb_typeof(', 'left(formula,1)'],
                ['', 'DEFAULT CURRENT_TIMESTAMP', 'length(', 'json_type(', 'substr(formula,1,1)'],
                $sql,
            );
            $sql = str_replace(
                ["fingerprint ~ '^[0-9a-f]{64}$'", "source_sha256 ~ '^[0-9a-f]{64}$'", "json_type(literal) IN ('boolean','number','string')", "json_type(calculated) IN ('null','boolean','number','string')"],
                ["length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'", "length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'", "json_type(literal) IN ('true','false','integer','real','text')", "json_type(calculated) IN ('null','true','false','integer','real','text')"],
                $sql,
            );
        } else {
            throw new LogicException('Sheets requires PostgreSQL or SQLite.');
        }
        $replaced = preg_replace_callback('/\bv_(\w+)/', fn (array $match): string => $this->schema->table($match[1]), $sql);
        $sql = is_string($replaced) ? $replaced : $sql;
        foreach (array_filter(array_map(trim(...), explode(';', $sql)), static fn (string $statement): bool => $statement !== '') as $statement) {
            $db->statement($statement);
        }
    }

    public function drop(string $entity): void
    {
        $this->schema->schemaConnection()->dropIfExists($this->schema->table($entity));
    }
}
