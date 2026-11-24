import { ref, shallowRef } from 'vue'
import { WorkbookApiError, type Command, type OpenedWorkbook, type Receipt, type Workbook, type WorkbookIntent, type WorkbooksClient } from '../api/workbooks'

interface CheckCell {
  sheet_id: string
  row: number
  column: number
  formula: string | null
  value: number | string | boolean | null
}

function setNativeCell(
  sheets: Record<string, Record<string, unknown>>,
  sheetId: string,
  row0: number,
  col0: number,
  nextCell: Record<string, unknown> | null,
): void {
  const sheet = sheets[sheetId]
  if (!sheet) return
  const cellData = (sheet.cellData ??= {}) as Record<string, Record<string, Record<string, unknown>>>
  const rowKey = String(row0)
  const colKey = String(col0)
  const existing = cellData[rowKey]?.[colKey]
  if (nextCell === null) {
    if (cellData[rowKey]) {
      delete cellData[rowKey][colKey]
      if (Object.keys(cellData[rowKey]).length === 0) delete cellData[rowKey]
    }
    return
  }
  const rowObj = (cellData[rowKey] ??= {})
  const merged: Record<string, unknown> = existing && typeof existing.s === 'string' ? {s: existing.s, ...nextCell} : {...nextCell}
  rowObj[colKey] = merged
}

const STRUCTURAL_KINDS = new Set<Command['kind']>([
  'insert_row_before',
  'delete_row',
  'insert_column_before',
  'delete_column',
  'add_sheet',
  'rename_sheet',
  'delete_sheet',
])

export function pendingCellKeys(commands: readonly Command[]): Set<string> {
  const keys = new Set<string>()
  for (const cmd of commands) {
    if (cmd.kind === 'set_number' || cmd.kind === 'set_text' || cmd.kind === 'set_boolean' || cmd.kind === 'set_formula') {
      keys.add(`${cmd.sheet_id}\0${cmd.row - 1}\0${cmd.column - 1}`)
    } else if (cmd.kind === 'set_values') {
      for (let r = 0; r < cmd.values.length; r++) {
        for (let c = 0; c < cmd.values[r].length; c++) {
          keys.add(`${cmd.sheet_id}\0${cmd.row - 1 + r}\0${cmd.column - 1 + c}`)
        }
      }
    }
  }
  return keys
}

function applyCommittedCommands(base: Workbook, commands: Command[], checks?: {cells?: CheckCell[]}): Workbook {
  const next = structuredClone(base)
  const sheets = (next.native.sheets ?? {}) as Record<string, Record<string, unknown>>
  const checkMap = new Map<string, CheckCell>()
  for (const cell of checks?.cells ?? []) {
    checkMap.set(`${cell.sheet_id}\0${cell.row}\0${cell.column}`, cell)
  }
  for (const cmd of commands) {
    if (cmd.kind === 'set_number') {
      setNativeCell(sheets, cmd.sheet_id, cmd.row - 1, cmd.column - 1, {v: cmd.value, t: 2})
    } else if (cmd.kind === 'set_text') {
      setNativeCell(sheets, cmd.sheet_id, cmd.row - 1, cmd.column - 1, {v: cmd.value, t: 1})
    } else if (cmd.kind === 'set_boolean') {
      setNativeCell(sheets, cmd.sheet_id, cmd.row - 1, cmd.column - 1, {v: cmd.value ? 1 : 0, t: 3})
    } else if (cmd.kind === 'set_formula') {
      const checked = checkMap.get(`${cmd.sheet_id}\0${cmd.row}\0${cmd.column}`)
      const cell: Record<string, unknown> = {f: cmd.formula}
      if (checked && checked.value !== null && checked.value !== undefined) {
        cell.v = checked.value
        if (typeof checked.value === 'number') cell.t = 2
        else if (typeof checked.value === 'boolean') cell.t = 3
        else if (typeof checked.value === 'string') cell.t = 1
      }
      setNativeCell(sheets, cmd.sheet_id, cmd.row - 1, cmd.column - 1, cell)
    } else if (cmd.kind === 'set_values') {
      for (let r = 0; r < cmd.values.length; r++) {
        for (let c = 0; c < cmd.values[r].length; c++) {
          const val = cmd.values[r][c]
          const nextCell = val === null ? null : 'number' in val ? {v: val.number, t: 2} : 'boolean' in val ? {v: val.boolean ? 1 : 0, t: 3} : {v: val.text, t: 1}
          setNativeCell(sheets, cmd.sheet_id, cmd.row - 1 + r, cmd.column - 1 + c, nextCell)
        }
      }
    }
  }
  return next
}

export function useWorkbook(node: string, client: WorkbooksClient) {
  const head = shallowRef<OpenedWorkbook>()
  const localAcknowledgement = shallowRef<OpenedWorkbook>()
  const pending = shallowRef<{intent: WorkbookIntent; base: OpenedWorkbook; locallyApplied: boolean}>()
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string>()
  const conflict = ref(false)
  let tailQueue: Promise<Receipt | undefined> = Promise.resolve(undefined)

  async function load() {
    loading.value = true
    error.value = undefined
    try {
      const opened = await client.open(node)
      localAcknowledgement.value = undefined
      head.value = opened
    } catch {
      error.value = 'Could not open the workbook.'
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<Receipt | undefined> {
    const submission = pending.value
    if (!submission || saving.value || conflict.value) return
    saving.value = true
    error.value = undefined
    try {
      let outcome
      try {
        const ifMatch = submission.intent.policy === 'revalidate_by_id' ? '' : submission.base.etag
        outcome = await client.submit(node, submission.intent, ifMatch)
      } catch (failure) {
        if (failure instanceof WorkbookApiError && failure.status < 500) throw failure
        outcome = await client.status(node, submission.intent.command_id)
      }
      if (outcome.state !== 'committed') {
        if (outcome.state === 'running') {
          error.value = 'The edit is still processing.'
          return
        }
        throw new WorkbookApiError(outcome.error?.status ?? 422, outcome.error?.code ?? 'invalid_command')
      }
      const {base} = submission
      const sameGeneration = outcome.marker.generation === base.marker.generation
      const nextPosition = outcome.marker.position === base.marker.position + 1
      const sameSnapshot = outcome.marker.position === base.marker.position && outcome.marker.sha256 === base.marker.sha256
      const cellOnly = submission.intent.commands.every(
        command => command.kind === 'set_number' || command.kind === 'set_text' || command.kind === 'set_boolean' || command.kind === 'set_formula' || command.kind === 'set_values',
      )
      if (sameGeneration && head.value === base && (sameSnapshot || (nextPosition && cellOnly))) {
        const opened: OpenedWorkbook = sameSnapshot
          ? {...base, etag: outcome.etag, marker: outcome.marker}
          : {
              ...base,
              etag: outcome.etag,
              marker: outcome.marker,
              workbook: applyCommittedCommands(
                base.workbook,
                submission.intent.commands,
                (outcome as Receipt & {checks?: {cells?: CheckCell[]}}).checks,
              ),
            }
        localAcknowledgement.value = submission.locallyApplied ? opened : undefined
        head.value = opened
        pending.value = undefined
        return outcome
      }
      const opened = await client.open(node)
      const openedNextPosition = opened.marker.position === base.marker.position + 1
      const openedSameSnapshot = opened.marker.position === base.marker.position && opened.marker.sha256 === base.marker.sha256
      localAcknowledgement.value =
        submission.locallyApplied && head.value === base &&
        opened.etag === outcome.etag && opened.marker.sha256 === outcome.marker.sha256 &&
        opened.marker.generation === base.marker.generation && (openedNextPosition || openedSameSnapshot)
          ? opened : undefined
      head.value = opened
      pending.value = undefined
      return outcome
    } catch (failure) {
      conflict.value = failure instanceof WorkbookApiError && failure.status === 409
      error.value = conflict.value ? 'The workbook changed. Your edit is still visible here.' : 'Could not save the edit.'
      return undefined
    } finally {
      saving.value = false
    }
  }

  function submit(commands: Command[], locallyApplied = false): Promise<Receipt | undefined> {
    if (saving.value && !conflict.value && locallyApplied) {
      tailQueue = tailQueue.then(() => submit(commands, locallyApplied))
      return tailQueue
    }
    const base = head.value
    if (!base || pending.value || commands.length === 0 || commands.some(command => !base.commands.includes(command.kind))) {
      return Promise.resolve(undefined)
    }
    const policy: WorkbookIntent['policy'] = commands.some(command => STRUCTURAL_KINDS.has(command.kind))
      ? 'exact_base'
      : commands.every(command => command.kind === 'fill_formula')
        ? 'revalidate_by_id'
        : 'rebase_cells'
    const commandId = globalThis.crypto.randomUUID()
    pending.value = {base, locallyApplied: locallyApplied && policy !== 'revalidate_by_id', intent: {
        command_id: commandId, expected_generation: base.marker.generation, policy, commands,
    }}
    return save()
  }

  async function refresh(): Promise<OpenedWorkbook | undefined> {
    if (loading.value || saving.value) return head.value
    try {
      const opened = await client.open(node)
      localAcknowledgement.value = undefined
      head.value = opened
      return opened
    } catch {
      return undefined
    }
  }

  async function loadCurrent() {
    pending.value = undefined
    conflict.value = false
    await load()
  }

  return {head, localAcknowledgement, pending, loading, saving, error, conflict, load, save, submit, refresh, loadCurrent}
}
