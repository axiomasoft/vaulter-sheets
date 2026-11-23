import type {Json, JsonObject, WorkbookV2} from '../protocol.ts';

export type ExchangeFormat = 'csv' | 'xlsx';
export type ExchangeOperation = 'import' | 'export';

export interface ExchangeRequest {
    version: 1;
    request_id: string;
    operation: ExchangeOperation;
    format: ExchangeFormat;
    profile_id: string;
    input_b64: string;
    input_sha256: string;
    options: JsonObject;
}

export interface SheetExchangeSummary {
    sheet_id: string;
    name: string;
    rows: number;
    columns: number;
    cells: number;
    formulas: number;
    styles: number;
    merges: number;
    validations: number;
    conditional_formatting: number;
}

export interface ExchangeLossEntry {
    scope: 'workbook' | 'sheet' | 'cell' | 'object';
    target: string;
    property: string;
    status: 'lost' | 'transformed' | 'preserved';
    reason: string;
}

export interface ExchangeDiagnostic {
    code: string;
    message: string;
    target?: string;
    detail?: JsonObject;
}

export interface CsvDialectReport {
    encoding: 'utf-8';
    delimiter: string;
    quote: string;
    line_ending: '\n' | '\r\n';
    formula_injection_defense: boolean;
}

export interface ExchangeReport {
    format: ExchangeFormat;
    operation: ExchangeOperation;
    source_sha256: string;
    output_sha256: string;
    date_system?: '1900' | '1904';
    dialect?: CsvDialectReport;
    sheets: SheetExchangeSummary[];
    defined_names: {preserved: number; lost: number};
    losses: ExchangeLossEntry[];
    diagnostics: ExchangeDiagnostic[];
    unknown_parts: string[];
    editable_published: boolean;
}

export type ExchangeErrorCode =
    | 'invalid_message'
    | 'unsupported_version'
    | 'profile_mismatch'
    | 'format_disabled'
    | 'base_mismatch'
    | 'unsafe_archive'
    | 'unsupported_content'
    | 'unknown_target'
    | 'limit_exceeded'
    | 'calculation_timeout'
    | 'runtime_failed';

export type ExchangeResponse =
    | {
        version: 1;
        request_id: string;
        ok: true;
        operation: ExchangeOperation;
        format: ExchangeFormat;
        output_b64: string;
        output_sha256: string;
        report: ExchangeReport;
    }
    | {
        version: 1;
        request_id: string | null;
        ok: false;
        error: {code: ExchangeErrorCode; message: string; detail?: JsonObject};
    };

export class ExchangeError extends Error {
    readonly code: ExchangeErrorCode;
    readonly detail: JsonObject | undefined;

    constructor(code: ExchangeErrorCode, message: string, detail?: JsonObject) {
        super(message);
        this.code = code;
        this.detail = detail;
    }
}

export interface ImportResult {
    workbook: WorkbookV2;
    report: ExchangeReport;
}

export interface ExportResult {
    bytes: Buffer;
    report: ExchangeReport;
}

export type {Json, JsonObject, WorkbookV2};
