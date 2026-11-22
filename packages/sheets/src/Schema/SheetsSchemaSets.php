<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Schema;

use Override;
use Packman\Attributes\Spi;
use Packman\Attributes\SpiKind;
use Packman\Schema\Contracts\Migration\SchemaSetProvider;
use Packman\Schema\Data\Migration\SchemaSet;
use Packman\Schema\Enums\SchemaScope;

/**
 * Declares the versioned database schema sets owned by `axiomasoft/vaulter-sheets`.
 */
#[Spi(kind: SpiKind::Call, since: '1.0')]
final class SheetsSchemaSets implements SchemaSetProvider
{
    /** @return list<SchemaSet> */
    #[Override]
    public function sets(): array
    {
        return [
            new SchemaSet(
                package: 'axiomasoft/vaulter-sheets',
                name: 'sheets',
                scope: SchemaScope::Central,
                path: dirname(__DIR__, 2).'/database/migrations',
                version: 1,
                drivers: ['pgsql', 'sqlite'],
            ),
        ];
    }
}
