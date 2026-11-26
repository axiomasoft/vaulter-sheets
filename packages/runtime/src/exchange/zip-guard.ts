import {SaxesParser} from 'saxes';
import yauzl from 'yauzl';
import {ExchangeError} from './types.ts';

export const ZIP_MAX_ENTRIES = 2_000;
export const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
export const ZIP_MAX_RATIO = 100;
export const ZIP_MAX_RELS_BYTES = 256 * 1024;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

const HYPERLINK_REL_TYPES = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink',
]);

const XINCLUDE_NS = 'http://www.w3.org/2001/XInclude';
const utf8Decoder = new TextDecoder('utf-8', {fatal: true});

interface ByteSpan {
    name: string;
    start: number;
    end: number;
}

function fail(message: string, reason: string, extra: Record<string, string | number> = {}): never {
    throw new ExchangeError('unsafe_archive', message, {reason, ...extra});
}

function decodeRawEntryName(entry: yauzl.Entry): string {
    const candidate = (entry as unknown as {fileName: unknown}).fileName;
    const raw = Buffer.isBuffer(candidate)
        ? candidate
        : Buffer.isBuffer(entry.fileNameRaw)
            ? entry.fileNameRaw
            : Buffer.from(String(candidate), 'utf8');
    if (raw.length === 0 || raw.includes(0)) {
        fail('ZIP entry name is empty or contains NUL', 'invalid_entry_name');
    }
    let decoded: string;
    try {
        decoded = utf8Decoder.decode(raw);
    } catch {
        fail('ZIP entry name is not valid UTF-8', 'invalid_utf8_name');
    }
    if (
        decoded.startsWith('/') ||
        decoded.includes('\\') ||
        /^[a-zA-Z]:/.test(decoded) ||
        /(?:^|\/)\.\.(?:\/|$)/.test(decoded)
    ) {
        fail(`ZIP entry path is unsafe: ${decoded}`, 'unsafe_entry_path', {entry: decoded});
    }
    return decoded;
}

function checkExternalAttributes(entry: yauzl.Entry, name: string): void {
    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    const creatorOs = entry.versionMadeBy >>> 8;
    if (mode === S_IFLNK) {
        fail(`ZIP entry is a symbolic link: ${name}`, 'symlink_entry', {entry: name});
    }
    if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
        fail(`ZIP entry has unsupported UNIX file type: ${name}`, 'special_file_entry', {entry: name, mode});
    }
    if (creatorOs === 3 && mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
        fail(`ZIP entry has disallowed UNIX mode: ${name}`, 'special_file_entry', {entry: name, mode});
    }
}

function computeSpan(buffer: Buffer, entry: yauzl.Entry, name: string): ByteSpan {
    const offset = entry.relativeOffsetOfLocalHeader;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 30 > buffer.length) {
        fail(`ZIP local header offset out of bounds for ${name}`, 'corrupt_local_header', {entry: name});
    }
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
        fail(`ZIP local header signature mismatch for ${name}`, 'corrupt_local_header', {entry: name});
    }
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > buffer.length || dataEnd > buffer.length || dataEnd < offset) {
        fail(`ZIP entry byte range exceeds archive bounds for ${name}`, 'corrupt_byte_range', {entry: name});
    }
    return {name, start: offset, end: dataEnd};
}

function assertNonOverlappingSpans(spans: ByteSpan[]): void {
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i - 1].end > spans[i].start) {
            fail(
                `ZIP entries overlap in archive byte stream (${spans[i - 1].name} and ${spans[i].name})`,
                'overlapping_entries',
                {first: spans[i - 1].name, second: spans[i].name},
            );
        }
    }
}

export function assertSafeXmlBytes(bytes: Buffer, entryName: string): string {
    if (bytes.includes(0)) {
        fail(`XML entry contains NUL byte: ${entryName}`, 'nul_in_xml', {entry: entryName});
    }
    let text: string;
    try {
        text = utf8Decoder.decode(bytes);
    } catch {
        fail(`XML entry is not valid UTF-8: ${entryName}`, 'invalid_utf8_xml', {entry: entryName});
    }
    return text;
}

function inspectXml(xmlText: string, entryName: string, relationships: boolean): void {
    const parser = new SaxesParser({xmlns: true, position: false});
    parser.on('doctype', () => {
        fail(`XML DOCTYPE is forbidden: ${entryName}`, 'xxe_doctype', {entry: entryName});
    });
    parser.on('opentag', tag => {
        if (tag.uri === XINCLUDE_NS || Object.values(tag.ns).includes(XINCLUDE_NS)) {
            fail(`XML XInclude is forbidden: ${entryName}`, 'xxe_xinclude', {entry: entryName});
        }
        if (!relationships || tag.local !== 'Relationship') return;
        const targetMode = tag.attributes.TargetMode?.value ?? '';
        if (targetMode.toLowerCase() !== 'external') return;
        const relType = tag.attributes.Type?.value ?? '';
        const target = tag.attributes.Target?.value ?? '';
        if (!HYPERLINK_REL_TYPES.has(relType) || !/^(?:https?:\/\/|mailto:)/i.test(target)) {
            fail(
                `Disallowed external relationship in ${entryName} (type=${relType})`,
                'disallowed_external_relationship',
                {entry: entryName, type: relType},
            );
        }
    });
    parser.on('error', err => {
        fail(`Malformed XML in ${entryName}: ${err.message}`, 'malformed_xml', {entry: entryName});
    });
    parser.write(xmlText).close();
}

function readStreamBounded(
    zipfile: yauzl.ZipFile,
    entry: yauzl.Entry,
    name: string,
    remainingTotalBudget: number,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
                reject(new ExchangeError('unsafe_archive', `Unable to read ZIP entry ${name}`, {reason: 'unreadable_entry', entry: name}));
                return;
            }
            const chunks: Buffer[] = [];
            let received = 0;
            let settled = false;
            const abortWith = (error: ExchangeError) => {
                if (settled) return;
                settled = true;
                stream.destroy();
                reject(error);
            };
            stream.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > entry.uncompressedSize || received > ZIP_MAX_ENTRY_BYTES) {
                    abortWith(new ExchangeError('limit_exceeded', `Entry ${name} exceeded declared/maximum uncompressed size`, {reason: 'zip_bomb_entry_overflow', entry: name}));
                    return;
                }
                if (received > remainingTotalBudget) {
                    abortWith(new ExchangeError('limit_exceeded', 'Total uncompressed archive size exceeded limit', {reason: 'zip_bomb_total_overflow'}));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('error', () => {
                abortWith(new ExchangeError('unsafe_archive', `Corrupt compressed stream in ${name}`, {reason: 'corrupt_stream', entry: name}));
            });
            stream.on('end', () => {
                if (settled) return;
                settled = true;
                if (received !== entry.uncompressedSize) {
                    reject(new ExchangeError('unsafe_archive', `Entry ${name} size mismatch (${received} != ${entry.uncompressedSize})`, {reason: 'size_mismatch', entry: name}));
                    return;
                }
                resolve(Buffer.concat(chunks));
            });
        });
    });
}

export interface VerifiedZipArchive {
    files: Map<string, Buffer>;
    xmlTexts: Map<string, string>;
}

/**
 * Validates the ZIP central directory, byte spans, UNIX file modes, decompression quotas,
 * XML XXE/XInclude constraints, and external relationships before returning verified entries.
 */
export async function inspectAndReadXlsxZip(buffer: Buffer): Promise<VerifiedZipArchive> {
    if (buffer.length < 22) {
        fail('Input is not a valid ZIP archive', 'not_a_zip');
    }

    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        yauzl.fromBuffer(buffer, {lazyEntries: true, decodeStrings: false, validateEntrySizes: true}, (err, zip) => {
            if (err || !zip) {
                reject(new ExchangeError('unsafe_archive', err?.message ?? 'Invalid ZIP archive', {reason: 'invalid_zip'}));
                return;
            }
            resolve(zip);
        });
    });

    try {
        if (zipfile.entryCount > ZIP_MAX_ENTRIES) {
            throw new ExchangeError('limit_exceeded', `ZIP archive has ${zipfile.entryCount} entries (max ${ZIP_MAX_ENTRIES})`, {reason: 'too_many_entries'});
        }

        const seenNames = new Set<string>();
        const spans: ByteSpan[] = [];
        const entries: {name: string; entry: yauzl.Entry}[] = [];
        let declaredTotal = 0;

        await new Promise<void>((resolve, reject) => {
            let count = 0;
            let done = false;
            const abort = (error: unknown) => {
                if (done) return;
                done = true;
                reject(error);
            };
            zipfile.on('error', err => abort(new ExchangeError('unsafe_archive', err.message, {reason: 'zip_error'})));
            zipfile.on('end', () => {
                if (!done) {
                    done = true;
                    resolve();
                }
            });
            zipfile.on('entry', (entry: yauzl.Entry) => {
                try {
                    count++;
                    if (count > ZIP_MAX_ENTRIES) {
                        throw new ExchangeError('limit_exceeded', `ZIP archive exceeded ${ZIP_MAX_ENTRIES} entries`, {reason: 'too_many_entries'});
                    }
                    const name = decodeRawEntryName(entry);
                    const canonicalKey = name.replace(/\/+$/, '').toLowerCase();
                    if (canonicalKey === '' || seenNames.has(canonicalKey)) {
                        fail(`Duplicate or root ZIP entry name: ${name}`, 'duplicate_entry_name', {entry: name});
                    }
                    seenNames.add(canonicalKey);
                    checkExternalAttributes(entry, name);

                    if (entry.uncompressedSize < 0 || entry.compressedSize < 0 || entry.uncompressedSize > ZIP_MAX_ENTRY_BYTES) {
                        throw new ExchangeError('limit_exceeded', `ZIP entry ${name} exceeds ${ZIP_MAX_ENTRY_BYTES} bytes`, {reason: 'entry_size_limit', entry: name});
                    }
                    declaredTotal += entry.uncompressedSize;
                    if (declaredTotal > ZIP_MAX_TOTAL_BYTES) {
                        throw new ExchangeError('limit_exceeded', `ZIP total size exceeds ${ZIP_MAX_TOTAL_BYTES} bytes`, {reason: 'total_size_limit'});
                    }
                    if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > ZIP_MAX_RATIO)) {
                        throw new ExchangeError('limit_exceeded', `ZIP entry ${name} exceeds ${ZIP_MAX_RATIO}x compression ratio`, {reason: 'compression_ratio_limit', entry: name});
                    }

                    spans.push(computeSpan(buffer, entry, name));
                    if (!name.endsWith('/')) {
                        entries.push({name, entry});
                    }
                    zipfile.readEntry();
                } catch (err) {
                    abort(err);
                }
            });
            zipfile.readEntry();
        });

        assertNonOverlappingSpans(spans);

        const files = new Map<string, Buffer>();
        const xmlTexts = new Map<string, string>();
        let actualTotal = 0;

        for (const {name, entry} of entries) {
            const lower = name.toLowerCase();
            if (lower.endsWith('.rels') && entry.uncompressedSize > ZIP_MAX_RELS_BYTES) {
                fail(`Relationship entry ${name} exceeds ${ZIP_MAX_RELS_BYTES} bytes`, 'oversized_rels', {entry: name});
            }
            const bytes = await readStreamBounded(zipfile, entry, name, ZIP_MAX_TOTAL_BYTES - actualTotal);
            actualTotal += bytes.length;
            files.set(name, bytes);

            const relationships = lower.endsWith('.rels');
            if (relationships || lower.endsWith('.xml')) {
                const xmlText = assertSafeXmlBytes(bytes, name);
                inspectXml(xmlText, name, relationships);
                xmlTexts.set(name, xmlText);
            }
        }

        return {files, xmlTexts};
    } finally {
        zipfile.close();
    }
}
