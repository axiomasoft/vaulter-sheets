import {fork, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
import {MAX_MESSAGE_BYTES} from '../frame.ts';
import {WIRE_PROFILE} from '../profile.ts';
import {canonicalize, parseStrict, type Json, type JsonObject, type WorkbookV2} from '../protocol.ts';
import {exportCsv, importCsv} from './csv.ts';
import {
    ExchangeError,
    type ExchangeFormat,
    type ExchangeOperation,
    type ExchangeRequest,
    type ExchangeResponse,
} from './types.ts';
import {exportXlsx, importXlsx} from './xlsx.ts';

export function getMaxExchangeBinaryBytes(): number {
    const raw = Number(process.env.SHEETS_EXCHANGE_MAX_BYTES ?? 32 * 1024 * 1024);
    if (!Number.isFinite(raw) || raw < 1024 * 1024) return 32 * 1024 * 1024;
    return Math.min(Math.trunc(raw), 128 * 1024 * 1024);
}

export const MAX_EXCHANGE_BINARY_BYTES = getMaxExchangeBinaryBytes();
export const EXCHANGE_STREAM_MAGIC = Buffer.from('VX01', 'ascii');
export const EXCHANGE_STREAM_CONTENT_TYPE = 'application/vnd.vaulter.exchange-stream';

export function encodeExchangeStreamFrame(meta: unknown, payload: Buffer = Buffer.alloc(0)): Buffer {
    const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
    const header = Buffer.alloc(8);
    EXCHANGE_STREAM_MAGIC.copy(header, 0);
    header.writeUInt32BE(metaBuf.length, 4);
    return Buffer.concat([header, metaBuf, payload]);
}

export function decodeExchangeStreamFrame(frame: Buffer, maxTotalBytes: number = getMaxExchangeBinaryBytes() + 8 * 1024 * 1024): {meta: Json; payload: Buffer} {
    if (frame.length < 8 || !frame.subarray(0, 4).equals(EXCHANGE_STREAM_MAGIC)) {
        throw new ExchangeError('invalid_message', 'invalid VX01 exchange stream header');
    }
    if (frame.length > maxTotalBytes) {
        throw new ExchangeError('limit_exceeded', `exchange stream exceeds ${maxTotalBytes} bytes`);
    }
    const metaLen = frame.readUInt32BE(4);
    if (metaLen < 2 || 8 + metaLen > frame.length) {
        throw new ExchangeError('invalid_message', 'invalid VX01 metadata length');
    }
    const meta = parseStrict(frame.subarray(8, 8 + metaLen).toString('utf8'));
    const payload = frame.subarray(8 + metaLen);
    return {meta, payload};
}

export function parseEnabledExchangeFormats(raw: string | undefined): ExchangeFormat[] {
    if (!raw) return [];
    const seen = new Set<ExchangeFormat>();
    for (const part of raw.split(',')) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed === 'csv' || trimmed === 'xlsx') seen.add(trimmed);
    }
    return [...seen];
}

function decodeExchangeRequest(value: Json): ExchangeRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ExchangeError('invalid_message', 'exchange message must be an object');
    }
    const raw = value as JsonObject;
    const allowed = ['version', 'request_id', 'operation', 'format', 'profile_id', 'input_b64', 'input_sha256', 'options'];
    const extra = Object.keys(raw).filter(k => !allowed.includes(k));
    if (extra.length > 0) {
        throw new ExchangeError('invalid_message', `unknown fields: ${extra.join(', ')}`);
    }
    if (raw.version !== 1) {
        throw new ExchangeError('unsupported_version', `exchange wire version ${String(raw.version)} is not supported`);
    }
    if (typeof raw.request_id !== 'string' || raw.request_id === '' || raw.request_id.length > 128) {
        throw new ExchangeError('invalid_message', 'request_id must be a non-empty string');
    }
    if (raw.operation !== 'import' && raw.operation !== 'export') {
        throw new ExchangeError('invalid_message', 'operation must be import or export');
    }
    if (raw.format !== 'csv' && raw.format !== 'xlsx') {
        throw new ExchangeError('invalid_message', 'format must be csv or xlsx');
    }
    if (typeof raw.profile_id !== 'string' || raw.profile_id === '') {
        throw new ExchangeError('invalid_message', 'profile_id is required');
    }
    if (typeof raw.input_b64 !== 'string') {
        throw new ExchangeError('invalid_message', 'input_b64 must be a string');
    }
    if (typeof raw.input_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.input_sha256)) {
        throw new ExchangeError('invalid_message', 'input_sha256 must be lowercase hex SHA-256');
    }
    const options = raw.options === undefined ? {} : raw.options;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new ExchangeError('invalid_message', 'options must be an object');
    }
    return {
        version: 1,
        request_id: raw.request_id,
        operation: raw.operation as ExchangeOperation,
        format: raw.format as ExchangeFormat,
        profile_id: raw.profile_id,
        input_b64: raw.input_b64,
        input_sha256: raw.input_sha256,
        options: options as JsonObject,
    };
}

function decodeBase64Strict(b64: string): Buffer {
    if (b64 === '') return Buffer.alloc(0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new ExchangeError('invalid_message', 'input_b64 is not valid base64');
    }
    const out = Buffer.from(b64, 'base64');
    const maxBinBytes = getMaxExchangeBinaryBytes();
    if (out.length > maxBinBytes) {
        throw new ExchangeError('limit_exceeded', `decoded exchange input exceeds ${maxBinBytes} bytes`);
    }
    return out;
}

function validateWorkbookForExport(input: Buffer): WorkbookV2 {
    let parsed: Json;
    try {
        parsed = parseStrict(new TextDecoder('utf-8', {fatal: true}).decode(input));
    } catch {
        throw new ExchangeError('invalid_message', 'export input is not valid UTF-8 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ExchangeError('invalid_message', 'export workbook must be an object');
    }
    const book = parsed as JsonObject;
    if (book.format_version !== 2 || !book.native || typeof book.native !== 'object' || Array.isArray(book.native)) {
        throw new ExchangeError('unsupported_content', 'export input must be a v2 workbook');
    }
    if (canonicalize(book.profile) !== canonicalize(WIRE_PROFILE)) {
        throw new ExchangeError('profile_mismatch', `runtime serves ${WIRE_PROFILE.id}`);
    }
    return book as unknown as WorkbookV2;
}

export async function runExchange(message: Json, enabledFormats: readonly ExchangeFormat[]): Promise<ExchangeResponse> {
    const request = decodeExchangeRequest(message);
    if (request.profile_id !== WIRE_PROFILE.id) {
        throw new ExchangeError('profile_mismatch', `runtime serves ${WIRE_PROFILE.id}`, {expected: WIRE_PROFILE.id, actual: request.profile_id});
    }
    if (!enabledFormats.includes(request.format)) {
        throw new ExchangeError('format_disabled', `exchange format ${request.format} is disabled`, {format: request.format});
    }

    const inputBytes = decodeBase64Strict(request.input_b64);
    const actualSha = createHash('sha256').update(inputBytes).digest('hex');
    if (actualSha !== request.input_sha256) {
        throw new ExchangeError('base_mismatch', 'input bytes do not match input_sha256', {expected: request.input_sha256, actual: actualSha});
    }

    if (request.operation === 'import') {
        const imported = request.format === 'csv'
            ? await importCsv(inputBytes, request.options)
            : await importXlsx(inputBytes, request.options);
        const canonical = Buffer.from(canonicalize(imported.workbook), 'utf8');
        const outputSha = createHash('sha256').update(canonical).digest('hex');
        return {
            version: 1,
            request_id: request.request_id,
            ok: true,
            operation: 'import',
            format: request.format,
            output_b64: canonical.toString('base64'),
            output_sha256: outputSha,
            report: {...imported.report, output_sha256: outputSha},
        };
    }

    const workbook = validateWorkbookForExport(inputBytes);
    const exported = request.format === 'csv'
        ? await exportCsv(workbook, request.options)
        : await exportXlsx(workbook, request.options);
    const maxBinBytes = getMaxExchangeBinaryBytes();
    if (exported.bytes.length > maxBinBytes) {
        throw new ExchangeError('limit_exceeded', `exported ${request.format} exceeds ${maxBinBytes} bytes`);
    }
    const outputB64 = exported.bytes.toString('base64');
    const maxWireBytes = Math.max(MAX_MESSAGE_BYTES, maxBinBytes * 2 + 2 * 1024 * 1024);
    if (Buffer.byteLength(outputB64) > maxWireBytes - 65_536) {
        throw new ExchangeError('limit_exceeded', 'encoded exchange response exceeds wire message budget');
    }
    return {
        version: 1,
        request_id: request.request_id,
        ok: true,
        operation: 'export',
        format: request.format,
        output_b64: outputB64,
        output_sha256: exported.report.output_sha256,
        report: exported.report,
    };
}

export async function processExchangeFrame(bytes: Uint8Array, enabledFormats: readonly ExchangeFormat[]): Promise<ExchangeResponse> {
    let requestId: string | null = null;
    try {
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (buf.length >= 4 && buf.subarray(0, 4).equals(EXCHANGE_STREAM_MAGIC)) {
            const {meta, payload} = decodeExchangeStreamFrame(buf);
            if (meta && typeof meta === 'object' && !Array.isArray(meta) && typeof meta.request_id === 'string') {
                requestId = meta.request_id;
            }
            const metaObj = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? {...meta} as JsonObject : {};
            if (metaObj.input_b64 === undefined || metaObj.input_b64 === '') {
                metaObj.input_b64 = payload.toString('base64');
            }
            return await runExchange(metaObj, enabledFormats);
        }
        const maxJsonBytes = Math.max(MAX_MESSAGE_BYTES, getMaxExchangeBinaryBytes() * 2 + 1024 * 1024);
        if (bytes.length > maxJsonBytes + 1) {
            throw new ExchangeError('limit_exceeded', 'exchange message exceeds byte limit');
        }
        if (bytes.at(-1) !== 10) {
            throw new ExchangeError('invalid_message', 'exchange message must end with LF');
        }
        let text: string;
        try {
            text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, -1));
        } catch {
            throw new ExchangeError('invalid_message', 'exchange message is not valid UTF-8');
        }
        if (/[\r\n]/.test(text)) {
            throw new ExchangeError('invalid_message', 'expected one JSON line');
        }
        let message: Json;
        try {
            message = parseStrict(text);
        } catch (err) {
            throw new ExchangeError('invalid_message', err instanceof Error ? err.message : 'invalid JSON');
        }
        if (message && typeof message === 'object' && !Array.isArray(message) && typeof message.request_id === 'string') {
            requestId = message.request_id;
        }
        return await runExchange(message, enabledFormats);
    } catch (err) {
        if (err instanceof ExchangeError) {
            return {
                version: 1,
                request_id: requestId,
                ok: false,
                error: {code: err.code, message: err.message, ...(err.detail ? {detail: err.detail} : {})},
            };
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('WireError') || message.includes('timeout')) {
            return {version: 1, request_id: requestId, ok: false, error: {code: 'calculation_timeout', message}};
        }
        return {version: 1, request_id: requestId, ok: false, error: {code: 'runtime_failed', message}};
    }
}

class ExchangeTransportError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`Exchange HTTP ${status}`);
        this.status = status;
    }
}

interface ExchangeTask {
    frame: Buffer;
    enabledFormats: readonly ExchangeFormat[];
    resolve: (response: ExchangeResponse) => void;
    reject: (error: ExchangeTransportError) => void;
}

interface ExchangeWorker {
    child: ChildProcess;
    tasks: number;
    active?: ExchangeTask;
    timer?: ReturnType<typeof setTimeout>;
}

/** Separate forked IPC pool for CSV/XLSX exchange jobs with isolated queue and memory limits. */
export class ExchangePool {
    private readonly workers = new Set<ExchangeWorker>();
    private readonly waiting: ExchangeTask[] = [];

    run(frame: Buffer, enabledFormats: readonly ExchangeFormat[]): Promise<ExchangeResponse> {
        if (this.waiting.length >= 8) return Promise.reject(new ExchangeTransportError(503));
        return new Promise((resolve, reject) => {
            this.waiting.push({frame, enabledFormats, resolve, reject});
            this.dispatch();
        });
    }

    private start(): ExchangeWorker {
        const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
        const child = fork(fileURLToPath(new URL(`./child.${extension}`, import.meta.url)), {
            serialization: 'advanced',
            execArgv: ['--max-old-space-size=640'],
        });
        const worker: ExchangeWorker = {child, tasks: 0};
        this.workers.add(worker);
        child.on('message', (message: {response?: ExchangeResponse}) => this.finish(worker, message.response ? 200 : 503, message.response));
        child.on('exit', () => this.finish(worker, 503));
        child.on('error', () => this.finish(worker, 503));
        return worker;
    }

    private finish(worker: ExchangeWorker, status: number, response?: ExchangeResponse): void {
        if (!this.workers.has(worker)) return;
        clearTimeout(worker.timer);
        const task = worker.active;
        worker.active = undefined;
        if (status !== 200 || worker.tasks >= 50) {
            this.workers.delete(worker);
            worker.child.kill();
        }
        if (response) task?.resolve(response);
        else task?.reject(new ExchangeTransportError(status));
        this.dispatch();
    }

    private dispatch(): void {
        while (this.waiting.length > 0) {
            const worker = [...this.workers].find(candidate => !candidate.active)
                ?? (this.workers.size < 2 ? this.start() : undefined);
            if (!worker) return;
            const task = this.waiting.shift()!;
            worker.active = task;
            worker.tasks++;
            worker.timer = setTimeout(() => this.finish(worker, 504), 20_000);
            worker.child.send({frame: task.frame, enabledFormats: [...task.enabledFormats]}, error => {
                if (error && worker.active === task) this.finish(worker, 503);
            });
        }
    }

    close(): void {
        for (const worker of this.workers) {
            clearTimeout(worker.timer);
            worker.child.kill();
        }
        this.workers.clear();
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const bytes = JSON.stringify(body) + '\n';
    const maxWireBytes = Math.max(MAX_MESSAGE_BYTES, getMaxExchangeBinaryBytes() * 2 + 2 * 1024 * 1024);
    if (Buffer.byteLength(bytes) > maxWireBytes + 1) {
        response.writeHead(413, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end('{"error":"limit_exceeded"}\n');
        return;
    }
    response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    response.end(bytes);
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
    const maxReadBytes = Math.max(MAX_MESSAGE_BYTES, getMaxExchangeBinaryBytes() + 8 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > maxReadBytes + 1) {
            request.resume();
            throw new ExchangeTransportError(413);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export type ExchangeHttpHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
    close: () => void;
};

function parseMultipartExchange(body: Buffer, contentType: string): Buffer {
    const match = /boundary=([^;\s]+)/i.exec(contentType);
    if (!match) throw new ExchangeError('invalid_message', 'missing multipart boundary');
    const boundary = match[1].replace(/^"|"$/g, '');
    const delim = Buffer.from(`--${boundary}`);
    let pos = body.indexOf(delim);
    let metaJson: string | null = null;
    let filePayload: Buffer = Buffer.alloc(0);
    while (pos !== -1) {
        const partStart = pos + delim.length;
        if (body.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) break;
        const headerStart = body[partStart] === 13 && body[partStart + 1] === 10 ? partStart + 2 : partStart;
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
        if (headerEnd === -1) break;
        const headers = body.subarray(headerStart, headerEnd).toString('utf8');
        const nextDelim = body.indexOf(delim, headerEnd + 4);
        if (nextDelim === -1) break;
        let partBody = body.subarray(headerEnd + 4, nextDelim);
        if (partBody.length >= 2 && partBody[partBody.length - 2] === 13 && partBody[partBody.length - 1] === 10) {
            partBody = partBody.subarray(0, partBody.length - 2);
        }
        const nameMatch = /name="([^"]+)"/i.exec(headers);
        if (nameMatch?.[1] === 'meta') {
            metaJson = partBody.toString('utf8');
        } else if (nameMatch?.[1] === 'file') {
            filePayload = partBody;
        }
        pos = nextDelim;
    }
    if (!metaJson) throw new ExchangeError('invalid_message', 'missing multipart meta part');
    return encodeExchangeStreamFrame(parseStrict(metaJson), filePayload);
}

export function createExchangeHttpHandler(enabledFormats: readonly ExchangeFormat[]): ExchangeHttpHandler {
    const pool = enabledFormats.length > 0 ? new ExchangePool() : null;
    const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        if (!pool || enabledFormats.length === 0) {
            request.resume();
            sendJson(response, 404, {error: 'exchange_disabled'});
            return;
        }
        try {
            const start = performance.now();
            const headers = request.headers ?? {};
            const contentType = String(headers['content-type'] ?? '').toLowerCase();
            const accept = String(headers.accept ?? '').toLowerCase();
            const rawBody = await readBounded(request);
            const frame = contentType.includes('multipart/form-data')
                ? parseMultipartExchange(rawBody, contentType)
                : rawBody;
            const result = await pool.run(frame, enabledFormats);
            process.stderr.write(JSON.stringify({
                request_id: result.request_id,
                profile: WIRE_PROFILE.id,
                duration_ms: Math.round(performance.now() - start),
                bytes: frame.length,
                result: result.ok ? `${result.operation}:${result.format}` : result.error.code,
            }) + '\n');
            if (contentType.includes(EXCHANGE_STREAM_CONTENT_TYPE) || accept.includes(EXCHANGE_STREAM_CONTENT_TYPE)) {
                let payload = Buffer.alloc(0);
                let outMeta: ExchangeResponse = result;
                if (result.ok && typeof result.output_b64 === 'string' && result.output_b64 !== '') {
                    payload = Buffer.from(result.output_b64, 'base64');
                    outMeta = {...result, output_b64: ''};
                }
                const outBuf = encodeExchangeStreamFrame(outMeta, payload);
                response.writeHead(200, {'Content-Type': EXCHANGE_STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store'});
                response.end(outBuf);
                return;
            }
            sendJson(response, 200, result);
        } catch (error) {
            const status = error instanceof ExchangeTransportError ? error.status : error instanceof ExchangeError ? 400 : 503;
            sendJson(response, status, {
                error: status === 413 ? 'limit_exceeded' : status === 504 ? 'calculation_timeout' : error instanceof ExchangeError ? error.code : 'runtime_unavailable',
            });
        }
    };
    handler.close = () => pool?.close();
    return handler;
}
