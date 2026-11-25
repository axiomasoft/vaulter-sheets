<?php

declare(strict_types=1);

use Vaulter\Sheets\Data\WorkbookProblem;
use Vaulter\Sheets\Exchange\ZipArchiveGuard;

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/**
 * Builds an archive in memory. Entries may set 'store' (no compression) and
 * 'mode' (UNIX file type and permission bits in the external attributes).
 *
 * @param list<array{name: string, data: string, store?: bool, mode?: int}> $entries
 */
function guardZip(array $entries): string
{
    $path = tempnam(sys_get_temp_dir(), 'vsx_test_');
    if ($path === false) {
        throw new RuntimeException('tempnam failed');
    }
    $zip = new ZipArchive;
    $zip->open($path, ZipArchive::OVERWRITE);
    foreach ($entries as $entry) {
        $zip->addFromString($entry['name'], $entry['data']);
        if ($entry['store'] ?? false) {
            $zip->setCompressionName($entry['name'], ZipArchive::CM_STORE);
        }
        if (isset($entry['mode'])) {
            $zip->setExternalAttributesName($entry['name'], ZipArchive::OPSYS_UNIX, $entry['mode'] << 16);
        }
    }
    $zip->close();
    $bytes = (string) file_get_contents($path);
    unlink($path);

    return $bytes;
}

function relationship(string $type, string $target, string $mode = 'External'): string
{
    return '<?xml version="1.0"?><Relationships xmlns="'.RELS_NS.'">'
        .'<Relationship Id="r1" Type="'.$type.'" Target="'.$target.'" TargetMode="'.$mode.'"/></Relationships>';
}

function guardProblem(string $bytes): ?WorkbookProblem
{
    try {
        new ZipArchiveGuard()->assertSafe($bytes);
    } catch (WorkbookProblem $problem) {
        return $problem;
    }

    return null;
}

it('rejects an unsafe archive with the reason that names the broken rule', function (string $bytes, string $problem, int $status, string $reason): void {
    $thrown = guardProblem($bytes);

    expect($thrown)->not->toBeNull()
        ->and($thrown?->problem)->toBe($problem)
        ->and($thrown?->status)->toBe($status)
        ->and($thrown?->detail['reason'] ?? null)->toBe($reason);
})->with([
    'too short for a ZIP' => fn (): array => [str_repeat('x', 21), 'unsafe_archive', 422, 'not_a_zip'],
    'not a ZIP' => fn (): array => [str_repeat('x', 64), 'unsafe_archive', 422, 'invalid_zip'],
    'parent traversal' => fn (): array => [guardZip([['name' => 'xl/../../evil.xml', 'data' => '<a/>']]), 'unsafe_archive', 422, 'unsafe_entry_path'],
    'absolute path' => fn (): array => [guardZip([['name' => '/xl/workbook.xml', 'data' => '<a/>']]), 'unsafe_archive', 422, 'unsafe_entry_path'],
    'drive letter' => fn (): array => [guardZip([['name' => 'C:/xl/workbook.xml', 'data' => '<a/>']]), 'unsafe_archive', 422, 'unsafe_entry_path'],
    'backslash separator' => fn (): array => [guardZip([['name' => 'xl\\workbook.xml', 'data' => '<a/>']]), 'unsafe_archive', 422, 'unsafe_entry_path'],
    'case-insensitive duplicate' => fn (): array => [guardZip([['name' => 'xl/a.xml', 'data' => '<a/>'], ['name' => 'XL/A.xml', 'data' => '<a/>']]), 'unsafe_archive', 422, 'duplicate_entry_name'],
    'symlink entry' => fn (): array => [guardZip([['name' => 'xl/link.xml', 'data' => '/etc/passwd', 'mode' => 0120777]]), 'unsafe_archive', 422, 'symlink_entry'],
    'FIFO entry' => fn (): array => [guardZip([['name' => 'xl/pipe.xml', 'data' => '<a/>', 'mode' => 0010644]]), 'unsafe_archive', 422, 'special_file_entry'],
    'compression ratio above 100' => fn (): array => [guardZip([['name' => 'xl/bomb.xml', 'data' => str_repeat('A', 1024 * 1024)]]), 'limit_exceeded', 413, 'compression_ratio_limit'],
    'oversized relationships part' => fn (): array => [guardZip([['name' => '_rels/.rels', 'data' => str_repeat('A', ZipArchiveGuard::MAX_RELS_BYTES + 1), 'store' => true]]), 'unsafe_archive', 422, 'oversized_rels'],
    'NUL byte in XML' => fn (): array => [guardZip([['name' => 'xl/workbook.xml', 'data' => "<a>\0</a>"]]), 'unsafe_archive', 422, 'invalid_xml_encoding'],
    'invalid UTF-8 in XML' => fn (): array => [guardZip([['name' => 'xl/workbook.xml', 'data' => "<a>\xC3\x28</a>"]]), 'unsafe_archive', 422, 'invalid_xml_encoding'],
    'DOCTYPE in XML' => fn (): array => [guardZip([['name' => 'xl/workbook.xml', 'data' => '<!DOCTYPE a [<!ENTITY x "y">]><a/>']]), 'unsafe_archive', 422, 'xxe_or_xinclude'],
    'XInclude in XML' => fn (): array => [guardZip([['name' => 'xl/workbook.xml', 'data' => '<a xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="/etc/passwd"/></a>']]), 'unsafe_archive', 422, 'xxe_or_xinclude'],
    'empty relationships part' => fn (): array => [guardZip([['name' => '_rels/.rels', 'data' => '']]), 'unsafe_archive', 422, 'malformed_rels'],
    'unterminated relationships part' => fn (): array => [guardZip([['name' => '_rels/.rels', 'data' => '<Relationships xmlns="'.RELS_NS.'">']]), 'unsafe_archive', 422, 'malformed_rels'],
    'external template relationship' => fn (): array => [guardZip([['name' => 'xl/_rels/workbook.xml.rels', 'data' => relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate', 'https://evil.invalid/a.dotm')]]), 'unsafe_archive', 422, 'disallowed_external_relationship'],
    'external hyperlink to a file URL' => fn (): array => [guardZip([['name' => 'xl/worksheets/_rels/sheet1.xml.rels', 'data' => relationship(HYPERLINK_REL, 'file:///etc/passwd')]]), 'unsafe_archive', 422, 'disallowed_external_relationship'],
    'external hyperlink with a javascript URL' => fn (): array => [guardZip([['name' => 'xl/worksheets/_rels/sheet1.xml.rels', 'data' => relationship(HYPERLINK_REL, 'javascript:alert(1)')]]), 'unsafe_archive', 422, 'disallowed_external_relationship'],
]);

it('accepts web and mail hyperlinks and internal relationships', function (string $rels): void {
    $bytes = guardZip([
        ['name' => '[Content_Types].xml', 'data' => '<?xml version="1.0"?><Types/>'],
        ['name' => 'xl/worksheets/_rels/sheet1.xml.rels', 'data' => $rels],
    ]);

    expect(guardProblem($bytes))->toBeNull();
})->with([
    'https hyperlink' => [relationship(HYPERLINK_REL, 'https://example.com/report')],
    'upper-case HTTP hyperlink' => [relationship(HYPERLINK_REL, 'HTTP://example.com/')],
    'mailto hyperlink' => [relationship(HYPERLINK_REL, 'mailto:team@example.com')],
    'strict OOXML hyperlink' => [relationship('http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink', 'https://example.com/')],
    'internal part' => [relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'worksheets/sheet1.xml', 'Internal')],
]);

it('bounds the compressed size while reading an upload stream', function (): void {
    $stream = fopen('php://memory', 'w+b');
    expect($stream)->toBeResource();
    fwrite($stream, guardZip([['name' => 'xl/workbook.xml', 'data' => random_bytes(4096), 'store' => true]]));
    rewind($stream);

    expect(fn () => ZipArchiveGuard::inspectStream($stream, 1024))->toThrow(WorkbookProblem::class, 'limit_exceeded');
    fclose($stream);
});
