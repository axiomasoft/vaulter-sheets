import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import type { Node, NodeAbilities } from '@vaulter/vue'
import { SPREADSHEET_VIEWER_KEY, VaulterSpreadsheet, type ExchangeJob, type OpenedWorkbook, type WorkbooksClient } from '../src/index'
import {
  cellCommands,
  clipboardValues,
  htmlClipboardValues,
  numfmtMutationToCommands,
  resolveTableSelection,
  setFormatCommandsFromCellValues,
  structuralMutationToCommands,
  styleToFormatSpec,
} from '../src/editor/cellCommands'
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

  it('sends a command using the observed generation and ETag, and skips reload on contiguous marker', async () => {
    const workbooks = client()
    const contiguous = {...receipt, marker: {...snapshot.marker, position: 2, sha256: 'b'.repeat(64)}}
    workbooks.submit.mockResolvedValueOnce(contiguous)
    const wrapper = view(workbooks)
    await flushPromises()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(workbooks.submit).toHaveBeenCalledWith('20', {
      command_id: expect.any(String), expected_generation: 0, policy: 'rebase_cells', commands: [command],
    }, '"20.0.1"')
    expect(workbooks.open).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('save')).toEqual([[contiguous]])
    wrapper.unmount()
  })

  it('keeps the editor mounted for local and compatible remote updates, and remounts on format change', async () => {
    const workbooks = client()
    const accepted = {...snapshot, etag: '"20.0.2"', marker: {...snapshot.marker, position: 2, sha256: 'b'.repeat(64)}}
    const newer = {...accepted, etag: '"20.0.4"', marker: {...accepted.marker, position: 4, sha256: 'd'.repeat(64)}}
    const incompatible = {
      ...newer,
      etag: '"20.1.5"',
      marker: {generation: 1, position: 5, sha256: 'e'.repeat(64)},
      workbook: {...newer.workbook, profile: {...newer.workbook.profile, id: 'univer-oss-v2'}},
    }
    workbooks.open.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(newer).mockResolvedValueOnce(incompatible)
    workbooks.submit
      .mockResolvedValueOnce({...receipt, etag: accepted.etag, marker: accepted.marker})
      .mockResolvedValueOnce({...receipt, etag: '"20.0.4"', marker: newer.marker})
      .mockResolvedValueOnce({...receipt, etag: '"20.1.5"', marker: incompatible.marker})

    const renderer = {dispose: vi.fn(), accept: vi.fn(), sync: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false), selectedRow: vi.fn()}
    const mountEditor = vi.mocked(mountWorkbook).mockClear().mockReturnValue(renderer)
    const wrapper = mount(VaulterSpreadsheet, {props: {node: makeSheetNode(), workbookClient: workbooks}})
    await flushPromises()
    const changed = mountEditor.mock.calls[0][3]
    changed([command])
    await flushPromises()

    expect(mountEditor).toHaveBeenCalledTimes(1)
    expect(workbooks.open).toHaveBeenCalledTimes(1)
    expect(renderer.dispose).not.toHaveBeenCalled()
    expect(renderer.accept).toHaveBeenCalledWith(expect.objectContaining({format_version: 2}))

    changed([{...command, expected: {number: 7}, value: 8}])
    await flushPromises()
    expect(workbooks.submit).toHaveBeenLastCalledWith('20', expect.anything(), accepted.etag)
    expect(workbooks.open).toHaveBeenCalledTimes(2)
    expect(renderer.sync).toHaveBeenCalledWith(newer.workbook, true)
    expect(mountEditor).toHaveBeenCalledTimes(1)
    expect(renderer.dispose).not.toHaveBeenCalled()

    changed([{...command, expected: {number: 8}, value: 9}])
    await flushPromises()
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

  it('forwards UI configuration props (showToolbar, showContextMenu, showHeader, locale) to mountWorkbook', async () => {
    const workbooks = client()
    const renderer = {dispose: vi.fn(), accept: vi.fn(), sync: vi.fn().mockReturnValue(true), selectedRow: vi.fn()}
    const mountEditor = vi.mocked(mountWorkbook).mockClear().mockReturnValue(renderer)
    const wrapper = mount(VaulterSpreadsheet, {
      props: {
        node: makeSheetNode(),
        workbookClient: workbooks,
        showToolbar: false,
        showContextMenu: false,
        showHeader: true,
        locale: 'ruRU',
      },
    })
    await flushPromises()
    expect(mountEditor).toHaveBeenCalledTimes(1)
    expect(mountEditor.mock.calls[0][5]).toMatchObject({
      showToolbar: false,
      showContextMenu: false,
      showHeader: true,
      locale: 'ruRU',
    })
    wrapper.unmount()
  })

  it('translates format, numfmt, structural, merge, freeze mutations and resolves table row_ids', () => {
    expect(styleToFormatSpec({bl: 1, bg: {rgb: '#ff0'}, ht: 2})).toEqual({
      font: {bold: true},
      fill: '#ffff00',
      alignment: {horizontal: 'center'},
    })
    expect(setFormatCommandsFromCellValues('detail', {
      1: {1: {s: {bl: 1}}, 2: {s: {bl: 1}}},
      2: {1: {s: {bl: 1}}, 2: {s: {bl: 1}}},
    }, s => s as Record<string, unknown>)).toEqual([{
      kind: 'set_format',
      sheet_id: 'detail',
      start_row: 2,
      start_column: 2,
      end_row: 3,
      end_column: 3,
      format: {font: {bold: true}},
    }])
    expect(numfmtMutationToCommands('sheet.mutation.set.numfmt', {
      subUnitId: 'detail',
      values: {k1: {ranges: [{startRow: 1, startColumn: 2, endRow: 1, endColumn: 2}]}},
      refMap: {k1: {pattern: '0.00%'}},
    })).toEqual([{
      kind: 'set_format',
      sheet_id: 'detail',
      start_row: 2,
      start_column: 3,
      end_row: 2,
      end_column: 3,
      format: {numFmt: '0.00%'},
    }])
    expect(structuralMutationToCommands('sheet.mutation.set-frozen', {
      subUnitId: 'detail', ySplit: 1, xSplit: 2,
    })).toEqual([{kind: 'set_freeze', sheet_id: 'detail', row_count: 1, column_count: 2}])
    expect(structuralMutationToCommands('sheet.mutation.add-worksheet-merge', {
      subUnitId: 'detail', ranges: [{startRow: 0, startColumn: 0, endRow: 1, endColumn: 2}],
    })).toEqual([{kind: 'merge_cells', sheet_id: 'detail', start_row: 1, start_column: 1, end_row: 2, end_column: 3}])

    const sel = resolveTableSelection([{
      table_id: 'items',
      sheet_id: 'detail',
      header_row: 1,
      columns: [{column_id: 'price', column: 3}, {column_id: 'sum', column: 4}],
      rows: [{row_id: 'apples', row: 2}, {row_id: 'pears', row: 3}],
    }], 'detail', [{startRow: 1, startColumn: 3, endRow: 2, endColumn: 3}])
    expect(sel.range?.a1).toBe('D2:D3')
    expect(sel.sheet_table).toEqual({table_id: 'items', row_ids: ['apples', 'pears'], column_ids: ['sum']})
  })

  it('emits selectionChange with sheet_table.row_ids and exposes getSelection', async () => {
    const workbooks = client()
    const payload = {
      sheet_id: 'detail',
      range: {sheet_id: 'detail', start_row: 2, start_column: 4, end_row: 3, end_column: 4, a1: 'D2:D3'},
      ranges: [{sheet_id: 'detail', start_row: 2, start_column: 4, end_row: 3, end_column: 4, a1: 'D2:D3'}],
      sheet_table: {table_id: 'items', row_ids: ['apples', 'pears'], column_ids: ['sum']},
    }
    const renderer = {dispose: vi.fn(), accept: vi.fn(), sync: vi.fn().mockReturnValue(true), selectedRow: vi.fn(), getSelection: vi.fn().mockReturnValue(payload)}
    const mountEditor = vi.mocked(mountWorkbook).mockClear().mockReturnValue(renderer)
    const wrapper = mount(VaulterSpreadsheet, {props: {node: makeSheetNode(), workbookClient: workbooks}})
    await flushPromises()
    mountEditor.mock.calls[0][5]?.onSelectionChange?.(payload)
    expect(wrapper.emitted('selectionChange')).toEqual([[payload]])
    expect(wrapper.vm.getSelection()).toEqual(payload)
    wrapper.unmount()
  })

  it('renders realtime awareness badges when realtime is enabled', async () => {
    const workbooks = client()
    const renderer = {dispose: vi.fn(), accept: vi.fn(), sync: vi.fn().mockReturnValue(true), selectedRow: vi.fn(), setPeerSelections: vi.fn()}
    const mountEditor = vi.mocked(mountWorkbook).mockClear().mockReturnValue(renderer)
    const wrapper = mount(VaulterSpreadsheet, {
      props: {
        node: makeSheetNode(),
        workbookClient: workbooks,
        realtime: {enabled: true, session: async () => ({endpoint: 'ws://localhost/v1/rooms/1', token: 't', generation: 0, mode: 'write'})},
      },
    })
    await flushPromises()
    const rt = mountEditor.mock.calls[0][5]?.realtime
    rt?.onConnection?.('connected')
    rt?.onAwareness?.([{
      client_id: 'peer-2',
      user: {name: 'Bob', color: '#16a34a'},
      selection: {sheet_id: 'detail', start_row: 2, start_column: 3, end_row: 2, end_column: 3},
      updated_at: 1,
    }])
    await flushPromises()
    expect(wrapper.get('[data-realtime-status]').text()).toBe('connected')
    expect(wrapper.get('[data-awareness-peer]').text()).toContain('Bob')
    expect(wrapper.get('[data-awareness-peer]').text()).toContain('detail!C2')
    expect(renderer.setPeerSelections).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('runs /exchanges export and displays losses[] in the exchange panel', async () => {
    const job: ExchangeJob = {
      exchange_id: 'ex-1',
      request_key: 'rk-1',
      kind: 'export',
      format: 'xlsx',
      state: 'succeeded',
      generation: 0,
      source_position: 1,
      result_receipt_id: null,
      output_blob_id: 'b1',
      source_blob_id: 'b0',
      options: {},
      error_code: null,
      report: {
        format: 'xlsx',
        operation: 'export',
        source_sha256: 'a'.repeat(64),
        output_sha256: 'b'.repeat(64),
        sheets: [],
        defined_names: {preserved: 0, lost: 0},
        losses: [{scope: 'sheet', target: 'detail', property: 'sparkline', status: 'lost', reason: 'unsupported'}],
        diagnostics: [],
        unknown_parts: [],
        editable_published: true,
      },
    }
    const workbooks: WorkbooksClient = {
      ...client(),
      open: vi.fn<WorkbooksClient['open']>().mockResolvedValue({
        ...snapshot,
        exchange: {formats: ['csv', 'xlsx'], import: ['csv', 'xlsx'], export: ['csv', 'xlsx']},
      }),
      registerExchange: vi.fn().mockResolvedValue(job),
      exchangeDownloadUrl: (_node, id) => `/api/vaulter-sheets/v1/workbooks/20/exchanges/${id}/download`,
    }
    const wrapper = mount(VaulterSpreadsheet, {
      props: {node: makeSheetNode(), workbookClient: workbooks, showExchange: true},
    })
    await flushPromises()
    await wrapper.get('[data-exchange-export="xlsx"]').trigger('click')
    await flushPromises()
    expect(workbooks.registerExchange).toHaveBeenCalledWith('20', expect.objectContaining({kind: 'export', format: 'xlsx'}))
    expect(wrapper.get('[data-exchange-download]').attributes('href')).toBe('/api/vaulter-sheets/v1/workbooks/20/exchanges/ex-1/download')
    expect(wrapper.get('[data-exchange-losses]').text()).toContain('sparkline')
    expect(wrapper.emitted('exchangeComplete')?.[0]).toEqual([job])
    wrapper.unmount()
  })

  it('parses html table clipboard payloads', () => {
    expect(htmlClipboardValues('<table><tr><td>12</td><td>Oranges</td></tr><tr><td>15</td><td></td></tr></table>')).toEqual([
      [{ number: 12 }, { text: 'Oranges' }],
      [{ number: 15 }, null],
    ])
    expect(htmlClipboardValues('<p>plain</p>')).toBeNull()
  })
})
