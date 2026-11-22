import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import { CanceledError, CommandType, LocaleType, mergeLocales, Univer, type IWorkbookData } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { SetRangeValuesCommand, UniverSheetsPlugin } from '@univerjs/sheets'
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
  dispose(): void
  selectedRow(): {sheet_id: string; row: number} | undefined
}

const locale = mergeLocales(DesignEn, UIEn, DocsUIEn, SheetsEn, SheetsUIEn, FormulaEn, FormulaUIEn, NumfmtUIEn)

export function mountWorkbook(element: HTMLElement, snapshot: Workbook, editable: () => boolean, changed: (commands: Command[]) => void, unsupported: () => void): MountedWorkbook {
  const native = snapshot.native as unknown as IWorkbookData
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
      if (command.type === CommandType.COMMAND && (!editable() || command.id !== SetRangeValuesCommand.id)) {
        throw new CanceledError()
      }
    })
    const changes = api.addEvent(api.Event.SheetValueChanged, ({effectedRanges}) => {
      if (!editable()) return
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
      const sheetId = sheet.getSheetId()
      try {
        const values = clipboardValues(text)
        const expected = values.map((items, r) => items.map((_, c) =>
          cellContent(native.sheets[sheetId]?.cellData?.[row + r]?.[column + c])))
        changed([{kind: 'set_values', sheet_id: sheetId, row: row + 1, column: column + 1, expected, values}])
      } catch {
        unsupported()
      }
    }
    element.addEventListener('paste', paste, {capture: true})
    // Engine recalculation can update only cached formula values; these are never command inputs.
    return {
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
