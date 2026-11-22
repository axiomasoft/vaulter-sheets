import {runOperation} from './operation.ts';
import {WireError, parseStrict, type Json, type Response} from './protocol.ts';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export async function processFrame(bytes: Uint8Array): Promise<Response> {
    let requestId: string | null = null;
    try {
        if (bytes.length > MAX_MESSAGE_BYTES + 1) throw new WireError('limit_exceeded', 'message exceeds byte limit');
        if (bytes.at(-1) !== 10) throw new WireError('invalid_message', 'message must end with LF');
        let text: string;
        try {
            text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, -1));
        } catch {
            throw new WireError('invalid_message', 'message is not valid UTF-8');
        }
        if (/[\r\n]/.test(text)) throw new WireError('invalid_message', 'expected one JSON line');
        const message: Json = parseStrict(text);
        if (message && typeof message === 'object' && !Array.isArray(message) && typeof message.request_id === 'string') {
            requestId = message.request_id;
        }
        return await runOperation(message);
    } catch (error) {
        if (!(error instanceof WireError)) throw error;
        return {version: 1, request_id: requestId, ok: false, error: {code: error.code, message: error.message, ...(error.detail ? {detail: error.detail} : {})}};
    }
}
