import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import {
  CanceledError,
  CellValueType,
  CommandType,
  ICommandService,
  LocaleType,
  mergeLocales,
  RedoCommandId,
  UndoCommandId,
  Univer,
  type IDisposable,
  type IExecutionOptions,
  type IWorkbookData,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import {
  AddWorksheetMergeAllCommand,
  AddWorksheetMergeCommand,
  AddWorksheetMergeHorizontalCommand,
  AddWorksheetMergeMutation,
  AddWorksheetMergeVerticalCommand,
  CancelFrozenCommand,
  ClearSelectionAllCommand,
  ClearSelectionContentCommand,
  ClearSelectionFormatCommand,
  InsertColAfterCommand,
  InsertColBeforeCommand,
  InsertColByRangeCommand,
  InsertColCommand,
  InsertColMutation,
  InsertMultiColsLeftCommand,
  InsertMultiColsRightCommand,
  InsertMultiRowsAboveCommand,
  InsertMultiRowsAfterCommand,
  InsertRowAfterCommand,
  InsertRowBeforeCommand,
  InsertRowByRangeCommand,
  InsertRowCommand,
  InsertRowMutation,
  InsertSheetCommand,
  InsertSheetMutation,
  RemoveColByRangeCommand,
  RemoveColCommand,
  RemoveColMutation,
  RemoveNumfmtMutation,
  RemoveRowByRangeCommand,
  RemoveRowCommand,
  RemoveRowMutation,
  RemoveSheetCommand,
  RemoveSheetMutation,
  RemoveWorksheetMergeCommand,
  RemoveWorksheetMergeMutation,
  ResetBackgroundColorCommand,
  ResetTextColorCommand,
  SetBackgroundColorCommand,
  SetBoldCommand,
  SetBorderBasicCommand,
  SetBorderColorCommand,
  SetBorderCommand,
  SetBorderPositionCommand,
  SetBorderStyleCommand,
  SetFontSizeCommand,
  SetFrozenCommand,
  SetFrozenMutation,
  SetHorizontalTextAlignCommand,
  SetItalicCommand,
  SetNumfmtMutation,
  SetRangeValuesCommand,
  SetRangeValuesMutation,
  SetStyleCommand,
  SetTextColorCommand,
  SetTextWrapCommand,
  SetVerticalTextAlignCommand,
  SetWorksheetActivateCommand,
  SetWorksheetActiveOperation,
  SetWorksheetColumnCountMutation,
  SetWorksheetNameCommand,
  SetWorksheetNameMutation,
  SetWorksheetRowCountMutation,
  UniverSheetsPlugin,
} from '@univerjs/sheets'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import {
  AddDecimalCommand,
  SetCurrencyCommand,
  SetNumfmtCommand,
  SetPercentCommand,
  SubtractDecimalCommand,
  UniverSheetsNumfmtPlugin,
} from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import {
  ChangeZoomRatioCommand,
  ExpandSelectionCommand,
  IEditorBridgeService,
  MoveSelectionCommand,
  MoveSelectionEnterAndTabCommand,
  RemoveColConfirmCommand,
  RemoveRowConfirmCommand,
  RemoveSheetConfirmCommand,
  ResetRangeTextColorCommand,
  ResetScrollCommand,
  ScrollCommand,
  ScrollToCellCommand,
  SelectAllCommand,
  SetColumnFrozenCommand,
  SetFirstColumnFrozenCommand,
  SetFirstRowFrozenCommand,
  SetRangeBoldCommand,
  SetRangeFontSizeCommand,
  SetRangeItalicCommand,
  SetRangeTextColorCommand,
  SetRowFrozenCommand,
  SetSelectionFrozenCommand,
  SetZoomRatioCommand,
  SetZoomRatioOperation,
  SheetCopyCommand,
  SheetCutCommand,
  SheetPasteCommand,
  SheetPasteFormatCommand,
  SheetPasteShortKeyCommand,
  SheetPasteValueCommand,
  ShowMenuListCommand,
  UniverSheetsUIPlugin,
} from '@univerjs/sheets-ui'
import { UniverUIPlugin } from '@univerjs/ui'
import DesignEn from '@univerjs/design/locale/en-US'
import UIEn from '@univerjs/ui/locale/en-US'
import DocsUIEn from '@univerjs/docs-ui/locale/en-US'
import SheetsEn from '@univerjs/sheets/locale/en-US'
import SheetsUIEn from '@univerjs/sheets-ui/locale/en-US'
import FormulaEn from '@univerjs/sheets-formula/locale/en-US'
import FormulaUIEn from '@univerjs/sheets-formula-ui/locale/en-US'
import NumfmtUIEn from '@univerjs/sheets-numfmt-ui/locale/en-US'
import DesignRu from '@univerjs/design/locale/ru-RU'
import UIRu from '@univerjs/ui/locale/ru-RU'
import DocsUIRu from '@univerjs/docs-ui/locale/ru-RU'
import SheetsRu from '@univerjs/sheets/locale/ru-RU'
import SheetsUIRu from '@univerjs/sheets-ui/locale/ru-RU'
import FormulaRu from '@univerjs/sheets-formula/locale/ru-RU'
import FormulaUIRu from '@univerjs/sheets-formula-ui/locale/ru-RU'
import NumfmtUIRu from '@univerjs/sheets-numfmt-ui/locale/ru-RU'
import '@univerjs/engine-formula/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-numfmt/facade'
import type {
  Command,
  Workbook,
  WorkbookLocale,
  WorkbookPresence,
  WorkbookPresenceSelection,
  WorkbookRoomSession,
  WorkbookSelectionPayload,
} from '../api/workbooks'
import {
  cellCommands,
  cellContent,
  clipboardValues,
  numfmtMutationToCommands,
  resolveTableSelection,
  setFormatCommandsFromCellValues,
  structuralMutationToCommands,
} from './cellCommands'

export interface MountedRealtimeOptions {
  session: () => Promise<WorkbookRoomSession>
  user?: WorkbookPresence['user']
  onState?: (workbook: Workbook) => void
  onConnection?: (state: 'connected' | 'reconnecting' | 'closed') => void
  onAwareness?: (peers: readonly WorkbookPresence[]) => void
  onConflict?: (code: string) => void
}

export interface MountWorkbookOptions {
  showToolbar?: boolean
  showContextMenu?: boolean
  showHeader?: boolean
  locale?: WorkbookLocale
  allowedCommands?: () => readonly string[]
  onSelectionChange?: (payload: WorkbookSelectionPayload) => void
  pendingCellKeys?: () => ReadonlySet<string>
  realtime?: MountedRealtimeOptions
}

export interface MountedWorkbook {
  accept(snapshot: Workbook): void
  sync?(snapshot: Workbook, isEditable: boolean): boolean
  dispose(): void
  selectedRow(): {sheet_id: string; row: number} | undefined
  getSelection?(): WorkbookSelectionPayload | undefined
  setPeerSelections?(peers: readonly WorkbookPresence[]): void
}

const enLocale = mergeLocales(DesignEn, UIEn, DocsUIEn, SheetsEn, SheetsUIEn, FormulaEn, FormulaUIEn, NumfmtUIEn)
const ruLocale = mergeLocales(DesignRu, UIRu, DocsUIRu, SheetsRu, SheetsUIRu, FormulaRu, FormulaUIRu, NumfmtUIRu)

const READONLY_COMMANDS = new Set<string>([
  MoveSelectionCommand.id,
  MoveSelectionEnterAndTabCommand.id,
  ExpandSelectionCommand.id,
  SelectAllCommand.id,
  ScrollCommand.id,
  ScrollToCellCommand.id,
  ResetScrollCommand.id,
  ChangeZoomRatioCommand.id,
  SetZoomRatioCommand.id,
  SetZoomRatioOperation.id,
  SheetCopyCommand.id,
  SetWorksheetActivateCommand.id,
  ShowMenuListCommand.id,
])

const EDIT_COMMANDS = new Set<string>([
  SetRangeValuesCommand.id,
  UndoCommandId,
  RedoCommandId,
  ClearSelectionAllCommand.id,
  ClearSelectionContentCommand.id,
  ClearSelectionFormatCommand.id,
  SheetPasteCommand.id,
  SheetPasteShortKeyCommand.id,
  SheetPasteValueCommand.id,
  SheetPasteFormatCommand.id,
  SheetCutCommand.id,
  SetStyleCommand.id,
  SetBoldCommand.id,
  SetRangeBoldCommand.id,
  SetItalicCommand.id,
  SetRangeItalicCommand.id,
  SetFontSizeCommand.id,
  SetRangeFontSizeCommand.id,
  SetTextColorCommand.id,
  SetRangeTextColorCommand.id,
  ResetTextColorCommand.id,
  ResetRangeTextColorCommand.id,
  SetBackgroundColorCommand.id,
  ResetBackgroundColorCommand.id,
  SetHorizontalTextAlignCommand.id,
  SetVerticalTextAlignCommand.id,
  SetTextWrapCommand.id,
  SetBorderCommand.id,
  SetBorderPositionCommand.id,
  SetBorderStyleCommand.id,
  SetBorderColorCommand.id,
  SetBorderBasicCommand.id,
  SetNumfmtCommand.id,
  SetPercentCommand.id,
  SetCurrencyCommand.id,
  AddDecimalCommand.id,
  SubtractDecimalCommand.id,
  InsertRowCommand.id,
  InsertRowBeforeCommand.id,
  InsertRowAfterCommand.id,
  InsertRowByRangeCommand.id,
  InsertMultiRowsAboveCommand.id,
  InsertMultiRowsAfterCommand.id,
  RemoveRowCommand.id,
  RemoveRowConfirmCommand.id,
  RemoveRowByRangeCommand.id,
  InsertColCommand.id,
  InsertColBeforeCommand.id,
  InsertColAfterCommand.id,
  InsertColByRangeCommand.id,
  InsertMultiColsLeftCommand.id,
  InsertMultiColsRightCommand.id,
  RemoveColCommand.id,
  RemoveColConfirmCommand.id,
  RemoveColByRangeCommand.id,
  InsertSheetCommand.id,
  RemoveSheetCommand.id,
  RemoveSheetConfirmCommand.id,
  SetWorksheetNameCommand.id,
  AddWorksheetMergeCommand.id,
  AddWorksheetMergeAllCommand.id,
  AddWorksheetMergeVerticalCommand.id,
  AddWorksheetMergeHorizontalCommand.id,
  RemoveWorksheetMergeCommand.id,
  SetSelectionFrozenCommand.id,
  SetRowFrozenCommand.id,
  SetColumnFrozenCommand.id,
  SetFirstRowFrozenCommand.id,
  SetFirstColumnFrozenCommand.id,
  SetFrozenCommand.id,
  CancelFrozenCommand.id,
])

const SUPPORTED_MUTATIONS = new Set<string>([
  SetRangeValuesMutation.id,
  SetNumfmtMutation.id,
  RemoveNumfmtMutation.id,
  InsertRowMutation.id,
  RemoveRowMutation.id,
  InsertColMutation.id,
  RemoveColMutation.id,
  InsertSheetMutation.id,
  RemoveSheetMutation.id,
  SetWorksheetNameMutation.id,
  SetFrozenMutation.id,
  AddWorksheetMergeMutation.id,
  RemoveWorksheetMergeMutation.id,
])

export function mountWorkbook(
  element: HTMLElement,
  snapshot: Workbook,
  editable: () => boolean,
  changed: (commands: Command[]) => void,
  unsupported: () => void,
  options: MountWorkbookOptions = {},
): MountedWorkbook {
  let currentSnapshot = snapshot
  let native = snapshot.native as unknown as IWorkbookData
  let syncing = false
  const univer = new Univer({
    locale: options.locale === 'ruRU' ? LocaleType.RU_RU : LocaleType.EN_US,
    locales: {
      [LocaleType.EN_US]: enLocale,
      [LocaleType.RU_RU]: ruLocale,
    },
  })
  let disposed = false
  let highlightDisposables: IDisposable[] = []
  let realtimeBinding: {
    updateAwareness(presence: {user?: WorkbookPresence['user']; selection?: WorkbookPresenceSelection | null}): void
    dispose(): void
  } | undefined

  try {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverFormulaEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, {
      container: element,
      header: options.showHeader ?? false,
      toolbar: options.showToolbar ?? true,
      contextMenu: options.showContextMenu ?? true,
      headerMenu: options.showHeader ?? false,
    })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverSheetsPlugin)
    univer.registerPlugin(UniverSheetsUIPlugin)
    univer.registerPlugin(UniverSheetsFormulaPlugin, {initialFormulaComputing: CalculationMode.FORCED})
    univer.registerPlugin(UniverSheetsFormulaUIPlugin)
    univer.registerPlugin(UniverSheetsNumfmtPlugin)
    univer.registerPlugin(UniverSheetsNumfmtUIPlugin)
    const resources = new Set(native.resources?.filter(({data}) => data && data !== '{}').map(({name}) => name))
    if (resources.has('SHEET_CONDITIONAL_FORMATTING_PLUGIN')) univer.registerPlugin(UniverSheetsConditionalFormattingPlugin)
    if (resources.has('SHEET_DATA_VALIDATION_PLUGIN')) univer.registerPlugin(UniverSheetsDataValidationPlugin)
    if (resources.has('SHEET_FILTER_PLUGIN')) univer.registerPlugin(UniverSheetsFilterPlugin)
    if (resources.has('SHEET_HYPER_LINK_PLUGIN')) univer.registerPlugin(UniverSheetsHyperLinkPlugin)

    const api = FUniver.newAPI(univer)
    let workbook = api.createWorkbook(structuredClone(native))
    workbook.setEditable(editable())

    const injector = univer.__getInjector()
    const commandService = injector.get(ICommandService)

    const guard = commandService.beforeCommandExecuted((command, flags?: IExecutionOptions) => {
      const params = command.params as {unitId?: string} | undefined
      if (params?.unitId && params.unitId !== workbook.getId()) return
      if (command.type === CommandType.OPERATION) return
      if (command.type === CommandType.MUTATION) {
        if (flags?.fromCollab || flags?.onlyLocal) return
        if (!editable() || !SUPPORTED_MUTATIONS.has(command.id)) {
          throw new CanceledError()
        }
        return
      }
      if (command.type === CommandType.COMMAND) {
        if (READONLY_COMMANDS.has(command.id)) return
        if (!editable() || !EDIT_COMMANDS.has(command.id)) {
          throw new CanceledError()
        }
      }
    })

    let pendingBatch: Command[] = []
    let batchScheduled = false
    const enqueueCommands = (commands: Command[]) => {
      if (commands.length === 0) return
      const allowed = options.allowedCommands?.()
      if (allowed && commands.some(cmd => !allowed.includes(cmd.kind))) {
        unsupported()
        return
      }
      pendingBatch.push(...commands)
      if (!batchScheduled) {
        batchScheduled = true
        queueMicrotask(() => {
          batchScheduled = false
          if (disposed || pendingBatch.length === 0) {
            pendingBatch = []
            return
          }
          const batch = pendingBatch
          pendingBatch = []
          changed(batch)
        })
      }
    }

    const mutationListener = !options.realtime ? commandService.onCommandExecuted((command, flags?: IExecutionOptions) => {
      if (syncing || !editable() || flags?.fromCollab || flags?.onlyLocal || command.type !== CommandType.MUTATION) return
      const params = command.params as Record<string, unknown> | undefined
      if (!params || params.unitId !== workbook.getId()) return

      if (command.id === SetRangeValuesMutation.id && params.cellValue && typeof params.cellValue === 'object' && typeof params.subUnitId === 'string') {
        const sheetId = params.subUnitId
        const wbStyles = workbook.getWorkbook().getStyles()
        const resolveStyle = (s: unknown): Record<string, unknown> | null => {
          if (typeof s === 'string') return (wbStyles.get(s) as Record<string, unknown> | undefined) ?? (native.styles?.[s] as Record<string, unknown> | undefined) ?? null
          if (s && typeof s === 'object') return s as Record<string, unknown>
          return null
        }
        const prevCellData = native.sheets?.[sheetId]?.cellData as Record<string, Record<string, unknown>> | undefined
        const styleCmds = setFormatCommandsFromCellValues(
          sheetId,
          params.cellValue as Record<string, Record<string, unknown>>,
          resolveStyle,
          prevCellData,
          Boolean(params.isOverrideStyle),
        )
        enqueueCommands(styleCmds)
        return
      }
      if (command.id === SetNumfmtMutation.id || command.id === RemoveNumfmtMutation.id) {
        enqueueCommands(numfmtMutationToCommands(command.id, params))
        return
      }
      enqueueCommands(structuralMutationToCommands(command.id, params))
    }) : undefined

    const changes = !options.realtime ? api.addEvent(api.Event.SheetValueChanged, ({effectedRanges}) => {
      if (syncing || !editable()) return
      try {
        const commands = effectedRanges.flatMap(range => {
          const sheet = range.getSheetId()
          const row = range.getRow()
          const column = range.getColumn()
          const after = range.getCellDataGrid().map(items => items.map(cell => cellContent(cell || null)))
          const before = after.map((items, r) => items.map((_, c) => cellContent(native.sheets[sheet]?.cellData?.[row + r]?.[column + c])))
          return cellCommands(sheet, row, column, before, after)
        })
        enqueueCommands(commands)
      } catch {
        unsupported()
      }
    }) : undefined

    const getSelectionPayload = (): WorkbookSelectionPayload | undefined => {
      const sheet = workbook.getActiveSheet()
      if (!sheet) return undefined
      const sel = sheet.getSelection()
      const activeRange = sel?.getActiveRange()
      const rangeList = sel?.getActiveRangeList() ?? (activeRange ? [activeRange] : [])
      const rawRanges = rangeList.map(r => ({
        startRow: r.getRow(),
        startColumn: r.getColumn(),
        endRow: r.getRow() + r.getHeight() - 1,
        endColumn: r.getColumn() + r.getWidth() - 1,
      }))
      return resolveTableSelection(currentSnapshot.tables ?? [], sheet.getSheetId(), rawRanges)
    }

    const emitSelection = () => {
      const payload = getSelectionPayload()
      if (!payload) return
      options.onSelectionChange?.(payload)
      if (realtimeBinding && options.realtime) {
        realtimeBinding.updateAwareness({
          user: options.realtime.user,
          selection: payload.range ? {
            sheet_id: payload.range.sheet_id,
            start_row: payload.range.start_row,
            start_column: payload.range.start_column,
            end_row: payload.range.end_row,
            end_column: payload.range.end_column,
          } : null,
        })
      }
    }

    const selectionListener = api.addEvent(api.Event.SelectionChanged, () => emitSelection())
    const sheetSwitchListener = commandService.onCommandExecuted(command => {
      if (command.id === SetWorksheetActiveOperation.id && (command.params as {unitId?: string} | undefined)?.unitId === workbook.getId()) {
        emitSelection()
      }
    })

    const paste = (event: ClipboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return
      const text = event.clipboardData?.getData('text/plain')
      if (!text) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!editable()) return
      const sheet = workbook.getActiveSheet()
      const selection = sheet.getSelection()?.getActiveRange()
      if (!selection) return
      const row = selection.getRow()
      const column = selection.getColumn()
      try {
        const values = clipboardValues(text)
        const cells = values.map(items => items.map(value => ({
          v: value === null ? null : 'number' in value ? value.number : 'boolean' in value ? (value.boolean ? 1 : 0) : value.text,
          t: value === null ? null : 'number' in value ? CellValueType.NUMBER : 'boolean' in value ? CellValueType.BOOLEAN : CellValueType.STRING,
          f: null, si: null, p: null,
        })))
        sheet.getRange(row, column, cells.length, cells[0].length).setValues(cells)
      } catch {
        unsupported()
      }
    }
    element.addEventListener('paste', paste, {capture: true})

    const syncSnapshot = (accepted: Workbook, isEditable: boolean): boolean => {
      const nextNative = accepted.native as unknown as IWorkbookData
      if (
        accepted.format_version !== currentSnapshot.format_version
        || accepted.profile.id !== currentSnapshot.profile.id
        || nextNative.id !== native.id
        || JSON.stringify(nextNative.sheetOrder ?? []) !== JSON.stringify(native.sheetOrder ?? [])
        || JSON.stringify(nextNative.resources ?? []) !== JSON.stringify(native.resources ?? [])
      ) {
        return false
      }
      for (const sheetId of nextNative.sheetOrder ?? []) {
        const prevSheet = native.sheets?.[sheetId]
        const nextSheet = nextNative.sheets?.[sheetId]
        if (!prevSheet || !nextSheet || !workbook.getSheetBySheetId(sheetId)) return false
        if (
          prevSheet.name !== nextSheet.name
          || JSON.stringify(prevSheet.freeze ?? {}) !== JSON.stringify(nextSheet.freeze ?? {})
          || JSON.stringify(prevSheet.rowData ?? {}) !== JSON.stringify(nextSheet.rowData ?? {})
          || JSON.stringify(prevSheet.columnData ?? {}) !== JSON.stringify(nextSheet.columnData ?? {})
          || JSON.stringify(prevSheet.mergeData ?? []) !== JSON.stringify(nextSheet.mergeData ?? [])
        ) {
          return false
        }
      }
      const skipKeys = options.pendingCellKeys?.()
      syncing = true
      try {
        const addedStyles: Record<string, NonNullable<IWorkbookData['styles'][string]>> = {}
        for (const [key, style] of Object.entries(nextNative.styles ?? {})) {
          if (style && JSON.stringify(native.styles?.[key]) !== JSON.stringify(style)) {
            addedStyles[key] = style
          }
        }
        if (Object.keys(addedStyles).length > 0) workbook.addStyles(addedStyles)

        const flags = {fromCollab: true, onlyLocal: true}
        const unitId = workbook.getId()
        for (const sheetId of nextNative.sheetOrder ?? []) {
          const prevSheet = native.sheets[sheetId]
          const nextSheet = nextNative.sheets[sheetId]
          if (typeof nextSheet.rowCount === 'number' && nextSheet.rowCount !== prevSheet.rowCount) {
            api.syncExecuteCommand(SetWorksheetRowCountMutation.id, {unitId, subUnitId: sheetId, rowCount: nextSheet.rowCount}, flags)
          }
          if (typeof nextSheet.columnCount === 'number' && nextSheet.columnCount !== prevSheet.columnCount) {
            api.syncExecuteCommand(SetWorksheetColumnCountMutation.id, {unitId, subUnitId: sheetId, columnCount: nextSheet.columnCount}, flags)
          }
          const prevCells = (prevSheet.cellData ?? {}) as Record<string, Record<string, unknown>>
          const nextCells = (nextSheet.cellData ?? {}) as Record<string, Record<string, unknown>>
          const cellValue: Record<number, Record<number, object | null>> = {}
          for (const [rKey, rowObj] of Object.entries(nextCells)) {
            const r = Number(rKey)
            for (const [cKey, nextCell] of Object.entries(rowObj ?? {})) {
              if (skipKeys?.has(`${sheetId}\0${r}\0${Number(cKey)}`)) continue
              if (JSON.stringify(prevCells[rKey]?.[cKey]) !== JSON.stringify(nextCell)) {
                (cellValue[r] ??= {})[Number(cKey)] = {
                  p: null, s: null, v: null, t: null, f: null, si: null, custom: null,
                  ...(nextCell as Record<string, unknown>),
                }
              }
            }
          }
          for (const [rKey, rowObj] of Object.entries(prevCells)) {
            const r = Number(rKey)
            for (const cKey of Object.keys(rowObj ?? {})) {
              if (skipKeys?.has(`${sheetId}\0${r}\0${Number(cKey)}`)) continue
              if (!nextCells[rKey] || !(cKey in nextCells[rKey])) {
                (cellValue[r] ??= {})[Number(cKey)] = null
              }
            }
          }
          if (Object.keys(cellValue).length > 0) {
            api.syncExecuteCommand(SetRangeValuesMutation.id, {unitId, subUnitId: sheetId, cellValue, isOverrideStyle: true}, flags)
          }
        }
        workbook.setEditable(isEditable)
        currentSnapshot = accepted
        native = nextNative
        return true
      } finally {
        syncing = false
      }
    }

    if (options.realtime) {
      const rt = options.realtime
      void import('@vaulter/sheets-realtime/native-adapter').then(({connectNativeWorkbook}) => {
        if (disposed) return
        const editorBridge = injector.get(IEditorBridgeService)
        realtimeBinding = connectNativeWorkbook({
          get unitId() { return workbook.getId() },
          commands: commandService,
          editor: editorBridge,
          readCell(sheetId, row0, col0) {
            const sheet = workbook.getSheetBySheetId(sheetId)
            const cell = sheet?.getRange(row0, col0)?.getCellData()
            return cellContent(cell ?? null)
          },
          replace(nextWorkbook) {
            const nextWb = nextWorkbook as unknown as Workbook
            if (!syncSnapshot(nextWb, editable())) {
              syncing = true
              try {
                api.disposeUnit(workbook.getId())
                workbook.dispose()
                currentSnapshot = nextWb
                native = nextWb.native as unknown as IWorkbookData
                workbook = api.createWorkbook(structuredClone(native))
                workbook.setEditable(editable())
              } finally {
                syncing = false
              }
            }
            rt.onState?.(nextWb)
          },
          onDraftConflict: () => rt.onConflict?.('draft_conflict'),
          onUnsupportedMutation: () => unsupported(),
        }, {
          session: rt.session,
          onConnection: rt.onConnection,
          onAwareness: rt.onAwareness,
          onConflict: (_intent, code) => rt.onConflict?.(code),
        })
        if (rt.user) realtimeBinding.updateAwareness({user: rt.user, selection: null})
      })
    }

    // Engine recalculation can update only cached formula values; these are never command inputs.
    return {
      accept(accepted) {
        currentSnapshot = accepted
        native = accepted.native as unknown as IWorkbookData
      },
      sync(accepted, isEditable) {
        return syncSnapshot(accepted, isEditable)
      },
      selectedRow() {
        const sheet = workbook.getActiveSheet()
        const range = sheet.getSelection()?.getActiveRange()
        return range ? {sheet_id: sheet.getSheetId(), row: range.getRow() + 1} : undefined
      },
      getSelection() {
        return getSelectionPayload()
      },
      setPeerSelections(peers) {
        for (const d of highlightDisposables) d.dispose()
        highlightDisposables = []
        const activeSheet = workbook.getActiveSheet()
        if (!activeSheet) return
        const activeSheetId = activeSheet.getSheetId()
        for (const peer of peers) {
          const sel = peer.selection
          if (!sel || sel.sheet_id !== activeSheetId) continue
          try {
            const range = activeSheet.getRange(
              sel.start_row - 1,
              sel.start_column - 1,
              sel.end_row - sel.start_row + 1,
              sel.end_column - sel.start_column + 1,
            )
            const color = peer.user?.color ?? '#2563eb'
            highlightDisposables.push(range.highlight({stroke: color, fill: `${color}20`}))
          } catch {
            // Ignore out-of-bounds remote selection during concurrent structural edits.
          }
        }
      },
      dispose() {
        if (disposed) return
        disposed = true
        for (const d of highlightDisposables) d.dispose()
        highlightDisposables = []
        realtimeBinding?.dispose()
        element.removeEventListener('paste', paste, {capture: true})
        selectionListener.dispose()
        sheetSwitchListener.dispose()
        mutationListener?.dispose()
        changes?.dispose()
        guard.dispose()
        try {
          api.disposeUnit(workbook.getId())
          workbook.dispose()
        } finally {
          univer.dispose()
        }
      },
    }
  } catch (error) {
    univer.dispose()
    throw error
  }
}
