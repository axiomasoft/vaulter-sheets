import {Editor, type JSONContent} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  buildWorkbookReferenceUrl,
  createWorkbookRangeReader,
  exportWorkbookReferences,
  parseWorkbookReference,
  WorkbookReference,
  type WorkbookRangeReader,
  type WorkbookRangeRequest,
} from '../src/index'

const location = {origin: 'https://fixture.example', pathPrefix: '/office/workbooks'}
const target = {nodeId: 'n1', sheetId: 's1', range: 'D2:D4'}
const canonical = 'https://fixture.example/office/workbooks/n1/sheets/s1?range=D2%3AD4'
const title = 'Secret Budget Title'

function cells(values: Array<number | null>) {
  return values.map((value, index) => ({a1: `D${index + 2}`, value}))
}

function reader(impl: WorkbookRangeReader): WorkbookRangeReader {
  return vi.fn(impl)
}

function mount(extensions: Editor['options']['extensions'], content?: JSONContent | string): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  return new Editor({element, extensions, content})
}

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  document.body.replaceChildren()
})

async function shown(selector: string): Promise<Element> {
  let found: Element | null = null
  await vi.waitFor(() => {
    found = document.querySelector(selector)
    expect(found).not.toBeNull()
  })
  return found!
}

describe('workbook reference url', () => {
  it('stores the canonical https link and reads the same fixed coordinates back', () => {
    expect(buildWorkbookReferenceUrl(location, target)).toBe(canonical)
    expect(parseWorkbookReference(canonical, location)).toEqual(target)
    expect(parseWorkbookReference('http://fixture.example/office/workbooks/n1/sheets/s1?range=D2:D4', location)).toBeNull()
    expect(parseWorkbookReference('https://user:pass@fixture.example/office/workbooks/n1/sheets/s1?range=D2:D4', location)).toBeNull()
    expect(parseWorkbookReference('https://fixture.example./office/workbooks/n1/sheets/s1?range=D2:D4', location)).toBeNull()
    expect(parseWorkbookReference('javascript:alert(1)', location)).toBeNull()
  })
})

describe('WorkbookReference', () => {
  it('keeps an ordinary link mark and does not cache the preview in the document', async () => {
    const readRange = reader(async () => ({status: 'ready', title, cells: cells([20, 15, null])}))
    const editor = mount([StarterKit, WorkbookReference.configure({...location, readRange})])
    editors.push(editor)
    editor.commands.insertContent('Lesson 7 ')
    expect(editor.commands.insertWorkbookReference(target)).toBe(true)
    const saved = editor.getJSON()
    const linked = textNodes(saved).find(node => node.marks?.some(mark => mark.type === 'link'))
    expect(linked).toMatchObject({type: 'text', text: 'D2:D4', marks: [{type: 'link', attrs: {href: canonical}}]})
    expect(linked?.marks?.map(mark => mark.type)).toEqual(['link'])
    expect(JSON.stringify(saved)).not.toContain('workbookReference')
    expect(JSON.stringify(saved)).not.toContain(title)
    expect(JSON.stringify(saved)).not.toContain('20')

    expect((await shown('[data-workbook-values]')).textContent).toBe('20|15|')
    expect(document.querySelector('[data-workbook-title]')?.textContent).toBe(title)
    expect(JSON.stringify(editor.getJSON())).toBe(JSON.stringify(saved))
    expect(readRange).toHaveBeenCalledWith({...target, purpose: 'preview'})
    expect(editor.getHTML()).toContain(`href="${canonical}"`)
    expect(editor.getHTML()).not.toContain(title)
  })

  it('keeps the same physical coordinates after a row insertion and shows the new values', async () => {
    let inserted = false
    const readRange = reader(async () => ({status: 'ready', cells: cells(inserted ? [null, 20, 15] : [20, 15, null])}))
    const editor = mount([StarterKit, WorkbookReference.configure({...location, readRange})])
    editors.push(editor)
    editor.commands.insertWorkbookReference(target)
    expect((await shown('[data-workbook-values]')).textContent).toBe('20|15|')
    const before = editor.getJSON()
    editors.splice(editors.indexOf(editor), 1)
    editor.destroy()
    document.body.replaceChildren()

    inserted = true
    const reopened = mount([StarterKit, WorkbookReference.configure({...location, readRange})], before)
    editors.push(reopened)
    expect((await shown('[data-workbook-values]')).textContent).toBe('|20|15')
    const after = reopened.getJSON()
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(textOf(after)).toContain('D2:D4')
    expect(JSON.stringify(after)).not.toContain('D3%3AD5')
    expect(JSON.stringify(after)).not.toContain('D3:D5')
  })

  it('shows one neutral state for a denied book, a deleted sheet and an invalid address', async () => {
    const readRange = reader(async (request: WorkbookRangeRequest) => {
      if (request.sheetId === 'missing') return {status: 'unavailable', title, cells: cells([20])} as never
      return {status: 'unavailable'}
    })
    const editor = mount([StarterKit, WorkbookReference.configure({...location, readRange})], {
      type: 'doc',
      content: [{type: 'paragraph', content: [
        {type: 'text', text: 'Lesson 7 '},
        {type: 'text', text: 'D2:D4', marks: [{type: 'link', attrs: {href: canonical}}]},
        {type: 'text', text: 'gone', marks: [{type: 'link', attrs: {href: canonical.replace('/sheets/s1?', '/sheets/missing?')}}]},
        {type: 'text', text: 'bad', marks: [{type: 'link', attrs: {href: canonical.replace('range=D2%3AD4', 'range=DROP')}}]},
        {type: 'text', text: 'web', marks: [{type: 'link', attrs: {href: 'https://example.com/notes'}}]},
      ]}],
    })
    editors.push(editor)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-workbook-unavailable]')).toHaveLength(3))
    expect(document.querySelector('[data-workbook-title]')).toBeNull()
    expect(document.querySelector('[data-workbook-values]')).toBeNull()
    expect(document.body.textContent).toContain('Lesson 7')
    expect(document.body.textContent).not.toContain(title)
    expect(document.body.textContent).not.toContain('20')
    expect(readRange).toHaveBeenCalledTimes(2)
    expect(readRange).not.toHaveBeenCalledWith(expect.objectContaining({sheetId: 's1', range: 'DROP'}))
  })

  it('re-checks access on export and leaves the saved link for a base editor', async () => {
    let allowed = true
    let exportable = true
    const readRange = reader(async request => {
      if (!allowed || (request.purpose === 'export' && !exportable)) return {status: 'unavailable'}
      return {status: 'ready', title, cells: cells([20, 15, null])}
    })
    const editor = mount([StarterKit, WorkbookReference.configure({...location, readRange})])
    editors.push(editor)
    editor.commands.insertWorkbookReference(target)
    await shown('[data-workbook-values]')
    const saved = editor.getJSON()

    const revealed = await exportWorkbookReferences(saved, location, readRange)
    expect(revealed).toEqual([{
      href: canonical, text: 'D2:D4', status: 'ready', nodeId: 'n1', sheetId: 's1', range: 'D2:D4', title, cells: cells([20, 15, null]),
    }])
    expect(readRange).toHaveBeenCalledWith(expect.objectContaining({purpose: 'export'}))

    exportable = false
    const banned = await exportWorkbookReferences(saved, location, readRange)
    expect(banned).toEqual([{href: canonical, text: 'D2:D4', status: 'unavailable', nodeId: 'n1', sheetId: 's1', range: 'D2:D4'}])
    expect(JSON.stringify(banned)).not.toContain(title)
    expect(JSON.stringify(banned)).not.toContain('20')

    allowed = false
    const revoked = await exportWorkbookReferences(structuredClone(saved), location, readRange)
    expect(revoked[0]).toMatchObject({status: 'unavailable'})
    expect(revoked[0]).not.toHaveProperty('cells')
    expect(revoked[0]).not.toHaveProperty('title')
    expect(saved).toEqual(editor.getJSON())
    editors.splice(editors.indexOf(editor), 1)
    editor.destroy()
    document.body.replaceChildren()

    const base = mount([StarterKit], saved)
    editors.push(base)
    const loaded = base.getJSON()
    expect(textNodes(loaded).some(node => node.text === 'D2:D4' && node.marks?.some(mark => mark.type === 'link' && mark.attrs?.href === canonical))).toBe(true)
    expect(document.querySelector('[data-workbook-preview]')).toBeNull()
    base.commands.insertContent(' kept')
    const reopened = base.getJSON()
    expect(JSON.stringify(reopened)).toContain(canonical)
    expect(JSON.stringify(reopened)).toContain('D2:D4')
    expect(JSON.stringify(reopened)).not.toContain(title)
  })
})

describe('createWorkbookRangeReader', () => {
  it('reads calculated cells and treats a failed or export-forbidden response as neutral', async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({data: [{cells: [{a1: 'D2', value: 20, formula: '=B2*C2'}]}]}), {status: 200}))
    const readRange = createWorkbookRangeReader({fetch: fetchImpl, canExport: () => false})
    expect(await readRange({...target, purpose: 'preview'})).toEqual({status: 'ready', cells: [{a1: 'D2', value: 20}]})
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = String(fetchImpl.mock.calls[0]?.[0])
    expect(url).toBe('/api/vaulter-sheets/v1/workbooks/n1/ranges?sheet_id=s1&range=D2%3AD4&fields=value')
    expect(url).not.toContain('fixture.example')
    expect(await readRange({...target, purpose: 'export'})).toEqual({status: 'unavailable'})
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({code: 'resource_unavailable', title}), {status: 404}))
    const denied = createWorkbookRangeReader({fetch: fetchImpl, canExport: () => true})
    expect(await denied({...target, purpose: 'export'})).toEqual({status: 'unavailable'})
  })
})

function textNodes(doc: JSONContent): JSONContent[] {
  const found: JSONContent[] = []
  const walk = (node: JSONContent): void => {
    if (node.text) found.push(node)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function textOf(doc: JSONContent): string {
  return textNodes(doc).map(node => node.text ?? '').join('')
}
