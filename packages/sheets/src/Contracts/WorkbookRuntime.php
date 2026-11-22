<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Contracts;

use stdClass;

interface WorkbookRuntime
{
    public function exchange(stdClass $request): stdClass;
}
