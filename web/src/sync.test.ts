import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPull, applyReceipt, NoteDB, save } from './store'
import { SyncEngine, type SyncState } from './sync'
import type { Outbox, RecordData, Session } from './types'

const opened: NoteDB[] = []
const engines: SyncEngine[] = []
const session: Session = {
  base: 'https://notes.example',
  token: 'device-secret',
  user: {
    id: 'account-a',
    username: 'tester',
    admin: false,
    quota: 2 * 1024 ** 3,
    used: 0,
    disabled: false,
  },
}
const timestamp = '2026-11-17T10:00:00.000Z'
function record(id: string, version = 1, title = 'server note'): RecordData {
  return {
    id,
    kind: 'note',
    version,
    updatedAt: timestamp,
    deletedAt: null,
    value: { title, plainText: title, folderId: '' },
  }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
function setup() {
  const db = new NoteDB('sync-test-' + crypto.randomUUID())
  opened.push(db)
  const states: SyncState[] = []
  const engine = new SyncEngine(db, session, (s) => states.push(s))
  engines.push(engine)
  vi.spyOn(engine, 'schedule').mockImplementation(() => {})
  return { db, states, engine }
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', { onLine: true })
})
afterEach(async () => {
  engines.splice(0).forEach((e) => e.stop())
  await Promise.all(opened.splice(0).map((db) => db.delete()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('actual sync engine network flow', () => {
  it('pushes folders before notes, authenticates, uploads attachments after note acknowledgement and consumes all pull pages', async () => {
    const { db, states, engine } = setup()
    await save(db, 'a-note', 'note', { title: 'offline note', folderId: 'z-folder' })
    await save(db, 'z-folder', 'folder', { name: '工作', module: 'note' })
    const blob = new Blob(['local attachment'], { type: 'text/plain' })
    await db.attachments.put({
      id: 'attachment-a',
      noteId: 'a-note',
      name: 'example.txt',
      mime: 'text/plain',
      size: blob.size,
      blob,
      uploaded: 0,
    })
    const order: string[] = []
    let version = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(session.base, '')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer ' + session.token)
      if (path === '/api/sync') {
        expect(headers.get('Content-Type')).toBe('application/json')
        const mutation = JSON.parse(String(init?.body)).mutations[0]
        order.push(mutation.record.kind)
        return json({
          receipts: [
            {
              opId: mutation.opId,
              record: { ...mutation.record, version: ++version, updatedAt: timestamp },
            },
          ],
        })
      }
      if (path === '/api/attachments/check') {
        return json({ exists: false })
      }
      if (path === '/api/attachments') {
        order.push('attachment')
        expect((await db.records.get('a-note'))?.dirty).toBe(0)
        expect(await db.outbox.count()).toBe(0)
        expect(init?.body).toBeInstanceOf(FormData)
        const form = init?.body as FormData
        expect(form.get('noteId')).toBe('a-note')
        expect(form.get('id')).toBe('attachment-a')
        expect(await (form.get('file') as Blob).text()).toBe('local attachment')
        return json({ hash: 'content-hash' })
      }
      order.push('pull')
      if (path === '/api/changes?cursor=0')
        return json({
          records: [record('remote-a', 5, 'first remote note')],
          cursor: 5,
          more: true,
        })
      expect(path).toBe('/api/changes?cursor=5')
      return json({
        records: [record('remote-b', 8, 'second remote note')],
        cursor: 8,
        more: false,
      })
    })
    vi.stubGlobal('fetch', fetcher)
    await engine.run()
    expect(order).toEqual(['folder', 'note', 'attachment', 'pull', 'pull'])
    expect(await db.outbox.count()).toBe(0)
    expect(await db.attachments.get('attachment-a')).toMatchObject({
      uploaded: 1,
      hash: 'content-hash',
    })
    expect((await db.records.get('remote-b'))?.value.title).toBe('second remote note')
    expect((await db.meta.get('cursor'))?.value).toBe(8)
    expect(states.at(-1)?.status).toBe('synced')
  })

  it('retains the exact durable mutation after a lost response and retries it idempotently', async () => {
    const { db, states, engine } = setup()
    await save(db, 'offline-note', 'note', { title: 'must survive network loss' })
    const queued = (await db.outbox.get('offline-note'))!
    let tries = 0
    const operations: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/sync')) {
          const m = JSON.parse(String(init?.body)).mutations[0]
          operations.push(m.opId)
          if (++tries === 1) throw Error('response lost')
          return json({ receipts: [{ opId: m.opId, record: { ...m.record, version: 12 } }] })
        }
        return json({ records: [], cursor: 0, more: false })
      }),
    )
    await engine.run()
    expect(states.at(-1)).toMatchObject({ status: 'error', message: 'response lost' })
    expect(await db.outbox.get('offline-note')).toEqual(queued)
    expect((await db.records.get('offline-note'))?.dirty).toBe(1)
    await engine.run()
    expect(operations).toEqual([queued.opId, queued.opId])
    expect(await db.outbox.count()).toBe(0)
    expect((await db.records.get('offline-note'))?.version).toBe(12)
    expect(states.at(-1)?.status).toBe('synced')
  })

  it('keeps uploads pending after a quota error while still receiving other-device edits and retrying later', async () => {
    const { db, states, engine } = setup()
    await applyPull(db, [record('attachment-note', 3)], 3)
    const blob = new Blob(['pending file'], { type: 'text/plain' })
    await db.attachments.put({
      id: 'pending-file',
      noteId: 'attachment-note',
      name: 'pending.txt',
      mime: 'text/plain',
      size: blob.size,
      blob,
      uploaded: 0,
    })
    let uploads = 0
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).replace(session.base, '')
        if (path === '/api/attachments/check') return json({ exists: false })
        calls.push(path)
        if (path === '/api/attachments') {
          uploads++
          return uploads === 1
            ? json({ error: '账号存储空间不足' }, 413)
            : json({ hash: 'retry-hash' })
        }
        return json({
          records: [record('remote-edit', 9, 'arrived despite quota failure')],
          cursor: 9,
          more: false,
        })
      }),
    )
    await engine.run()
    expect(calls).toEqual(['/api/attachments', '/api/changes?cursor=3'])
    expect((await db.records.get('remote-edit'))?.value.title).toBe('arrived despite quota failure')
    expect((await db.attachments.get('pending-file'))?.uploaded).toBe(0)
    expect(states.at(-1)).toMatchObject({ status: 'error', message: '账号存储空间不足' })
    await engine.run()
    expect((await db.attachments.get('pending-file'))?.uploaded).toBe(1)
    expect(states.at(-1)?.status).toBe('synced')
  })

  it('receives incoming changes even when a malformed outgoing record is rejected, preserving its pending copy', async () => {
    const { db, states, engine } = setup()
    await save(db, 'pending-note', 'note', { title: 'pending body' })
    const pending = await db.outbox.get('pending-note')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/sync')
          ? json({ error: '请先同步文件夹' }, 400)
          : json({
              records: [record('other-note', 8, 'new incoming content')],
              cursor: 8,
              more: false,
            }),
      ),
    )
    await engine.run()
    expect(await db.outbox.get('pending-note')).toEqual(pending)
    expect((await db.records.get('other-note'))?.value.title).toBe('new incoming content')
    expect(states.at(-1)).toMatchObject({ status: 'error', message: '请先同步文件夹' })
  })

  it('performs no network requests offline and leaves every local edit durable', async () => {
    const { db, states, engine } = setup()
    await save(db, 'offline-note', 'note', { title: '地铁里写下的记录' })
    vi.stubGlobal('navigator', { onLine: false })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await engine.run()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await db.outbox.count()).toBe(1)
    expect(states.at(-1)?.status).toBe('offline')
  })

  it('batches notes in one /api/sync call, skips echo pull via nextCursor, and instant-dedups attachments', async () => {
    const { db, states, engine } = setup()
    await save(db, 'note-batch-1', 'note', { title: '笔记一' })
    await save(db, 'note-batch-2', 'note', { title: '笔记二' })
    const blob = new Blob(['same-image-bytes'], { type: 'image/png' })
    await db.attachments.put({
      id: 'att-dedup-1',
      noteId: 'note-batch-1',
      name: 'pic.png',
      mime: 'image/png',
      size: blob.size,
      blob,
      uploaded: 0,
    })
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(session.base, '')
      calls.push(path)
      if (path === '/api/sync') {
        const body = JSON.parse(String(init?.body))
        expect(body.compact).toBe(true)
        expect(body.cursor).toBe(0)
        expect(body.mutations).toHaveLength(2)
        return json({
          receipts: body.mutations.map((m: { opId: string; record: RecordData }, idx: number) => ({
            opId: m.opId,
            id: m.record.id,
            version: 10 + idx,
            updatedAt: timestamp,
          })),
          nextCursor: 11,
          hasOtherChanges: false,
        })
      }
      if (path === '/api/attachments/check') {
        const body = JSON.parse(String(init?.body))
        expect(body.id).toBe('att-dedup-1')
        expect(body.hash).toMatch(/^[0-9a-f]{64}$/)
        return json({ exists: true, hash: body.hash })
      }
      throw Error('unexpected endpoint: ' + path)
    })
    vi.stubGlobal('fetch', fetcher)
    await engine.run()
    expect(calls).toEqual(['/api/sync', '/api/attachments/check'])
    expect(await db.outbox.count()).toBe(0)
    expect((await db.meta.get('cursor'))?.value).toBe(11)
    expect((await db.attachments.get('att-dedup-1'))?.uploaded).toBe(1)
    expect(states.at(-1)?.status).toBe('synced')
  })
})

describe('late receipt safety across tabs', () => {
  it('preserves local edits in a conflict copy when another tab receives a duplicate original receipt', async () => {
    const { db } = setup()
    await save(db, 'original-note', 'note', { title: 'new version' })
    const sent = (await db.outbox.get('original-note'))!
    const result = {
      opId: sent.opId,
      record: record('original-note', 10, 'new version'),
      conflict: record('conflict-note', 9, 'displaced version（冲突副本）'),
    }
    await applyReceipt(db, sent, result)
    await save(db, 'conflict-note', 'note', {
      title: '正在手工合并冲突',
      plainText: 'new handwritten merge',
    })
    const queued = await db.outbox.get('conflict-note')
    await applyReceipt(db, sent, result)
    expect(await db.records.get('conflict-note')).toMatchObject({
      dirty: 1,
      value: { title: '正在手工合并冲突', plainText: 'new handwritten merge' },
    })
    expect(await db.outbox.get('conflict-note')).toEqual(queued)
  })

  it('does not rebase a newer pending edit backwards when an older receipt arrives late', async () => {
    const { db } = setup()
    await applyPull(db, [record('original-note', 12, 'latest acknowledged')], 12)
    await save(db, 'original-note', 'note', { title: 'next local edit' })
    const pending = (await db.outbox.get('original-note'))!
    const oldSent: Outbox = {
      id: 'original-note',
      opId: 'old-operation',
      base: 7,
      rev: 1,
      record: record('original-note', 7, 'old sent body'),
    }
    await applyReceipt(db, oldSent, {
      opId: oldSent.opId,
      record: record('original-note', 10, 'old acknowledged'),
    })
    expect(await db.outbox.get('original-note')).toEqual(pending)
    expect(await db.records.get('original-note')).toMatchObject({
      version: 12,
      dirty: 1,
      value: { title: 'next local edit' },
    })
  })
})
