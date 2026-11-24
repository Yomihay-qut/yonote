export type InlinePart = { text: string; changed?: boolean }
export type DiffLine = {
  no: number
  text: string
  type: 'same' | 'add' | 'del'
  parts?: InlinePart[]
}
export type SplitRow = {
  kind: 'same' | 'change'
  left: DiffLine | null
  right: DiffLine | null
}
export type DiffResult = {
  rows: SplitRow[]
  leftLines: DiffLine[]
  rightLines: DiffLine[]
  added: number
  removed: number
  identical: boolean
}

type Op = { type: 'same' | 'add' | 'del'; oldIdx?: number; newIdx?: number }

function lcsOps(a: string[], b: string[]): Op[] {
  const m = a.length
  const n = b.length
  if (m === 0 && n === 0) return []
  if (m === 0) return b.map((_, j) => ({ type: 'add', newIdx: j }))
  if (n === 0) return a.map((_, i) => ({ type: 'del', oldIdx: i }))

  // Use classic DP when m*n is small; fall back to unique-line anchor matching for huge middle sections.
  if (m * n > 250_000) {
    return anchorDiffOps(a, b, 0, m, 0, n)
  }

  const dp = new Uint32Array((m + 1) * (n + 1))
  const w = n + 1
  for (let i = m - 1; i >= 0; i--) {
    const ai = a[i]
    const row = i * w
    const nextRow = (i + 1) * w
    for (let j = n - 1; j >= 0; j--) {
      dp[row + j] = ai === b[j]
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', oldIdx: i, newIdx: j })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: 'del', oldIdx: i++ })
    } else {
      ops.push({ type: 'add', newIdx: j++ })
    }
  }
  while (i < m) ops.push({ type: 'del', oldIdx: i++ })
  while (j < n) ops.push({ type: 'add', newIdx: j++ })
  return ops
}

function anchorDiffOps(a: string[], b: string[], aStart: number, aEnd: number, bStart: number, bEnd: number): Op[] {
  const aLen = aEnd - aStart
  const bLen = bEnd - bStart
  if (aLen === 0 && bLen === 0) return []
  if (aLen === 0) {
    const ops: Op[] = []
    for (let j = bStart; j < bEnd; j++) ops.push({ type: 'add', newIdx: j })
    return ops
  }
  if (bLen === 0) {
    const ops: Op[] = []
    for (let i = aStart; i < aEnd; i++) ops.push({ type: 'del', oldIdx: i })
    return ops
  }
  if (aLen * bLen <= 40_000) {
    const subOps = lcsOps(a.slice(aStart, aEnd), b.slice(bStart, bEnd))
    return subOps.map((op) => ({
      type: op.type,
      oldIdx: op.oldIdx !== undefined ? op.oldIdx + aStart : undefined,
      newIdx: op.newIdx !== undefined ? op.newIdx + bStart : undefined,
    }))
  }

  const countA = new Map<string, number>()
  const indexA = new Map<string, number>()
  for (let i = aStart; i < aEnd; i++) {
    const line = a[i]
    countA.set(line, (countA.get(line) || 0) + 1)
    indexA.set(line, i)
  }
  const countB = new Map<string, number>()
  for (let j = bStart; j < bEnd; j++) {
    const line = b[j]
    countB.set(line, (countB.get(line) || 0) + 1)
  }

  let bestAi = -1
  let bestBj = -1
  let bestScore = Infinity
  const aMid = (aStart + aEnd) / 2
  const bMid = (bStart + bEnd) / 2
  for (let j = bStart; j < bEnd; j++) {
    const line = b[j]
    if (countA.get(line) === 1 && countB.get(line) === 1) {
      const ai = indexA.get(line)!
      const score = Math.abs(ai - aMid) + Math.abs(j - bMid)
      if (score < bestScore) {
        bestScore = score
        bestAi = ai
        bestBj = j
      }
    }
  }

  if (bestAi >= 0) {
    return [
      ...anchorDiffOps(a, b, aStart, bestAi, bStart, bestBj),
      { type: 'same', oldIdx: bestAi, newIdx: bestBj },
      ...anchorDiffOps(a, b, bestAi + 1, aEnd, bestBj + 1, bEnd),
    ]
  }

  const ops: Op[] = []
  for (let i = aStart; i < aEnd; i++) ops.push({ type: 'del', oldIdx: i })
  for (let j = bStart; j < bEnd; j++) ops.push({ type: 'add', newIdx: j })
  return ops
}

function diffInline(oldLine: string, newLine: string): { left: InlinePart[]; right: InlinePart[] } | null {
  if (oldLine === newLine || !oldLine || !newLine) return null
  const a = Array.from(oldLine)
  const b = Array.from(newLine)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)
  const totalCommon = prefix + suffix
  // Skip fine-grained highlighting if the lines share almost nothing or middle is massive.
  if (totalCommon === 0 && a.length * b.length > 1600) return null
  if (aMid.length * bMid.length > 25_000) {
    return {
      left: buildInlineParts(a, new Set(Array.from({ length: aMid.length }, (_, k) => prefix + k))),
      right: buildInlineParts(b, new Set(Array.from({ length: bMid.length }, (_, k) => prefix + k))),
    }
  }

  const changedA = new Set<number>()
  const changedB = new Set<number>()
  const midOps = lcsOps(aMid, bMid)
  for (const op of midOps) {
    if (op.type === 'del' && op.oldIdx !== undefined) changedA.add(prefix + op.oldIdx)
    if (op.type === 'add' && op.newIdx !== undefined) changedB.add(prefix + op.newIdx)
  }

  const unchangedChars = a.length - changedA.size
  if (unchangedChars < Math.min(a.length, b.length) * 0.2) return null

  return {
    left: buildInlineParts(a, changedA),
    right: buildInlineParts(b, changedB),
  }
}

function buildInlineParts(chars: string[], changed: Set<number>): InlinePart[] {
  const parts: InlinePart[] = []
  let buf = ''
  let state = false
  for (let i = 0; i < chars.length; i++) {
    const isChanged = changed.has(i)
    if (i > 0 && isChanged !== state) {
      parts.push(state ? { text: buf, changed: true } : { text: buf })
      buf = ''
    }
    state = isChanged
    buf += chars[i]
  }
  if (buf) parts.push(state ? { text: buf, changed: true } : { text: buf })
  return parts
}

export function computeDiff(oldText: string, newText: string): DiffResult {
  const oldNorm = oldText.replace(/\r\n/g, '\n')
  const newNorm = newText.replace(/\r\n/g, '\n')
  const oldLines = oldNorm === '' ? [] : oldNorm.split('\n')
  const newLines = newNorm === '' ? [] : newNorm.split('\n')

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const ops: Op[] = []
  for (let i = 0; i < prefix; i++) ops.push({ type: 'same', oldIdx: i, newIdx: i })
  const midA = oldLines.slice(prefix, oldLines.length - suffix)
  const midB = newLines.slice(prefix, newLines.length - suffix)
  for (const op of lcsOps(midA, midB)) {
    ops.push({
      type: op.type,
      oldIdx: op.oldIdx !== undefined ? op.oldIdx + prefix : undefined,
      newIdx: op.newIdx !== undefined ? op.newIdx + prefix : undefined,
    })
  }
  for (let k = suffix - 1; k >= 0; k--) {
    ops.push({
      type: 'same',
      oldIdx: oldLines.length - 1 - k,
      newIdx: newLines.length - 1 - k,
    })
  }

  const rows: SplitRow[] = []
  const leftLines: DiffLine[] = []
  const rightLines: DiffLine[] = []
  let added = 0
  let removed = 0

  let idx = 0
  while (idx < ops.length) {
    const op = ops[idx]
    if (op.type === 'same') {
      const text = oldLines[op.oldIdx!]
      const left: DiffLine = { no: op.oldIdx! + 1, text, type: 'same' }
      const right: DiffLine = { no: op.newIdx! + 1, text, type: 'same' }
      rows.push({ kind: 'same', left, right })
      leftLines.push(left)
      rightLines.push(right)
      idx++
      continue
    }

    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (idx < ops.length && ops[idx].type !== 'same') {
      const cur = ops[idx]
      if (cur.type === 'del') {
        const line: DiffLine = { no: cur.oldIdx! + 1, text: oldLines[cur.oldIdx!], type: 'del' }
        dels.push(line)
        removed++
      } else {
        const line: DiffLine = { no: cur.newIdx! + 1, text: newLines[cur.newIdx!], type: 'add' }
        adds.push(line)
        added++
      }
      idx++
    }

    const pairCount = Math.min(dels.length, adds.length)
    for (let k = 0; k < pairCount; k++) {
      const inline = diffInline(dels[k].text, adds[k].text)
      if (inline) {
        dels[k].parts = inline.left
        adds[k].parts = inline.right
      }
    }
    for (const d of dels) leftLines.push(d)
    for (const a of adds) rightLines.push(a)

    const rowCount = Math.max(dels.length, adds.length)
    for (let k = 0; k < rowCount; k++) {
      rows.push({
        kind: 'change',
        left: dels[k] || null,
        right: adds[k] || null,
      })
    }
  }

  return {
    rows,
    leftLines,
    rightLines,
    added,
    removed,
    identical: added === 0 && removed === 0,
  }
}
