import {expect, test, type APIRequestContext, type Page} from '@playwright/test'

declare global {
  interface Window {
    referenceFixture: {
      load: (content: unknown) => void
      exportDocument: () => Promise<string>
    }
  }
}

const canonicalRange = 'D2:D4'

async function createBook(request: APIRequestContext): Promise<{id: string; name: string}> {
  const created = await request.post('/api/test/reference', {headers: {'X-Fixture-Actor': '1'}})
  expect(created.ok(), await created.text()).toBe(true)
  const body = await created.json()
  return {id: String(body.id), name: String(body.name)}
}

async function access(request: APIRequestContext, node: string, role: 'reader' | 'previewer' | 'none'): Promise<void> {
  const response = await request.post('/api/test/reference-access', {headers: {'X-Fixture-Actor': '1'}, data: {node, role}})
  expect(response.ok(), await response.text()).toBe(true)
}

function office(node: string, sheet = 'detail', extra = ''): string {
  return `/office/workbooks/${node}/sheets/${sheet}?range=${encodeURIComponent(canonicalRange)}${extra}`
}

async function openText(page: Page, node: string, actor: string, extension: boolean): Promise<void> {
  await page.goto(`/?actor=${actor}&node=${node}&sheet=detail&range=${encodeURIComponent(canonicalRange)}&extension=${extension ? '1' : '0'}&insert=${extension ? '1' : '0'}`)
  await expect(page.locator('[data-reference-fixture]')).toHaveAttribute('data-extension', extension ? 'on' : 'off')
  await expect(page.locator('[data-reference-fixture]')).toHaveAttribute('data-viewer', 'vaulter/univer')
}

test('a text-only reader sees no book title or values; a book reader sees the fixed range', async ({page, request}) => {
  const book = await createBook(request)
  const node = book.id
  const title = book.name
  const denied = await request.get(office(node), {headers: {'X-Fixture-Actor': '2'}})
  expect(denied.status()).toBe(404)
  const deniedBody = await denied.text()
  expect(deniedBody).toContain('Unavailable')
  expect(deniedBody).not.toContain(title)
  expect(deniedBody).not.toContain('20|15|')

  const allowed = await request.get(office(node), {headers: {'X-Fixture-Actor': '1', Accept: 'application/json'}})
  expect(allowed.ok(), await allowed.text()).toBe(true)
  const revealed = await allowed.json()
  expect(revealed.title).toBe(title)
  expect(revealed.cells.map((cell: {value: unknown}) => cell.value ?? '').join('|')).toBe('20|15|')

  await openText(page, node, '2', true)
  await expect(page.locator('[data-workbook-unavailable]')).toBeVisible()
  await expect(page.locator('[data-workbook-title]')).toHaveCount(0)
  await expect(page.locator('[data-workbook-values]')).toHaveCount(0)
  await expect(page.locator('[data-editor]')).toContainText('Lesson 7')
  await expect(page.locator('[data-editor]')).toContainText(canonicalRange)
  const hidden = await page.locator('[data-document]').innerText()
  expect(hidden).toContain(`range=${encodeURIComponent(canonicalRange)}`)
  expect(hidden).not.toContain(title)
  expect(hidden).not.toContain('"value"')

  await openText(page, node, '1', true)
  await expect(page.locator('[data-workbook-values]')).toHaveText('20|15|')
  await expect(page.locator('[data-workbook-title]')).toHaveText(title)
})

test('a deleted sheet, a revoked export and an export ban stay neutral', async ({page, request}) => {
  const book = await createBook(request)
  const node = book.id
  const title = book.name
  const missing = await request.get(office(node, 'missing'), {headers: {'X-Fixture-Actor': '1', Accept: 'application/json'}})
  expect(missing.status()).toBe(404)
  const missingBody = await missing.text()
  expect(missingBody).not.toContain(title)
  expect(missingBody).not.toContain('20')

  await access(request, node, 'reader')
  const exported = await request.get(`${office(node)}&export=1`, {headers: {'X-Fixture-Actor': '2', Accept: 'application/json'}})
  expect(exported.ok(), await exported.text()).toBe(true)
  expect((await exported.json()).title).toBe(title)

  await access(request, node, 'none')
  const revoked = await request.get(`${office(node)}&export=1`, {headers: {'X-Fixture-Actor': '2', Accept: 'application/json'}})
  expect(revoked.status()).toBe(404)
  const revokedBody = await revoked.text()
  expect(revokedBody).not.toContain(title)
  expect(revokedBody).not.toContain('20')

  await access(request, node, 'previewer')
  const preview = await request.get(office(node), {headers: {'X-Fixture-Actor': '2', Accept: 'application/json'}})
  expect(preview.ok(), await preview.text()).toBe(true)
  expect((await preview.json()).cells.map((cell: {value: unknown}) => cell.value ?? '').join('|')).toBe('20|15|')
  const banned = await request.get(`${office(node)}&export=1`, {headers: {'X-Fixture-Actor': '2', Accept: 'application/json'}})
  expect(banned.status()).toBe(404)
  expect(await banned.text()).not.toContain(title)

  await openText(page, node, '2', true)
  await expect(page.locator('[data-workbook-values]')).toHaveText('20|15|')
  await access(request, node, 'none')
  await page.waitForFunction(() => typeof window.referenceFixture?.exportDocument === 'function')
  expect(await page.evaluate(() => window.referenceFixture.exportDocument())).toBe('Unavailable')
  await expect(page.locator('[data-export]')).toHaveText('Unavailable')
  const saved = await page.locator('[data-document]').innerText()
  expect(saved).toContain('D2%3AD4')
  expect(saved).not.toContain(title)
})

test('a base editor keeps the fixed coordinates, which show the new cells after a row insert', async ({page, request}) => {
  const book = await createBook(request)
  const node = book.id
  const title = book.name
  await openText(page, node, '1', true)
  await expect(page.locator('[data-workbook-values]')).toHaveText('20|15|')
  const saved = await page.locator('[data-document]').innerText()
  expect(saved).toContain(`"text":"${canonicalRange}"`)
  expect(saved).toContain('D2%3AD4')
  expect(saved).not.toContain(title)

  const head = await request.get(`/api/vaulter-sheets/v1/workbooks/${node}`, {headers: {'X-Fixture-Actor': '1', Accept: 'application/json'}})
  expect(head.ok(), await head.text()).toBe(true)
  const inserted = await request.post(`/api/vaulter-sheets/v1/workbooks/${node}/commands`, {
    headers: {'X-Fixture-Actor': '1', 'If-Match': head.headers().etag ?? '', Accept: 'application/json'},
    data: {
      command_id: 'insert-before-row-2',
      expected_generation: (await head.json()).data.marker.generation,
      policy: 'exact_base',
      commands: [{kind: 'insert_row_before', sheet_id: 'detail', row: 2, count: 1}],
    },
  })
  expect(inserted.ok(), await inserted.text()).toBe(true)

  await page.goto(`/?actor=1&node=${node}&extension=0&insert=0`)
  await page.waitForFunction(() => typeof window.referenceFixture?.load === 'function')
  await page.evaluate(json => window.referenceFixture.load(JSON.parse(json)), saved)
  await expect(page.locator('[data-editor] a')).toHaveAttribute('href', /range=D2(?::|%3A)D4/)
  await expect(page.locator('[data-editor]')).toContainText(canonicalRange)
  await expect(page.locator('[data-workbook-preview]')).toHaveCount(0)
  const reopened = await page.locator('[data-document]').innerText()
  expect(reopened).toContain('D2%3AD4')
  expect(reopened).not.toContain('D3%3AD5')

  await page.goto(`/?actor=1&node=${node}&extension=1&insert=0`)
  await page.waitForFunction(() => typeof window.referenceFixture?.load === 'function')
  await page.evaluate(json => window.referenceFixture.load(JSON.parse(json)), saved)
  await expect(page.locator('[data-workbook-values]')).not.toHaveText('20|15|')
  await expect(page.locator('[data-editor]')).toContainText(canonicalRange)
  expect(await page.locator('[data-document]').innerText()).toContain('D2%3AD4')
})
