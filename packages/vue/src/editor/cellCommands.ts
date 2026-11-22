import type { ICellData } from '@univerjs/core'
import type { CellContent, Command, Literal } from '../api/workbooks'

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
  if (next.some(row => row.some(value => value && 'boolean' in value))) {
    throw new Error('Boolean input is outside the editing profile.')
  }
  const row = startRow + 1
  const column = startColumn + 1
  const value = next[0][0]
  if (next.length === 1 && next[0].length === 1 && value) {
    const target = {sheet_id, row, column, expected: previous[0][0]}
    if ('number' in value) return [{...target, kind: 'set_number', value: value.number}]
    if ('text' in value) return [{...target, kind: 'set_text', value: value.text}]
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
