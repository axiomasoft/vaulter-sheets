<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Packman\Schema\Contracts\Migration\SchemaSetProvider;
use Packman\Schema\Data\Migration\SchemaSet;
use Packman\Schema\Enums\SchemaScope;

final class SheetsRealtimeSchema implements SchemaSetProvider
{
    /** @return list<SchemaSet> */
    public function sets(): array
    {
        return [new SchemaSet(
            package: 'axiomasoft/vaulter-sheets',
            name: 'sheets-realtime',
            scope: SchemaScope::Central,
            path: dirname(__DIR__, 2).'/database/realtime-migrations',
            version: 1,
            drivers: ['pgsql', 'sqlite'],
        )];
    }
}
