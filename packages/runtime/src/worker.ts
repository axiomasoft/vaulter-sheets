import {setImmediate} from 'node:timers/promises';
import {processFrame} from './frame.ts';

process.on('message', async (message: {frame: Buffer}) => {
    try {
        const response = await processFrame(message.frame);
        await setImmediate();
        process.send?.({response});
    } catch {
        process.send?.({failed: true});
    }
});
