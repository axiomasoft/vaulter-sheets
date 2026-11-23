<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

use stdClass;
use Symfony\Component\Process\Exception\ProcessTimedOutException;
use Symfony\Component\Process\Exception\RuntimeException;
use Symfony\Component\Process\Process;
use Vaulter\Sheets\Contracts\WorkbookExchangeRuntime;
use Vaulter\Sheets\Data\WorkbookProblem;

final class NodeWorkbookExchangeRuntime implements WorkbookExchangeRuntime
{
    public function exchange(stdClass $request): stdClass
    {
        $rawCommand = config('vaulter-sheets.exchange.command', ['vaulter-sheets-exchange']);
        /** @var list<string> $command */
        $command = is_array($rawCommand)
            ? array_values(array_map(static fn (mixed $item): string => is_scalar($item) ? (string) $item : '', $rawCommand))
            : ['vaulter-sheets-exchange'];
        if ($command === [] || $command[0] === '') {
            $command = ['vaulter-sheets-exchange'];
        }

        $rawFormats = config('vaulter-sheets.exchange.formats', []);
        $formats = is_array($rawFormats)
            ? array_values(array_filter(array_map(
                static fn (mixed $item): string => is_string($item) ? strtolower(trim($item)) : '',
                $rawFormats,
            ), static fn (string $f): bool => in_array($f, ['csv', 'xlsx'], true)))
            : [];

        $timeoutRaw = config('vaulter-sheets.runtime_timeout_seconds', 25);
        $timeout = is_int($timeoutRaw) || is_float($timeoutRaw) ? (float) $timeoutRaw : 25.0;

        $process = new Process($command, env: ['SHEETS_EXCHANGE_FORMATS' => implode(',', $formats)]);
        $process->setInput(ExchangeWire::request($request));
        $process->setTimeout($timeout);
        $stdout = '';
        $process->disableOutput();
        try {
            $exit = $process->run(static function (string $channel, string $chunk) use (&$stdout): void {
                if ($channel === Process::OUT) {
                    $stdout .= $chunk;
                    if (strlen($stdout) > ExchangeWire::limit()) {
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

        return ExchangeWire::response($stdout, $request);
    }
}
