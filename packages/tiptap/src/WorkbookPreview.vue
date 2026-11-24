<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {settleRange, type WorkbookCell, type WorkbookRangeReader, type WorkbookRangeResult, type WorkbookReferenceTarget} from './contract'

const props = defineProps({
  target: {type: Object as () => WorkbookReferenceTarget | null, default: null},
  invalid: {type: Boolean, default: false},
  readRange: {type: Function as unknown as () => WorkbookRangeReader | undefined, default: undefined},
  refreshIntervalMs: {type: Number, default: 0},
  refreshTrigger: {type: [Number, String] as unknown as () => number | string | undefined, default: undefined},
})

const emit = defineEmits<{
  refresh: [detail: {target: WorkbookReferenceTarget | null; result: WorkbookRangeResult; trigger: 'mount' | 'props' | 'manual' | 'auto'}]
}>()

const state = ref<'loading' | 'ready' | 'unavailable'>('loading')
const title = ref('')
const cells = ref<WorkbookCell[]>([])
let requestVersion = 0
let pollTimer: ReturnType<typeof setInterval> | undefined

const summaryValues = computed(() => cells.value.map(cell => cell.value === null ? '' : String(cell.value)).join('|'))

function colToNumber(col: string): number {
  let n = 0
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64)
  return n
}

const grid = computed(() => {
  const colSet = new Set<string>()
  const rowSet = new Set<number>()
  const byCoord = new Map<string, WorkbookCell>()
  for (const cell of cells.value) {
    const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(cell.a1)
    if (!match) continue
    const col = match[1]
    const row = Number(match[2])
    colSet.add(col)
    rowSet.add(row)
    byCoord.set(`${col}${row}`, cell)
  }
  const cols = [...colSet].sort((a, b) => colToNumber(a) - colToNumber(b))
  const rows = [...rowSet].sort((a, b) => a - b)
  return {cols, rows, byCoord}
})

function formatCell(cell: WorkbookCell | undefined): string {
  if (!cell || cell.value === null || cell.value === undefined) return ''
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  if (typeof cell.value === 'number') {
    if (cell.format && cell.format.includes('%')) {
      return `${(cell.value * 100).toFixed(0)}%`
    }
    return String(cell.value)
  }
  return String(cell.value)
}

async function refresh(trigger: 'mount' | 'props' | 'manual' | 'auto' = 'manual'): Promise<void> {
  const current = ++requestVersion
  const target = props.target
  if (props.invalid || target === null || props.readRange === undefined) {
    title.value = ''
    cells.value = []
    state.value = 'unavailable'
    return
  }
  try {
    const result = settleRange(await props.readRange({nodeId: target.nodeId, sheetId: target.sheetId, range: target.range, purpose: 'preview'}))
    if (current !== requestVersion) return
    if (result.status !== 'ready') {
      title.value = ''
      cells.value = []
      state.value = 'unavailable'
      emit('refresh', {target, result, trigger})
      return
    }
    title.value = result.title ?? ''
    cells.value = result.cells
    state.value = 'ready'
    emit('refresh', {target, result, trigger})
  } catch {
    if (current !== requestVersion) return
    title.value = ''
    cells.value = []
    state.value = 'unavailable'
  }
}

function setupPolling() {
  clearInterval(pollTimer)
  pollTimer = undefined
  if (props.refreshIntervalMs > 0) {
    pollTimer = setInterval(() => {
      void refresh('auto')
    }, props.refreshIntervalMs)
  }
}

function onWorkbookChanged(event: Event) {
  const detail = (event as CustomEvent<{nodeId?: string}>).detail
  if (!detail?.nodeId || detail.nodeId === props.target?.nodeId) {
    void refresh('auto')
  }
}

onMounted(() => {
  void refresh('mount')
  setupPolling()
  if (typeof window !== 'undefined') {
    window.addEventListener('vaulter-sheets:workbook-changed', onWorkbookChanged)
  }
})

watch(
  [() => props.target?.nodeId, () => props.target?.sheetId, () => props.target?.range, () => props.invalid, () => props.readRange, () => props.refreshTrigger],
  () => {
    void refresh('props')
  },
)

watch(() => props.refreshIntervalMs, setupPolling)

onBeforeUnmount(() => {
  requestVersion++
  clearInterval(pollTimer)
  if (typeof window !== 'undefined') {
    window.removeEventListener('vaulter-sheets:workbook-changed', onWorkbookChanged)
  }
})

defineExpose({refresh, state})
</script>

<template>
  <span class="workbook-reference-preview" data-workbook-preview :data-state="state">
    <template v-if="state === 'ready'">
      <span class="workbook-reference-preview__header">
        <span v-if="title" class="workbook-reference-preview__title" data-workbook-title>{{ title }}</span>
        <button type="button" class="workbook-reference-preview__refresh" data-workbook-refresh aria-label="Refresh" @click="refresh('manual')">↻</button>
      </span>
      <span class="workbook-reference-preview__sr" data-workbook-values>{{ summaryValues }}</span>
      <table v-if="grid.cols.length > 0 && grid.rows.length > 0" class="workbook-reference-preview__table" data-workbook-table>
        <thead>
          <tr>
            <th scope="col" class="workbook-reference-preview__corner"></th>
            <th v-for="col in grid.cols" :key="col" scope="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in grid.rows" :key="row">
            <th scope="row">{{ row }}</th>
            <td
              v-for="col in grid.cols"
              :key="`${col}${row}`"
              :data-cell="`${col}${row}`"
              :title="grid.byCoord.get(`${col}${row}`)?.formula ?? undefined"
            >{{ formatCell(grid.byCoord.get(`${col}${row}`)) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
    <span v-else-if="state === 'unavailable'" data-workbook-unavailable>Unavailable</span>
  </span>
</template>

<style scoped>
.workbook-reference-preview { display: inline-flex; flex-direction: column; gap: 0.25rem; vertical-align: middle; }
.workbook-reference-preview__header { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.85em; font-weight: 600; }
.workbook-reference-preview__refresh { border: 1px solid currentColor; border-radius: 0.25rem; background: transparent; cursor: pointer; font-size: 0.75em; padding: 0 0.25rem; line-height: 1.2; }
.workbook-reference-preview__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.workbook-reference-preview__table { border-collapse: collapse; font-size: 0.85em; }
.workbook-reference-preview__table th, .workbook-reference-preview__table td { border: 1px solid #d1d5db; padding: 0.125rem 0.375rem; text-align: left; }
.workbook-reference-preview__table th { background: #f3f4f6; font-weight: 600; }
</style>
