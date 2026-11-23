<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Runtime;

use stdClass;
use Symfony\Component\Process\Exception\ProcessTimedOutException;
use Symfony\Component\Process\Exception\RuntimeException;
use Symfony\Component\Process\Process;
use Vaulter\Sheets\Contracts\WorkbookRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;

final class NodeWorkbookRuntime implements WorkbookRuntime
{
    public function exchange(stdClass $request): stdClass
    {
        $commandRaw = config('vaulter-sheets.runtime_command', ['vaulter-sheets-runtime']);
        if (!is_array($commandRaw) || $commandRaw === []) {
            throw new WorkbookProblem('runtime_failed', 503);
        }
        $command = [];
        foreach ($commandRaw as $part) {
            if (!is_string($part) || $part === '') {
                throw new WorkbookProblem('runtime_failed', 503);
            }
            $command[] = $part;
        }
        $timeoutRaw = config('vaulter-sheets.runtime_timeout_seconds', 25);
        $timeout = is_int($timeoutRaw) || is_float($timeoutRaw) ? (float) $timeoutRaw : 25.0;

        $process = new Process($command);
        $process->setInput(RuntimeWire::request($request));
        $process->setTimeout($timeout);
        $stdout = '';
        $process->disableOutput();
        try {
            $exit = $process->run(static function (string $channel, string $chunk) use (&$stdout): void {
                if ($channel === Process::OUT) {
                    $stdout .= $chunk;
                    if (strlen($stdout) > RuntimeWire::limit()) {
                        throw new WorkbookProblem('runtime_failed', 503);
                    }
                }
            });
        } catch (ProcessTimedOutException) {
            throw new WorkbookProblem('calculation_pending', 503);
        } catch (RuntimeException) {
            throw new WorkbookProblem('runtime_failed', 503);
        } finally {
            if ($process->isRunning()) {
                $process->stop(0);
            }
        }
        if ($exit !== 0) {
            throw new WorkbookProblem('runtime_failed', 503);
        }

        return RuntimeWire::response($stdout, $request);
    }
}
