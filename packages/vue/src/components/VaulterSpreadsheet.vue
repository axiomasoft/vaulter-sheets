<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Node } from '@vaulter/vue'
import {
  createWorkbooksClient,
  type Command,
  type ExchangeJob,
  type ExchangeLossEntry,
  type Receipt,
  type Workbook,
  type WorkbookLocale,
  type WorkbookPresence,
  type WorkbookRoomSession,
  type WorkbooksClient,
  type WorkbookSelectionPayload,
} from '../api/workbooks'
import { pendingCellKeys, useWorkbook } from '../composables/useWorkbook'
import type { MountedWorkbook } from '../editor/mountWorkbook'

export interface VaulterRealtimeOptions {
  enabled?: boolean
  session?: () => Promise<WorkbookRoomSession>
  user?: WorkbookPresence['user']
  autoSwitchProfile?: boolean
}

const props = withDefaults(defineProps<{
  node: Node
  readonly?: boolean
  autoLoad?: boolean
  workbookClient?: WorkbooksClient
  showToolbar?: boolean
  showContextMenu?: boolean
  showHeader?: boolean
  locale?: WorkbookLocale
  realtime?: boolean | VaulterRealtimeOptions
  showExchange?: boolean
  exchangePollMs?: number
  uploadImportFile?: (file: File) => Promise<{ id: string }>
}>(), {
  readonly: false,
  autoLoad: true,
  showToolbar: true,
  showContextMenu: true,
  showHeader: false,
  locale: 'enUS',
  realtime: false,
  showExchange: false,
  exchangePollMs: 500,
})

const emit = defineEmits<{
  save: [receipt: Receipt]
  selectionChange: [payload: WorkbookSelectionPayload]
  awarenessChange: [peers: readonly WorkbookPresence[]]
  exchangeComplete: [job: ExchangeJob]
  realtimeStateChange: [state: 'connected' | 'reconnecting' | 'closed']
}>()

const client = computed(() => props.workbookClient ?? createWorkbooksClient())
const { head, localAcknowledgement, pending, loading, saving, error, conflict, load, save, submit, refresh, loadCurrent } = useWorkbook(props.node.id, client.value)

const realtimeConfig = computed<VaulterRealtimeOptions | null>(() => {
  if (!props.realtime) return null
  if (props.realtime === true) return { enabled: true }
  return props.realtime.enabled === false ? null : props.realtime
})
const realtimeEnabled = computed(() => realtimeConfig.value !== null)
const realtimeReadonly = ref(false)
const connectionState = ref<'connected' | 'reconnecting' | 'closed'>('closed')
const awarenessPeers = ref<readonly WorkbookPresence[]>([])
const realtimeWorkbook = shallowRef<Workbook>()

const isReadonly = computed(() => {
  if (props.readonly || !props.node.abilities.edit) return true
  if (realtimeEnabled.value) return realtimeReadonly.value
  return !head.value?.commands.length
})

const activeWorkbook = computed(() => realtimeWorkbook.value ?? head.value?.workbook)

const element = ref<HTMLElement>()
const renderer = shallowRef<MountedWorkbook>()
let version = 0
let exchangeTimer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

const exchangeJob = ref<ExchangeJob | null>(null)
const exchangeBusy = ref(false)
const exchangeError = ref<string>()
const importSourceNodeId = ref('')
const exchangeLosses = computed<ExchangeLossEntry[]>(() => exchangeJob.value?.report?.losses ?? [])
const exportFormats = computed(() => head.value?.exchange?.export ?? (props.node.abilities.download ? (['xlsx', 'csv'] as const) : []))
const importFormats = computed(() => head.value?.exchange?.import ?? (!isReadonly.value ? (['xlsx', 'csv'] as const) : []))
const downloadHref = computed(() => {
  const job = exchangeJob.value
  if (!job || job.kind !== 'export' || job.state !== 'succeeded') return undefined
  return client.value.exchangeDownloadUrl?.(props.node.id, job.exchange_id)
})

function notifyWorkbookChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vaulter-sheets:workbook-changed', { detail: { nodeId: props.node.id } }))
  }
}

onMounted(() => {
  if (props.autoLoad) void load()
})

async function resolveRealtimeSession(): Promise<WorkbookRoomSession> {
  const cfg = realtimeConfig.value
  if (cfg?.session) {
    const sess = await cfg.session()
    realtimeReadonly.value = sess.mode === 'read'
    return sess
  }
  const c = client.value
  if (!c.realtimeSession) throw new Error('Realtime session client is unavailable.')
  try {
    const sess = await c.realtimeSession(props.node.id)
    realtimeReadonly.value = sess.mode === 'read'
    return sess
  } catch (err) {
    if (cfg?.autoSwitchProfile && head.value?.etag && c.switchRealtimeProfile) {
      await c.switchRealtimeProfile(props.node.id, 'journal', head.value.etag)
      const sess = await c.realtimeSession(props.node.id)
      realtimeReadonly.value = sess.mode === 'read'
      return sess
    }
    throw err
  }
}

async function mount() {
  const current = ++version
  renderer.value?.dispose()
  renderer.value = undefined
  if (!head.value || !element.value) return
  try {
    const { mountWorkbook } = await import('../editor/mountWorkbook')
    if (current !== version || !head.value || !element.value) return
    const rt = realtimeConfig.value
    renderer.value = markRaw(mountWorkbook(
      element.value,
      head.value.workbook,
      () => !isReadonly.value && (realtimeEnabled.value || !pending.value),
      commands => { void reportSave(submit(commands, true)) },
      () => { void mount().then(() => { error.value = 'This edit is outside the workbook profile.' }) },
      {
        showToolbar: props.showToolbar,
        showContextMenu: props.showContextMenu,
        showHeader: props.showHeader,
        locale: props.locale,
        allowedCommands: () => realtimeEnabled.value ? [] : (head.value?.commands ?? []),
        pendingCellKeys: () => pending.value ? pendingCellKeys(pending.value.intent.commands) : new Set<string>(),
        onSelectionChange: payload => emit('selectionChange', payload),
        ...(rt ? {
          realtime: {
            session: resolveRealtimeSession,
            user: rt.user,
            onState: wb => {
              realtimeWorkbook.value = wb
              notifyWorkbookChanged()
            },
            onConnection: st => {
              connectionState.value = st
              emit('realtimeStateChange', st)
            },
            onAwareness: peers => {
              awarenessPeers.value = peers
              renderer.value?.setPeerSelections?.(peers)
              emit('awarenessChange', peers)
            },
            onConflict: code => {
              error.value = `Realtime conflict: ${code}`
            },
          },
        } : {}),
      },
    ))
  } catch {
    if (current === version) error.value = 'Could not start the spreadsheet editor.'
  }
}

watch(
  [head, element, isReadonly, () => props.showToolbar, () => props.showContextMenu, () => props.showHeader, () => props.locale, realtimeEnabled],
  ([opened, target, readonly, toolbar, contextMenu, header, loc, rt], [previous, oldTarget, wasReadonly, oldToolbar, oldContextMenu, oldHeader, oldLoc, oldRt]) => {
    const uiUnchanged = toolbar === oldToolbar && contextMenu === oldContextMenu && header === oldHeader && loc === oldLoc && rt === oldRt
    if (opened && target === oldTarget && uiUnchanged && renderer.value) {
      if (opened !== previous && opened === localAcknowledgement.value && readonly === wasReadonly) {
        renderer.value.accept(opened.workbook)
        return
      }
      if (renderer.value.sync?.(opened.workbook, !readonly && (rt || !pending.value))) {
        return
      }
    }
    void mount()
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(exchangeTimer)
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
  if (receipt) {
    emit('save', receipt)
    notifyWorkbookChanged()
  }
}

async function insertRow() {
  const target = renderer.value?.selectedRow()
  if (target) await persist([{ ...target, kind: 'insert_row_before', count: 1 }])
}

async function reload() {
  await loadCurrent()
  await nextTick()
}

function getSelection(): WorkbookSelectionPayload | undefined {
  return renderer.value?.getSelection?.()
}

async function pollExchange(exchangeId: string): Promise<ExchangeJob | undefined> {
  const c = client.value
  if (!c.exchangeStatus || unmounted) return undefined
  const job = await c.exchangeStatus(props.node.id, exchangeId)
  exchangeJob.value = job
  if (job.state === 'queued' || job.state === 'running') {
    await new Promise<void>(resolve => {
      exchangeTimer = setTimeout(resolve, props.exchangePollMs)
    })
    return pollExchange(exchangeId)
  }
  exchangeBusy.value = false
  emit('exchangeComplete', job)
  if (job.state === 'failed') {
    exchangeError.value = job.error_code ?? 'exchange_failed'
  } else if (job.kind === 'import') {
    await loadCurrent()
    notifyWorkbookChanged()
  }
  return job
}

async function exportWorkbook(format: 'xlsx' | 'csv', options?: Record<string, unknown>): Promise<ExchangeJob | undefined> {
  const c = client.value
  if (!c.registerExchange || !head.value) return undefined
  exchangeBusy.value = true
  exchangeError.value = undefined
  try {
    const job = await c.registerExchange(props.node.id, {
      request_key: `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'export',
      format,
      source: {
        generation: head.value.marker.generation,
        position: head.value.marker.position,
        sha256: head.value.marker.sha256,
      },
      ...(options ? { options } : {}),
    })
    exchangeJob.value = job
    if (job.state === 'queued' || job.state === 'running') {
      return await pollExchange(job.exchange_id)
    }
    exchangeBusy.value = false
    emit('exchangeComplete', job)
    return job
  } catch (err) {
    exchangeBusy.value = false
    exchangeError.value = err instanceof Error ? err.message : 'export_failed'
    return undefined
  }
}

async function importWorkbook(params: { format: 'xlsx' | 'csv'; sourceNodeId?: string; file?: File; options?: Record<string, unknown> }): Promise<ExchangeJob | undefined> {
  const c = client.value
  if (!c.registerExchange || !head.value || isReadonly.value) return undefined
  exchangeBusy.value = true
  exchangeError.value = undefined
  try {
    let nodeId = params.sourceNodeId?.trim() || importSourceNodeId.value.trim()
    if (!nodeId && params.file && props.uploadImportFile) {
      const uploaded = await props.uploadImportFile(params.file)
      nodeId = uploaded.id
    }
    if (!nodeId) {
      exchangeBusy.value = false
      exchangeError.value = 'source_node_required'
      return undefined
    }
    const job = await c.registerExchange(props.node.id, {
      request_key: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'import',
      format: params.format,
      source: { node_id: nodeId, expected_generation: head.value.marker.generation },
      ...(params.options ? { options: params.options } : {}),
    })
    exchangeJob.value = job
    if (job.state === 'queued' || job.state === 'running') {
      return await pollExchange(job.exchange_id)
    }
    exchangeBusy.value = false
    emit('exchangeComplete', job)
    if (job.state === 'succeeded') {
      await loadCurrent()
      notifyWorkbookChanged()
    }
    return job
  } catch (err) {
    exchangeBusy.value = false
    exchangeError.value = err instanceof Error ? err.message : 'import_failed'
    return undefined
  }
}

async function onImportFileSelected(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return
  const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx'
  await importWorkbook({ format, file })
  if (input) input.value = ''
}

function formatPeerSelection(peer: WorkbookPresence): string {
  const sel = peer.selection
  if (!sel) return ''
  const col = (n: number) => {
    let c = n
    let s = ''
    while (c > 0) {
      c -= 1
      s = String.fromCharCode(65 + (c % 26)) + s
      c = Math.floor(c / 26)
    }
    return s
  }
  const start = `${col(sel.start_column)}${sel.start_row}`
  const end = `${col(sel.end_column)}${sel.end_row}`
  return start === end ? `${sel.sheet_id}!${start}` : `${sel.sheet_id}!${start}:${end}`
}

defineExpose({
  load,
  save: persist,
  submit: persist,
  refresh,
  workbook: head,
  saving,
  conflict,
  getSelection,
  exportWorkbook,
  importWorkbook,
  exchangeJob,
  exchangeLosses,
  awarenessPeers,
  connectionState,
})
</script>

<template>
  <div class="vaulter-spreadsheet" :data-readonly="isReadonly">
    <div v-if="realtimeEnabled" class="vaulter-spreadsheet__bar" data-realtime-bar>
      <slot name="awareness" :peers="awarenessPeers" :connection="connectionState">
        <span class="vaulter-spreadsheet__status" data-realtime-status>{{ connectionState }}</span>
        <div v-if="awarenessPeers.length > 0" class="vaulter-spreadsheet__awareness" data-awareness-badges>
          <span
            v-for="peer in awarenessPeers"
            :key="peer.client_id"
            class="vaulter-spreadsheet__badge"
            data-awareness-peer
            :style="{ borderColor: peer.user?.color ?? '#2563eb' }"
          >
            <span class="vaulter-spreadsheet__dot" :style="{ backgroundColor: peer.user?.color ?? '#2563eb' }" />
            <span>{{ peer.user?.name ?? peer.client_id }}</span>
            <span v-if="peer.selection" class="vaulter-spreadsheet__peer-range">{{ formatPeerSelection(peer) }}</span>
          </span>
        </div>
      </slot>
    </div>

    <div v-if="loading && !head" role="status"><slot name="loading">Loading workbook…</slot></div>
    <p v-if="error" role="alert"><slot name="error" :error="error">{{ error }}</slot></p>

    <slot
      v-if="head"
      :node="node"
      :workbook="activeWorkbook ?? head.workbook"
      :readonly="isReadonly"
      :submit="persist"
      :saving="saving"
      :conflict="conflict"
      :get-selection="getSelection"
      :export-workbook="exportWorkbook"
      :import-workbook="importWorkbook"
      :exchange-job="exchangeJob"
      :exchange-losses="exchangeLosses"
      :awareness-peers="awarenessPeers"
      :connection-state="connectionState"
    >
      <div ref="element" class="vaulter-spreadsheet__editor" aria-label="Spreadsheet"></div>
      <button v-if="!isReadonly && head.commands.includes('insert_row_before')" type="button" :disabled="!!pending" @click="insertRow">Insert row above</button>
    </slot>

    <div v-if="showExchange && head" class="vaulter-spreadsheet__exchange" data-exchange-panel>
      <slot
        name="exchange"
        :export-workbook="exportWorkbook"
        :import-workbook="importWorkbook"
        :job="exchangeJob"
        :losses="exchangeLosses"
        :busy="exchangeBusy"
        :error="exchangeError"
        :download-url="downloadHref"
      >
        <div class="vaulter-spreadsheet__exchange-actions">
          <button
            v-for="fmt in exportFormats"
            :key="`exp-${fmt}`"
            type="button"
            :data-exchange-export="fmt"
            :disabled="exchangeBusy"
            @click="exportWorkbook(fmt)"
          >
            Export {{ fmt.toUpperCase() }}
          </button>
          <a
            v-if="downloadHref"
            :href="downloadHref"
            download
            data-exchange-download
          >Download {{ exchangeJob?.format?.toUpperCase() }}</a>
          <template v-if="!isReadonly && importFormats.length > 0">
            <input
              v-model="importSourceNodeId"
              type="text"
              placeholder="Source file node ID"
              data-exchange-source-node
            />
            <button
              v-for="fmt in importFormats"
              :key="`imp-${fmt}`"
              type="button"
              :data-exchange-import="fmt"
              :disabled="exchangeBusy || !importSourceNodeId.trim()"
              @click="importWorkbook({ format: fmt })"
            >
              Import {{ fmt.toUpperCase() }}
            </button>
            <input
              v-if="uploadImportFile"
              type="file"
              accept=".xlsx,.csv"
              data-exchange-file
              :disabled="exchangeBusy"
              @change="onImportFileSelected"
            />
          </template>
        </div>
        <p v-if="exchangeError" role="alert" data-exchange-error>{{ exchangeError }}</p>
        <ul v-if="exchangeLosses.length > 0" class="vaulter-spreadsheet__losses" data-exchange-losses>
          <li v-for="(loss, idx) in exchangeLosses" :key="idx">
            {{ loss.scope }} {{ loss.target }} ({{ loss.property }}): {{ loss.status }} — {{ loss.reason }}
          </li>
        </ul>
      </slot>
    </div>

    <span v-if="saving" role="status">Saving…</span>
    <button v-else-if="pending && !conflict" type="button" @click="persist()">Retry save</button>
    <button v-if="conflict" type="button" @click="reload">Load current workbook</button>
  </div>
</template>

<style scoped>
.vaulter-spreadsheet__editor { min-height: 32rem; height: min(70vh, 55rem); }
.vaulter-spreadsheet__bar { display: flex; align-items: center; gap: 0.75rem; padding: 0.25rem 0; font-size: 0.875rem; }
.vaulter-spreadsheet__awareness { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.vaulter-spreadsheet__badge { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.125rem 0.5rem; border: 1px solid; border-radius: 9999px; }
.vaulter-spreadsheet__dot { width: 0.5rem; height: 0.5rem; border-radius: 9999px; }
.vaulter-spreadsheet__peer-range { opacity: 0.75; font-family: monospace; }
.vaulter-spreadsheet__exchange { margin-top: 0.5rem; }
.vaulter-spreadsheet__exchange-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.vaulter-spreadsheet__losses { margin: 0.5rem 0 0; padding-left: 1.25rem; font-size: 0.875rem; }
</style>
