<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Realtime;

use Vaulter\Collaboration\RoomTokens;
use Vaulter\Documents\Contracts\CollaborationProtocolDriver;
use Vaulter\Documents\Data\Collaboration\CollaborationGrant;
use Vaulter\Documents\Data\Collaboration\CollaborationMode;
use Vaulter\Documents\Data\Collaboration\CollaborationSession;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Types\SpreadsheetDocumentType;

final readonly class WorkbookRoomDriver implements CollaborationProtocolDriver
{
    public const string VERSION = 'univer-sheets/1';

    public function __construct(private RoomTokens $tokens) {}

    public function protocol(): string
    {
        return SpreadsheetDocumentType::COLLABORATION_PROTOCOL;
    }

    public function version(): string
    {
        return self::VERSION;
    }

    public function supportsState(string $documentType, string $stateFormat, int $schemaVersion, bool $hasCheckpoint, CollaborationMode $mode): bool
    {
        return $documentType === SpreadsheetDocumentType::KEY && $stateFormat === SpreadsheetDocumentType::COLLABORATION_FORMAT
            && $schemaVersion === 2 && $hasCheckpoint;
    }

    public function issueSession(CollaborationGrant $grant): CollaborationSession
    {
        $endpoint = $this->endpoint();
        $minted = $this->tokens->mint($grant->principal, $grant->nodeId, $grant->driveId, $grant->tenant, $grant->generation,
            $grant->schemaVersion, $grant->mode === CollaborationMode::Write, self::VERSION, $grant->stateFormat, $grant->notAfter, profile: 'strict');

        return new CollaborationSession($this->protocol(), $this->version(), rtrim($endpoint, '/').'/v1/rooms/'.rawurlencode($minted['room']),
            $minted['token'], $minted['exp'], $grant->mode, $grant->nodeId, $grant->generation,
            $grant->schemaVersion, ['room' => $minted['room'], 'profile' => 'strict']);
    }

    public function endpoint(): string
    {
        $endpoint = config('vaulter-sheets.realtime.url');
        if (!is_string($endpoint) || preg_match('~^wss?://[^/?#@\s]+(?:/[^?#\s]*)?$~D', $endpoint) !== 1) {
            throw new WorkbookProblem('room_unavailable', 503);
        }

        return $endpoint;
    }
}
