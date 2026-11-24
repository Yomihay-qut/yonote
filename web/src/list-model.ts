import type { Doc, LocalRecord, RecordSummary } from './types'

export function firstImage(doc?: Doc): string | undefined {
  if (!doc) return
  if (doc.type === 'image' && typeof doc.attrs?.attachmentId === 'string')
    return doc.attrs.attachmentId
  for (const child of doc.content || []) {
    const id = firstImage(child)
    if (id) return id
  }
}
export function summarize(record: LocalRecord): RecordSummary {
  const { content, plainText, note, ...metadata } = record.value
  return {
    ...record,
    value: { ...metadata, plainText: plainText?.slice(0, 160), note: note?.slice(0, 160) },
    characterCount: plainText?.length || 0,
    thumbnailId: firstImage(content),
  }
}
export type SortOrder = 'updated' | 'created' | 'title' | 'manual'
export function sortRecords(records: RecordSummary[], sort: SortOrder) {
  return [...records].sort(
    (a, b) =>
      Number(!!b.value.pinned) - Number(!!a.value.pinned) ||
      (sort === 'manual'
        ? (a.value.sort || 0) - (b.value.sort || 0)
        : sort === 'title'
          ? (a.value.title || '').localeCompare(b.value.title || '', 'zh-CN')
          : sort === 'created'
            ? (b.value.createdAt || b.updatedAt).localeCompare(a.value.createdAt || a.updatedAt)
            : b.updatedAt.localeCompare(a.updatedAt)),
  )
}
export function groupRecords(records: RecordSummary[], enabled: boolean, today = new Date()) {
  if (!enabled) return [{ label: '', records }]
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const groups: { label: string; records: RecordSummary[] }[] = []
  for (const record of records) {
    const date = new Date(record.updatedAt)
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const label = record.value.pinned
      ? '置顶'
      : day >= start
        ? '今天'
        : day >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()
          ? '昨天'
          : `${date.getFullYear()}年${date.getMonth() + 1}月`
    let group = groups.find((g) => g.label === label)
    if (!group) {
      group = { label, records: [] }
      groups.push(group)
    }
    group.records.push(record)
  }
  return groups
}
export type Placement = 'before' | 'after'
export function moveRecord(records: RecordSummary[], source: string, target: string, placement: Placement) {
  const from = records.findIndex((record) => record.id === source)
  const to = records.findIndex((record) => record.id === target)
  if (from < 0 || to < 0 || from === to || !!records[from].value.pinned !== !!records[to].value.pinned) return records
  const index = to + Number(placement === 'after') - Number(from < to)
  if (index === from) return records
  const result = [...records]
  const [item] = result.splice(from, 1)
  result.splice(index, 0, item)
  return result
}
