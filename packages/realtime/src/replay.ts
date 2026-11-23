import {createHash} from 'node:crypto';
import type {WorkbookV2} from '@vaulter/sheets-runtime/browser';
import {position, record, type WorkbookRoomMarker, type WorkbookRoomState} from './protocol.ts';

function workbook(value: unknown): WorkbookV2 {
    if (!record(value) || !record(value.workbook) || value.workbook.format_version !== 2
        || !record(value.workbook.native) || !record(value.workbook.profile) || !Array.isArray(value.workbook.tables)) {
        throw new Error('Invalid workbook checkpoint');
    }
    return value.workbook as unknown as WorkbookV2;
}

function decode(bytes: string): {value: unknown; digest: string} {
    const binary = Buffer.from(bytes, 'base64');
    if (binary.toString('base64') !== bytes) throw new Error('Invalid journal encoding');
    return {value: JSON.parse(binary.toString('utf8')), digest: createHash('sha256').update(binary).digest('hex')};
}

export function replay(log: unknown): WorkbookRoomState {
    if (!record(log) || !position(log.generation) || !position(log.checkpoint_seq) || !position(log.head_seq)
        || log.checkpoint_seq > log.head_seq || typeof log.checkpoint !== 'string' || !Array.isArray(log.tail)
        || typeof log.etag !== 'string' || !record(log.marker) || log.marker.generation !== log.generation
        || !position(log.marker.position) || typeof log.marker.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(log.marker.sha256)) {
        throw new Error('Invalid workbook journal');
    }
    let current = workbook(decode(log.checkpoint).value);
    let cursor = log.checkpoint_seq;
    for (const update of log.tail as unknown[]) {
        if (!record(update) || update.seq !== cursor + 1 || typeof update.payload !== 'string') throw new Error('Journal gap');
        const decoded = decode(update.payload);
        if (decoded.digest !== update.sha256 || !record(decoded.value) || decoded.value.update_id !== update.update_id
            || !Array.isArray(decoded.value.commands)) throw new Error('Journal update identity mismatch');
        current = workbook(decoded.value);
        cursor++;
    }
    if (cursor !== log.head_seq) throw new Error('Journal tail is incomplete');
    if (log.insertions !== null && (!Array.isArray(log.insertions) || !log.insertions.every(item => record(item)
        && typeof item.sheet_id === 'string' && position(item.row) && item.row > 0 && position(item.count) && item.count > 0))) {
        throw new Error('Invalid structural history');
    }
    return {generation: log.generation, seq: cursor, etag: log.etag, marker: log.marker as unknown as WorkbookRoomMarker, workbook: current, insertions: log.insertions};
}
