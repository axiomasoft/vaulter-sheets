<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Types;

use Packman\Attributes\Api;
use Vaulter\Documents\Content\OpaqueContent;
use Vaulter\Documents\Content\OpaqueJsonCodec;
use Vaulter\Documents\Contracts\DocumentCodec;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Data\Types\DocumentFeatures;
use Vaulter\Documents\Data\Types\DocumentViewer;

/**
 * A spreadsheet workbook owned by the Univer editor; the server stores its JSON
 * snapshot as is (schema v1). Single-user: Univer collaboration is a separate
 * engine, not the Yjs lane.
 */
#[Api]
final readonly class SpreadsheetDocumentType implements DocumentType
{
    public const string KEY = 'vaulter/spreadsheet';

    public function key(): string
    {
        return self::KEY;
    }

    public function label(): string
    {
        return 'Spreadsheet';
    }

    public function schemaVersion(): int
    {
        return 1;
    }

    public function codec(): DocumentCodec
    {
        return new OpaqueJsonCodec;
    }

    public function defaultContent(): DocumentContent
    {
        return OpaqueContent::fromArray([]);
    }

    public function viewer(): DocumentViewer
    {
        return new DocumentViewer(key: 'vaulter/univer');
    }

    public function features(): DocumentFeatures
    {
        return new DocumentFeatures(editable: true, previewable: true, thumbnailable: false, downloadable: false);
    }
}
