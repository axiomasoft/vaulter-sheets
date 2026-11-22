<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Node } from '@vaulter/vue'
import { createWorkbooksClient, type Command, type Receipt, type WorkbooksClient } from '../api/workbooks'
import { useWorkbook } from '../composables/useWorkbook'
import type { MountedWorkbook } from '../editor/mountWorkbook'

const props = withDefaults(defineProps<{
  node: Node
  readonly?: boolean
  autoLoad?: boolean
  workbookClient?: WorkbooksClient
}>(), {readonly: false, autoLoad: true})
const emit = defineEmits<{save: [receipt: Receipt]}>()
const {head, localAcknowledgement, pending, loading, saving, error, conflict, load, save, submit, loadCurrent} = useWorkbook(props.node.id, props.workbookClient ?? createWorkbooksClient())
const isReadonly = computed(() => props.readonly || !props.node.abilities.edit || !head.value?.commands.length)
const element = ref<HTMLElement>()
const renderer = shallowRef<MountedWorkbook>()
let version = 0

onMounted(() => {
  if (props.autoLoad) void load()
})

async function mount() {
  const current = ++version
  renderer.value?.dispose()
  renderer.value = undefined
  if (!head.value || !element.value) return
  try {
    const {mountWorkbook} = await import('../editor/mountWorkbook')
    if (current !== version || !head.value || !element.value) return
    renderer.value = markRaw(mountWorkbook(element.value, head.value.workbook, () => !isReadonly.value && !pending.value,
      commands => { void reportSave(submit(commands, true)) },
      () => { void mount().then(() => { error.value = 'This edit is outside the workbook profile.' }) },
    ))
  } catch {
    if (current === version) error.value = 'Could not start the spreadsheet editor.'
  }
}

watch([head, element, isReadonly], ([opened, target, readonly], [previous, oldTarget, wasReadonly]) => {
  if (opened && opened !== previous && opened === localAcknowledgement.value && target === oldTarget && readonly === wasReadonly && renderer.value) {
    renderer.value.accept(opened.workbook)
    return
  }
  void mount()
}, {flush: 'post'})
onBeforeUnmount(() => {
  version++
  renderer.value?.dispose()
  renderer.value = undefined
})

async function persist(commands?: Command[]) {
  if (isReadonly.value) return
  await reportSave(commands ? submit(commands) : save())
}

async function reportSave(operation: Promise<Receipt | undefined>) {
  const receipt = await operation
  if (receipt) emit('save', receipt)
}

async function insertRow() {
  const target = renderer.value?.selectedRow()
  if (target) await persist([{...target, kind: 'insert_row_before', count: 1}])
}

async function reload() {
  await loadCurrent()
  await nextTick()
}

defineExpose({load, save: persist, submit: persist, workbook: head, saving, conflict})
</script>

<template>
  <div class="vaulter-spreadsheet" :data-readonly="isReadonly">
    <div v-if="loading && !head" role="status"><slot name="loading">Loading workbook…</slot></div>
    <p v-if="error" role="alert"><slot name="error" :error="error">{{ error }}</slot></p>
    <slot v-if="head" :node="node" :workbook="head.workbook" :readonly="isReadonly" :submit="persist" :saving="saving" :conflict="conflict">
      <div ref="element" class="vaulter-spreadsheet__editor" aria-label="Spreadsheet"></div>
      <button v-if="!isReadonly && head.commands.includes('insert_row_before')" type="button" :disabled="!!pending" @click="insertRow">Insert row above</button>
    </slot>
    <span v-if="saving" role="status">Saving…</span>
    <button v-else-if="pending && !conflict" type="button" @click="persist()">Retry save</button>
    <button v-if="conflict" type="button" @click="reload">Load current workbook</button>
  </div>
</template>

<style scoped>
.vaulter-spreadsheet__editor { min-height: 32rem; height: min(70vh, 55rem); }
</style>
