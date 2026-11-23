import {fork, type ChildProcess} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
import {MAX_MESSAGE_BYTES} from './frame.ts';
import {assertInstalledProfile, WIRE_PROFILE} from './profile.ts';
import {sha256Canonical, type Response} from './protocol.ts';
import {createExchangeHttpHandler, parseEnabledExchangeFormats} from './exchange/worker.ts';

class TransportError extends Error {
    constructor(readonly status: number) { super(`Runtime HTTP ${status}`); }
}

interface Task {
    frame: Buffer;
    resolve: (response: Response) => void;
    reject: (error: TransportError) => void;
}

interface Worker {
    child: ChildProcess;
    tasks: number;
    active?: Task;
    timer?: ReturnType<typeof setTimeout>;
}

class Pool {
    private readonly workers = new Set<Worker>();
    private readonly waiting: Task[] = [];

    run(frame: Buffer): Promise<Response> {
        if (this.waiting.length >= 8) return Promise.reject(new TransportError(503));
        return new Promise((resolve, reject) => {
            this.waiting.push({frame, resolve, reject});
            this.dispatch();
        });
    }

    private start(): Worker {
        const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
        const child = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), {
            serialization: 'advanced',
            execArgv: ['--max-old-space-size=640'],
        });
        const worker: Worker = {child, tasks: 0};
        this.workers.add(worker);
        child.on('message', (message: {response?: Response}) => this.finish(worker, message.response ? 200 : 503, message.response));
        child.on('exit', () => this.finish(worker, 503));
        child.on('error', () => this.finish(worker, 503));
        return worker;
    }

    private finish(worker: Worker, status: number, response?: Response): void {
        if (!this.workers.has(worker)) return;
        clearTimeout(worker.timer);
        const task = worker.active;
        worker.active = undefined;
        if (status !== 200 || worker.tasks >= 50) {
            this.workers.delete(worker);
            worker.child.kill();
        }
        if (response) task?.resolve(response);
        else task?.reject(new TransportError(status));
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
            worker.child.send({frame: task.frame}, error => {
                if (error && worker.active === task) this.finish(worker, 503);
            });
        }
    }
}

function send(response: ServerResponse, status: number, body: unknown): void {
    const bytes = JSON.stringify(body) + '\n';
    if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES + 1) {
        send(response, 413, {error: 'limit_exceeded'});
        return;
    }
    response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    response.end(bytes);
}

async function read(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    // Return a 413 on the writable side before discarding the remaining request body.
    for await (const chunk of request.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > MAX_MESSAGE_BYTES + 1) {
            request.resume();
            throw new TransportError(413);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

const tokenFile = process.env.SHEETS_RUNTIME_TOKEN_FILE;
if (!tokenFile) throw new Error('SHEETS_RUNTIME_TOKEN_FILE is required');
const token = readFileSync(tokenFile, 'utf8').trim();
if (!token) throw new Error('The runtime token file is empty');
const authorization = Buffer.from(`Bearer ${token}`);
const pool = new Pool();
const exchangeFormats = parseEnabledExchangeFormats(process.env.SHEETS_EXCHANGE_FORMATS);
const handleExchange = createExchangeHttpHandler(exchangeFormats);
let ready = false;
assertInstalledProfile();
const workbook = {
    format_version: 2, profile: WIRE_PROFILE, tables: [],
    native: {id: 'health', name: 'Health', appVersion: '1.5.2', locale: 'enUS', styles: {}, resources: [], sheetOrder: ['health'], sheets: {health: {
        id: 'health', name: 'Health', rowCount: 5, columnCount: 5, cellData: {0: {0: {f: '=1+1'}}},
    }}},
};
const probe = {
    version: 1, request_id: 'readiness', operation: 'read', profile_id: WIRE_PROFILE.id,
    base: {generation: 0, position: 0, sha256: sha256Canonical(workbook)}, workbook,
    selector: {ranges: [{sheet_id: 'health', range: 'A1:A1'}]},
};
void pool.run(Buffer.from(JSON.stringify(probe) + '\n')).then(result => {
    ready = result.ok && result.operation === 'read' && result.data.ranges[0]?.cells[0]?.value === 2;
}, () => { ready = false; });

createServer({requestTimeout: 25_000}, async (request, response) => {
    if (request.method === 'GET' && request.url === '/livez') return send(response, 200, {live: true});
    if (request.method === 'GET' && request.url === '/readyz') return send(response, ready ? 200 : 503, {ready});
    if (request.method !== 'POST' || (request.url !== '/v1/operations' && request.url !== '/v1/exchange')) return send(response, 404, {error: 'not_found'});
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        request.resume();
        return send(response, 401, {error: 'unauthorized'});
    }
    if (!ready) {
        request.resume();
        return send(response, 503, {error: 'runtime_unavailable'});
    }
    if (request.url === '/v1/exchange') {
        await handleExchange(request, response);
        return;
    }
    try {
        const start = performance.now();
        const frame = await read(request);
        const result = await pool.run(frame);
        process.stderr.write(JSON.stringify({request_id: result.request_id, profile: WIRE_PROFILE.id,
            duration_ms: Math.round(performance.now() - start), bytes: frame.length,
            result: result.ok ? result.operation : result.error.code}) + '\n');
        send(response, 200, result);
    } catch (error) {
        const status = error instanceof TransportError ? error.status : 503;
        send(response, status, {error: status === 413 ? 'limit_exceeded' : status === 504 ? 'calculation_timeout' : 'runtime_unavailable'});
    }
}).listen(Number(process.env.PORT ?? 3100), '0.0.0.0');
