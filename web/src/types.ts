export type Module = 'note' | 'todo'
export type Doc = {
  type: string
  text?: string
  attrs?: Record<string, any>
  marks?: { type: string; attrs?: Record<string, any> }[]
  content?: Doc[]
}
export type Value = {
  title?: string
  content?: Doc
  plainText?: string
  folderId?: string
  pinned?: boolean
  starred?: boolean
  sort?: number
  createdAt?: string
  bgColor?: string
  note?: string
  done?: boolean
  doneAt?: string | null
  remindAt?: string | null
  remindLocation?: { lat: number; lng: number; radius: number; name: string } | null
  name?: string
  module?: Module
  color?: string
  purged?: boolean
}
export type RecordData = {
  id: string
  kind: Module | 'folder'
  version: number
  updatedAt: string
  deletedAt: string | null
  value: Value
}
export type LocalRecord = RecordData & {
  dirty: number
  rev: number
  syncedHash?: string
  ownAckedVersion?: number
}
// List queries never read rich-text documents or full note bodies.
export type RecordSummary = LocalRecord & { thumbnailId?: string; characterCount?: number }
export type Outbox = { id: string; opId: string; base: number; rev: number; record: RecordData }
export type Attachment = {
  id: string
  noteId: string
  name: string
  mime: string
  size: number
  blob?: Blob
  thumbnail?: Blob
  uploaded: number
  hash?: string
}
export type User = {
  id: string
  username: string
  admin: boolean
  quota: number
  used: number
  disabled: boolean
}
export type Session = { base: string; token: string; user: User }
export type Device = { id: string; name: string; lastSeen: string; current: boolean }
export type ApiKeyInfo = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  folderIds: string[]
  createdAt: string
  lastUsedAt?: string | null
}
export type HistoryEntry = { id: string; createdAt: string; record: RecordData }
export type Receipt = {
  opId: string
  id?: string
  version?: number
  updatedAt?: string
  unchanged?: boolean
  purged?: boolean
  record?: RecordData
  conflict?: RecordData
}
