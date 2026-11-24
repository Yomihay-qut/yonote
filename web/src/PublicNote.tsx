import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent } from '@tiptap/react'
import { StickyNote, NotebookPen } from 'lucide-react'
import { currentLocale, translateServerError } from './i18n'
import { editorExtensions } from './editor'
import { AttachmentContext } from './media'
import { normalizePaperToken } from './palette'
import { NoteDB, emptyDoc } from './store'
import { Empty } from './ui'
import type { RecordData } from './types'
export default function PublicNote({ token }: { token: string }) {
  const { t } = useTranslation()
  const [record, setRecord] = useState<RecordData | null>(null),
    [error, setError] = useState('')
  const db = useMemo(() => new NoteDB('yonote:public'), [])
  const editor = useEditor({ extensions: editorExtensions, editable: false, content: emptyDoc }, [])
  useEffect(() => {
    fetch('/api/public/' + token)
      .then(async (r) => {
        const v = await r.json()
        if (!r.ok) throw Error(translateServerError(v.error))
        setRecord(v)
        editor?.commands.setContent(v.value.content || emptyDoc, { emitUpdate: false })
      })
      .catch((e) => setError(translateServerError(e.message)))
    return () => db.close()
  }, [token, editor])
  const paper = normalizePaperToken(record?.value.bgColor)
  return (
    <AttachmentContext.Provider value={{ db, session: null, publicToken: token }}>
      <div className="public-page-shell" data-paper={paper || undefined}>
        <div className="public-page">
          <header>
            <StickyNote size={22} />
            <span>{t('app.name')}</span>
            <small>{t('app.publicReadonly')}</small>
          </header>
          {record ? (
            <article className="note-paper">
              <h1>{record.value.title || t('notes.untitledNote')}</h1>
              <div className="note-meta">{new Date(record.updatedAt).toLocaleDateString(currentLocale())}</div>
              <EditorContent editor={editor} />
            </article>
          ) : (
            <Empty
              icon={<NotebookPen />}
              title={error || t('public.opening')}
              text={error ? t('public.askSharer') : ''}
            />
          )}
          <footer>{t('app.name')}</footer>
        </div>
      </div>
    </AttachmentContext.Provider>
  )
}
