#!/usr/bin/env node
import {MAX_MESSAGE_BYTES} from '../frame.ts';
import {assertInstalledProfile} from '../profile.ts';
import {parseEnabledExchangeFormats, processExchangeFrame} from './worker.ts';

async function main(): Promise<void> {
    assertInstalledProfile();
    const enabledFormats = parseEnabledExchangeFormats(process.env.SHEETS_EXCHANGE_FORMATS);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > MAX_MESSAGE_BYTES + 1) {
            process.stdout.write('{"version":1,"request_id":null,"ok":false,"error":{"code":"limit_exceeded","message":"exchange message exceeds byte limit"}}\n');
            return;
        }
        chunks.push(chunk);
    }
    const response = await processExchangeFrame(Buffer.concat(chunks), enabledFormats);
    process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch(() => {
    process.stderr.write('vaulter-sheets-exchange failed\n');
    process.exitCode = 70;
});
