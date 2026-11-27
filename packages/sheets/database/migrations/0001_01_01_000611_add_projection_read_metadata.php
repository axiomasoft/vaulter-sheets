<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Vaulter\Schema\SchemaHelpers;

return new class extends Migration
{
    public function up(): void
    {
        $schema = app(SchemaHelpers::class);
        $db = $schema->schemaConnection();
        $db->table($schema->table('sheets_projection_builds'), static function (Blueprint $table): void {
            $table->text('snapshot')->nullable();
        });
        $db->table($schema->table('sheets_projection_sheets'), static function (Blueprint $table): void {
            $table->integer('row_count')->nullable();
            $table->integer('column_count')->nullable();
            $table->text('empty_formats')->nullable();
        });
        $db->table($schema->table('sheets_projection_tables'), static function (Blueprint $table): void {
            $table->integer('header_row')->nullable();
        });
        foreach (['columns', 'rows'] as $axis) {
            $db->table($schema->table('sheets_projection_'.$axis), static function (Blueprint $table): void {
                $table->integer('ordinal')->nullable();
            });
        }
    }

    public function down(): void
    {
        $schema = app(SchemaHelpers::class);
        $db = $schema->schemaConnection();
        foreach ([
            'builds' => ['snapshot'], 'sheets' => ['row_count', 'column_count', 'empty_formats'],
            'tables' => ['header_row'], 'columns' => ['ordinal'], 'rows' => ['ordinal'],
        ] as $entity => $columns) {
            $db->table($schema->table('sheets_projection_'.$entity), static function (Blueprint $table) use ($columns): void {
                $table->dropColumn($columns);
            });
        }
    }
};
