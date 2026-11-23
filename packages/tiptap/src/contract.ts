/** Physical A1 range stored in the link. Row insertion does not rewrite it. */
const RANGE = /^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/
const ID = /^[A-Za-z0-9_-]{1,255}$/

export interface WorkbookReferenceTarget {
  nodeId: string
  sheetId: string
  range: string
}

export interface WorkbookReferenceLocation {
  origin: string
  pathPrefix?: string
}

export interface WorkbookCell {
  a1: string
  value: string | number | boolean | null
}

export interface WorkbookRangeRequest extends WorkbookReferenceTarget {
  purpose: 'preview' | 'export'
}

export type WorkbookRangeResult =
  | {status: 'ready'; cells: WorkbookCell[]; title?: string}
  | {status: 'unavailable'}

export type WorkbookRangeReader = (request: WorkbookRangeRequest) => Promise<WorkbookRangeResult>

export type ClassifiedWorkbookReference =
  | {kind: 'foreign'}
  | {kind: 'invalid'}
  | {kind: 'reference'; target: WorkbookReferenceTarget}

export interface ExportedWorkbookReference {
  href: string
  text: string
  status: 'ready' | 'unavailable'
  nodeId?: string
  sheetId?: string
  range?: string
  cells?: WorkbookCell[]
  title?: string
}

export interface JsonContent {
  type?: string
  text?: string
  marks?: {type?: string; attrs?: {href?: unknown}}[]
  content?: JsonContent[]
}

export function pathPrefixOf(location: WorkbookReferenceLocation): string {
  const prefix = location.pathPrefix ?? '/office/workbooks'
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
}

export function buildWorkbookReferenceUrl(location: WorkbookReferenceLocation, target: WorkbookReferenceTarget): string | null {
  if (!ID.test(target.nodeId) || !ID.test(target.sheetId) || !RANGE.test(target.range) || target.range.length > 32) return null
  let origin: URL
  try {
    origin = new URL(location.origin)
  } catch {
    return null
  }
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.hostname.endsWith('.') || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return null
  const path = `${pathPrefixOf(location)}/${encodeURIComponent(target.nodeId)}/sheets/${encodeURIComponent(target.sheetId)}`
  return `${origin.origin}${path}?range=${encodeURIComponent(target.range)}`
}

export function classifyWorkbookReference(href: string, location: WorkbookReferenceLocation): ClassifiedWorkbookReference {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return {kind: 'foreign'}
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname.endsWith('.') || url.hash !== '') return {kind: 'foreign'}
  let origin: URL
  try {
    origin = new URL(location.origin)
  } catch {
    return {kind: 'foreign'}
  }
  if (url.origin !== origin.origin) return {kind: 'foreign'}
  const prefix = pathPrefixOf(location).split('/').filter(part => part !== '')
  const parts = url.pathname.split('/').filter(part => part !== '')
  if (parts.length !== prefix.length + 3 || prefix.some((part, index) => parts[index] !== part) || parts[prefix.length + 1] !== 'sheets') return {kind: 'foreign'}
  const nodeId = safeDecode(parts[prefix.length] ?? '')
  const sheetId = safeDecode(parts[prefix.length + 2] ?? '')
  if (!ID.test(nodeId) || !ID.test(sheetId)) return {kind: 'invalid'}
  const keys = [...url.searchParams.keys()]
  const range = url.searchParams.get('range') ?? ''
  if (keys.length !== 1 || keys[0] !== 'range' || !RANGE.test(range) || range.length > 32) return {kind: 'invalid'}
  return {kind: 'reference', target: {nodeId, sheetId, range}}
}

export function parseWorkbookReference(href: string, location: WorkbookReferenceLocation): WorkbookReferenceTarget | null {
  const parsed = classifyWorkbookReference(href, location)
  return parsed.kind === 'reference' ? parsed.target : null
}

/** Drop anything except a ready payload so a denied read cannot carry a title or cells. */
export function settleRange(result: WorkbookRangeResult): WorkbookRangeResult {
  if (result.status !== 'ready') return {status: 'unavailable'}
  return {
    status: 'ready',
    title: result.title,
    cells: result.cells.map(cell => ({a1: cell.a1, value: cell.value ?? null})),
  }
}

export async function exportWorkbookReferences(doc: JsonContent, location: WorkbookReferenceLocation, readRange?: WorkbookRangeReader): Promise<ExportedWorkbookReference[]> {
  const found: {href: string; text: string}[] = []
  const walk = (node: JsonContent): void => {
    if (typeof node.text === 'string') {
      for (const mark of node.marks ?? []) {
        if (mark.type === 'link' && typeof mark.attrs?.href === 'string') found.push({href: mark.attrs.href, text: node.text})
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  const exported: ExportedWorkbookReference[] = []
  for (const item of found) {
    const parsed = classifyWorkbookReference(item.href, location)
    if (parsed.kind === 'foreign') continue
    if (parsed.kind === 'invalid' || readRange === undefined) {
      exported.push({href: item.href, text: item.text, status: 'unavailable'})
      continue
    }
    let settled: WorkbookRangeResult
    try {
      settled = settleRange(await readRange({...parsed.target, purpose: 'export'}))
    } catch {
      settled = {status: 'unavailable'}
    }
    if (settled.status !== 'ready') {
      exported.push({href: item.href, text: item.text, status: 'unavailable', nodeId: parsed.target.nodeId, sheetId: parsed.target.sheetId, range: parsed.target.range})
      continue
    }
    exported.push({
      href: item.href, text: item.text, status: 'ready', nodeId: parsed.target.nodeId, sheetId: parsed.target.sheetId, range: parsed.target.range,
      cells: settled.cells, ...(settled.title === undefined ? {} : {title: settled.title}),
    })
  }
  return exported
}

export interface WorkbookRangeClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  headers?: () => HeadersInit
  /** Re-read on every export. A false result is neutral and does not return cells. */
  canExport?: () => boolean | Promise<boolean>
}

/** Same-origin reader for `GET /workbooks/{node}/ranges`. The href itself is never fetched. */
export function createWorkbookRangeReader(options: WorkbookRangeClientOptions = {}): WorkbookRangeReader {
  const baseUrl = (options.baseUrl ?? '/api/vaulter-sheets/v1').replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  return async request => {
    if (request.purpose === 'export' && options.canExport !== undefined && !await options.canExport()) return {status: 'unavailable'}
    const params = new URLSearchParams({sheet_id: request.sheetId, range: request.range, fields: 'value'})
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/workbooks/${encodeURIComponent(request.nodeId)}/ranges?${params}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: new Headers(options.headers?.()),
      })
    } catch {
      return {status: 'unavailable'}
    }
    if (!response.ok) return {status: 'unavailable'}
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {status: 'unavailable'}
    }
    const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : null
    if (!Array.isArray(data)) return {status: 'unavailable'}
    const cells: WorkbookCell[] = []
    for (const part of data) {
      const rows = part && typeof part === 'object' && 'cells' in part ? part.cells : null
      if (!Array.isArray(rows)) continue
      for (const cell of rows) {
        if (!cell || typeof cell !== 'object' || !('a1' in cell) || typeof cell.a1 !== 'string') continue
        const value = 'value' in cell ? cell.value : null
        cells.push({a1: cell.a1, value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null})
      }
    }
    return {status: 'ready', cells}
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}
