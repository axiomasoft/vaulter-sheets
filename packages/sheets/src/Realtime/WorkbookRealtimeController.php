<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use stdClass;
use Vaulter\Collaboration\Persistence\RoomWriteConflict;
use Vaulter\Documents\Enums\Documents\DocumentWriteMode;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Http\Support\NodeRequestContext;
use Vaulter\Sheets\Data\WorkbookCommand;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

final readonly class WorkbookRealtimeController
{
    public function __construct(private NodeRequestContext $contexts, private WorkbookRoomSession $rooms, private AppendWorkbookMutation $append) {}

    public function session(Request $request, string $node): JsonResponse
    {
        return $this->respond(fn (): array => ['data' => $this->rooms->issue($this->contexts->resolve($request, $node), $node)->toArray()]);
    }

    public function profile(Request $request, string $node): JsonResponse
    {
        return $this->respond(function () use ($request, $node): array {
            $value = $request->input('mode');
            $mode = is_string($value) ? DocumentWriteMode::tryFrom($value) : null;
            $tag = $request->header('If-Match');
            if ($mode === null || $tag === null) {
                throw new WorkbookProblem('invalid_command', 422);
            }

            return ['data' => $this->rooms->switchProfile($this->contexts->resolve($request, $node), $node, $mode, $tag)];
        });
    }

    public function ready(Request $request): JsonResponse
    {
        return $this->respond(function () use ($request): array {
            $this->assertOwnerToken($request);

            return ['protocol' => WorkbookRoomDriver::VERSION];
        });
    }

    public function owner(Request $request, string $action): JsonResponse
    {
        return $this->respond(function () use ($request, $action): array {
            $this->assertOwnerToken($request);
            $bytes = $request->getContent();
            if (strlen($bytes) > 1_048_576) {
                throw new WorkbookProblem('limit_exceeded', 413);
            }
            try {
                $body = StrictJson::decode($bytes);
            } catch (WireException) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            if (!$body instanceof stdClass || !is_string($body->room ?? null) || !is_string($body->owner_id ?? null) || !Str::isUuid($body->owner_id)) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            $call = $this->rooms->credential($request->bearerToken(), $body->room);
            $context = $this->rooms->context($call);
            $fence = $body->owner_fence ?? null;
            if (in_array($action, ['append', 'renew', 'release'], true) && (!is_int($fence) || $fence < 1 || $fence > 9_007_199_254_740_991)) {
                throw new WorkbookProblem('invalid_command', 422);
            }
            if ($action !== 'append') {
                $after = $body->after_seq ?? null;
                if ($after !== null && (!is_int($after) || $after < 0 || $after > 9_007_199_254_740_991)) {
                    throw new WorkbookProblem('invalid_command', 422);
                }

                return $this->rooms->owner($context, $call, $action, $body->owner_id, is_int($fence) ? $fence : null, $after, ($body->include_state ?? false) === true);
            }
            $base = $body->base_seq ?? null;
            $intent = $body->intent ?? null;
            $tag = $body->if_match ?? null;
            if (!is_int($base) || $base < 0 || $base > 9_007_199_254_740_991
                || !$intent instanceof stdClass || ($tag !== null && !is_string($tag))) {
                throw new WorkbookProblem('invalid_command', 422);
            }

            return $this->append->execute($context, $call->ref->nodeId, $body->owner_id, $fence, $base, WorkbookCommand::fromWire($intent, $tag), $call);
        });
    }

    private function assertOwnerToken(Request $request): void
    {
        $file = config('vaulter-sheets.realtime.owner_token_file');
        $raw = is_string($file) && is_readable($file) ? file_get_contents($file, length: 4097) : false;
        $key = is_string($raw) ? trim($raw) : '';
        $presented = $request->header('X-Vaulter-Sheets-Owner');
        if (strlen($key) < 32 || strlen($key) > 4096 || $presented === null || !hash_equals($key, $presented)) {
            throw new WorkbookProblem('owner_credential_invalid', 401);
        }
    }

    /** @param Closure(): array<string, mixed> $action */
    private function respond(Closure $action): JsonResponse
    {
        try {
            return response()->json($action(), headers: ['Cache-Control' => 'no-store']);
        } catch (RoomWriteConflict $conflict) {
            return response()->json(['code' => $conflict->reason], 409);
        } catch (NodeNotFoundException|PermissionDeniedException) {
            return response()->json(['code' => 'resource_unavailable'], 404);
        } catch (WorkbookProblem $problem) {
            return response()->json(['code' => $problem->problem, 'detail' => $problem->detail], $problem->status);
        }
    }
}
