<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useDocument } from '@vaulter/vue'
import type { DocumentBody, DocumentContent, Node } from '@vaulter/vue'

// Headless shell for a spreadsheet document (`vaulter/univer` viewer) — owns loading the
// snapshot with its ETag, tracking unsaved edits and persisting them (debounced autosave);
// the actual spreadsheet surface (Univer, etc.) is mounted by the consumer in the default
// slot, seeded from `workbook` and fed back through `set-workbook`.
const props = withDefaults(
  defineProps<{
    node: Node
    readonly?: boolean
    autoLoad?: boolean
    /** Autosave debounce window in ms. */
    debounceMs?: number
  }>(),
  { readonly: false, autoLoad: true, debounceMs: 800 },
)

const emit = defineEmits<{
  save: [saved: DocumentContent]
  'workbook-changed': [workbook: DocumentBody]
}>()

const { content: workbook, loading, saving, error, conflict, load, setContent, save } =
  useDocument(props.node.id, { debounceMs: props.debounceMs })

const isReadonly = computed(() => props.readonly || !props.node.abilities.edit)

onMounted(() => {
  if (props.autoLoad) {
    // A load failure is captured in `error` (shown via the error slot); swallow the
    // rejection here so it is not an unhandled promise rejection.
    void load().catch(() => undefined)
  }
})

function update(next: DocumentBody): void {
  if (isReadonly.value) {
    return
  }
  setContent(next)
  emit('workbook-changed', next)
}

async function persist(): Promise<void> {
  emit('save', await save())
}

defineExpose({ load, save: persist, setWorkbook: update, workbook, saving, conflict })
</script>

<template>
  <div class="vaulter-spreadsheet" :data-readonly="isReadonly">
    <slot v-if="loading" name="loading">Loading…</slot>
    <p v-else-if="error && !conflict" class="vaulter-spreadsheet__error" role="alert">
      <slot name="error" :error="error">Could not load this spreadsheet.</slot>
    </p>
    <slot
      v-else
      :node="node"
      :workbook="workbook"
      :saving="saving"
      :readonly="isReadonly"
      :conflict="conflict"
      :set-workbook="update"
      :save="persist"
    >
      <div class="vaulter-spreadsheet__placeholder">
        Mount your spreadsheet editor here (seed it from <code>workbook</code>, feed edits to
        <code>set-workbook</code>).
      </div>
    </slot>
  </div>
</template>
