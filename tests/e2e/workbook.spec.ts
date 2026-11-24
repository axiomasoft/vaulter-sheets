import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

interface RangeCell {
  row: number
  column: number
  a1: string
  value?: unknown
  formula?: string | null
}

async function createWorkbook(page: Page, payload: Record<string, unknown> = {}) {
  const created = await page.request.post('/api/test/workbooks', { data: payload })
  expect(created.ok()).toBeTruthy()
  return (await created.json()).id as string
}

async function readRange(page: Page, id: string, sheetId: string, range: string): Promise<RangeCell[]> {
  const response = await page.request.get(`/api/vaulter-sheets/v1/workbooks/${id}/ranges?sheet_id=${sheetId}&range=${range}`)
  expect(response.ok()).toBeTruthy()
  const json = (await response.json()) as { data: Array<{ cells: RangeCell[] }> }
  return json.data[0].cells
}

async function dispatchPaste(page: Page, data: { plain?: string; html?: string }) {
  await page.evaluate(({ plain, html }) => {
    const target = document.querySelector('canvas[id^="univer-sheet-main-canvas"]') ?? document.querySelector('canvas')
    if (!target) throw new Error('Sheet canvas not found')
    const transfer = new DataTransfer()
    if (plain !== undefined) transfer.setData('text/plain', plain)
    if (html !== undefined) transfer.setData('text/html', html)
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, data)
}

async function installCanvasTextObserver(page: Page) {
  await page.addInitScript(() => {
    const texts: string[] = []
    ;(window as unknown as { __canvasTexts?: string[] }).__canvasTexts = texts
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text: string, ...args: unknown[]) {
      texts.push(String(text))
      return original.apply(this, [text, ...(args as [number, number, number?])])
    }
  })
}

test('edits C3, inserts row above with Summary 41.00 canvas recalc, pastes HTML, undoes/redoes, survives restart, and bounds 20x GC', async ({ page }) => {
  await installCanvasTextObserver(page)
  const id = await createWorkbook(page)

  await page.goto(`/?node=${id}`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible()

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()

  // Single-click C3 and type 7 + Enter
  await canvas.click({ position: { x: 266, y: 80 } })
  const save = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.type('7')
  await page.keyboard.press('Enter')
  const saveRes = await save
  expect(saveRes.status()).toBe(200)
  expect(saveRes.request().postDataJSON().commands).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'set_number', sheet_id: 'detail', row: 3, column: 3, value: 7 })]),
  )
  await expect(page.getByText('Workbook saved')).toBeVisible()

  // Verify Summary!B2 = 41 and canvas paints 41.00
  expect((await readRange(page, id, 'summary', 'B2'))[0]?.value).toBe(41)
  await page.getByRole('tab', { name: 'Summary' }).click()
  await page.waitForFunction(() => (window as unknown as { __canvasTexts?: string[] }).__canvasTexts?.includes('41.00'), null, { timeout: 10_000 })
  await page.getByRole('tab', { name: 'Detail' }).click()

  // Undo & Redo on C3
  const undoSave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.press('ControlOrMeta+z')
  expect((await undoSave).status()).toBe(200)
  await expect(page.getByText('Saving…')).toHaveCount(0)

  const redoKey = await page.evaluate(() => navigator.platform.startsWith('Mac') ? 'Meta+Shift+z' : 'Control+y')
  const redoSave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.press(redoKey)
  expect((await redoSave).status()).toBe(200)
  await expect(page.getByText('Saving…')).toHaveCount(0)

  // UI insert_row_before on row 3 -> Pears shifts to row 4 with =B4*C4 and Summary!B2 stays 41.00
  await canvas.click({ position: { x: 266, y: 80 } })
  const insertSave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.getByRole('button', { name: 'Insert row above' }).click()
  const insertRes = await insertSave
  expect(insertRes.status()).toBe(200)
  expect(insertRes.request().postDataJSON().commands[0].kind).toBe('insert_row_before')

  const shifted = await readRange(page, id, 'detail', 'B4:D4')
  expect(shifted.map(c => c.value)).toEqual([3, 7, 21])
  expect(shifted[2]?.formula).toBe('=B4*C4')
  expect((await readRange(page, id, 'summary', 'B2'))[0]?.value).toBe(41)

  // HTML clipboard paste into E2:F3
  await canvas.click({ position: { x: 442, y: 56 } })
  const htmlPasteSave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await dispatchPaste(page, { html: '<table><tr><td>12</td><td>Oranges</td></tr><tr><td>15</td><td>Berries</td></tr></table>' })
  const htmlPasteRes = await htmlPasteSave
  expect(htmlPasteRes.status()).toBe(200)
  expect(htmlPasteRes.request().postDataJSON().commands[0].kind).toBe('set_values')
  const pastedRange = await readRange(page, id, 'detail', 'E2:F3')
  expect(pastedRange.map(c => c.value)).toEqual([12, 'Oranges', 15, 'Berries'])

  // Runtime restart + cold reload
  const signal = process.env.SHEETS_RUNTIME_RESTART_SIGNAL
  const workerPid = process.env.SHEETS_RUNTIME_CHILD_PID
  if (signal && workerPid) {
    const previous = readFileSync(workerPid, 'utf8')
    process.kill(Number(readFileSync(signal, 'utf8').trim()), 'SIGUSR2')
    await expect.poll(async () => {
      try {
        return readFileSync(workerPid, 'utf8') !== previous &&
          (await page.request.get(`/api/vaulter-sheets/v1/workbooks/${id}/ranges?sheet_id=summary&range=B2`)).ok()
      } catch {
        return false
      }
    }).toBe(true)
  }
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })
  expect((await readRange(page, id, 'detail', 'B4:D4')).map(c => c.value)).toEqual([3, 7, 21])

  // 20x open/dispose GC check (after 10 warmup cycles)
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const cycleEditor = async () => {
    await page.getByRole('button', { name: 'Close workbook' }).click()
    await expect(page.locator('canvas[id^="univer-sheet-main-canvas"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Open workbook' }).click()
    await expect(page.locator('canvas[id^="univer-sheet-main-canvas"]').first()).toBeVisible({ timeout: 20_000 })
  }
  for (let i = 0; i < 10; i++) await cycleEditor()
  const beforeGc = await heap()
  for (let i = 0; i < 20; i++) await cycleEditor()
  const growth = (await heap()) - beforeGc
  expect(growth).toBeLessThan(5 * 1024 * 1024)
})

test('pastes 100x100 TSV cells and reverts with a single undo', async ({ page }) => {
  const id = await createWorkbook(page, { row_count: 110, column_count: 110 })
  await page.goto(`/?node=${id}`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 90, y: 128 } }) // A5

  const tsv = Array.from({ length: 100 }, (_, r) =>
    Array.from({ length: 100 }, (__, c) => String(r * 100 + c + 1)).join('\t'),
  ).join('\n')

  const pasteSave = page.waitForResponse(
    res => res.url().endsWith('/commands') && res.request().method() === 'POST',
    { timeout: 25_000 },
  )
  await dispatchPaste(page, { plain: tsv })
  const pasteRes = await pasteSave
  expect(pasteRes.status()).toBe(200)
  expect(pasteRes.request().postDataJSON().commands[0].kind).toBe('set_values')
  expect((await readRange(page, id, 'detail', 'A5'))[0]?.value).toBe(1)
  expect((await readRange(page, id, 'detail', 'CV104'))[0]?.value).toBe(10_000)

  const undoSave = page.waitForResponse(
    res => res.url().endsWith('/commands') && res.request().method() === 'POST',
    { timeout: 25_000 },
  )
  await page.keyboard.press('ControlOrMeta+z')
  expect((await undoSave).status()).toBe(200)

  expect((await readRange(page, id, 'detail', 'A5'))[0]?.value ?? null).toBeNull()
  expect((await readRange(page, id, 'detail', 'CV104'))[0]?.value ?? null).toBeNull()
})

test('supports Russian keyboard input in ruRU locale and arrow-key navigation', async ({ page }) => {
  const id = await createWorkbook(page)
  await page.goto(`/?node=${id}&locale=ruRU`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 442, y: 56 } }) // E2
  await page.keyboard.press('ArrowRight') // F2
  await page.keyboard.press('ArrowDown') // F3

  const save = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.type('Привет')
  await page.keyboard.press('Enter')
  expect((await save).status()).toBe(200)

  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowUp')

  expect((await readRange(page, id, 'detail', 'F3'))[0]?.value).toBe('Привет')
  expect((await readRange(page, id, 'detail', 'E2'))[0]?.value ?? null).toBeNull()
})

test('shows 409 conflict banner and recovers via Load current workbook', async ({ page }) => {
  const id = await createWorkbook(page)
  await page.goto(`/?node=${id}`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })

  const headRes = await page.request.get(`/api/vaulter-sheets/v1/workbooks/${id}`)
  expect(headRes.ok()).toBeTruthy()
  const etag = headRes.headers()['etag']
  const head = await headRes.json()

  const ext = await page.request.post(`/api/vaulter-sheets/v1/workbooks/${id}/commands`, {
    headers: { 'If-Match': etag },
    data: {
      command_id: '00000000-0000-4000-8000-000000000409',
      expected_generation: head.data.marker.generation,
      policy: 'exact_base',
      commands: [{ kind: 'set_number', sheet_id: 'detail', row: 2, column: 3, expected: { number: 10 }, value: 11 }],
    },
  })
  expect(ext.status()).toBe(200)

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 266, y: 56 } }) // C2
  const conflictSave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.type('9')
  await page.keyboard.press('Enter')
  expect((await conflictSave).status()).toBe(409)

  await expect(page.getByText('The workbook changed. Your edit is still visible here.')).toBeVisible()
  await page.getByRole('button', { name: 'Load current workbook' }).click()
  await expect(page.getByText('The workbook changed. Your edit is still visible here.')).toHaveCount(0)
  expect((await readRange(page, id, 'detail', 'C2'))[0]?.value).toBe(11)
})

test('retries save after transient 5xx failure', async ({ page }) => {
  const id = await createWorkbook(page)
  await page.goto(`/?node=${id}`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })

  let intercepted = false
  await page.route('**/commands', async route => {
    if (!intercepted && route.request().method() === 'POST') {
      intercepted = true
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service Unavailable' })
      return
    }
    await route.continue()
  })

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 442, y: 56 } }) // E2
  await page.keyboard.type('42')
  await page.keyboard.press('Enter')

  await expect(page.getByText('Could not save the edit.')).toBeVisible()
  const retrySave = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.getByRole('button', { name: 'Retry save' }).click()
  expect((await retrySave).status()).toBe(200)
  await expect(page.getByText('Workbook saved')).toBeVisible()
  expect((await readRange(page, id, 'detail', 'E2'))[0]?.value).toBe(42)
})

test('enforces read-only UI and blocks edits without sending commands', async ({ page }) => {
  const id = await createWorkbook(page)
  let commandPosts = 0
  page.on('request', req => {
    if (req.url().endsWith('/commands') && req.method() === 'POST') commandPosts += 1
  })

  await page.goto(`/?node=${id}&readonly=1`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Insert row above' })).toHaveCount(0)

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 266, y: 80 } })
  await page.keyboard.type('99')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)

  expect(commandPosts).toBe(0)
  expect((await readRange(page, id, 'detail', 'C3'))[0]?.value).toBe(5)
})

test('opens and saves a CAS-offloaded workbook larger than 512 KB', async ({ page }) => {
  const id = await createWorkbook(page, { large: true })
  const storageBefore = await page.request.get(`/api/test/workbooks/${id}/storage`)
  expect(storageBefore.ok()).toBeTruthy()
  const beforeMeta = await storageBefore.json()
  expect(beforeMeta.storage).toBe('media_blob')

  await page.goto(`/?node=${id}`)
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })

  const canvas = page.locator('canvas[id^="univer-sheet-main-canvas"]').first()
  await canvas.click({ position: { x: 266, y: 80 } })
  const save = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().method() === 'POST')
  await page.keyboard.type('8')
  await page.keyboard.press('Enter')
  expect((await save).status()).toBe(200)
  await expect(page.getByText('Workbook saved')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('tab', { name: 'Detail' })).toBeVisible({ timeout: 20_000 })
  expect((await readRange(page, id, 'detail', 'C3'))[0]?.value).toBe(8)

  const storageAfter = await page.request.get(`/api/test/workbooks/${id}/storage`)
  const afterMeta = await storageAfter.json()
  expect(afterMeta.storage).toBe('media_blob')
})
