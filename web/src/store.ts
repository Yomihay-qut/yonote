import Dexie, { type Table } from 'dexie'
import { summarize } from './list-model'
import { v7 as uuid } from 'uuid'
import type {
  Attachment,
  Doc,
  LocalRecord,
  RecordSummary,
  Module,
  Outbox,
  Receipt,
  RecordData,
  Session,
  Value,
} from './types'

export const emptyDoc: Doc = { type: 'doc', content: [{ type: 'paragraph' }] }
export function textDoc(text: string): Doc {
  return {
    type: 'doc',
    content: text
      .split('\n')
      .map((t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })),
  }
}
export class NoteDB extends Dexie {
  records!: Table<LocalRecord, string>
  summaries!: Table<RecordSummary, string>
  outbox!: Table<Outbox, string>
  attachments!: Table<Attachment, string>
  meta!: Table<{ key: string; value: any }, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({
      records: 'id,kind,dirty,updatedAt',
      outbox: 'id,opId',
      attachments: 'id,noteId,uploaded',
      meta: 'key',
    })
    this.version(2)
      .stores({ summaries: 'id,kind,updatedAt' })
      .upgrade(async (tx) => {
        const records = await tx.table('records').toArray()
        await tx.table('summaries').bulkPut(records.map(summarize))
      })
  }
}
export function normalizeBase(s: string) {
  const v = s.trim().replace(/\/+$/, '')
  if (!v) return ''
  const u = new URL(v)
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
  )
    throw Error('服务器请使用 HTTPS 地址')
  if (u.username || u.password || u.search || u.hash) throw Error('请填写服务器首页地址')
  return u.origin + u.pathname.replace(/\/+$/, '')
}
export function sessionRead(): Session | null {
  try {
    return JSON.parse(localStorage.getItem('yonote-session') || 'null')
  } catch {
    return null
  }
}
export function dbName(session: Session | null) {
  return session
    ? 'yonote:' + encodeURIComponent(session.base || location.origin) + ':' + session.user.id
    : 'yonote:local'
}
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}'
}

// Pure synchronous SHA-256 (FIPS 180-4) so content hashing runs atomically inside Dexie transactions
// without yielding to non-IndexedDB microtasks or requiring SecureContext crypto.subtle.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256Sync(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLen = bytes.length * 8
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64
  const buf = new Uint8Array(paddedLen)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, '0')).join('')
}

export function recordContentHash(
  kind: RecordData['kind'],
  deletedAt: string | null | undefined,
  value: Value,
): string {
  return sha256Sync(canonicalJSON({ kind, deleted: Boolean(deletedAt), value }))
}

export function plainRecord(r: LocalRecord): RecordData {
  const { dirty, rev, syncedHash, ownAckedVersion, ...out } = r
  return out
}
async function putRecord(db: NoteDB, record: LocalRecord) {
  await db.records.put(record)
  await db.summaries.put(summarize(record))
}

export async function save(
  db: NoteDB,
  id: string,
  kind: RecordData['kind'],
  patch: Partial<Value>,
  deletedAt?: string | null,
  baseVersion?: number,
) {
  await db.transaction('rw', db.records, db.summaries, db.outbox, async () => {
    const old = await db.records.get(id)
    const pending = await db.outbox.get(id)
    const nextDeletedAt = deletedAt === undefined ? old?.deletedAt || null : deletedAt
    const nextValue: Value = { ...(old?.value || { createdAt: new Date().toISOString() }), ...patch }
    const nextHash = recordContentHash(kind, nextDeletedAt, nextValue)

    // Content-hash short-circuit: if local state matches the last acknowledged server state,
    // skip creating/keeping any outbox mutation (zero wasted upload bandwidth).
    if (old && old.syncedHash && nextHash === old.syncedHash) {
      if (!old.dirty && !pending) return
      const clean: LocalRecord = {
        ...old,
        updatedAt: old.updatedAt,
        deletedAt: nextDeletedAt,
        value: nextValue,
        dirty: 0,
        rev: old.rev + 1,
      }
      await putRecord(db, clean)
      if (pending) await db.outbox.delete(id)
      return
    }

    const r: LocalRecord = {
      id,
      kind,
      version: old?.version || 0,
      updatedAt: new Date().toISOString(),
      deletedAt: nextDeletedAt,
      value: nextValue,
      dirty: 1,
      rev: (old?.rev || 0) + 1,
      syncedHash: old?.syncedHash,
      ownAckedVersion: old?.ownAckedVersion,
    }
    const minAck = old?.ownAckedVersion || 0
    const base = pending
      ? Math.max(pending.base, minAck)
      : Math.max(baseVersion ?? r.version, minAck)
    await putRecord(db, r)
    await db.outbox.put({
      id,
      opId: uuid(),
      base,
      rev: r.rev,
      record: plainRecord(r),
    })
  })
}
export async function createRecord(db: NoteDB, module: Module, folderId = '') {
  const id = uuid()
  await save(
    db,
    id,
    module,
    module === 'note'
      ? { title: '', content: emptyDoc, plainText: '', folderId, sort: Date.now() }
      : {
          title: '',
          note: '',
          done: false,
          doneAt: null,
          remindAt: null,
          remindLocation: null,
          folderId,
          sort: Date.now(),
        },
  )
  return id
}
export async function applyReceipt(db: NoteDB, sent: Outbox, result: Receipt) {
  await db.transaction('rw', db.records, db.summaries, db.outbox, async () => {
    const current = await db.records.get(sent.id)
    const pending = await db.outbox.get(sent.id)
    const ackedVersion = result.record?.version ?? result.version ?? sent.record.version
    const ackedUpdatedAt = result.record?.updatedAt ?? result.updatedAt ?? sent.record.updatedAt
    const ackedRecord: RecordData = result.record ?? {
      ...sent.record,
      version: ackedVersion,
      updatedAt: ackedUpdatedAt,
    }
    const ackedHash = recordContentHash(ackedRecord.kind, ackedRecord.deletedAt, ackedRecord.value)
    const nextOwnAck = Math.max(current?.ownAckedVersion || 0, ackedVersion)

    if (pending?.opId === sent.opId) {
      await putRecord(db, {
        ...ackedRecord,
        dirty: 0,
        rev: current?.rev || 0,
        syncedHash: ackedHash,
        ownAckedVersion: nextOwnAck,
      })
      await db.outbox.delete(sent.id)
    } else if (current && pending && ackedVersion > current.version) {
      const localHash = recordContentHash(current.kind, current.deletedAt, current.value)
      if (localHash === ackedHash) {
        await putRecord(db, {
          ...current,
          version: ackedVersion,
          updatedAt: ackedUpdatedAt,
          dirty: 0,
          syncedHash: ackedHash,
          ownAckedVersion: nextOwnAck,
        })
        await db.outbox.delete(sent.id)
      } else {
        const r: LocalRecord = {
          ...current,
          version: ackedVersion,
          syncedHash: ackedHash,
          ownAckedVersion: nextOwnAck,
        }
        await putRecord(db, r)
        await db.outbox.put({
          ...pending,
          opId: uuid(),
          base: ackedVersion,
          record: plainRecord(r),
        })
      }
    }
    if (result.conflict) {
      const existing = await db.records.get(result.conflict.id)
      if (!existing?.dirty && (!existing || existing.version < result.conflict.version))
        await putRecord(db, {
          ...result.conflict,
          dirty: 0,
          rev: (existing?.rev || 0) + 1,
          syncedHash: recordContentHash(
            result.conflict.kind,
            result.conflict.deletedAt,
            result.conflict.value,
          ),
        })
    }
  })
}
export async function applyPull(db: NoteDB, records: RecordData[], cursor: number) {
  await db.transaction('rw', db.records, db.summaries, db.meta, async () => {
    for (const r of records) {
      const old = await db.records.get(r.id)
      if (!old?.dirty && (!old || old.version < r.version))
        await putRecord(db, {
          ...r,
          dirty: 0,
          rev: (old?.rev || 0) + 1,
          syncedHash: recordContentHash(r.kind, r.deletedAt, r.value),
          ownAckedVersion: old?.ownAckedVersion,
        })
    }
    const prev = Number((await db.meta.get('cursor'))?.value || 0)
    await db.meta.put({ key: 'cursor', value: Math.max(prev, cursor) })
  })
}
export async function advanceCursor(db: NoteDB, cursor: number) {
  await db.transaction('rw', db.meta, async () => {
    const prev = Number((await db.meta.get('cursor'))?.value || 0)
    if (cursor > prev) await db.meta.put({ key: 'cursor', value: cursor })
  })
}
export async function initialize(db: NoteDB, local: boolean) {
  if (await db.meta.get('initialized')) return
  await db.transaction('rw', db.records, db.summaries, db.outbox, db.meta, async () => {
    if (local)
      for (const module of ['note', 'todo'] as Module[]) {
        for (const [i, name] of ['工作', '个人', '购物'].entries()) {
          const id = uuid()
          await save(db, id, 'folder', {
            name,
            module,
            color: ['#e6839a', '#79b8d2', '#e5bd42'][i],
            sort: i,
          })
        }
      }
    await db.meta.put({ key: 'initialized', value: true })
  })
}
export async function deleteFolder(db: NoteDB, id: string) {
  const rows = await db.records.toArray()
  await db.transaction('rw', db.records, db.summaries, db.outbox, async () => {
    for (const r of rows.filter((r) => r.value.folderId === id))
      await save(db, r.id, r.kind, { folderId: '' })
    await save(db, id, 'folder', {}, new Date().toISOString())
  })
}
export async function migrateLocal(target: NoteDB) {
  const source = new NoteDB('yonote:local')
  try {
    const rows = await source.records.toArray()
    for (const r of rows.sort(
      (a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'),
    )) {
      if (!r.value.purged) await save(target, r.id, r.kind, r.value, r.deletedAt)
    }
    const files = await source.attachments.toArray()
    await target.attachments.bulkPut(files.map((f) => ({ ...f, uploaded: 0 })))
    return rows.length
  } finally {
    source.close()
  }
}
export function docText(d: Doc): string {
  return d.text || d.content?.map(docText).join(d.type === 'doc' ? '\n' : '') || ''
}
