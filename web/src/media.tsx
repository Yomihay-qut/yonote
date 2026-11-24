import { useEffect, useRef, useState, createContext, useContext } from 'react'
import { v7 as uuid } from 'uuid'
import i18n from './i18n'
import type { Attachment, Session } from './types'
import type { NoteDB } from './store'
export const AttachmentContext = createContext<{
  db: NoteDB
  session: Session | null
  publicToken?: string
} | null>(null)
export function useAttachment(id: string | undefined, thumbnail = false, enabled = true) {
  const ctx = useContext(AttachmentContext)
  const [state, set] = useState<{ url?: string; error?: string }>({})
  useEffect(() => {
    if (!ctx || !id || !enabled) return
    set({})
    let live = true
    let url = ''
    const controller = new AbortController()
    void (async () => {
      try {
        let file = await ctx.db.attachments.get(id)
        let blob = thumbnail ? file?.thumbnail || file?.blob : file?.blob
        if (!blob) {
          if (!ctx.session && !ctx.publicToken) throw Error(i18n.t('media.connectToDownload'))
          const base = ctx.session?.base || ''
          const path = ctx.publicToken
            ? '/api/public/' + ctx.publicToken + '/attachments/' + id
            : '/api/attachments/' + id
          const res = await fetch(base + path, {
            headers: ctx.session ? { Authorization: 'Bearer ' + ctx.session.token } : {},
            signal: controller.signal,
          })
          if (!res.ok) throw Error(i18n.t('media.retryAttachment'))
          blob = await res.blob()
          if (ctx.session) {
            if (file) await ctx.db.attachments.update(id, { blob })
            else
              await ctx.db.attachments.put({
                id,
                noteId: '',
                name: i18n.t('media.attachment'),
                mime: blob.type,
                size: blob.size,
                blob,
                uploaded: 1,
              })
          }
        }
        if (thumbnail && blob && !file?.thumbnail) {
          const small = await makeThumbnail(blob)
          if (small) {
            blob = small
            if (ctx.session || file) await ctx.db.attachments.update(id, { thumbnail: small })
          }
        }
        if (live) {
          url = URL.createObjectURL(blob)
          set({ url })
        }
      } catch (e) {
        if (live) set({ error: e instanceof Error ? e.message : i18n.t('media.loadFailed') })
      }
    })()
    return () => {
      live = false
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [ctx?.db, ctx?.session?.token, id, ctx?.publicToken, thumbnail, enabled])
  return state
}
export async function addFile(
  db: NoteDB,
  noteId: string,
  file: File,
  original = false,
): Promise<Attachment> {
  if (file.size > 50 * 1024 * 1024) throw Error(i18n.t('media.fileTooLarge'))
  let blob: Blob = file
  if (!original && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    const image = await createImageBitmap(file)
    try {
      const scale = Math.min(1, 2560 / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(image.width * scale)
      canvas.height = Math.round(image.height * scale)
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const compressed = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.88),
      )
      if (compressed && compressed.size < file.size) blob = compressed
    } finally {
      image.close()
    }
  }
  const out: Attachment = {
    id: uuid(),
    noteId,
    name: file.name,
    mime: blob.type,
    size: blob.size,
    blob,
    thumbnail: blob.type.startsWith('image/') ? await makeThumbnail(blob) : undefined,
    uploaded: 0,
  }
  await db.attachments.put(out)
  return out
}
async function makeThumbnail(blob: Blob): Promise<Blob | undefined> {
  if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return
  try {
    const image = await createImageBitmap(blob)
    try {
      const ratio = Math.min(1, 320 / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * ratio))
      canvas.height = Math.max(1, Math.round(image.height * ratio))
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
      return (
        (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.76))) ||
        undefined
      )
    } finally {
      image.close()
    }
  } catch {
    return
  }
}
export function AttachmentThumb({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null),
    [visible, setVisible] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '160px' },
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [id])
  const { url } = useAttachment(id, true, visible)
  return (
    <span ref={ref} className="card-thumbnail" aria-hidden="true">
      {url && <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />}
    </span>
  )
}
export function formatBytes(n: number) {
  if (n < 1024) return n + ' B'
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return (n / 1024 ** 3).toFixed(2) + ' GB'
}
