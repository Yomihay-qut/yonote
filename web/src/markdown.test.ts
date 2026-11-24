import { MarkdownManager } from '@tiptap/markdown'
import { expect, it } from 'vitest'
import { editorExtensions } from './editor'

it('exports legacy note formatting and preserves app attachment paths', () => {
  const markdown = new MarkdownManager({ extensions: editorExtensions })
  const result = markdown.serialize({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '出发计划' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '路线', marks: [{ type: 'bold' }] }] },
      {
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '带上相机' }] }],
        }],
      },
      { type: 'image', attrs: { attachmentId: 'image-1', alt: '地图' } },
      { type: 'attachment', attrs: { attachmentId: 'file-1', name: '路线.pdf' } },
    ],
  })
  expect(result).toContain('## 出发计划')
  expect(result).toContain('**路线**')
  expect(result).toContain('- [x] 带上相机')
  expect(result).toContain('![地图](attachments/image-1)')
  expect(result).toContain('[路线.pdf](attachments/file-1)')
})
