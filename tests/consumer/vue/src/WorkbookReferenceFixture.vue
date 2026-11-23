<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref, shallowRef} from 'vue'
import {Editor, type JSONContent} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {SPREADSHEET_VIEWER_KEY, VaulterSpreadsheet} from '../../../../packages/vue/dist/vaulter-sheets-vue.js'
import '../../../../packages/vue/dist/vaulter-sheets-vue.css'
import {
  exportWorkbookReferences,
  WorkbookReference,
  type WorkbookCell,
  type WorkbookRangeReader,
} from '../../../../packages/tiptap/src/index'

declare global {
  interface Window {
    vaulterViewers: Record<string, unknown>
    referenceFixture: {
      load: (content: JSONContent) => void
      exportDocument: () => Promise<string>
    }
  }
}

const props = defineProps<{
  actor: string
  nodeId: string
  sheetId: string
  range: string
  extension: boolean
  insert: boolean
}>()

const host = ref<HTMLElement>()
const documentJson = ref('')
const exported = ref('')
const editor = shallowRef<Editor>()
const origin = 'https://fixture.example'

const viewers: Record<string, unknown> = {[SPREADSHEET_VIEWER_KEY]: VaulterSpreadsheet}
window.vaulterViewers = viewers

const readRange: WorkbookRangeReader = async request => {
  const params = new URLSearchParams({range: request.range})
  if (request.purpose === 'export') params.set('export', '1')
  const response = await fetch(`/office/workbooks/${encodeURIComponent(request.nodeId)}/sheets/${encodeURIComponent(request.sheetId)}?${params}`, {
    headers: {Accept: 'application/json', 'X-Fixture-Actor': props.actor},
    cache: 'no-store',
  })
  if (!response.ok) return {status: 'unavailable'}
  const body = await response.json() as {status?: string; title?: unknown; cells?: {a1?: unknown; value?: unknown}[]}
  if (body.status !== 'ready' || !Array.isArray(body.cells)) return {status: 'unavailable'}
  const cells: WorkbookCell[] = []
  for (const cell of body.cells) {
    if (typeof cell.a1 !== 'string') continue
    const value = cell.value
    cells.push({a1: cell.a1, value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null})
  }
  return {status: 'ready', ...(typeof body.title === 'string' ? {title: body.title} : {}), cells}
}

onMounted(() => {
  const element = host.value
  if (!element) return
  const mounted = new Editor({
    element,
    extensions: props.extension
      ? [StarterKit, WorkbookReference.configure({origin, pathPrefix: '/office/workbooks', readRange})]
      : [StarterKit],
  })
  editor.value = mounted
  const publish = () => { documentJson.value = JSON.stringify(mounted.getJSON()) }
  mounted.on('update', publish)
  if (props.insert && props.extension) {
    mounted.commands.insertContent('Lesson 7 ')
    mounted.commands.insertWorkbookReference({nodeId: props.nodeId, sheetId: props.sheetId, range: props.range})
  }
  publish()
  window.referenceFixture = {
    load(content: JSONContent) {
      mounted.commands.setContent(content)
      publish()
    },
    async exportDocument() {
      const references = await exportWorkbookReferences(mounted.getJSON(), {origin, pathPrefix: '/office/workbooks'}, props.extension ? readRange : undefined)
      exported.value = references.map(item => item.status === 'ready'
        ? `${item.title ?? ''}|${(item.cells ?? []).map(cell => cell.value ?? '').join('|')}`
        : 'Unavailable').join('\n')
      return exported.value
    },
  }
})

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <article data-reference-fixture :data-extension="extension ? 'on' : 'off'" :data-viewer="SPREADSHEET_VIEWER_KEY">
    <div ref="host" data-editor></div>
    <pre data-document>{{ documentJson }}</pre>
    <pre data-export>{{ exported }}</pre>
  </article>
</template>
