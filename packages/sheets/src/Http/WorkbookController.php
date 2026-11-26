<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Http;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use stdClass;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Http\Support\NodeRequestContext;
use Vaulter\Drive\Operations\NodeEditAccess;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Queries\ReadWorkbookRange;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

final readonly class WorkbookController
{
    public function __construct(
        private NodeRequestContext $contexts,
        private WorkbookOperations $workbooks,
        private ReadWorkbookRange $ranges,
        private NodeEditAccess $access,
    ) {}

    public function show(Request $request, string $node): JsonResponse
    {
        return $this->respond(function () use ($request, $node): JsonResponse {
            $data = $this->workbooks->catalog($this->contexts->resolve($request, $node), $node);
            $etag = is_string($data['etag'] ?? null) ? $data['etag'] : null;

            return response()->json(['data' => $data])->setEtag($etag);
        });
    }

    public function commit(Request $request, string $node): JsonResponse
    {
        return $this->respond(function () use ($request, $node): JsonResponse {
            $context = $this->contexts->resolve($request, $node);
            if (!$this->access->canEdit($context, $node)) {
                throw new WorkbookProblem('resource_unavailable', 404);
            }
            $bytes = $request->getContent();
            if (strlen($bytes) > 1024 * 1024) {
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
            $command = WorkbookCommand::fromWire($body, $request->header('If-Match'));

            return $this->outcome($this->workbooks->commit($context, $node, $command));
        });
    }

    public function status(Request $request, string $node, string $command): JsonResponse
    {
        return $this->respond(fn (): JsonResponse => $this->outcome(
            $this->workbooks->status($this->contexts->resolve($request, $node), $node, $command),
        ));
    }

    public function ranges(Request $request, string $node): JsonResponse
    {
        return $this->respond(function () use ($request, $node): JsonResponse {
            $sheet = $request->query('sheet_id');
            $range = $request->query('range');
            $fields = $request->query('fields');
            $limit = $request->query('limit', '10000');
            if (!is_string($sheet) || $sheet === '' || !is_string($range) || strlen($range) > 32 || strlen($sheet) > 255
                || !is_string($limit) || !ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 10_000
                || ($fields !== null && !is_string($fields))) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            $fields = $fields === null ? [] : explode(',', $fields);
            if (array_diff($fields, ['value', 'formula']) !== []) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            $context = $this->contexts->resolve($request, $node);

            return response()->json(['data' => $this->ranges->execute($context, $node, $sheet, $range, (int) $limit, $fields)]);
        });
    }

    /**
     * @param array<string, mixed> $outcome
     */
    private function outcome(array $outcome): JsonResponse
    {
        $error = is_array($outcome['error'] ?? null) ? $outcome['error'] : [];
        $errorStatus = is_int($error['status'] ?? null) ? $error['status'] : 500;
        $status = match ($outcome['state'] ?? null) {
            'rejected' => $errorStatus,
            'running' => 202,
            default => 200,
        };
        $response = response()->json(['data' => $outcome], $status);
        $etag = $outcome['etag'] ?? null;
        if (is_string($etag) && $etag !== '') {
            $response->setEtag($etag);
        }

        return $response;
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
            'type' => 'about:blank', 'title' => $problem->problem, 'code' => $problem->problem, 'status' => $problem->status,
            'detail' => $problem->detail,
        ], $problem->status, ['Content-Type' => 'application/problem+json']);
    }
}
