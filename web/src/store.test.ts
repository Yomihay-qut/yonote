import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPull, applyReceipt, dbName, deleteFolder, initialize, NoteDB, save } from './store'
import type { RecordData, Session } from './types'

const opened: NoteDB[] = []
function database(suffix = '') {
  const db = new NoteDB('test-yonote-' + crypto.randomUUID() + suffix)
  opened.push(db)
  return db
}
const timestamp = '2026-11-17T10:00:00.000Z'
function record(id = 'note-one', version = 1, title = '服务器记录'): RecordData {
  return {
    id,
    kind: 'note',
    version,
    updatedAt: timestamp,
    deletedAt: null,
    value: { title, plainText: title, folderId: '' },
  }
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.delete()))
})

describe('durable outbox acknowledgement', () => {
  it('retains edits made while an earlier revision is in flight and rebases the queued mutation', async () => {
    const db = database()
    await applyPull(db, [record('note-one', 7, '原始内容')], 7)
    await save(db, 'note-one', 'note', { title: '正在上传的版本' })
    const inFlight = (await db.outbox.get('note-one'))!
    expect(inFlight.base).toBe(7)
    await save(db, 'note-one', 'note', { title: '上传期间继续写', plainText: '第二次本机编辑' })
    const newer = (await db.outbox.get('note-one'))!
    expect(newer.opId).not.toBe(inFlight.opId)
    await applyReceipt(db, inFlight, {
      opId: inFlight.opId,
      record: record('note-one', 11, '正在上传的版本'),
    })
    const local = (await db.records.get('note-one'))!
    const next = (await db.outbox.get('note-one'))!
    expect(local.value.title).toBe('上传期间继续写')
    expect(local.value.plainText).toBe('第二次本机编辑')
    expect(local.dirty).toBe(1)
    expect(local.version).toBe(11)
    expect(local.rev).toBe(newer.rev)
    expect(next.base).toBe(11)
    expect(next.opId).not.toBe(inFlight.opId)
    expect(next.opId).not.toBe(newer.opId)
    expect(next.record.value.title).toBe('上传期间继续写')
    expect(next.record.version).toBe(11)
    await applyReceipt(db, next, {
      opId: next.opId,
      record: record('note-one', 12, '上传期间继续写'),
    })
    expect((await db.records.get('note-one'))?.dirty).toBe(0)
    expect(await db.outbox.get('note-one')).toBeUndefined()
  })

  it('clears only the exact acknowledged operation and stores a conflict copy as an independent clean note', async () => {
    const db = database()
    await save(db, 'note-one', 'note', { title: '本机内容' })
    const sent = (await db.outbox.get('note-one'))!
    const conflict = record('conflict-copy', 8, '另一设备内容（冲突副本）')
    await applyReceipt(db, sent, {
      opId: sent.opId,
      record: record('note-one', 9, '本机内容'),
      conflict,
    })
    expect(await db.outbox.count()).toBe(0)
    expect(await db.records.get('note-one')).toMatchObject({
      version: 9,
      dirty: 0,
      value: { title: '本机内容' },
    })
    expect(await db.records.get('conflict-copy')).toMatchObject({ ...conflict, dirty: 0 })
    await save(db, 'conflict-copy', 'note', { title: '手动合并后' })
    expect((await db.records.get('note-one'))?.value.title).toBe('本机内容')
    expect((await db.outbox.get('conflict-copy'))?.base).toBe(8)
  })
})

describe('incremental pull', () => {
  it('keeps pending local changes, ignores older snapshots and advances the cursor', async () => {
    const db = database()
    await applyPull(db, [record('dirty-note', 5, '旧正文'), record('clean-note', 7, '较新正文')], 7)
    await save(db, 'dirty-note', 'note', { title: '离线编辑', plainText: '离线编辑正文' })
    const outbox = await db.outbox.get('dirty-note')
    await applyPull(
      db,
      [
        record('dirty-note', 10, '远端编辑'),
        record('clean-note', 4, '过时正文'),
        record('new-note', 11, '新备忘'),
      ],
      11,
    )
    expect(await db.records.get('dirty-note')).toMatchObject({
      version: 5,
      dirty: 1,
      value: { title: '离线编辑', plainText: '离线编辑正文' },
    })
    expect(await db.outbox.get('dirty-note')).toEqual(outbox)
    expect(await db.records.get('clean-note')).toMatchObject({
      version: 7,
      value: { title: '较新正文' },
    })
    expect(await db.records.get('new-note')).toMatchObject({ version: 11, dirty: 0 })
    expect((await db.meta.get('cursor'))?.value).toBe(11)
  })

  it('commits pulled rows and their cursor atomically, rolling back a malformed batch', async () => {
    const db = database()
    await applyPull(db, [record('kept-note', 3, '已有备忘')], 3)
    const invalid = { ...record('invalid-note', 5), id: undefined } as unknown as RecordData
    await expect(applyPull(db, [record('new-note', 4), invalid], 5)).rejects.toBeDefined()
    expect(await db.records.get('new-note')).toBeUndefined()
    expect((await db.records.get('kept-note'))?.version).toBe(3)
    expect((await db.meta.get('cursor'))?.value).toBe(3)
  })
})

describe('workspace and folder isolation', () => {
  it('separates records and outboxes by server and account namespace', async () => {
    function session(base: string, id: string): Session {
      return {
        base,
        token: 'unused',
        user: { id, username: id, admin: false, quota: 2 * 1024 ** 3, used: 0, disabled: false },
      }
    }
    const a = session('https://a.example', 'alice'),
      b = session('https://a.example', 'bob'),
      c = session('https://b.example', 'alice')
    expect(new Set([dbName(a), dbName(b), dbName(c), dbName(null)]).size).toBe(4)
    const prefix = 'isolation-' + crypto.randomUUID()
    const alice = new NoteDB(prefix + dbName(a)),
      bob = new NoteDB(prefix + dbName(b))
    opened.push(alice, bob)
    await save(alice, 'same-id', 'note', { title: 'Alice 私人内容' })
    await save(bob, 'same-id', 'note', { title: 'Bob 私人内容' })
    expect((await alice.records.get('same-id'))?.value.title).toBe('Alice 私人内容')
    expect((await bob.records.get('same-id'))?.value.title).toBe('Bob 私人内容')
    await alice.outbox.clear()
    expect(await bob.outbox.count()).toBe(1)
  })

  it('seeds separate local folder systems once and leaves cloud workspaces empty until pull', async () => {
    const local = database(),
      cloud = database()
    await initialize(local, true)
    await initialize(local, true)
    const folders = await local.records.where('kind').equals('folder').toArray()
    const noteFolders = folders.filter((f) => f.value.module === 'note'),
      todoFolders = folders.filter((f) => f.value.module === 'todo')
    expect(noteFolders.map((f) => f.value.name).sort()).toEqual(['个人', '工作', '购物'].sort())
    expect(todoFolders.map((f) => f.value.name).sort()).toEqual(['个人', '工作', '购物'].sort())
    expect(new Set(folders.map((f) => f.id)).size).toBe(6)
    expect(await local.records.count()).toBe(6)
    expect(await local.records.where('kind').equals('note').count()).toBe(0)
    await initialize(cloud, false)
    expect(await cloud.records.count()).toBe(0)
    expect(await cloud.outbox.count()).toBe(0)
    expect((await cloud.meta.get('initialized'))?.value).toBe(true)
  })

  it('deleting a note folder moves only its notes to Default and leaves a same-named todo folder intact', async () => {
    const db = database()
    await initialize(db, true)
    const folders = await db.records.where('kind').equals('folder').toArray()
    const noteFolder = folders.find((f) => f.value.module === 'note' && f.value.name === '工作')!
    const todoFolder = folders.find((f) => f.value.module === 'todo' && f.value.name === '工作')!
    await save(db, 'work-note', 'note', { title: '工作备忘', folderId: noteFolder.id })
    await save(db, 'work-todo', 'todo', { title: '工作待办', folderId: todoFolder.id, done: false })
    await deleteFolder(db, noteFolder.id)
    expect((await db.records.get(noteFolder.id))?.deletedAt).toBeTruthy()
    expect((await db.records.get(todoFolder.id))?.deletedAt).toBeNull()
    expect((await db.records.get('work-note'))?.value.folderId).toBe('')
    expect((await db.records.get('work-todo'))?.value.folderId).toBe(todoFolder.id)
    expect((await db.outbox.get('work-note'))?.record.value.folderId).toBe('')
  })
})

describe('content-hash deduplication and compact receipts', () => {
  it('skips outbox on unchanged save and clears dirty state when reverted to synced content', async () => {
    const db = database()
    await applyPull(db, [record('hash-note', 5, '原始标题')], 5)
    // Saving identical content does not enqueue anything.
    await save(db, 'hash-note', 'note', { title: '原始标题', plainText: '原始标题' })
    expect(await db.outbox.get('hash-note')).toBeUndefined()
    expect((await db.records.get('hash-note'))?.dirty).toBe(0)

    // Edit creates outbox entry; reverting back to exact synced content clears outbox & dirty.
    await save(db, 'hash-note', 'note', { title: '临时改一下', plainText: '临时改一下' })
    expect(await db.outbox.get('hash-note')).toBeDefined()
    expect((await db.records.get('hash-note'))?.dirty).toBe(1)

    await save(db, 'hash-note', 'note', { title: '原始标题', plainText: '原始标题' })
    expect(await db.outbox.get('hash-note')).toBeUndefined()
    expect((await db.records.get('hash-note'))?.dirty).toBe(0)
  })

  it('applies compact receipts without full record bodies and persists ownAckedVersion floor', async () => {
    const db = database()
    await save(db, 'compact-note', 'note', { title: '精简回执测试' })
    const sent = (await db.outbox.get('compact-note'))!
    await applyReceipt(db, sent, {
      opId: sent.opId,
      id: 'compact-note',
      version: 20,
      updatedAt: timestamp,
    })
    const local = (await db.records.get('compact-note'))!
    expect(local.dirty).toBe(0)
    expect(local.version).toBe(20)
    expect(local.ownAckedVersion).toBe(20)
    expect(local.syncedHash).toBeTruthy()
    expect(await db.outbox.count()).toBe(0)

    // Even if a stale baseVersion (e.g. 5) is passed, persisted ownAckedVersion floor keeps base >= 20.
    await save(db, 'compact-note', 'note', { title: '继续编辑' }, undefined, 5)
    expect((await db.outbox.get('compact-note'))?.base).toBe(20)
  })
})
