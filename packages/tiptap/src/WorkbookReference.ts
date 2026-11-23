import {Extension} from '@tiptap/core'
import {VueWidgetRenderer} from '@tiptap/vue-3'
import WorkbookPreview from './WorkbookPreview.vue'
import {
  buildWorkbookReferenceUrl,
  classifyWorkbookReference,
  type WorkbookRangeReader,
  type WorkbookReferenceLocation,
  type WorkbookReferenceTarget,
} from './contract'

export interface WorkbookReferenceOptions extends WorkbookReferenceLocation {
  readRange?: WorkbookRangeReader
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    workbookReference: {
      /** Insert an ordinary link mark. The visible text is the fixed range, not the book title or cell values. */
      insertWorkbookReference: (target: WorkbookReferenceTarget, text?: string) => ReturnType
    }
  }

  interface Storage {
    workbookReference: {readRange?: WorkbookRangeReader}
  }
}

/**
 * Decorates workbook links while they are shown. The saved document stays an ordinary `link` mark:
 * disabling this extension leaves the href and the fixed coordinates untouched.
 */
export const WorkbookReference = Extension.create<WorkbookReferenceOptions>({
  name: 'workbookReference',

  addOptions() {
    return {origin: '', pathPrefix: '/office/workbooks'}
  },

  addStorage() {
    return {readRange: undefined}
  },

  onCreate() {
    this.storage.readRange = this.options.readRange
  },

  addCommands() {
    return {
      insertWorkbookReference: (target, text) => ({commands, editor}) => {
        if (editor.schema.marks.link === undefined) return false
        const href = buildWorkbookReferenceUrl(this.options, target)
        if (href === null) return false
        const label = text && text.trim() !== '' ? text : target.range
        return commands.insertContent({type: 'text', text: label, marks: [{type: 'link', attrs: {href}}]})
      },
    }
  },

  addDecorations() {
    const location = this.options
    const editor = this.editor
    return {
      create: ({state}) => {
        const widgets: ReturnType<typeof VueWidgetRenderer>[] = []
        let index = 0
        state.doc.descendants((node, pos) => {
          if (!node.isText) return
          const href = node.marks.find(mark => mark.type.name === 'link')?.attrs.href
          if (typeof href !== 'string') return
          const parsed = classifyWorkbookReference(href, location)
          if (parsed.kind === 'foreign') return
          widgets.push(VueWidgetRenderer(WorkbookPreview, {
            editor,
            pos: pos + node.nodeSize,
            key: `workbook-reference:${index}:${href}`,
            side: 1,
            ignoreSelection: true,
            stopEvent: () => true,
            props: {
              target: parsed.kind === 'reference' ? parsed.target : null,
              invalid: parsed.kind === 'invalid',
              readRange: location.readRange,
            },
          }))
          index += 1
        })
        return widgets
      },
    }
  },
})
