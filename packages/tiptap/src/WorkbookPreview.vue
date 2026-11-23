<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {settleRange, type WorkbookRangeReader, type WorkbookReferenceTarget} from './contract'

const props = defineProps({
  target: {type: Object as () => WorkbookReferenceTarget | null, default: null},
  invalid: {type: Boolean, default: false},
  readRange: {type: Function as unknown as () => WorkbookRangeReader | undefined, default: undefined},
})

const state = ref<'loading' | 'ready' | 'unavailable'>('loading')
const title = ref('')
const values = ref('')

onMounted(async () => {
  const target = props.target
  if (props.invalid || target === null || props.readRange === undefined) {
    state.value = 'unavailable'
    return
  }
  try {
    const result = settleRange(await props.readRange({nodeId: target.nodeId, sheetId: target.sheetId, range: target.range, purpose: 'preview'}))
    if (result.status !== 'ready') {
      state.value = 'unavailable'
      return
    }
    title.value = result.title ?? ''
    values.value = result.cells.map(cell => cell.value === null ? '' : String(cell.value)).join('|')
    state.value = 'ready'
  } catch {
    title.value = ''
    values.value = ''
    state.value = 'unavailable'
  }
})
</script>

<template>
  <span class="workbook-reference-preview" data-workbook-preview :data-state="state">
    <template v-if="state === 'ready'">
      <span v-if="title" data-workbook-title>{{ title }}</span>
      <span data-workbook-values>{{ values }}</span>
    </template>
    <span v-else-if="state === 'unavailable'" data-workbook-unavailable>Unavailable</span>
  </span>
</template>
