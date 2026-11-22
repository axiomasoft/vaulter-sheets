import { ref, shallowRef } from 'vue'
import { WorkbookApiError, type Command, type OpenedWorkbook, type Receipt, type WorkbookIntent, type WorkbooksClient } from '../api/workbooks'

export function useWorkbook(node: string, client: WorkbooksClient) {
  const head = shallowRef<OpenedWorkbook>()
  const localAcknowledgement = shallowRef<OpenedWorkbook>()
  const pending = shallowRef<{intent: WorkbookIntent; base: OpenedWorkbook; locallyApplied: boolean}>()
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string>()
  const conflict = ref(false)

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
        outcome = await client.submit(node, submission.intent, submission.base.etag)
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
      const opened = await client.open(node)
      const {base} = submission
      const nextPosition = opened.marker.position === base.marker.position + 1
      const sameSnapshot = opened.marker.position === base.marker.position && opened.marker.sha256 === base.marker.sha256
      localAcknowledgement.value =
        submission.locallyApplied && head.value === base &&
        opened.etag === outcome.etag && opened.marker.sha256 === outcome.marker.sha256 &&
        opened.marker.generation === base.marker.generation && (nextPosition || sameSnapshot)
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

  function submit(commands: Command[], locallyApplied = false) {
    const base = head.value
    if (!base || pending.value || commands.length === 0 || commands.some(command => !base.commands.includes(command.kind))) {
      return Promise.resolve(undefined)
    }
    const policy = commands.some(command => command.kind === 'insert_row_before') ? 'exact_base' : 'rebase_cells'
    const commandId = globalThis.crypto.randomUUID()
    pending.value = {base, locallyApplied: locallyApplied && policy === 'rebase_cells', intent: {
        command_id: commandId, expected_generation: base.marker.generation, policy, commands,
    }}
    return save()
  }

  async function loadCurrent() {
    pending.value = undefined
    conflict.value = false
    await load()
  }

  return {head, localAcknowledgement, pending, loading, saving, error, conflict, load, save, submit, loadCurrent}
}
