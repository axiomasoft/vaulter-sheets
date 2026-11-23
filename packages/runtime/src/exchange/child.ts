import {setImmediate} from 'node:timers/promises';
import type {ExchangeFormat} from './types.ts';
import {processExchangeFrame} from './worker.ts';

process.on('message', async (message: {frame: Buffer; enabledFormats: ExchangeFormat[]}) => {
    try {
        const response = await processExchangeFrame(message.frame, message.enabledFormats);
        await setImmediate();
        process.send?.({response});
    } catch {
        process.send?.({failed: true});
    }
});
