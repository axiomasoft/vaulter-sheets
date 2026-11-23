<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Types;

use Packman\Attributes\Api;
use Vaulter\Documents\Contracts\DocumentCodec;
use Vaulter\Documents\Contracts\DocumentContent;
use Vaulter\Documents\Contracts\DocumentType;
use Vaulter\Documents\Contracts\RequiresCommandWrite;
use Vaulter\Documents\Data\Types\DocumentFeatures;
use Vaulter\Documents\Data\Types\DocumentViewer;
use Vaulter\Sheets\Content\WorkbookCodec;

#[Api]
final readonly class SpreadsheetDocumentType implements DocumentType, RequiresCommandWrite
{
    public const string KEY = 'vaulter/spreadsheet';

    public function __construct(private WorkbookCodec $workbookCodec) {}

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
        return 2;
    }

    public function codec(): DocumentCodec
    {
        return $this->workbookCodec;
    }

    public function defaultContent(): DocumentContent
    {
        return WorkbookCodec::blank();
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
