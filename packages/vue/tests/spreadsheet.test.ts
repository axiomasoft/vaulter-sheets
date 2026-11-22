import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Plugin } from 'vue'
import {
  VaulterPlugin,
  createVaulterClient,
  type Node,
  type NodeAbilities,
  type VaulterClient,
} from '@vaulter/vue'
import { SPREADSHEET_VIEWER_KEY, VaulterSpreadsheet } from '../src/index'

const ALL_ABILITIES: NodeAbilities = {
  view: true,
  download: true,
  comment: true,
  edit: true,
  create: true,
  move: true,
  copy: true,
  trash: true,
  restore: true,
  share: true,
  manage: true,
  delete: true,
}

function makeSheetNode(overrides: { id?: string; name?: string; abilities?: Partial<NodeAbilities> } = {}): Node {
  return {
    id: overrides.id ?? '20',
    drive_id: '1',
    parent_id: null,
    kind: 'document',
    name: overrides.name ?? 'Budget',
    mime: 'application/vnd.vaulter.document+json',
    extension: null,
    size_bytes: 0,
    version: 1,
    etag: '"20.0.1"',
    path: '/Budget',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    trashed_at: null,
    abilities: { ...ALL_ABILITIES, ...overrides.abilities },
    presentation: {
      handler: null,
      document_type: 'vaulter/spreadsheet',
      type_available: true,
      viewer: { key: SPREADSHEET_VIEWER_KEY, props: {} },
      capabilities: {
        editable: true,
        previewable: true,
        downloadable: false,
        thumbnailable: false,
        collaborative: false,
      },
    },
  } as Node
}

function content(body: Record<string, unknown>, etag = '"20.0.1"') {
  return {
    type: 'vaulter/spreadsheet',
    schema_version: 1,
    state_version: 1,
    collab_epoch: 0,
    revision_id: null,
    content: body,
    etag,
  }
}

function withPluginClient(documents: { content: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }) {
  const base = createVaulterClient({
    fetch: async () => new Response(null, { status: 204 }),
  })
  const client = {
    ...base,
    documents: {
      ...base.documents,
      ...documents,
    },
  } as unknown as VaulterClient

  return {
    global: {
      plugins: [
        [
          VaulterPlugin as unknown as Plugin,
          {
            client,
            viewers: {
              [SPREADSHEET_VIEWER_KEY]: VaulterSpreadsheet,
            },
          },
        ] as [Plugin, Record<string, unknown>],
      ],
    },
  }
}

describe('VaulterSpreadsheet', () => {
  it('loads on mount and exposes the workbook + a save through the default slot', async () => {
    const loaded = vi.fn().mockResolvedValue(content({ id: 'wb1', name: 'Budget' }))
    const update = vi.fn().mockResolvedValue(content({ id: 'wb1', name: 'Budget' }, '"20.0.2"'))

    const wrapper = mount(VaulterSpreadsheet, {
      props: { node: makeSheetNode() },
      slots: {
        default: `<template #default="{ workbook }"><pre class="wb">{{ JSON.stringify(workbook) }}</pre></template>`,
      },
      ...withPluginClient({ content: loaded, update }),
    })

    await flushPromises()

    expect(loaded).toHaveBeenCalledWith('20')
    expect(wrapper.get('.wb').text()).toContain('Budget')
    expect(wrapper.classes()).toContain('vaulter-spreadsheet')
  })

  it('persists with the ETag of the loaded snapshot', async () => {
    const loaded = vi.fn().mockResolvedValue(content({ id: 'wb1' }, '"20.0.7"'))
    const update = vi.fn().mockResolvedValue(content({ id: 'wb1', rev: 2 }, '"20.0.8"'))
    const wrapper = mount(VaulterSpreadsheet, {
      props: { node: makeSheetNode() },
      ...withPluginClient({ content: loaded, update }),
    })
    await flushPromises()

    ;(wrapper.vm as unknown as { setWorkbook: (w: object) => void }).setWorkbook({ id: 'wb1', rev: 2 })
    await (wrapper.vm as unknown as { save: () => Promise<void> }).save()

    expect(update).toHaveBeenCalledWith('20', { id: 'wb1', rev: 2 }, { etag: '"20.0.7"' })
    expect(wrapper.emitted('save')).toHaveLength(1)
  })

  it('ignores edits when the caller cannot edit the node', async () => {
    const loaded = vi.fn().mockResolvedValue(content({ id: 'wb1' }))
    const wrapper = mount(VaulterSpreadsheet, {
      props: { node: makeSheetNode({ abilities: { edit: false } }) },
      ...withPluginClient({ content: loaded, update: vi.fn() }),
    })
    await flushPromises()

    ;(wrapper.vm as unknown as { setWorkbook: (w: object) => void }).setWorkbook({ id: 'wb1', rev: 9 })

    expect(wrapper.emitted('workbook-changed')).toBeUndefined()
    expect(wrapper.attributes('data-readonly')).toBe('true')
  })

  it('surfaces a load failure in the error slot', async () => {
    const wrapper = mount(VaulterSpreadsheet, {
      props: { node: makeSheetNode() },
      ...withPluginClient({
        content: vi.fn().mockRejectedValue(new Error('boom')),
        update: vi.fn(),
      }),
    })

    await flushPromises()

    expect(wrapper.find('.vaulter-spreadsheet__error').exists()).toBe(true)
  })
})
