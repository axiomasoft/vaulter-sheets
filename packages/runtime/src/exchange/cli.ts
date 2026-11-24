#!/usr/bin/env node
import {MAX_MESSAGE_BYTES} from '../frame.ts';
import {assertInstalledProfile} from '../profile.ts';
import {
    encodeExchangeStreamFrame,
    EXCHANGE_STREAM_MAGIC,
    getMaxExchangeBinaryBytes,
    parseEnabledExchangeFormats,
    processExchangeFrame,
} from './worker.ts';

async function main(): Promise<void> {
    assertInstalledProfile();
    const enabledFormats = parseEnabledExchangeFormats(process.env.SHEETS_EXCHANGE_FORMATS);
    const maxBytes = Math.max(MAX_MESSAGE_BYTES, getMaxExchangeBinaryBytes() + 8 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > maxBytes + 1) {
            process.stdout.write('{"version":1,"request_id":null,"ok":false,"error":{"code":"limit_exceeded","message":"exchange message exceeds byte limit"}}\n');
            return;
        }
        chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    const response = await processExchangeFrame(input, enabledFormats);
    if (input.subarray(0, 4).equals(EXCHANGE_STREAM_MAGIC)) {
        let payload = Buffer.alloc(0);
        let outMeta = response;
        if (response.ok && typeof response.output_b64 === 'string' && response.output_b64 !== '') {
            payload = Buffer.from(response.output_b64, 'base64');
            outMeta = {...response, output_b64: ''};
        }
        process.stdout.write(encodeExchangeStreamFrame(outMeta, payload));
        return;
    }
    process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch(() => {
    process.stderr.write('vaulter-sheets-exchange failed\n');
    process.exitCode = 70;
});
