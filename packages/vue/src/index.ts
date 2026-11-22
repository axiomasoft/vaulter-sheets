export { default as VaulterSpreadsheet } from './components/VaulterSpreadsheet.vue'

export const SPREADSHEET_VIEWER_KEY = 'vaulter/univer' as const

export { createWorkbooksClient, WorkbookApiError } from './api/workbooks'
export type { Command, OpenedWorkbook, Receipt, Workbook, WorkbooksClient } from './api/workbooks'
