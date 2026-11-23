<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Http;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use stdClass;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Http\Support\NodeRequestContext;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Exchange\WorkbookExchange;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

final readonly class WorkbookExchangeController
{
    public function __construct(
        private NodeRequestContext $contexts,
        private WorkbookExchange $exchange,
    ) {}

    public function register(Request $request, string $node): JsonResponse
    {
        return $this->respond(function () use ($request, $node): JsonResponse {
            $context = $this->contexts->resolve($request, $node);
            $bytes = $request->getContent();
            if (strlen($bytes) > 256 * 1024) {
                throw new WorkbookProblem('limit_exceeded', 413);
            }
            try {
                $body = StrictJson::decode($bytes);
            } catch (WireException) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            if (!$body instanceof stdClass) {
                throw new WorkbookProblem('invalid_command', 422);
            }

            $sourceContext = null;
            if (($body->kind ?? null) === 'import' && ($body->source ?? null) instanceof stdClass) {
                $sourceNode = $body->source->node_id ?? null;
                if ((is_string($sourceNode) || is_int($sourceNode)) && (string) $sourceNode !== '') {
                    $sourceContext = $this->contexts->resolve($request, (string) $sourceNode);
                }
            }

            $outcome = $this->exchange->register($context, $node, $body, $sourceContext);
            $job = $outcome['job'];
            $status = $outcome['created'] || in_array($job['state'], ['queued', 'running'], true) ? 202 : 200;

            return response()->json(['data' => $job], $status);
        });
    }

    public function status(Request $request, string $node, string $exchange): JsonResponse
    {
        return $this->respond(fn (): JsonResponse => response()->json([
            'data' => $this->exchange->status($this->contexts->resolve($request, $node), $node, $exchange),
        ]));
    }

    public function download(Request $request, string $node, string $exchange): JsonResponse|StreamedResponse
    {
        try {
            $context = $this->contexts->resolve($request, $node);
            $result = $this->exchange->download($context, $node, $exchange);
            $stream = $result['stream'];
            $headers = [
                'Content-Type' => $result['mime'],
                'Cache-Control' => 'no-store',
                'X-Content-Type-Options' => 'nosniff',
            ];
            if ($result['sha256'] !== '') {
                $headers['ETag'] = '"'.$result['sha256'].'"';
            }

            return response()->streamDownload(static function () use ($stream): void {
                try {
                    fpassthru($stream);
                } finally {
                    fclose($stream);
                }
            }, $result['filename'], $headers);
        } catch (NodeNotFoundException) {
            return $this->problem(new WorkbookProblem('resource_unavailable', 404));
        } catch (WorkbookProblem $problem) {
            return $this->problem($problem);
        }
    }

    /**
     * @param Closure(): JsonResponse $call
     */
    private function respond(Closure $call): JsonResponse
    {
        try {
            return $call();
        } catch (NodeNotFoundException) {
            return $this->problem(new WorkbookProblem('resource_unavailable', 404));
        } catch (WorkbookProblem $problem) {
            return $this->problem($problem);
        }
    }

    private function problem(WorkbookProblem $problem): JsonResponse
    {
        return response()->json([
            'type' => 'about:blank',
            'title' => $problem->problem,
            'code' => $problem->problem,
            'status' => $problem->status,
            'detail' => $problem->detail,
        ], $problem->status, ['Content-Type' => 'application/problem+json']);
    }
}
