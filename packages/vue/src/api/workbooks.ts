export type CellContent = {number: number} | {text: string} | {boolean: boolean} | {formula: string} | null
export type Literal = {number: number} | {text: string} | {boolean: boolean} | null

export type WorkbookLocale = 'enUS' | 'ruRU'

export type BorderStyleName = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double'
export type BorderSideSpec = null | {style: BorderStyleName; color?: string}
export interface FormatSpec {
  font?: {bold?: boolean; italic?: boolean; size?: number; color?: string | null}
  fill?: string | null
  borders?: {all?: BorderSideSpec; top?: BorderSideSpec; right?: BorderSideSpec; bottom?: BorderSideSpec; left?: BorderSideSpec}
  alignment?: {horizontal?: 'left' | 'center' | 'right' | null; vertical?: 'top' | 'middle' | 'bottom' | null; wrap?: boolean}
  numFmt?: string | null
}

export interface OperandExpectation { content: CellContent; value?: number }
export type IfScalar = number | string | boolean
export type IfComparator = '=' | '<>' | '>' | '>=' | '<' | '<='
export type FormulaExpression =
  | {op: 'subtract' | 'add' | 'multiply' | 'divide'; left_column_id: string; right_column_id: string}
  | {op: 'sum' | 'average'; column_ids: string[]}
  | {
      op: 'if'
      condition: {left_column_id: string; comparator: IfComparator} & ({right_column_id: string} | {right_value: IfScalar})
    } & ({then_column_id: string} | {then_value: IfScalar}) & ({else_column_id: string} | {else_value: IfScalar})
  | {op: 'template'; template: string; params: Record<string, string>}
export type RowInputsExpectation = {left: OperandExpectation; right: OperandExpectation} | Record<string, OperandExpectation>

export interface TableColumnBinding { column_id: string; column: number }
export interface TableRowBinding { row_id: string; row: number }
export interface TableBinding {
  table_id: string
  sheet_id: string
  header_row: number
  columns: TableColumnBinding[]
  rows: TableRowBinding[]
}

export interface WorkbookSelectionRange {
  sheet_id: string
  start_row: number
  start_column: number
  end_row: number
  end_column: number
  a1: string
}

export interface WorkbookTableSelection {
  table_id: string
  sheet_id: string
  row_ids: string[]
  column_ids: string[]
}

export interface WorkbookSelectionPayload {
  sheet_id: string
  range: WorkbookSelectionRange | null
  ranges: WorkbookSelectionRange[]
  table?: WorkbookTableSelection
  sheet_table?: {
    table_id: string
    row_ids: string[]
    column_ids: string[]
  }
}

interface CellTarget { sheet_id: string; row: number; column: number }
export type Command =
  | (CellTarget & {kind: 'set_number'; expected: CellContent; value: number})
  | (CellTarget & {kind: 'set_text'; expected: CellContent; value: string})
  | (CellTarget & {kind: 'set_boolean'; expected: CellContent; value: boolean})
  | (CellTarget & {kind: 'set_formula'; expected: CellContent; formula: string})
  | (CellTarget & {kind: 'set_values'; expected: CellContent[][]; values: Literal[][]})
  | {kind: 'insert_row_before'; sheet_id: string; row: number; count: number}
  | {kind: 'delete_row'; sheet_id: string; row: number; count: number}
  | {kind: 'insert_column_before'; sheet_id: string; column: number; count: number}
  | {kind: 'delete_column'; sheet_id: string; column: number; count: number}
  | {kind: 'add_sheet'; sheet_id: string; name: string; index?: number; row_count?: number; column_count?: number}
  | {kind: 'rename_sheet'; sheet_id: string; name: string; expected_name?: string}
  | {kind: 'delete_sheet'; sheet_id: string}
  | {kind: 'set_freeze'; sheet_id: string; row_count: number; column_count: number}
  | {kind: 'merge_cells'; sheet_id: string; start_row: number; start_column: number; end_row: number; end_column: number; strategy?: 'default' | 'across' | 'vertically'}
  | {kind: 'unmerge_cells'; sheet_id: string; start_row: number; start_column: number; end_row: number; end_column: number}
  | {kind: 'set_format'; sheet_id: string; start_row: number; start_column: number; end_row: number; end_column: number; format: FormatSpec}
  | {
      kind: 'fill_formula'
      sheet_id: string
      table_id: string
      scope: 'fixed_members' | 'current_rows'
      row_ids: string[]
      destination_column_id: string
      expression: FormulaExpression
      expected_destination: CellContent[]
      expected_inputs?: RowInputsExpectation[]
    }

export interface ExchangeCapabilities {
  formats: ('csv' | 'xlsx')[]
  import: ('csv' | 'xlsx')[]
  export: ('csv' | 'xlsx')[]
}

export interface ExchangeLossEntry {
  scope: 'workbook' | 'sheet' | 'cell' | 'object'
  target: string
  property: string
  status: 'lost' | 'transformed' | 'preserved'
  reason: string
}

export interface ExchangeDiagnostic {
  code: string
  message: string
  target?: string
  detail?: Record<string, unknown>
}

export interface ExchangeReport {
  format: 'csv' | 'xlsx'
  operation: 'import' | 'export'
  source_sha256: string
  output_sha256: string
  date_system?: '1900' | '1904'
  sheets: Array<{
    sheet_id: string
    name: string
    rows: number
    columns: number
    cells: number
    formulas: number
    styles: number
    merges: number
    validations: number
    conditional_formatting: number
  }>
  defined_names: { preserved: number; lost: number }
  losses: ExchangeLossEntry[]
  diagnostics: ExchangeDiagnostic[]
  unknown_parts: string[]
  editable_published: boolean
}

export interface ExchangeJob {
  exchange_id: string
  request_key: string
  kind: 'import' | 'export'
  format: 'csv' | 'xlsx'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  generation: number
  source_position: number
  result_receipt_id: string | null
  output_blob_id: string | null
  source_blob_id: string
  options: Record<string, unknown>
  report: ExchangeReport | null
  error_code: string | null
}

export interface RegisterExchangeRequest {
  request_key: string
  kind: 'import' | 'export'
  format: 'csv' | 'xlsx'
  source:
    | { node_id: string; revision_id?: string; expected_generation?: number }
    | { generation: number; position: number; sha256?: string }
    | { revision_id: string }
  options?: Record<string, unknown>
}

export interface WorkbookRoomSession {
  endpoint: string
  token: string
  generation: number
  mode: 'read' | 'write'
}

export interface WorkbookPresenceSelection {
  sheet_id: string
  start_row: number
  start_column: number
  end_row: number
  end_column: number
}

export interface WorkbookPresence {
  client_id: string
  /** `id` and `type` come from the peer's verified room token; name and colour are the peer's own. */
  user?: { id?: string | number; type?: string; name?: string; color?: string }
  selection?: WorkbookPresenceSelection | null
  updated_at: number
}

export interface WorkbookMarker { generation: number; position: number; sha256: string }
export interface Workbook {
  format_version: 2
  profile: {id: string; engine: string; plugins: {name: string; version: string}[]}
  native: Record<string, unknown>
  tables: TableBinding[]
}
export interface OpenedWorkbook { workbook: Workbook; marker: WorkbookMarker; etag: string; commands: string[]; exchange?: ExchangeCapabilities }
export interface Receipt { state: 'committed'; command_id: string; receipt_id: string; marker: WorkbookMarker; etag: string }
export interface CommandOutcome { state: 'running' | 'rejected'; command_id: string; error?: {code: string; status: number} }
export interface WorkbookIntent { command_id: string; expected_generation: number; policy: 'rebase_cells' | 'exact_base' | 'revalidate_by_id'; commands: Command[] }

export interface WorkbooksClient {
  open(node: string): Promise<OpenedWorkbook>
  submit(node: string, intent: WorkbookIntent, etag: string): Promise<Receipt | CommandOutcome>
  status(node: string, command: string): Promise<Receipt | CommandOutcome>
  registerExchange?(node: string, body: RegisterExchangeRequest): Promise<ExchangeJob>
  exchangeStatus?(node: string, exchange: string): Promise<ExchangeJob>
  exchangeDownloadUrl?(node: string, exchange: string): string
  downloadExchange?(node: string, exchange: string): Promise<Blob>
  realtimeSession?(node: string): Promise<WorkbookRoomSession>
  switchRealtimeProfile?(node: string, mode: 'snapshot' | 'journal', etag: string): Promise<{ generation: number; position: number; mode: string }>
}

export class WorkbookApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

export function createWorkbooksClient(options: {baseUrl?: string; fetch?: typeof fetch; headers?: () => HeadersInit} = {}): WorkbooksClient {
  const baseUrl = (options.baseUrl ?? '/api/vaulter-sheets/v1').replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const request = async <T>(node: string, suffix = '', body?: unknown, etag?: string, method = body ? 'POST' : 'GET'): Promise<T> => {
    const headers = new Headers(options.headers?.())
    headers.set('Accept', 'application/json')
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
      if (etag) headers.set('If-Match', etag)
      const xsrf = typeof document === 'undefined' ? undefined : document.cookie.split('; ').find(cookie => cookie.startsWith('XSRF-TOKEN='))
      if (xsrf && !headers.has('X-XSRF-TOKEN')) headers.set('X-XSRF-TOKEN', decodeURIComponent(xsrf.slice(11)))
    }
    const response = await fetchImpl(`${baseUrl}/workbooks/${encodeURIComponent(node)}${suffix}`, {
      method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json() as {data?: T; code?: string}
    if (payload.data && (response.ok || 'state' in (payload.data as object))) return payload.data
    throw new WorkbookApiError(response.status, payload.code ?? 'request_failed')
  }
  const exchangeDownloadUrl = (node: string, exchange: string) =>
    `${baseUrl}/workbooks/${encodeURIComponent(node)}/exchanges/${encodeURIComponent(exchange)}/download`
  return {
    open: node => request(node),
    submit: (node, intent, etag) => request(node, '/commands', intent, etag),
    status: (node, command) => request(node, `/commands/${encodeURIComponent(command)}`),
    registerExchange: (node, body) => request(node, '/exchanges', body),
    exchangeStatus: (node, exchange) => request(node, `/exchanges/${encodeURIComponent(exchange)}`),
    exchangeDownloadUrl,
    downloadExchange: async (node, exchange) => {
      const headers = new Headers(options.headers?.())
      const response = await fetchImpl(exchangeDownloadUrl(node, exchange), {method: 'GET', credentials: 'same-origin', headers})
      if (!response.ok) throw new WorkbookApiError(response.status, 'download_failed')
      return response.blob()
    },
    realtimeSession: node => request(node, '/realtime/session', {}),
    switchRealtimeProfile: (node, mode, etag) => request(node, '/realtime/profile', {mode}, etag, 'PUT'),
  }
}
