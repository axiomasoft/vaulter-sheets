import type {ErrorCode, JsonObject} from './protocol.ts';

export class WireError extends Error {
    readonly code: ErrorCode;
    readonly detail: JsonObject | undefined;
    constructor(code: ErrorCode, message: string, detail?: JsonObject) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}
