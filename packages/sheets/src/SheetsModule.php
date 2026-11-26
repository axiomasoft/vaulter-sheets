<?php

declare(strict_types=1);

namespace Vaulter\Sheets;

use Packman\Attributes\Api;
use Packman\Extensions\Concerns\Composition\ContributesToSlots;
use Packman\Extensions\Contracts\Composition\WithSlots;
use Packman\Extensions\Contracts\Persistence\WithSchema;
use Packman\Plugins\Contracts\Registry\ExtensionPlugin;
use Packman\Plugins\Data\Plugin\PluginManifest;
use Packman\Plugins\Laravel\PluginRegistrar;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Events\Documents\DocumentContentUpdated;
use Vaulter\Documents\Events\Revisions\DocumentRestored;
use Vaulter\Events\Outbox\OutboxConsumer;
use Vaulter\Modules\Activation;
use Vaulter\Modules\ModuleId;
use Vaulter\Modules\PluginModuleSpec;
use Vaulter\Modules\WithModuleRuntime;
use Vaulter\Sheets\Console\RecoverWorkbookJobs;
use Vaulter\Sheets\Console\WorkbookSchedule;
use Vaulter\Sheets\Projections\PublishCellProjection;
use Vaulter\Sheets\Schema\SheetsSchema;
use Vaulter\Sheets\Schema\SheetsSchemaSets;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

#[Api(since: '1.0')]
final class SheetsModule implements ExtensionPlugin, WithModuleRuntime, WithSchema, WithSlots
{
    use ContributesToSlots;

    public function manifest(): PluginManifest
    {
        return new PluginManifest(
            id: 'vaulter.'.$this->id()->value,
            version: '1.0.0',
            requires: array_map(
                static fn (string $id): string => 'vaulter.'.$id,
                array_keys($this->requires()),
            ),
        );
    }

    public function register(PluginRegistrar $registrar): void {}

    public function moduleRuntime(): PluginModuleSpec
    {
        return new PluginModuleSpec(
            plugin: self::class,
            protocolVersion: $this->version(),
            requires: $this->requires(),
            routes: [dirname(__DIR__).'/routes/sheets.php'],
            commands: [RecoverWorkbookJobs::class],
            listeners: [
                ['event' => DocumentContentUpdated::class, 'listener' => PublishCellProjection::class],
                ['event' => DocumentRestored::class, 'listener' => PublishCellProjection::class],
            ],
            schedules: [WorkbookSchedule::class],
            bindings: [SheetsBindings::class],
        );
    }

    public function id(): ModuleId
    {
        return new ModuleId('sheets');
    }

    public function version(): string
    {
        return '1.0';
    }

    public function activation(): Activation
    {
        return Activation::Auto;
    }

    /** @return array<string, string> */
    public function requires(): array
    {
        return ['core' => '^1.0', 'documents' => '^1.0', 'media' => '^1.0'];
    }

    public function migrationPath(): string
    {
        return dirname(__DIR__).'/database/migrations';
    }

    public function tablePrefix(): string
    {
        return 'v_';
    }

    public function tableNouns(): array
    {
        return app(SheetsSchema::class)->entities();
    }

    public function schemaSetProviders(): array
    {
        return [SheetsSchemaSets::class];
    }

    public function schemaComponents(): array
    {
        return [SheetsSchema::class];
    }

    /** @return list<array{slot: class-string, id: string, implementation: class-string, key?: string}> */
    public function slotContributions(): array
    {
        return [
            ['slot' => OutboxConsumer::class, 'id' => PublishCellProjection::ID, 'implementation' => PublishCellProjection::class],
            [
                'slot' => DocumentType::class,
                'id' => 'sheets.type.workbook',
                'implementation' => SpreadsheetDocumentType::class,
                'key' => SpreadsheetDocumentType::KEY,
            ],
        ];
    }
}
