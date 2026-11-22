#!/usr/bin/env node
import {MAX_MESSAGE_BYTES, processFrame} from './frame.ts';
import {assertInstalledProfile} from './profile.ts';

async function main(): Promise<void> {
    assertInstalledProfile();
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length > MAX_MESSAGE_BYTES + 1) {
            process.stdout.write('{"version":1,"request_id":null,"ok":false,"error":{"code":"limit_exceeded","message":"message exceeds byte limit"}}\n');
            return;
        }
        chunks.push(chunk);
    }
    process.stdout.write(JSON.stringify(await processFrame(Buffer.concat(chunks))) + '\n');
}

main().catch(() => {
    process.stderr.write('vaulter-sheets-runtime calculation failed\n');
    process.exitCode = 70;
});
