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

export const MAX_EXCHANGE_BINARY_BYTES = 5 * 1024 * 1024;

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
    if (out.length > MAX_EXCHANGE_BINARY_BYTES) {
        throw new ExchangeError('limit_exceeded', `decoded exchange input exceeds ${MAX_EXCHANGE_BINARY_BYTES} bytes`);
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
    if (exported.bytes.length > MAX_EXCHANGE_BINARY_BYTES) {
        throw new ExchangeError('limit_exceeded', `exported ${request.format} exceeds ${MAX_EXCHANGE_BINARY_BYTES} bytes`);
    }
    const outputB64 = exported.bytes.toString('base64');
    if (Buffer.byteLength(outputB64) > MAX_MESSAGE_BYTES - 65_536) {
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
        if (bytes.length > MAX_MESSAGE_BYTES + 1) {
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
    if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES + 1) {
        response.writeHead(413, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end('{"error":"limit_exceeded"}\n');
        return;
    }
    response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    response.end(bytes);
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > MAX_MESSAGE_BYTES + 1) {
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
            const frame = await readBounded(request);
            const result = await pool.run(frame, enabledFormats);
            process.stderr.write(JSON.stringify({
                request_id: result.request_id,
                profile: WIRE_PROFILE.id,
                duration_ms: Math.round(performance.now() - start),
                bytes: frame.length,
                result: result.ok ? `${result.operation}:${result.format}` : result.error.code,
            }) + '\n');
            sendJson(response, 200, result);
        } catch (error) {
            const status = error instanceof ExchangeTransportError ? error.status : 503;
            sendJson(response, status, {
                error: status === 413 ? 'limit_exceeded' : status === 504 ? 'calculation_timeout' : 'runtime_unavailable',
            });
        }
    };
    handler.close = () => pool?.close();
    return handler;
}
