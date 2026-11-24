<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Exchange;

use Vaulter\Sheets\Data\WorkbookProblem;
use XMLReader;
use ZipArchive;

/**
 * Inspects OOXML (.xlsx) ZIP archives strictly before parsing or decompression.
 * Never unpacks entries to disk; validates entry paths, UNIX file types (refusing
 * symlinks S_IFLNK), compression ratio/size quotas, XML DTD/ENTITY/XInclude,
 * and external relationship targets via bounded stream reads.
 */
final class ZipArchiveGuard
{
    public const int MAX_ENTRIES = 2_000;

    public const int MAX_ENTRY_BYTES = 50 * 1024 * 1024;

    public const int MAX_TOTAL_BYTES = 150 * 1024 * 1024;

    public const int MAX_RATIO = 100;

    public const int MAX_RELS_BYTES = 256 * 1024;

    private const int S_IFMT = 0170000;

    /**
     * @param resource $stream
     */
    public static function inspectStream(mixed $stream, int $maxCompressedBytes): void
    {
        if (!is_resource($stream)) {
            throw new WorkbookProblem('unsafe_archive', 422);
        }
        $bytes = '';
        while (!feof($stream)) {
            $chunk = fread($stream, 65536);
            if ($chunk === false) {
                throw new WorkbookProblem('unsafe_archive', 422);
            }
            $bytes .= $chunk;
            if (strlen($bytes) > $maxCompressedBytes) {
                throw new WorkbookProblem('limit_exceeded', 413);
            }
        }
        (new self())->assertSafe($bytes);
    }

    private const int S_IFREG = 0100000;

    private const int S_IFDIR = 0040000;

    private const int S_IFLNK = 0120000;

    private const string XINCLUDE_NS = 'http://www.w3.org/2001/XInclude';

    private const array HYPERLINK_REL_TYPES = [
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink',
    ];

    public function assertSafe(string $bytes): void
    {
        if (strlen($bytes) < 22) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'not_a_zip']);
        }

        $tmp = tempnam(sys_get_temp_dir(), 'vsx_');
        if ($tmp === false) {
            throw new WorkbookProblem('runtime_failed', 503);
        }

        try {
            if (file_put_contents($tmp, $bytes) !== strlen($bytes)) {
                throw new WorkbookProblem('runtime_failed', 503);
            }

            $zip = new ZipArchive;
            $opened = $zip->open($tmp, ZipArchive::RDONLY | ZipArchive::CHECKCONS);
            if ($opened !== true) {
                throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'invalid_zip']);
            }

            try {
                $this->inspectArchive($zip);
            } finally {
                $zip->close();
            }
        } finally {
            @unlink($tmp);
        }
    }

    private function inspectArchive(ZipArchive $zip): void
    {
        $count = $zip->numFiles;
        if ($count > self::MAX_ENTRIES) {
            throw new WorkbookProblem('limit_exceeded', 413, ['reason' => 'too_many_entries']);
        }

        $seen = [];
        $entries = [];
        $declaredTotal = 0;

        for ($i = 0; $i < $count; $i++) {
            $stat = $zip->statIndex($i, ZipArchive::FL_ENC_RAW);
            if (!is_array($stat)) {
                throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'invalid_entry_header']);
            }
            $rawName = $stat['name'];
            $this->assertSafeName($rawName, $seen);
            $this->assertSafeExternalAttrs($zip, $i, $rawName);

            $size = $stat['size'];
            $compSize = $stat['comp_size'];
            if ($size < 0 || $compSize < 0 || $size > self::MAX_ENTRY_BYTES) {
                throw new WorkbookProblem('limit_exceeded', 413, ['reason' => 'entry_size_limit', 'entry' => $rawName]);
            }
            $declaredTotal += $size;
            if ($declaredTotal > self::MAX_TOTAL_BYTES) {
                throw new WorkbookProblem('limit_exceeded', 413, ['reason' => 'total_size_limit']);
            }
            if ($size > 0 && ($compSize === 0 || ($size / $compSize) > self::MAX_RATIO)) {
                throw new WorkbookProblem('limit_exceeded', 413, ['reason' => 'compression_ratio_limit', 'entry' => $rawName]);
            }

            if (str_ends_with($rawName, '/')) {
                continue;
            }

            $lower = strtolower($rawName);
            $isRels = str_ends_with($lower, '.rels');
            $isXml = str_ends_with($lower, '.xml');
            if ($isRels && $size > self::MAX_RELS_BYTES) {
                throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'oversized_rels', 'entry' => $rawName]);
            }
            $entries[$i] = [$rawName, $size, $isRels, $isXml];
        }

        $actualTotal = 0;
        foreach ($entries as $i => [$rawName, $size, $isRels, $isXml]) {
            $remaining = self::MAX_TOTAL_BYTES - $actualTotal;
            $content = $this->readBoundedEntry($zip, $i, $rawName, $size, $remaining);
            $actualTotal += strlen($content);

            if ($isRels) {
                $this->assertSafeXmlText($content, $rawName);
                $this->assertSafeRelationships($content, $rawName);
            } elseif ($isXml) {
                $this->assertSafeXmlText($content, $rawName);
            }
        }
    }

    /**
     * @param array<string, true> $seen
     */
    private function assertSafeName(string $name, array &$seen): void
    {
        if ($name === '' || str_contains($name, "\0") || !mb_check_encoding($name, 'UTF-8')) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'invalid_entry_name']);
        }
        if (str_starts_with($name, '/') || str_contains($name, '\\')
            || preg_match('/^[A-Za-z]:/', $name) === 1
            || preg_match('#(?:^|/)\.\.(?:/|$)#', $name) === 1) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'unsafe_entry_path', 'entry' => $name]);
        }
        $key = strtolower(rtrim($name, '/'));
        if ($key === '' || isset($seen[$key])) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'duplicate_entry_name', 'entry' => $name]);
        }
        $seen[$key] = true;
    }

    private function assertSafeExternalAttrs(ZipArchive $zip, int $index, string $name): void
    {
        $opsys = 0;
        $attr = 0;
        if (!$zip->getExternalAttributesIndex($index, $opsys, $attr) || !is_int($attr)) {
            return;
        }
        $mode = ($attr >> 16) & self::S_IFMT;
        if ($mode === self::S_IFLNK) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'symlink_entry', 'entry' => $name]);
        }
        if ($mode !== 0 && $mode !== self::S_IFREG && $mode !== self::S_IFDIR) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'special_file_entry', 'entry' => $name]);
        }
    }

    private function readBoundedEntry(ZipArchive $zip, int $index, string $name, int $expectedSize, int $remainingTotal): string
    {
        $stream = $zip->getStreamIndex($index);
        if (!is_resource($stream)) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'unreadable_entry', 'entry' => $name]);
        }
        $buf = '';
        $received = 0;
        try {
            while (!feof($stream)) {
                $chunk = fread($stream, 65_536);
                if ($chunk === false) {
                    throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'corrupt_stream', 'entry' => $name]);
                }
                if ($chunk === '') {
                    continue;
                }
                $received += strlen($chunk);
                if ($received > $expectedSize || $received > self::MAX_ENTRY_BYTES || $received > $remainingTotal) {
                    throw new WorkbookProblem('limit_exceeded', 413, ['reason' => 'zip_bomb_overflow', 'entry' => $name]);
                }
                $buf .= $chunk;
            }
        } finally {
            fclose($stream);
        }
        if ($received !== $expectedSize) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'size_mismatch', 'entry' => $name]);
        }

        return $buf;
    }

    private function assertSafeXmlText(string $xml, string $entry): void
    {
        if (str_contains($xml, "\0") || !mb_check_encoding($xml, 'UTF-8')) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'invalid_xml_encoding', 'entry' => $entry]);
        }
        if (preg_match('/<!\s*(?:DOCTYPE|ENTITY)\b/i', $xml) === 1 || str_contains($xml, self::XINCLUDE_NS)) {
            throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'xxe_or_xinclude', 'entry' => $entry]);
        }
    }

    private function assertSafeRelationships(string $xml, string $entry): void
    {
        $reader = new XMLReader;
        $prevInternal = libxml_use_internal_errors(true);
        libxml_clear_errors();
        try {
            if (!$reader->XML($xml, 'UTF-8', LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING)) {
                throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'malformed_rels', 'entry' => $entry]);
            }
            while ($reader->read()) {
                if (in_array($reader->nodeType, [XMLReader::DOC_TYPE, XMLReader::ENTITY, XMLReader::ENTITY_REF], true)) {
                    throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'xxe_doctype', 'entry' => $entry]);
                }
                if ($reader->nodeType !== XMLReader::ELEMENT) {
                    continue;
                }
                if ($reader->namespaceURI === self::XINCLUDE_NS) {
                    throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'xxe_xinclude', 'entry' => $entry]);
                }
                if ($reader->localName !== 'Relationship') {
                    continue;
                }
                $targetMode = $reader->getAttribute('TargetMode') ?? '';
                if (strtolower($targetMode) !== 'external') {
                    continue;
                }
                $relType = $reader->getAttribute('Type') ?? '';
                $target = $reader->getAttribute('Target') ?? '';
                if (!in_array($relType, self::HYPERLINK_REL_TYPES, true)
                    || preg_match('#^(?:https?://|mailto:)#i', $target) !== 1) {
                    throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'disallowed_external_relationship', 'entry' => $entry]);
                }
            }
            if (libxml_get_last_error() !== false) {
                throw new WorkbookProblem('unsafe_archive', 422, ['reason' => 'malformed_rels', 'entry' => $entry]);
            }
        } finally {
            $reader->close();
            libxml_clear_errors();
            libxml_use_internal_errors($prevInternal);
        }
    }
}
