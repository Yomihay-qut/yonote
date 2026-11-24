import i18n, { translateServerError } from './i18n'
import { advanceCursor, applyPull, applyReceipt, type NoteDB } from './store'
import type { Outbox, RecordData, Receipt, Session } from './types'

type SyncPushResponse = {
  receipts: Receipt[]
  nextCursor?: number
  hasOtherChanges?: boolean
}

const MAX_BATCH_COUNT = 50
const MAX_BATCH_BYTES = 2 * 1024 * 1024
const FOCUS_COOLDOWN_MS = 15_000

async function blobSha256(blob: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle?.digest || typeof blob.arrayBuffer !== 'function') return null
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function chunkOutbox(items: Outbox[]): Outbox[][] {
  const chunks: Outbox[][] = []
  let current: Outbox[] = []
  let bytes = 0
  for (const item of items) {
    const est = JSON.stringify(item.record).length + 128
    if (current.length > 0 && (current.length >= MAX_BATCH_COUNT || bytes + est > MAX_BATCH_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += est
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export async function api<T>(session: Session, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + session.token)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(session.base + path, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    let message = i18n.t('sync.serverRequestFailed', { status: res.status })
    try {
      const serverMsg = (await res.json()).error
      if (serverMsg) message = translateServerError(String(serverMsg))
    } catch {}
    throw Error(message)
  }
  return res.json()
}
export type SyncState = {
  status: 'local' | 'syncing' | 'synced' | 'offline' | 'error'
  message: string
  last?: string
}
export class SyncEngine {
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private retries = 0
  private lastSyncedAt = 0
  constructor(
    public db: NoteDB,
    public session: Session | null,
    public report: (s: SyncState) => void,
  ) {}
  start() {
    this.stopped = false
    window.addEventListener('online', this.online)
    window.addEventListener('focus', this.onFocus)
    this.schedule(100)
  }
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    window.removeEventListener('online', this.online)
    window.removeEventListener('focus', this.onFocus)
  }
  private online = () => this.schedule(100)
  private onFocus = () => {
    if (this.stopped) return
    if (Date.now() - this.lastSyncedAt >= FOCUS_COOLDOWN_MS) {
      this.schedule(100)
      return
    }
    void Promise.all([
      this.db.outbox.count(),
      this.db.attachments.where('uploaded').equals(0).count(),
    ])
      .then(([pending, files]) => {
        if (!this.stopped && (pending > 0 || files > 0)) this.schedule(100)
      })
      .catch(() => {})
  }
  schedule(ms = 650) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), ms)
  }
  private async sendChunk(chunk: Outbox[]): Promise<SyncPushResponse> {
    const cursor = Number((await this.db.meta.get('cursor'))?.value || 0)
    const res = await api<SyncPushResponse>(this.session!, '/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        mutations: chunk.map((sent) => ({
          opId: sent.opId,
          base: sent.base,
          record: sent.record,
        })),
        cursor,
        compact: true,
      }),
    })
    if (this.stopped) return res
    const byOp = new Map(res.receipts.map((r) => [r.opId, r]))
    for (let i = 0; i < chunk.length; i++) {
      const sent = chunk[i]
      const rec = byOp.get(sent.opId) ?? res.receipts[i]
      if (rec) await applyReceipt(this.db, sent, rec)
    }
    if (res.hasOtherChanges === false && typeof res.nextCursor === 'number') {
      await advanceCursor(this.db, res.nextCursor)
    }
    return res
  }
  async run() {
    if (this.running || this.stopped) return
    if (!this.session) {
      this.report({ status: 'local', message: i18n.t('sync.savedLocally') })
      return
    }
    if (!navigator.onLine) {
      this.report({ status: 'offline', message: i18n.t('sync.offlineQueued') })
      this.schedule(10000)
      return
    }
    this.running = true
    this.report({ status: 'syncing', message: i18n.t('sync.syncing') })
    try {
      let outgoingError: unknown
      let pushedAny = false
      let canSkipPull = false
      try {
        // Send active folders first, then other records in bounded batches so folders always exist before referencing notes.
        for (let pass = 0; pass < 8; pass++) {
          const batch = await this.db.outbox.toArray()
          if (!batch.length) break
          const activeFolders = batch.filter((a) => a.record.kind === 'folder' && !a.record.deletedAt)
          const rest = batch.filter((a) => !(a.record.kind === 'folder' && !a.record.deletedAt))
          const groups = [
            ...(activeFolders.length ? chunkOutbox(activeFolders) : []),
            ...(rest.length ? chunkOutbox(rest) : []),
          ]
          for (const chunk of groups) {
            if (this.stopped) return
            try {
              const res = await this.sendChunk(chunk)
              if (this.stopped) return
              pushedAny = true
              canSkipPull = res.hasOtherChanges === false && typeof res.nextCursor === 'number'
            } catch (e) {
              if (chunk.length > 1) {
                // Isolate a single malformed mutation so valid edits in the same batch still commit.
                for (const item of chunk) {
                  if (this.stopped) return
                  try {
                    const res = await this.sendChunk([item])
                    if (this.stopped) return
                    pushedAny = true
                    canSkipPull = res.hasOtherChanges === false && typeof res.nextCursor === 'number'
                  } catch (itemErr) {
                    outgoingError ??= itemErr
                    canSkipPull = false
                  }
                }
              } else {
                outgoingError ??= e
                canSkipPull = false
              }
            }
          }
          if (outgoingError) break
        }
      } catch (e) {
        outgoingError = e
        canSkipPull = false
      }
      const attachments = await this.db.attachments.where('uploaded').equals(0).toArray()
      for (const a of attachments) {
        if (this.stopped) return
        if (!a.blob) continue
        const record = await this.db.records.get(a.noteId)
        if (!record || record.dirty || record.deletedAt) continue
        try {
          const hash = a.hash && /^[0-9a-f]{64}$/i.test(a.hash) ? a.hash.toLowerCase() : await blobSha256(a.blob)
          if (hash) {
            try {
              const check = await api<{ exists?: boolean; hash?: string }>(
                this.session,
                '/api/attachments/check',
                {
                  method: 'POST',
                  body: JSON.stringify({ id: a.id, noteId: a.noteId, hash, filename: a.name }),
                },
              )
              if (this.stopped) return
              if (check.exists === true) {
                await this.db.attachments.update(a.id, { uploaded: 1, hash: check.hash || hash })
                continue
              }
            } catch {
              // Older server or transient check failure: fall through to standard multipart upload.
            }
          }
          const form = new FormData()
          form.set('file', a.blob, a.name)
          form.set('id', a.id)
          form.set('noteId', a.noteId)
          const res = await api<{ hash: string }>(this.session, '/api/attachments', {
            method: 'POST',
            body: form,
          })
          if (this.stopped) return
          await this.db.attachments.update(a.id, { uploaded: 1, hash: res.hash })
        } catch (e) {
          outgoingError ??= e
        }
      }
      if (!(pushedAny && !outgoingError && canSkipPull)) {
        let more = true
        while (more) {
          if (this.stopped) return
          const cursor = Number((await this.db.meta.get('cursor'))?.value || 0)
          const res = await api<{ records: RecordData[]; cursor: number; more: boolean }>(
            this.session,
            '/api/changes?cursor=' + cursor,
          )
          if (this.stopped) return
          await applyPull(this.db, res.records, res.cursor)
          more = res.more
        }
      }
      if (outgoingError) throw outgoingError
      this.retries = 0
      const pending = await this.db.outbox.count()
      if (!pending) this.lastSyncedAt = Date.now()
      this.report(
        pending
          ? { status: 'syncing', message: i18n.t('sync.partialSynced') }
          : { status: 'synced', message: i18n.t('sync.allSynced'), last: new Date().toISOString() },
      )
    } catch (e) {
      this.retries++
      this.report({
        status: navigator.onLine ? 'error' : 'offline',
        message: e instanceof Error ? translateServerError(e.message) : i18n.t('sync.retryLater'),
      })
    } finally {
      this.running = false
      if (!this.stopped)
        this.schedule(this.retries ? Math.min(60000, 2000 * 2 ** this.retries) : 60000)
    }
  }
}
