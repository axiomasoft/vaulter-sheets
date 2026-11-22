<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Console;

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Contracts\Config\Repository;
use Vaulter\Modules\ModuleSchedule;

final class WorkbookSchedule implements ModuleSchedule
{
    public function define(Schedule $schedule, Repository $config): void
    {
        if ($config->get('vaulter-sheets.commands', true)) {
            $schedule->command(RecoverWorkbookJobs::class)->everyMinute()->withoutOverlapping();
        }
    }
}
