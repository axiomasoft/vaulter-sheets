<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Projections;

use Vaulter\Sheets\Data\WorkbookMarker;

final class PublishCellProjection
{
    public function canPublish(WorkbookMarker $source, WorkbookMarker $current): bool
    {
        return $source->generation === $current->generation
            && $source->position === $current->position
            && hash_equals($source->sha256, $current->sha256);
    }
}
