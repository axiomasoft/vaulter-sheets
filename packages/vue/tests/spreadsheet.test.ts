import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import type { Node, NodeAbilities } from '@vaulter/vue'
import { SPREADSHEET_VIEWER_KEY, VaulterSpreadsheet, type OpenedWorkbook, type WorkbooksClient } from '../src/index'
import { cellCommands, clipboardValues } from '../src/editor/cellCommands'
import { mountWorkbook } from '../src/editor/mountWorkbook'

vi.mock('../src/editor/mountWorkbook', () => ({mountWorkbook: vi.fn()}))

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

const snapshot: OpenedWorkbook = {
  workbook: {format_version: 2, profile: {id: 'univer-oss-basic-1', engine: '@univerjs/core@1.5.2', plugins: []}, native: {id: 'budget'}, tables: []},
  marker: {generation: 0, position: 1, sha256: 'a'.repeat(64)},
  etag: '"20.0.1"',
  commands: ['set_number', 'set_text', 'set_formula', 'set_values'],
}
const command = {kind: 'set_number' as const, sheet_id: 'detail', row: 3, column: 3, expected: {number: 5}, value: 7}
const receipt = {state: 'committed' as const, command_id: 'fixture', receipt_id: 'r1', marker: snapshot.marker, etag: '"20.0.2"'}

function client(): WorkbooksClient & {
  open: ReturnType<typeof vi.fn<WorkbooksClient['open']>>;
  submit: ReturnType<typeof vi.fn<WorkbooksClient['submit']>>;
  status: ReturnType<typeof vi.fn<WorkbooksClient['status']>>;
} {
  return {
    open: vi.fn<WorkbooksClient['open']>().mockResolvedValue(snapshot),
    submit: vi.fn<WorkbooksClient['submit']>().mockResolvedValue(receipt),
    status: vi.fn<WorkbooksClient['status']>().mockResolvedValue(receipt),
  }
}

function view(workbookClient = client(), node = makeSheetNode()) {
  return mount(VaulterSpreadsheet, {
    props: {node, workbookClient},
    slots: {default: ({workbook, submit, readonly}) => h('button', {
      'data-readonly': readonly, onClick: () => submit([command]),
    }, String(workbook.native.id))},
  })
}

describe('VaulterSpreadsheet', () => {
  it('opens the authoritative workbook and exposes the slot snapshot', async () => {
    const workbooks = client()
    const wrapper = view(workbooks)
    await flushPromises()
    expect(workbooks.open).toHaveBeenCalledWith('20')
    expect(wrapper.get('button').text()).toBe('budget')
    wrapper.unmount()
  })

  it('sends a command using the observed generation and ETag, then refreshes from the owner', async () => {
    const workbooks = client()
    const wrapper = view(workbooks)
    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(workbooks.submit).toHaveBeenCalledWith('20', {
      command_id: expect.any(String), expected_generation: 0, policy: 'rebase_cells', commands: [command],
    }, '"20.0.1"')
    expect(workbooks.open).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('save')).toEqual([[receipt]])
    wrapper.unmount()
  })

  it('keeps the editor mounted for an acknowledged local edit and remounts for a newer owner head', async () => {
    const workbooks = client()
    const accepted = {...snapshot, etag: '"20.0.2"', marker: {...snapshot.marker, position: 2, sha256: 'b'.repeat(64)}}
    const newer = {...accepted, etag: '"20.0.4"', marker: {...accepted.marker, position: 4, sha256: 'd'.repeat(64)}}
    workbooks.open.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(accepted).mockResolvedValueOnce(newer)
    workbooks.submit
      .mockResolvedValueOnce({...receipt, marker: accepted.marker})
      .mockResolvedValueOnce({...receipt, etag: '"20.0.3"', marker: {...accepted.marker, position: 3, sha256: 'c'.repeat(64)}})

    const renderer = {dispose: vi.fn(), accept: vi.fn(), selectedRow: vi.fn()}
    const mountEditor = vi.mocked(mountWorkbook).mockClear().mockReturnValue(renderer)
    const wrapper = mount(VaulterSpreadsheet, {props: {node: makeSheetNode(), workbookClient: workbooks}})
    await flushPromises()
    const changed = mountEditor.mock.calls[0][3]
    changed([command])
    await flushPromises()

    expect(mountEditor).toHaveBeenCalledTimes(1)
    expect(renderer.dispose).not.toHaveBeenCalled()
    expect(renderer.accept).toHaveBeenCalledWith(accepted.workbook)

    changed([{...command, expected: {number: 7}, value: 8}])
    await flushPromises()
    expect(workbooks.submit).toHaveBeenLastCalledWith('20', expect.anything(), accepted.etag)
    expect(mountEditor).toHaveBeenCalledTimes(2)
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('ignores edits when the node is read-only', async () => {
    const workbooks = client()
    const wrapper = view(workbooks, makeSheetNode({abilities: {edit: false}}))
    await flushPromises()
    await wrapper.get('button').trigger('click')
    expect(workbooks.submit).not.toHaveBeenCalled()
    expect(wrapper.get('button').attributes('data-readonly')).toBe('true')
    wrapper.unmount()
  })

  it('surfaces a load failure in the error slot', async () => {
    const workbooks = client()
    workbooks.open.mockRejectedValue(new Error('offline'))
    const wrapper = mount(VaulterSpreadsheet, {
      props: {node: makeSheetNode(), workbookClient: workbooks},
      slots: {error: ({error}) => h('strong', error)},
    })
    await flushPromises()
    expect(wrapper.get('[role=alert] strong').text()).toBe('Could not open the workbook.')
    wrapper.unmount()
  })

  it('recovers the original command receipt after a lost response', async () => {
    const workbooks = client()
    workbooks.submit.mockRejectedValue(new Error('disconnected'))
    const wrapper = view(workbooks)
    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(workbooks.status).toHaveBeenCalledWith('20', workbooks.submit.mock.calls[0][1].command_id)
    expect(wrapper.emitted('save')).toEqual([[receipt]])
    wrapper.unmount()
  })

  it('normalizes one-based coordinates and rejects mixed formula batches', () => {
    expect(cellCommands('detail', 2, 2, [[{number: 5}]], [[{number: 7}]])).toEqual([command])
    expect(() => cellCommands('detail', 2, 2, [[null, null]], [[{formula: '=1+1'}, {number: 7}]])).toThrow('batch of literals')
    expect(clipboardValues('7\t=1+1\r\n\tlabel\r\n')).toEqual([[{number: 7}, {text: '=1+1'}], [null, {text: 'label'}]])
    expect(() => clipboardValues('7\t8\n9')).toThrow('must be a rectangle')
  })
})
