<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Packman\Extensions\Concerns\Composition\ContributesToSlots;
use Packman\Extensions\Contracts\Composition\WithSlots;
use Packman\Extensions\Contracts\Persistence\WithSchema;
use Packman\Plugins\Contracts\Registry\ExtensionPlugin;
use Packman\Plugins\Data\Plugin\PluginManifest;
use Packman\Plugins\Laravel\PluginRegistrar;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Modules\Activation;
use Vaulter\Modules\PluginModuleSpec;
use Vaulter\Modules\WithModuleRuntime;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final class SheetsRealtimeModule implements ExtensionPlugin, WithModuleRuntime, WithSchema, WithSlots
{
    use ContributesToSlots;

    public function manifest(): PluginManifest
    {
        return new PluginManifest(id: 'vaulter.sheets-realtime', version: '1.0.0', requires: ['vaulter.sheets', 'vaulter.collaboration', 'vaulter.documents']);
    }

    public function register(PluginRegistrar $registrar): void {}

    public function moduleRuntime(): PluginModuleSpec
    {
        return new PluginModuleSpec(plugin: self::class, activation: Activation::OptIn, routes: [dirname(__DIR__, 2).'/routes/realtime.php']);
    }

    public function migrationPath(): ?string
    {
        return config('vaulter.modules.sheets-realtime') === true ? dirname(__DIR__, 2).'/database/realtime-migrations' : null;
    }

    public function tablePrefix(): string
    {
        return 'v_';
    }

    /** @return list<string> */
    public function tableNouns(): array
    {
        return ['sheets_realtime_links'];
    }

    /** @return list<class-string> */
    public function schemaSetProviders(): array
    {
        return $this->migrationPath() === null ? [] : [SheetsRealtimeSchema::class];
    }

    /** @return list<class-string> */
    public function schemaComponents(): array
    {
        return [];
    }

    /** @return list<array{slot: class-string, id: string, implementation: class-string, key: string}> */
    public function slotContributions(): array
    {
        return [[
            'slot' => CollaborationProtocolDriver::class,
            'id' => 'sheets.realtime.univer',
            'implementation' => WorkbookRoomDriver::class,
            'key' => SpreadsheetDocumentType::COLLABORATION_PROTOCOL,
        ]];
    }
}
