import { useEffect, useMemo, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { StickyNote, NotebookPen } from 'lucide-react'
import { editorExtensions } from './editor'
import { AttachmentContext } from './media'
import { normalizePaperToken } from './palette'
import { NoteDB, emptyDoc } from './store'
import { Empty } from './ui'
import type { RecordData } from './types'
const dateLabel = (s: string) => new Date(s).toLocaleDateString('zh-CN')
export default function PublicNote({ token }: { token: string }) {
  const [record, setRecord] = useState<RecordData | null>(null),
    [error, setError] = useState('')
  const db = useMemo(() => new NoteDB('yonote:public'), [])
  const editor = useEditor({ extensions: editorExtensions, editable: false, content: emptyDoc }, [])
  useEffect(() => {
    fetch('/api/public/' + token)
      .then(async (r) => {
        const v = await r.json()
        if (!r.ok) throw Error(v.error)
        setRecord(v)
        editor?.commands.setContent(v.value.content || emptyDoc, { emitUpdate: false })
      })
      .catch((e) => setError(e.message))
    return () => db.close()
  }, [token, editor])
  const paper = normalizePaperToken(record?.value.bgColor)
  return (
    <AttachmentContext.Provider value={{ db, session: null, publicToken: token }}>
      <div className="public-page-shell" data-paper={paper || undefined}>
        <div className="public-page">
          <header>
            <StickyNote size={22} />
            <span>便签</span>
            <small>只读分享</small>
          </header>
          {record ? (
            <article className="note-paper">
              <h1>{record.value.title || '未命名备忘'}</h1>
              <div className="note-meta">{dateLabel(record.updatedAt)}</div>
              <EditorContent editor={editor} />
            </article>
          ) : (
            <Empty
              icon={<NotebookPen />}
              title={error || '正在打开分享…'}
              text={error ? '请联系分享者获取新的链接' : ''}
            />
          )}
          <footer>便签</footer>
        </div>
      </div>
    </AttachmentContext.Provider>
  )
}
