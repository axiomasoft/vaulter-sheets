<?php

declare(strict_types=1);

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpFoundation\Response;
use Vaulter\Drive\Exceptions\Access\PermissionDeniedException;
use Vaulter\Drive\Exceptions\Nodes\NodeNotFoundException;
use Vaulter\Drive\Exceptions\Profiles\ProfileRestrictionException;
use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Http\Support\NodeRequestContext;
use Vaulter\Exceptions\Access\MissingActorException;
use Vaulter\Sheets\Contracts\WorkbookOperations;
use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Queries\ReadWorkbookRange;

/*
 * Synthetic office page. The saved text link points here. Reveal and export both
 * resolve the node, the sheet and the current book grant again; a miss is a
 * neutral stub with no workbook title and no cell values.
 */
Route::get('/office/workbooks/{node}/sheets/{sheet}', static function (Request $request, string $node, string $sheet): Response {
    $range = $request->query('range');
    $neutral = static function (Request $request): Response {
        $payload = ['status' => 'unavailable'];
        if (str_contains((string) $request->header('Accept'), 'application/json')) {
            return response()->json($payload, 404, ['Cache-Control' => 'private, no-store']);
        }

        return response('<!doctype html><meta charset="utf-8"><article data-state="unavailable"><p>Unavailable</p></article>', 404, [
            'Content-Type' => 'text/html; charset=UTF-8', 'Cache-Control' => 'private, no-store',
        ]);
    };
    if (!is_string($range) || strlen($range) > 32 || preg_match('/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/', $range) !== 1) {
        return $neutral($request);
    }

    try {
        $context = app(NodeRequestContext::class)->resolve($request, $node);
        $catalog = app(WorkbookOperations::class)->catalog($context, $node);
        $exporting = $request->query('export') === '1';
        if ($exporting) {
            $flags = Vaulter::drive($context->drive)->actingAs($request->user())->nodes()->abilities($node)->flags;
            if (($flags['download'] ?? false) !== true) {
                return $neutral($request);
            }
        }
        $read = app(ReadWorkbookRange::class)->execute($context, $node, $sheet, $range, 100, ['value']);
        $name = Vaulter::drive($context->drive)->actingAs($request->user())->nodes()->find($node)->name;
    } catch (NodeNotFoundException|PermissionDeniedException|ProfileRestrictionException|WorkbookProblem|MissingActorException) {
        return $neutral($request);
    }

    $cells = [];
    foreach ($read as $part) {
        $rows = is_array($part->cells ?? null) ? $part->cells : [];
        foreach ($rows as $cell) {
            $vars = $cell instanceof stdClass ? get_object_vars($cell) : (is_array($cell) ? $cell : null);
            if ($vars === null) {
                continue;
            }
            $value = $vars['value'] ?? null;
            if (!is_string($value) && !is_int($value) && !is_float($value) && !is_bool($value)) {
                $value = null;
            }
            $cells[] = ['a1' => is_string($vars['a1'] ?? null) ? $vars['a1'] : '', 'value' => $value];
        }
    }
    if (str_contains((string) $request->header('Accept'), 'application/json')) {
        return response()->json([
            'status' => 'ready', 'title' => $name, 'range' => $range, 'cells' => $cells,
        ], 200, ['Cache-Control' => 'private, no-store']);
    }
    $shown = array_map(static fn (array $cell): string => $cell['value'] === null ? '' : (string) $cell['value'], $cells);
    $html = '<!doctype html><meta charset="utf-8"><article data-state="ready"><h1 data-workbook-title>'
        .htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')
        .'</h1><p data-workbook-values>'
        .htmlspecialchars(implode('|', $shown), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')
        .'</p></article>';

    return response($html, 200, ['Content-Type' => 'text/html; charset=UTF-8', 'Cache-Control' => 'private, no-store']);
})->name('office.workbooks.show')->where(['node' => '[A-Za-z0-9_-]+', 'sheet' => '[A-Za-z0-9_-]+']);
