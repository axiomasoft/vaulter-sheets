import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import { CanceledError, CellValueType, CommandType, LocaleType, mergeLocales, RedoCommandId, UndoCommandId, Univer, type IWorkbookData } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { SetRangeValuesCommand, SetRangeValuesMutation, SetWorksheetColumnCountMutation, SetWorksheetRowCountMutation, UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { UniverUIPlugin } from '@univerjs/ui'
import DesignEn from '@univerjs/design/locale/en-US'
import UIEn from '@univerjs/ui/locale/en-US'
import DocsUIEn from '@univerjs/docs-ui/locale/en-US'
import SheetsEn from '@univerjs/sheets/locale/en-US'
import SheetsUIEn from '@univerjs/sheets-ui/locale/en-US'
import FormulaEn from '@univerjs/sheets-formula/locale/en-US'
import FormulaUIEn from '@univerjs/sheets-formula-ui/locale/en-US'
import NumfmtUIEn from '@univerjs/sheets-numfmt-ui/locale/en-US'
import '@univerjs/engine-formula/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-numfmt/facade'
import type { Command, Workbook } from '../api/workbooks'
import { cellCommands, cellContent, clipboardValues } from './cellCommands'

export interface MountedWorkbook {
  accept(snapshot: Workbook): void
  sync?(snapshot: Workbook, isEditable: boolean): boolean
  dispose(): void
  selectedRow(): {sheet_id: string; row: number} | undefined
}

const locale = mergeLocales(DesignEn, UIEn, DocsUIEn, SheetsEn, SheetsUIEn, FormulaEn, FormulaUIEn, NumfmtUIEn)
const editCommands = new Set([SetRangeValuesCommand.id, UndoCommandId, RedoCommandId])

export function mountWorkbook(element: HTMLElement, snapshot: Workbook, editable: () => boolean, changed: (commands: Command[]) => void, unsupported: () => void): MountedWorkbook {
  let currentSnapshot = snapshot
  let native = snapshot.native as unknown as IWorkbookData
  let syncing = false
  const univer = new Univer({
    locale: LocaleType.EN_US,
    locales: {[LocaleType.EN_US]: locale},
  })
  let disposed = false
  try {
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverFormulaEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, {container: element, header: false, toolbar: false, contextMenu: false, headerMenu: false})
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
    const workbook = api.createWorkbook(structuredClone(native))
    workbook.setEditable(editable())
    const guard = workbook.onBeforeCommandExecute(command => {
      if (command.type === CommandType.COMMAND && (!editable() || !editCommands.has(command.id))) {
        throw new CanceledError()
      }
    })
    const changes = api.addEvent(api.Event.SheetValueChanged, ({effectedRanges}) => {
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
        if (commands.length > 0) changed(commands)
      } catch {
        unsupported()
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
          v: value === null ? null : 'number' in value ? value.number : value.text,
          t: value === null ? null : 'number' in value ? CellValueType.NUMBER : CellValueType.STRING,
          f: null, si: null, p: null,
        })))
        sheet.getRange(row, column, cells.length, cells[0].length).setValues(cells)
      } catch {
        unsupported()
      }
    }
    element.addEventListener('paste', paste, {capture: true})
    // Engine recalculation can update only cached formula values; these are never command inputs.
    return {
      accept(accepted) {
        currentSnapshot = accepted
        native = accepted.native as unknown as IWorkbookData
      },
      sync(accepted, isEditable) {
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
            JSON.stringify(prevSheet.rowData ?? {}) !== JSON.stringify(nextSheet.rowData ?? {})
            || JSON.stringify(prevSheet.columnData ?? {}) !== JSON.stringify(nextSheet.columnData ?? {})
            || JSON.stringify(prevSheet.mergeData ?? []) !== JSON.stringify(nextSheet.mergeData ?? [])
          ) {
            return false
          }
        }
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
      },
      selectedRow() {
        const sheet = workbook.getActiveSheet()
        const range = sheet.getSelection()?.getActiveRange()
        return range ? {sheet_id: sheet.getSheetId(), row: range.getRow() + 1} : undefined
      },
      dispose() {
        if (disposed) return
        disposed = true
        element.removeEventListener('paste', paste, {capture: true})
        changes.dispose()
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
