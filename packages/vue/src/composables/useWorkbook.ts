import { ref, shallowRef } from 'vue'
import { WorkbookApiError, type Command, type OpenedWorkbook, type Receipt, type WorkbookIntent, type WorkbooksClient } from '../api/workbooks'

export function useWorkbook(node: string, client: WorkbooksClient) {
  const head = shallowRef<OpenedWorkbook>()
  const pending = shallowRef<{intent: WorkbookIntent; etag: string}>()
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string>()
  const conflict = ref(false)

  async function load() {
    loading.value = true
    error.value = undefined
    try {
      head.value = await client.open(node)
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
        outcome = await client.submit(node, submission.intent, submission.etag)
      } catch (failure) {
        if (failure instanceof WorkbookApiError && failure.status < 500) throw failure
        outcome = await client.status(node, submission.intent.command_id)
      }
      if (outcome.state === 'running') {
        error.value = 'The edit is still processing.'
        return
      }
      if (outcome.state === 'rejected') {
        throw new WorkbookApiError(outcome.error?.status ?? 422, outcome.error?.code ?? 'invalid_command')
      }
      head.value = await client.open(node)
      pending.value = undefined
      return outcome as Receipt
    } catch (failure) {
      conflict.value = failure instanceof WorkbookApiError && failure.status === 409
      error.value = conflict.value ? 'The workbook changed. Your edit is still visible here.' : 'Could not save the edit.'
      return undefined
    } finally {
      saving.value = false
    }
  }

  function submit(commands: Command[]) {
    if (!head.value || pending.value || commands.length === 0 || commands.some(command => !head.value?.commands.includes(command.kind))) {
      return Promise.resolve(undefined)
    }
    const policy = commands.some(command => command.kind === 'insert_row_before') ? 'exact_base' : 'rebase_cells'
    const commandId = globalThis.crypto.randomUUID()
    pending.value = {etag: head.value.etag, intent: {
      command_id: commandId, expected_generation: head.value.marker.generation, policy, commands,
    }}
    return save()
  }

  async function loadCurrent() {
    pending.value = undefined
    conflict.value = false
    await load()
  }

  return {head, pending, loading, saving, error, conflict, load, save, submit, loadCurrent}
}
