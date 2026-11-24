import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferedSave, flushEdits } from './buffered-save'
import { applyPull, NoteDB, save } from './store'
import { firstImage, groupRecords, moveRecord, sortRecords, summarize } from './list-model'
import type { LocalRecord } from './types'

const databases: NoteDB[] = []
const writers: BufferedSave[] = []
const makeDB = (name = 'front-' + crypto.randomUUID()) => {
  const db = new NoteDB(name)
  databases.push(db)
  return db
}
const note = (id: string, title = id): LocalRecord => ({
  id,
  kind: 'note',
  version: 1,
  rev: 1,
  dirty: 0,
  updatedAt: '2026-11-17T10:00:00Z',
  deletedAt: null,
  value: {
    title,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '一份很长的笔记正文。'.repeat(1200) }],
        },
        { type: 'image', attrs: { attachmentId: 'image-one' } },
      ],
    },
    plainText: '一份很长的笔记正文。'.repeat(1200),
  },
})
afterEach(async () => {
  for (const writer of writers.splice(0)) await writer.dispose()
  vi.useRealTimers()
  await Promise.all(databases.splice(0).map((db) => db.delete()))
})

describe('editor persistence without per-keystroke serialization', () => {
  it('coalesces a continuous burst, bounds delay, and persists the final input', async () => {
    vi.useFakeTimers()
    let input = ''
    const values: string[] = []
    const writer = new BufferedSave(
      async () => {
        values.push(input)
      },
      () => {},
    )
    writers.push(writer)
    for (let i = 0; i < 100; i++) {
      input += '字'
      writer.schedule()
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(values.length).toBe(1)
    expect(values[0].length).toBeGreaterThanOrEqual(79)
    await vi.advanceTimersByTimeAsync(240)
    expect(values.map((v) => v.length)).toEqual([80, 100])
  })
  it('flushes immediately before unmount and reads the snapshot synchronously', async () => {
    vi.useFakeTimers()
    let alive = true
    let text = '最后一句'
    let saved = ''
    const writer = new BufferedSave(
      async () => {
        if (!alive) throw Error('editor destroyed')
        saved = text
      },
      () => {},
    )
    writers.push(writer)
    writer.schedule()
    text = '最后一句，含刚输入的字'
    const result = writer.dispose()
    alive = false
    await result
    expect(saved).toBe(text)
    await vi.advanceTimersByTimeAsync(1000)
    expect(saved).toBe(text)
  })
  it('keeps failed work pending and blocks navigation until a later retry succeeds', async () => {
    vi.useFakeTimers()
    let failed = true
    let saved = ''
    const error = vi.fn()
    const writer = new BufferedSave(async () => {
      if (failed) throw Error('quota')
      saved = '完整内容'
    }, error)
    writers.push(writer)
    writer.schedule()
    await expect(writer.flush()).rejects.toThrow('quota')
    expect(writer.hasPending).toBe(true)
    expect(error).toHaveBeenCalledTimes(1)
    failed = false
    await writer.flush()
    expect(saved).toBe('完整内容')
    expect(writer.hasPending).toBe(false)
  })
  it('flushes all open editors before a workspace switch', async () => {
    vi.useFakeTimers()
    const saveA = vi.fn(async () => {}),
      saveB = vi.fn(async () => {})
    for (const save of [saveA, saveB]) {
      const writer = new BufferedSave(save, () => {})
      writers.push(writer)
      writer.schedule()
    }
    await flushEdits()
    expect(saveA).toHaveBeenCalledTimes(1)
    expect(saveB).toHaveBeenCalledTimes(1)
  })
})
describe('compact record projections and safe upgrade', () => {
  it('upgrades an existing v1 database atomically while retaining full content and queued work', async () => {
    const name = 'upgrade-' + crypto.randomUUID()
    const old = new Dexie(name)
    old.version(1).stores({
      records: 'id,kind,dirty,updatedAt',
      outbox: 'id,opId',
      attachments: 'id,noteId,uploaded',
      meta: 'key',
    })
    const original = note('existing-note')
    await old.table('records').put(original)
    await old
      .table('outbox')
      .put({ id: original.id, opId: 'still-pending', base: 0, rev: 1, record: original })
    old.close()
    const db = makeDB(name)
    await db.open()
    expect(await db.records.get(original.id)).toEqual(original)
    expect((await db.outbox.get(original.id))?.opId).toBe('still-pending')
    const small = (await db.summaries.get(original.id))!
    expect(small.value.content).toBeUndefined()
    expect(small.value.plainText?.length).toBe(160)
    expect(small.thumbnailId).toBe('image-one')
    expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(original).length * 0.05)
  })
  it('updates the list projection on writes and sync without losing full-text search content', async () => {
    const db = makeDB()
    const r = note('note-one')
    await applyPull(db, [r], 1)
    await save(db, r.id, 'note', { title: '新标题', plainText: r.value.plainText + '尾部关键词' })
    expect((await db.summaries.get(r.id))?.value.title).toBe('新标题')
    expect((await db.records.get(r.id))?.value.plainText).toContain('尾部关键词')
    expect((await db.summaries.get(r.id))?.value.content).toBeUndefined()
  })
  it('preserves the edit-start version when a remote revision arrives before buffered save', async () => {
    const db = makeDB()
    const r = note('concurrent')
    r.version = 7
    await applyPull(db, [r], 7)
    await applyPull(db, [{ ...r, version: 11, value: { ...r.value, title: '另一端改动' } }], 11)
    await save(db, r.id, 'note', { title: '输入中的本机改动' }, undefined, 7)
    expect((await db.outbox.get(r.id))?.base).toBe(7)
    expect((await db.records.get(r.id))?.value.title).toBe('输入中的本机改动')
  })
})
describe('list operations', () => {
  it('sorts without mutating inputs and keeps pins first', () => {
    const a = summarize(note('a', '乙')),
      b = summarize(note('b', '甲'))
    a.value.pinned = true
    expect(sortRecords([b, a], 'title').map((r) => r.id)).toEqual(['a', 'b'])
    expect([b, a].map((r) => r.id)).toEqual(['b', 'a'])
  })
  it('groups today, yesterday and months with pinned entries separate', () => {
    const r = [note('pin'), note('today'), note('yesterday'), note('old')].map(summarize)
    r[0].value.pinned = true
    r[1].updatedAt = new Date(2026, 10, 17, 9).toISOString()
    r[2].updatedAt = new Date(2026, 10, 16, 22).toISOString()
    r[3].updatedAt = new Date(2026, 9, 3).toISOString()
    expect(groupRecords(r, true, new Date(2026, 10, 17, 12)).map((g) => g.label)).toEqual([
      '置顶',
      '今天',
      '昨天',
      '2026年10月',
    ])
    expect(groupRecords(r, false)[0].records).toHaveLength(4)
  })
  it('supports dropping above or below the adjacent card while preserving pinned groups', () => {
    const items = ['a', 'b', 'c'].map((id) => summarize(note(id)))
    expect(moveRecord(items, 'c', 'a', 'before').map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(moveRecord(items, 'a', 'b', 'after').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(moveRecord(items, 'a', 'b', 'before')).toBe(items)
    expect(moveRecord(items, 'missing', 'a', 'after')).toBe(items)
    items[0].value.pinned = true
    expect(moveRecord(items, 'a', 'b', 'after')).toBe(items)
    expect(firstImage(note('a').value.content)).toBe('image-one')
  })
})

import { computeDiff } from './diff'

describe('history diff engine', () => {
  it('computes line and inline character diffs accurately', () => {
    const oldText = '第一行\n姓名：张三\n性别：男\n最后一行'
    const newText = '第一行\n姓名：李四\n性别：男\n新增行\n最后一行'
    const d = computeDiff(oldText, newText)
    expect(d.identical).toBe(false)
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    const changeRow = d.rows.find((r) => r.kind === 'change')
    expect(changeRow?.left?.text).toBe('姓名：张三')
    expect(changeRow?.right?.text).toBe('姓名：李四')
    expect(changeRow?.left?.parts?.some((p) => p.changed && p.text.includes('张三'))).toBe(true)
    expect(changeRow?.right?.parts?.some((p) => p.changed && p.text.includes('李四'))).toBe(true)
    expect(computeDiff(newText, newText).identical).toBe(true)
  })
})
