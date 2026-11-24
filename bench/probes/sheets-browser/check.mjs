import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
try {
  await server.listen()
  const browserOptions = process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chromium' }
  browser = await chromium.launch(browserOptions)
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.paintedTotals = new Set()
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (value, ...args) {
      if (value === '35.00' || value === '41.00') window.paintedTotals.add(value)
      return fillText.call(this, value, ...args)
    }
  })
  await page.goto(server.resolvedUrls.local[0])

  const canvas = page.locator('#univer-sheet-main-canvas_vaulter-smoke')
  await canvas.waitFor({ state: 'visible' })
  async function showSummary(expected) {
    await page.evaluate(() => window.paintedTotals.clear())
    await page.getByText('Summary', { exact: true }).click()
    await page.waitForFunction(text =>
      window.probeWorkbook.getActiveSheet().getSheetName() === 'Summary'
      && window.paintedTotals.has(text), expected)
  }

  async function readCells(row) {
    return page.evaluate(row => {
      const book = window.probeWorkbook
      const detail = book.getSheetByName('Detail')
      const total = book.getSheetByName('Summary').getRange('B2')
      return {
        book: book.getId(), price: detail.getRange('C' + row).getRawValue(),
        line: detail.getRange('D' + row).getRawValue(),
        lineFormula: detail.getRange('D' + row).getFormula(),
        total: total.getRawValue(), totalFormula: total.getFormula(),
      }
    }, row)
  }

  await showSummary('35.00')
  const before = await readCells(3)
  assert.deepEqual(before, {
    book: 'vaulter-smoke', price: 5, line: 15, lineFormula: '=B3*C3',
    total: 35, totalFormula: '=SUM(Detail!D2:D3)',
  })

  await page.getByText('Detail', { exact: true }).click()
  await page.waitForFunction(() => window.probeWorkbook.getActiveSheet().getSheetName() === 'Detail')
  const center = await page.evaluate(() => {
    const r = window.probeWorkbook.getActiveSheet().getRange('C3').getCellRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await canvas.click({ position: center })
  await page.waitForFunction(() => window.probeWorkbook.getActiveRange()?.getA1Notation() === 'C3')
  await page.keyboard.press('7')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.probeWorkbook.getSheetByName('Summary').getRange('B2').getRawValue() === 41)
  await showSummary('41.00')
  const edited = await readCells(3)
  assert.deepEqual(edited, { ...before, price: 7, line: 21, total: 41 })

  await page.evaluate(() => { window.probeWorkbook.getSheetByName('Detail').insertRowBefore(1) })
  await page.waitForFunction(() =>
    window.probeWorkbook.getSheetByName('Summary').getRange('B2').getFormula() === '=SUM(Detail!D3:D4)')
  const moved = await readCells(4)
  assert.deepEqual(moved, { ...edited, lineFormula: '=B4*C4', totalFormula: '=SUM(Detail!D3:D4)' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: browser.version(), before, edited, moved, canvasText: ['35.00', '41.00'] }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
