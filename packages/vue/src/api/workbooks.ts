export type CellContent = {number: number} | {text: string} | {boolean: boolean} | {formula: string} | null
export type Literal = {number: number} | {text: string} | null

interface CellTarget { sheet_id: string; row: number; column: number }
export type Command =
  | (CellTarget & {kind: 'set_number'; expected: CellContent; value: number})
  | (CellTarget & {kind: 'set_text'; expected: CellContent; value: string})
  | (CellTarget & {kind: 'set_formula'; expected: CellContent; formula: string})
  | (CellTarget & {kind: 'set_values'; expected: CellContent[][]; values: Literal[][]})
  | {kind: 'insert_row_before'; sheet_id: string; row: number; count: number}

export interface WorkbookMarker { generation: number; position: number; sha256: string }
export interface Workbook {
  format_version: 2
  profile: {id: string; engine: string; plugins: {name: string; version: string}[]}
  native: Record<string, unknown>
  tables: unknown[]
}
export interface OpenedWorkbook { workbook: Workbook; marker: WorkbookMarker; etag: string; commands: string[] }
export interface Receipt { state: 'committed'; command_id: string; receipt_id: string; marker: WorkbookMarker; etag: string }
export interface CommandOutcome { state: 'running' | 'rejected'; command_id: string; error?: {code: string; status: number} }
export interface WorkbookIntent { command_id: string; expected_generation: number; policy: 'rebase_cells' | 'exact_base'; commands: Command[] }

export interface WorkbooksClient {
  open(node: string): Promise<OpenedWorkbook>
  submit(node: string, intent: WorkbookIntent, etag: string): Promise<Receipt | CommandOutcome>
  status(node: string, command: string): Promise<Receipt | CommandOutcome>
}

export class WorkbookApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

export function createWorkbooksClient(options: {baseUrl?: string; fetch?: typeof fetch; headers?: () => HeadersInit} = {}): WorkbooksClient {
  const baseUrl = (options.baseUrl ?? '/api/vaulter-sheets/v1').replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const request = async <T>(node: string, suffix = '', body?: WorkbookIntent, etag?: string): Promise<T> => {
    const headers = new Headers(options.headers?.())
    headers.set('Accept', 'application/json')
    if (body && etag) {
      headers.set('Content-Type', 'application/json')
      headers.set('If-Match', etag)
      const xsrf = typeof document === 'undefined' ? undefined : document.cookie.split('; ').find(cookie => cookie.startsWith('XSRF-TOKEN='))
      if (xsrf && !headers.has('X-XSRF-TOKEN')) headers.set('X-XSRF-TOKEN', decodeURIComponent(xsrf.slice(11)))
    }
    const response = await fetchImpl(`${baseUrl}/workbooks/${encodeURIComponent(node)}${suffix}`, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', headers, body: body && JSON.stringify(body),
    })
    const payload = await response.json() as {data?: T; code?: string}
    if (payload.data && (response.ok || 'state' in (payload.data as object))) return payload.data
    throw new WorkbookApiError(response.status, payload.code ?? 'request_failed')
  }
  return {
    open: node => request(node),
    submit: (node, intent, etag) => request(node, '/commands', intent, etag),
    status: (node, command) => request(node, `/commands/${encodeURIComponent(command)}`),
  }
}
