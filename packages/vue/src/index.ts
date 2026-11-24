export { default as VaulterSpreadsheet } from './components/VaulterSpreadsheet.vue'
export type { VaulterRealtimeOptions } from './components/VaulterSpreadsheet.vue'

export const SPREADSHEET_VIEWER_KEY = 'vaulter/univer' as const

export { createWorkbooksClient, WorkbookApiError } from './api/workbooks'
export type {
  BorderSideSpec,
  BorderStyleName,
  CellContent,
  Command,
  CommandOutcome,
  ExchangeCapabilities,
  ExchangeDiagnostic,
  ExchangeJob,
  ExchangeLossEntry,
  ExchangeReport,
  FormatSpec,
  FormulaExpression,
  Literal,
  OpenedWorkbook,
  Receipt,
  RegisterExchangeRequest,
  TableBinding,
  TableColumnBinding,
  TableRowBinding,
  Workbook,
  WorkbookIntent,
  WorkbookLocale,
  WorkbookMarker,
  WorkbookPresence,
  WorkbookPresenceSelection,
  WorkbookRoomSession,
  WorkbooksClient,
  WorkbookSelectionPayload,
  WorkbookSelectionRange,
  WorkbookTableSelection,
} from './api/workbooks'
