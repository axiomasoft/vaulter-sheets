import { readFileSync } from 'node:fs';

/** Shared formula vector. Origin: vaulter plan/examples/workbook.json, copied into this repo. */
export function loadCorpus() {
    const url = new URL('../../examples/workbook.json', import.meta.url);
    const text = readFileSync(url, 'utf8');
    return { url: url.pathname, book: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

export function step(book, action) {
    return book.steps.find((item) => item.action === action);
}

export function percentile(samples, p) {
    const sorted = [...samples].sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

export function summarize(samples) {
    return {
        n: samples.length,
        p50_ms: percentile(samples, 50),
        p95_ms: percentile(samples, 95),
        max_ms: samples.length ? Math.max(...samples) : null,
    };
}
