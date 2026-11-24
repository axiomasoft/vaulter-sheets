import {
  BorderStyleTypes,
  HorizontalAlign,
  VerticalAlign,
  WrapStrategy,
  type ICellData,
} from '@univerjs/core'
import {
  AddWorksheetMergeMutation,
  InsertColMutation,
  InsertRowMutation,
  InsertSheetMutation,
  RemoveColMutation,
  RemoveNumfmtMutation,
  RemoveRowMutation,
  RemoveSheetMutation,
  RemoveWorksheetMergeMutation,
  SetFrozenMutation,
  SetNumfmtMutation,
  SetWorksheetNameMutation,
} from '@univerjs/sheets'
import type {
  BorderSideSpec,
  BorderStyleName,
  CellContent,
  Command,
  FormatSpec,
  Literal,
  TableBinding,
  WorkbookSelectionPayload,
  WorkbookSelectionRange,
} from '../api/workbooks'

export function cellContent(cell?: Pick<ICellData, 'f' | 'v' | 't'> | null): CellContent {
  if (cell?.f) return {formula: cell.f}
  const value = cell?.v
  if (typeof value === 'boolean' || cell?.t === 3) return {boolean: Boolean(value)}
  if (typeof value === 'number' && Number.isFinite(value)) return {number: value}
  if (typeof value === 'string') return {text: value}
  return null
}

export function cellCommands(sheet_id: string, startRow: number, startColumn: number, previous: CellContent[][], next: CellContent[][]): Command[] {
  if (JSON.stringify(previous) === JSON.stringify(next)) return []
  const row = startRow + 1
  const column = startColumn + 1
  const value = next[0][0]
  if (next.length === 1 && next[0].length === 1 && value) {
    const target = {sheet_id, row, column, expected: previous[0][0]}
    if ('number' in value) return [{...target, kind: 'set_number', value: value.number}]
    if ('text' in value) return [{...target, kind: 'set_text', value: value.text}]
    if ('boolean' in value) return [{...target, kind: 'set_boolean', value: value.boolean}]
    if ('formula' in value) return [{...target, kind: 'set_formula', formula: value.formula}]
  }
  if (next.some(items => items.some(item => item && 'formula' in item))) {
    throw new Error('A batch of literals cannot include formulas.')
  }
  return [{kind: 'set_values', sheet_id, row, column, expected: previous, values: next as Literal[][]}]
}

export function clipboardValues(text: string): Literal[][] {
  const matrix = text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).map(line => line.split('\t'))
  const width = matrix[0].length
  if (matrix.length * width > 10_000 || matrix.some(row => row.length !== width)) {
    throw new Error('Clipboard data must be a rectangle of at most 10,000 cells.')
  }
  return matrix.map(row => row.map(value => {
    if (value === '') return null
    const number = Number(value)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(number)) return {number}
    return {text: value}
  }))
}

export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed.toLowerCase()
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed)
  if (short) {
    const [r, g, b] = short[1].split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(trimmed)
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]].map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('')
    if (rgb[4] !== undefined) {
      const alpha = Math.max(0, Math.min(255, Math.round(Number(rgb[4]) * 255))).toString(16).padStart(2, '0')
      return `#${hex}${alpha}`
    }
    return `#${hex}`
  }
  return null
}

function mapBorderStyle(style: unknown): BorderStyleName | null {
  switch (style) {
    case BorderStyleTypes.NONE: return 'none'
    case BorderStyleTypes.THIN: return 'thin'
    case BorderStyleTypes.MEDIUM: return 'medium'
    case BorderStyleTypes.THICK: return 'thick'
    case BorderStyleTypes.DASHED: return 'dashed'
    case BorderStyleTypes.DOTTED: return 'dotted'
    case BorderStyleTypes.DOUBLE: return 'double'
    default: return null
  }
}

function mapBorderSide(side: unknown): BorderSideSpec | undefined {
  if (side === undefined) return undefined
  if (side === null) return null
  if (typeof side !== 'object') return undefined
  const rec = side as {s?: unknown; cl?: {rgb?: unknown}}
  const style = mapBorderStyle(rec.s)
  if (!style) return undefined
  const color = normalizeHexColor(rec.cl?.rgb)
  return color ? {style, color} : {style}
}

export function styleToFormatSpec(
  style: Record<string, unknown> | null,
  prevStyle?: Record<string, unknown> | null,
  isOverride = false,
): FormatSpec | null {
  if (style === null) {
    return {
      font: {bold: false, italic: false, color: null},
      fill: null,
      borders: {all: null},
      alignment: {horizontal: null, vertical: null, wrap: false},
      numFmt: null,
    }
  }
  const format: FormatSpec = {}
  const font: NonNullable<FormatSpec['font']> = {}
  if (style.bl !== undefined) font.bold = style.bl === 1
  else if (isOverride && prevStyle?.bl !== undefined) font.bold = false
  if (style.it !== undefined) font.italic = style.it === 1
  else if (isOverride && prevStyle?.it !== undefined) font.italic = false
  if (typeof style.fs === 'number' && style.fs >= 1 && style.fs <= 409) font.size = style.fs
  if ('cl' in style) {
    const color = style.cl && typeof style.cl === 'object' ? normalizeHexColor((style.cl as {rgb?: unknown}).rgb) : null
    if (color !== null || style.cl === null) font.color = color
  } else if (isOverride && prevStyle?.cl !== undefined) {
    font.color = null
  }
  if (Object.keys(font).length > 0) format.font = font

  if ('bg' in style) {
    const fill = style.bg && typeof style.bg === 'object' ? normalizeHexColor((style.bg as {rgb?: unknown}).rgb) : null
    if (fill !== null || style.bg === null) format.fill = fill
  } else if (isOverride && prevStyle?.bg !== undefined) {
    format.fill = null
  }

  if ('bd' in style) {
    if (style.bd === null) {
      format.borders = {all: null}
    } else if (style.bd && typeof style.bd === 'object') {
      const bd = style.bd as Record<string, unknown>
      const borders: NonNullable<FormatSpec['borders']> = {}
      for (const [k, target] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']] as const) {
        const mapped = mapBorderSide(bd[k])
        if (mapped !== undefined) borders[target] = mapped
      }
      if (Object.keys(borders).length > 0) format.borders = borders
    }
  } else if (isOverride && prevStyle?.bd !== undefined) {
    format.borders = {all: null}
  }

  const alignment: NonNullable<FormatSpec['alignment']> = {}
  if (style.ht !== undefined) {
    alignment.horizontal = style.ht === HorizontalAlign.LEFT ? 'left'
      : style.ht === HorizontalAlign.CENTER ? 'center'
        : style.ht === HorizontalAlign.RIGHT ? 'right' : null
  } else if (isOverride && prevStyle?.ht !== undefined) {
    alignment.horizontal = null
  }
  if (style.vt !== undefined) {
    alignment.vertical = style.vt === VerticalAlign.TOP ? 'top'
      : style.vt === VerticalAlign.MIDDLE ? 'middle'
        : style.vt === VerticalAlign.BOTTOM ? 'bottom' : null
  } else if (isOverride && prevStyle?.vt !== undefined) {
    alignment.vertical = null
  }
  if (style.tb !== undefined) {
    alignment.wrap = style.tb === WrapStrategy.WRAP
  } else if (isOverride && prevStyle?.tb !== undefined) {
    alignment.wrap = false
  }
  if (Object.keys(alignment).length > 0) format.alignment = alignment

  if ('n' in style) {
    const pat = style.n && typeof style.n === 'object' ? (style.n as {pattern?: unknown}).pattern : null
    if (typeof pat === 'string' && pat.length > 0 && pat.length <= 255) format.numFmt = pat
    else if (style.n === null) format.numFmt = null
  } else if (isOverride && prevStyle?.n !== undefined) {
    format.numFmt = null
  }

  return Object.keys(format).length > 0 ? format : null
}

export function setFormatCommandsFromCellValues(
  sheetId: string,
  cellValue: Record<string, Record<string, unknown>>,
  resolveStyle: (s: unknown) => Record<string, unknown> | null,
  prevCellData?: Record<string, Record<string, unknown>>,
  isOverride = false,
): Command[] {
  const byFormat = new Map<string, {format: FormatSpec; cells: {row: number; col: number}[]}>()
  for (const [rKey, rowObj] of Object.entries(cellValue)) {
    const row = Number(rKey)
    if (!Number.isSafeInteger(row) || row < 0 || !rowObj || typeof rowObj !== 'object') continue
    for (const [cKey, cell] of Object.entries(rowObj)) {
      const col = Number(cKey)
      if (!Number.isSafeInteger(col) || col < 0) continue
      const prevCell = prevCellData?.[rKey]?.[cKey] as {s?: unknown} | undefined
      const prevStyle = prevCell?.s !== undefined ? resolveStyle(prevCell.s) : null
      let format: FormatSpec | null = null
      if (cell === null) {
        if (prevStyle) format = styleToFormatSpec(null, prevStyle, true)
      } else if (typeof cell === 'object' && 's' in cell) {
        const nextStyle = (cell as {s?: unknown}).s === null ? null : resolveStyle((cell as {s?: unknown}).s)
        format = styleToFormatSpec(nextStyle, prevStyle, isOverride)
      }
      if (!format) continue
      const key = JSON.stringify(format)
      let bucket = byFormat.get(key)
      if (!bucket) {
        bucket = {format, cells: []}
        byFormat.set(key, bucket)
      }
      bucket.cells.push({row, col})
    }
  }
  const commands: Command[] = []
  for (const {format, cells} of byFormat.values()) {
    const rows = cells.map(c => c.row)
    const cols = cells.map(c => c.col)
    const minR = Math.min(...rows)
    const maxR = Math.max(...rows)
    const minC = Math.min(...cols)
    const maxC = Math.max(...cols)
    if ((maxR - minR + 1) * (maxC - minC + 1) === cells.length) {
      commands.push({
        kind: 'set_format',
        sheet_id: sheetId,
        start_row: minR + 1,
        start_column: minC + 1,
        end_row: maxR + 1,
        end_column: maxC + 1,
        format,
      })
    } else {
      for (const {row, col} of cells) {
        commands.push({
          kind: 'set_format',
          sheet_id: sheetId,
          start_row: row + 1,
          start_column: col + 1,
          end_row: row + 1,
          end_column: col + 1,
          format,
        })
      }
    }
  }
  return commands
}

export function numfmtMutationToCommands(id: string, params: Record<string, unknown>): Command[] {
  const sheetId = params.subUnitId
  if (typeof sheetId !== 'string') return []
  const commands: Command[] = []
  if (id === SetNumfmtMutation.id && params.values && typeof params.values === 'object' && params.refMap && typeof params.refMap === 'object') {
    const values = params.values as Record<string, {ranges?: {startRow: number; startColumn: number; endRow: number; endColumn: number}[]}>
    const refMap = params.refMap as Record<string, {pattern?: string}>
    for (const [key, entry] of Object.entries(values)) {
      const pattern = refMap[key]?.pattern
      if (typeof pattern !== 'string' || !Array.isArray(entry?.ranges)) continue
      for (const r of entry.ranges) {
        commands.push({
          kind: 'set_format',
          sheet_id: sheetId,
          start_row: r.startRow + 1,
          start_column: r.startColumn + 1,
          end_row: r.endRow + 1,
          end_column: r.endColumn + 1,
          format: {numFmt: pattern},
        })
      }
    }
  } else if (id === RemoveNumfmtMutation.id && Array.isArray(params.ranges)) {
    for (const r of params.ranges as {startRow: number; startColumn: number; endRow: number; endColumn: number}[]) {
      commands.push({
        kind: 'set_format',
        sheet_id: sheetId,
        start_row: r.startRow + 1,
        start_column: r.startColumn + 1,
        end_row: r.endRow + 1,
        end_column: r.endColumn + 1,
        format: {numFmt: null},
      })
    }
  }
  return commands
}

export function structuralMutationToCommands(id: string, params: Record<string, unknown>): Command[] {
  if (id === InsertSheetMutation.id && params.sheet && typeof params.sheet === 'object') {
    const sheet = params.sheet as {id?: unknown; name?: unknown; rowCount?: unknown; columnCount?: unknown}
    if (typeof sheet.id !== 'string' || typeof sheet.name !== 'string') return []
    const cmd: Extract<Command, {kind: 'add_sheet'}> = {kind: 'add_sheet', sheet_id: sheet.id, name: sheet.name}
    if (typeof params.index === 'number' && Number.isSafeInteger(params.index) && params.index >= 0) cmd.index = params.index
    if (typeof sheet.rowCount === 'number' && Number.isSafeInteger(sheet.rowCount) && sheet.rowCount > 0) cmd.row_count = sheet.rowCount
    if (typeof sheet.columnCount === 'number' && Number.isSafeInteger(sheet.columnCount) && sheet.columnCount > 0) cmd.column_count = sheet.columnCount
    return [cmd]
  }
  const sheetId = params.subUnitId
  if (typeof sheetId !== 'string') return []
  if (id === RemoveSheetMutation.id) return [{kind: 'delete_sheet', sheet_id: sheetId}]
  if (id === SetWorksheetNameMutation.id && typeof params.name === 'string') {
    return [{
      kind: 'rename_sheet',
      sheet_id: sheetId,
      name: params.name,
      ...(typeof params.oldName === 'string' && params.oldName !== '' ? {expected_name: params.oldName} : {}),
    }]
  }
  if (id === InsertRowMutation.id && params.range && typeof params.range === 'object') {
    const r = params.range as {startRow: number; endRow: number}
    return [{kind: 'insert_row_before', sheet_id: sheetId, row: r.startRow + 1, count: r.endRow - r.startRow + 1}]
  }
  if (id === RemoveRowMutation.id && params.range && typeof params.range === 'object') {
    const r = params.range as {startRow: number; endRow: number}
    return [{kind: 'delete_row', sheet_id: sheetId, row: r.startRow + 1, count: r.endRow - r.startRow + 1}]
  }
  if (id === InsertColMutation.id && params.range && typeof params.range === 'object') {
    const r = params.range as {startColumn: number; endColumn: number}
    return [{kind: 'insert_column_before', sheet_id: sheetId, column: r.startColumn + 1, count: r.endColumn - r.startColumn + 1}]
  }
  if (id === RemoveColMutation.id && params.range && typeof params.range === 'object') {
    const r = params.range as {startColumn: number; endColumn: number}
    return [{kind: 'delete_column', sheet_id: sheetId, column: r.startColumn + 1, count: r.endColumn - r.startColumn + 1}]
  }
  if (id === SetFrozenMutation.id && typeof params.ySplit === 'number' && typeof params.xSplit === 'number') {
    return [{kind: 'set_freeze', sheet_id: sheetId, row_count: Math.max(0, params.ySplit), column_count: Math.max(0, params.xSplit)}]
  }
  if ((id === AddWorksheetMergeMutation.id || id === RemoveWorksheetMergeMutation.id) && Array.isArray(params.ranges)) {
    const kind = id === AddWorksheetMergeMutation.id ? 'merge_cells' : 'unmerge_cells'
    return (params.ranges as {startRow: number; startColumn: number; endRow: number; endColumn: number}[]).map(r => ({
      kind,
      sheet_id: sheetId,
      start_row: r.startRow + 1,
      start_column: r.startColumn + 1,
      end_row: r.endRow + 1,
      end_column: r.endColumn + 1,
    }))
  }
  return []
}

function columnToLetters(column: number): string {
  let col = column
  let out = ''
  while (col > 0) {
    col -= 1
    out = String.fromCharCode(65 + (col % 26)) + out
    col = Math.floor(col / 26)
  }
  return out
}

export function resolveTableSelection(
  tables: readonly TableBinding[],
  sheetId: string,
  rawRanges: readonly {startRow: number; startColumn: number; endRow: number; endColumn: number}[],
): WorkbookSelectionPayload {
  const ranges: WorkbookSelectionRange[] = rawRanges.map(r => {
    const start_row = r.startRow + 1
    const start_column = r.startColumn + 1
    const end_row = r.endRow + 1
    const end_column = r.endColumn + 1
    const startA1 = `${columnToLetters(start_column)}${start_row}`
    const endA1 = `${columnToLetters(end_column)}${end_row}`
    return {
      sheet_id: sheetId,
      start_row,
      start_column,
      end_row,
      end_column,
      a1: startA1 === endA1 ? startA1 : `${startA1}:${endA1}`,
    }
  })
  const primary = ranges[ranges.length - 1] ?? null
  const payload: WorkbookSelectionPayload = {sheet_id: sheetId, range: primary, ranges}
  for (const table of tables) {
    if (table.sheet_id !== sheetId) continue
    const rowSet = new Set<string>()
    const colSet = new Set<string>()
    const sortedRows = [...table.rows].sort((a, b) => a.row - b.row)
    for (const r of ranges) {
      for (const rowBinding of sortedRows) {
        if (rowBinding.row >= r.start_row && rowBinding.row <= r.end_row) rowSet.add(rowBinding.row_id)
      }
      for (const colBinding of table.columns) {
        if (colBinding.column >= r.start_column && colBinding.column <= r.end_column) colSet.add(colBinding.column_id)
      }
    }
    if (rowSet.size > 0 || colSet.size > 0) {
      const row_ids = [...rowSet]
      const column_ids = [...colSet]
      payload.table = {table_id: table.table_id, sheet_id: sheetId, row_ids, column_ids}
      payload.sheet_table = {table_id: table.table_id, row_ids, column_ids}
      break
    }
  }
  return payload
}
