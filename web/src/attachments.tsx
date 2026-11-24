import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { Image as ImageExtension } from '@tiptap/extension-image'
import { useState } from 'react'
import { Download, FileText, LoaderCircle, ImageOff } from 'lucide-react'
import { useAttachment, formatBytes } from './media'
import { ImageViewer } from './ImageViewer'
function ImageView({ node, selected }: NodeViewProps) {
  const { url, error } = useAttachment(node.attrs.attachmentId)
  const [preview, setPreview] = useState(false)
  return (
    <NodeViewWrapper className={'note-image ' + (selected ? 'selected' : '')} data-drag-handle>
      {url ? (
        <img
          src={url}
          alt={node.attrs.alt || '图片'}
          loading="lazy"
          decoding="async"
          onClick={() => setPreview(true)}
          role="button"
          tabIndex={0}
          aria-label="查看图片"
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPreview(true)
          }}
        />
      ) : error ? (
        <div className="attachment-loading">
          <ImageOff size={20} />
          {error}
        </div>
      ) : (
        <div className="attachment-loading">
          <LoaderCircle className="spin" size={20} />
          正在读取图片
        </div>
      )}
      {preview && url && (
        <ImageViewer
          url={url}
          name={node.attrs.alt || '图片.png'}
          onClose={() => setPreview(false)}
        />
      )}
    </NodeViewWrapper>
  )
}
function FileView({ node, selected }: NodeViewProps) {
  const { url, error } = useAttachment(node.attrs.attachmentId)
  return (
    <NodeViewWrapper
      className={'file-attachment ' + (selected ? 'selected' : '')}
      contentEditable={false}
    >
      <span className="file-icon">
        <FileText size={22} />
      </span>
      <span>
        <strong>{node.attrs.name || '附件'}</strong>
        <small>{error || formatBytes(Number(node.attrs.size) || 0)}</small>
      </span>
      {url ? (
        <a
          href={url}
          download={node.attrs.name}
          aria-label={'下载 ' + node.attrs.name}
          onClick={async (e) => {
            e.preventDefault()
            try {
              const { downloadBlob } = await import('./export')
              await downloadBlob(await (await fetch(url)).blob(), node.attrs.name)
            } catch {}
          }}
        >
          <Download size={19} />
        </a>
      ) : (
        <LoaderCircle className="spin" size={18} />
      )}
    </NodeViewWrapper>
  )
}
export const LocalImage = ImageExtension.extend({
  addAttributes() {
    return { ...this.parent?.(), attachmentId: { default: null } }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
  renderMarkdown(node, helpers, context) {
    return this.parent?.({
      ...node,
      attrs: { ...node.attrs, alt: node.attrs?.alt || '图片', src: 'attachments/' + node.attrs?.attachmentId },
    }, helpers, context) ?? ''
  },
}).configure({ allowBase64: false })
export const FileAttachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { attachmentId: { default: null }, name: { default: '附件' }, size: { default: 0 } }
  },
  parseHTML() {
    return [{ tag: 'div[data-attachment]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-attachment': '' }),
      HTMLAttributes.name || '附件',
    ]
  },
  addNodeView() {
    return ReactNodeViewRenderer(FileView)
  },
  renderMarkdown(node) {
    const name = String(node.attrs?.name || '附件').replace(/[\\[\]]/g, '\\$&')
    return '[' + name + '](attachments/' + node.attrs?.attachmentId + ')'
  },
})
