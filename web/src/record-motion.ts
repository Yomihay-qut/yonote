import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { registerBackHandler } from './native'
import { useEvent } from './interaction'
import {
  Spring,
  animateMotion,
  cardGhost,
  clamp,
  fluidSpring,
  measureCard,
  mix,
  motionEnabled,
  motionTiming,
  roundPx,
  roundUnit,
  type CardOrigin,
} from './motion'
import { moveRecord, type Placement } from './list-model'
import type { RecordSummary } from './types'

type Reorder = (source: string, target: string, placement: Placement) => Promise<boolean>
type Destination = { id: string; placement: Placement }
type Point = { x: number; y: number }
export type LayoutSlot = { id: string; left: number; top: number; width: number; height: number }

export function findReorderTarget(
  slots: LayoutSlot[],
  draggedId: string,
  dragRect: { left: number; top: number; width: number; height: number },
  grid: boolean,
): { targetId: string; placement: Placement } | null {
  const index = slots.findIndex((slot) => slot.id === draggedId)
  if (index < 0) return null

  if (grid) {
    const cx = dragRect.left + dragRect.width / 2
    const cy = dragRect.top + dragRect.height / 2
    for (let i = 0; i < slots.length; i++) {
      if (i === index) continue
      const slot = slots[i]
      const padX = slot.width * 0.12
      const padY = slot.height * 0.12
      if (
        cx >= slot.left + padX &&
        cx <= slot.left + slot.width - padX &&
        cy >= slot.top + padY &&
        cy <= slot.top + slot.height - padY
      ) {
        return { targetId: slot.id, placement: i > index ? 'after' : 'before' }
      }
    }
    return null
  }

  let target: { targetId: string; placement: Placement } | null = null
  for (let i = index - 1; i >= 0; i--) {
    const slot = slots[i]
    if (dragRect.top < slot.top + slot.height * 0.5) {
      target = { targetId: slot.id, placement: 'before' }
    } else {
      break
    }
  }
  if (target) return target

  const dragBottom = dragRect.top + dragRect.height
  for (let i = index + 1; i < slots.length; i++) {
    const slot = slots[i]
    if (dragBottom > slot.top + slot.height * 0.5) {
      target = { targetId: slot.id, placement: 'after' }
    } else {
      break
    }
  }
  return target
}

function documentLayoutOffset(element: HTMLElement): Point {
  let x = 0, y = 0
  let cur: HTMLElement | null = element
  while (cur) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { x, y }
}

type Drag = {
  id: string
  pointer: number
  card: HTMLElement
  start: Point
  point: Point
  lastPoint: Point
  lastTime: number
  vx: number
  vy: number
  origin?: CardOrigin
  cardStart?: { left: number; top: number }
  ghost?: HTMLElement
  liftSpring?: Spring
  liftScale: number
  fromHandle: boolean
  scroller: HTMLElement
  width: number
  scrollTop: number
  records: RecordSummary[]
  order: RecordSummary[]
  slots?: LayoutSlot[]
  slotsDirty?: boolean
  scrollerBounds?: DOMRect
  destination?: Destination
}
const translate = (x: number, y: number) => `translate3d(${roundPx(x)}px,${roundPx(y)}px,0)`
function cards(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-record-id]'))
}

function applyGhostTransform(active: Drag) {
  if (!active.ghost || !active.origin) return
  const dx = active.point.x - active.start.x
  const dy = active.point.y - active.start.y
  const scale = motionEnabled() ? roundUnit(active.liftScale) : 1
  active.ghost.style.transform = translate(active.origin.x + dx, active.origin.y + dy) +
    (Math.abs(scale - 1) < 0.001 ? '' : ` scale(${scale})`)
}

export function useRecordLayout(root: RefObject<HTMLDivElement | null>, key: string, held: string | null) {
  const previous = useRef(new Map<string, Point>())
  const animations = useRef(new Map<string, Animation>())
  useLayoutEffect(() => {
    const list = root.current!
    const items = cards(list)
    // Pass 1 (READ): capture in-flight transform offsets before cancelling anything.
    const offsets = new Map<string, DOMMatrixReadOnly>()
    const toCancel: Animation[] = []
    for (const card of items) {
      const id = card.dataset.recordId!
      const active = animations.current.get(id)
      if (!active) continue
      const transform = getComputedStyle(card).transform
      if (transform !== 'none') offsets.set(id, new DOMMatrixReadOnly(transform))
      toCancel.push(active)
    }
    // Pass 2 (WRITE): cancel active animations together so layout only flushes once below.
    for (const active of toCancel) active.cancel()

    // Pass 3 (READ): single batched layout measurement + viewport culling bounds.
    const bounds = list.getBoundingClientRect()
    const scroller = list.closest<HTMLElement>('.record-list')
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight }
    const viewTop = view.top - 120
    const viewBottom = view.bottom + 120
    const next = new Map<string, Point>()
    const moves: { card: HTMLElement; id: string; dx: number; dy: number }[] = []
    for (const card of items) {
      const id = card.dataset.recordId!
      const box = card.getBoundingClientRect()
      const point = { x: box.left - bounds.left, y: box.top - bounds.top }
      next.set(id, point)
      const old = previous.current.get(id)
      if (!old || id === held) continue
      // Skip FLIP animations for cards completely outside the visible viewport.
      if (box.bottom < viewTop || box.top > viewBottom) continue
      const offset = offsets.get(id)
      const dx = old.x + (offset?.m41 ?? 0) - point.x
      const dy = old.y + (offset?.m42 ?? 0) - point.y
      if (Math.abs(dx) + Math.abs(dy) < 1) continue
      moves.push({ card, id, dx, dy })
    }
    // Pass 4 (WRITE): launch animations in one batch.
    for (const { card, id, dx, dy } of moves) {
      const animation = animateMotion(card, [{ transform: translate(dx, dy) }, { transform: 'none' }])
      if (!animation) continue
      animations.current.set(id, animation)
      void animation.finished.catch(() => {}).finally(() => {
        if (animations.current.get(id) === animation) animations.current.delete(id)
      })
    }
    previous.current = next
  }, [key, held])
  useLayoutEffect(() => () => {
    animations.current.forEach((animation) => animation.cancel())
    animations.current.clear()
  }, [])
}

export function useRecordDrag(
  root: RefObject<HTMLDivElement | null>, records: RecordSummary[], enabled: boolean, grid: boolean, reorder: Reorder,
) {
  const [preview, setPreview] = useState<string[] | null>(null)
  const [held, setHeld] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const frame = useRef(0)
  const suppressClick = useRef(false)
  const landing = useRef<{ node: HTMLElement; spring?: Spring; frame?: number } | null>(null)
  const saving = useRef(false)
  const cleanup = () => {
    const pending = landing.current
    landing.current = null
    if (pending?.frame) cancelAnimationFrame(pending.frame)
    pending?.spring?.dispose()
    pending?.node.remove()
  }
  const clearDrag = useEvent(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const active = drag.current
    drag.current = null
    if (active && root.current?.hasPointerCapture(active.pointer)) root.current.releasePointerCapture(active.pointer)
    active?.liftSpring?.dispose()
    active?.ghost?.remove()
    cleanup()
    if (root.current) delete root.current.dataset.reordering
    setHeld(null)
    setPreview(null)
  })
  useEffect(() => registerBackHandler('gesture', () => {
    if (!drag.current?.ghost) return false
    finish(true)
    return true
  }), [])
  useEffect(() => {
    if (!enabled || (drag.current && drag.current.records.some((item) => !records.some((record) => record.id === item.id)))) {
      clearDrag()
    }
  }, [enabled, records])
  useLayoutEffect(() => {
    const list = root.current
    const resize = () => {
      if (drag.current && root.current?.offsetWidth !== drag.current.width) clearDrag()
    }
    const blockTouchScroll = (event: TouchEvent) => {
      if (drag.current?.fromHandle || drag.current?.ghost) event.preventDefault()
    }
    window.addEventListener('resize', resize)
    list?.addEventListener('touchmove', blockTouchScroll, { passive: false })
    return () => {
      window.removeEventListener('resize', resize)
      list?.removeEventListener('touchmove', blockTouchScroll)
      cancelAnimationFrame(frame.current)
      drag.current?.liftSpring?.dispose()
      drag.current?.ghost?.remove()
      cleanup()
    }
  }, [])
  useEffect(() => {
    if (!held && preview && records.map((record) => record.id).join() === preview.join()) setPreview(null)
  }, [held, preview, records])

  function down(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false
    if (!enabled || saving.current || event.button !== 0 || drag.current) return
    const target = event.target as Element
    const handle = target.closest('.sort-handle')
    if (!handle &&
      (event.pointerType !== 'mouse' || !target.closest('.card-main') || target.closest('[data-card-control]'))) return
    const card = target.closest<HTMLElement>('[data-record-id]')
    const scroller = root.current?.closest<HTMLElement>('.record-list')
    if (!card || !scroller) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) sel.removeAllRanges()
    cleanup()
    setHeld(null)
    const point = { x: event.clientX, y: event.clientY }
    drag.current = {
      id: card.dataset.recordId!, pointer: event.pointerId, card, start: point, point,
      lastPoint: point, lastTime: event.timeStamp, vx: 0, vy: 0, liftScale: 1,
      fromHandle: !!handle,
      scroller, width: event.currentTarget.offsetWidth, scrollTop: scroller.scrollTop,
      records, order: records,
    }
    // Capture on a stable node and disable native touch-action before move starts.
    if (handle) {
      event.currentTarget.dataset.reordering = 'true'
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }
  function measureSlots(active: Drag, list: HTMLElement): LayoutSlot[] {
    const byId = new Map(cards(list).map((card) => [card.dataset.recordId!, card]))
    const pin = !!active.order.find((record) => record.id === active.id)?.value.pinned
    const rootPos = documentLayoutOffset(list)
    const slots: LayoutSlot[] = []
    for (const record of active.order) {
      if (!!record.value.pinned !== pin) continue
      const item = byId.get(record.id)
      if (!item) continue
      const pos = documentLayoutOffset(item)
      slots.push({
        id: record.id,
        left: pos.x - rootPos.x,
        top: pos.y - rootPos.y,
        width: item.offsetWidth,
        height: item.offsetHeight,
      })
    }
    active.slots = slots
    active.slotsDirty = false
    return slots
  }
  function lift(active: Drag) {
    const list = root.current!
    active.origin = measureCard(active.card)
    const rootPos = documentLayoutOffset(list)
    const cardPos = documentLayoutOffset(active.card)
    active.cardStart = { left: cardPos.x - rootPos.x, top: cardPos.y - rootPos.y }
    active.scrollTop = active.scroller.scrollTop
    active.scrollerBounds = active.scroller.getBoundingClientRect()
    active.order = [...active.records]
    measureSlots(active, list)
    active.ghost = cardGhost(active.card, active.origin)
    active.ghost.classList.add('dragged-card')
    document.body.append(active.ghost)
    active.card.dataset.dragged = 'true'
    list.dataset.reordering = 'true'
    if (!list.hasPointerCapture(active.pointer)) list.setPointerCapture(active.pointer)
    suppressClick.current = true
    setHeld(active.id)
    active.liftSpring = new Spring(0, (value) => {
      active.liftScale = mix(1, 1.03, value)
      applyGhostTransform(active)
    }, fluidSpring)
    active.liftSpring.to(1)
  }
  function paint() {
    frame.current = 0
    const active = drag.current
    const list = root.current
    if (!active?.ghost || !active.origin || !list) return
    applyGhostTransform(active)
    const { point, start, scroller, origin } = active
    const bounds = active.scrollerBounds ?? (active.scrollerBounds = scroller.getBoundingClientRect())
    const inside = point.x >= bounds.left - 12 && point.x <= bounds.right + 12
    if (!inside) return
    const step = point.y < bounds.top + 48 ? -clamp((bounds.top + 48 - point.y) * 0.22, 0, 16)
      : clamp((point.y - bounds.bottom + 48) * 0.22, 0, 16)
    const before = scroller.scrollTop
    if (step) scroller.scrollTop += step

    // Reuse cached layout slots during continuous pointer moves; only re-measure after an order swap.
    const slots = !active.slots || active.slotsDirty ? measureSlots(active, list) : active.slots
    if (active.cardStart) {
      const dragRect = {
        left: active.cardStart.left + (point.x - start.x),
        top: active.cardStart.top + (point.y - start.y) + (scroller.scrollTop - active.scrollTop),
        width: origin.width,
        height: origin.height,
      }
      const hit = findReorderTarget(slots, active.id, dragRect, grid)
      if (hit) {
        const nextOrder = moveRecord(active.order, active.id, hit.targetId, hit.placement)
        if (nextOrder !== active.order) {
          active.order = nextOrder
          active.slotsDirty = true
          const initialIndex = active.records.findIndex((record) => record.id === active.id)
          const finalIndex = nextOrder.findIndex((record) => record.id === active.id)
          if (finalIndex === initialIndex || finalIndex < 0) {
            active.destination = undefined
          } else if (finalIndex > initialIndex) {
            const prev = nextOrder[finalIndex - 1]
            active.destination = prev ? { id: prev.id, placement: 'after' } : undefined
          } else {
            const next = nextOrder[finalIndex + 1]
            active.destination = next ? { id: next.id, placement: 'before' } : undefined
          }
          setPreview(active.destination ? nextOrder.map((record) => record.id) : null)
        }
      }
    }
    if (scroller.scrollTop !== before) frame.current = requestAnimationFrame(paint)
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || active.pointer !== event.pointerId) return
    const dt = Math.max(1, event.timeStamp - active.lastTime)
    const ivx = (event.clientX - active.lastPoint.x) * 1000 / dt
    const ivy = (event.clientY - active.lastPoint.y) * 1000 / dt
    active.vx = clamp(active.vx * 0.4 + ivx * 0.6, -2400, 2400)
    active.vy = clamp(active.vy * 0.4 + ivy * 0.6, -2400, 2400)
    active.lastPoint = { x: event.clientX, y: event.clientY }
    active.lastTime = event.timeStamp
    active.point = { x: event.clientX, y: event.clientY }
    if (!active.ghost) {
      const threshold = active.fromHandle ? 3 : 8
      if (Math.hypot(active.point.x - active.start.x, active.point.y - active.start.y) < threshold) return
      lift(active)
    }
    event.preventDefault()
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }
  function persist(source: string, destination: Destination) {
    saving.current = true
    return reorder(source, destination.id, destination.placement).catch(() => false).finally(() => { saving.current = false })
  }
  const finish = useEvent((cancelled: boolean, endTime?: number) => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const active = drag.current
    drag.current = null
    if (!active) return
    active.liftSpring?.dispose()
    active.liftSpring = undefined
    const list = root.current!
    if (list.hasPointerCapture(active.pointer)) list.releasePointerCapture(active.pointer)
    delete list.dataset.reordering
    if (!active.ghost) return
    const bounds = active.scroller.getBoundingClientRect()
    const { x, y } = active.point
    const inside = x >= bounds.left - 12 && x <= bounds.right + 12 && y >= bounds.top - 12 && y <= bounds.bottom + 12
    const destination = !cancelled && inside ? active.destination : undefined
    if (!destination) setPreview(null)
    const saved = destination ? persist(active.id, destination) : Promise.resolve(false)
    const fromX = active.origin ? active.origin.x + (active.point.x - active.start.x) : 0
    const fromY = active.origin ? active.origin.y + (active.point.y - active.start.y) : 0
    const fromScale = motionEnabled() ? active.liftScale : 1
    const releaseAge = endTime === undefined ? Infinity : endTime - active.lastTime
    const vx = !cancelled && releaseAge < 90 ? active.vx : 0
    const vy = !cancelled && releaseAge < 90 ? active.vy : 0
    const pending = { node: active.ghost } as NonNullable<typeof landing.current>
    landing.current = pending
    pending.frame = requestAnimationFrame(() => {
      pending.frame = undefined
      const card = cards(list).find((element) => element.dataset.recordId === active.id)
      const box = card?.getBoundingClientRect()
      let landed: Promise<void> = Promise.resolve()
      if (box) {
        const toX = box.left, toY = box.top
        const dist = Math.hypot(toX - fromX, toY - fromY)
        const speedAlong = dist > 4
          ? clamp(((toX - fromX) * vx + (toY - fromY) * vy) / (dist * dist), -2, 8)
          : 0
        landed = new Promise<void>((resolve) => {
          const spring = new Spring(0, (value) => {
            const lx = mix(fromX, toX, value)
            const ly = mix(fromY, toY, value)
            const s = mix(fromScale, 1, clamp(value))
            pending.node.style.transform = translate(lx, ly) + (Math.abs(s - 1) < 0.001 ? '' : ` scale(${s})`)
          }, fluidSpring)
          pending.spring = spring
          spring.set(0, speedAlong)
          spring.to(1, resolve)
        })
      }
      void Promise.allSettled([saved, landed]).then(() => {
        if (landing.current !== pending) return
        cleanup()
        setHeld(null)
        setPreview(null)
      })
    })
  })
  function end(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const active = drag.current
    if (!active || active.pointer !== event.pointerId) return
    if (!cancelled && active.ghost) {
      active.point = { x: event.clientX, y: event.clientY }
      cancelAnimationFrame(frame.current)
      paint()
    }
    finish(cancelled, event.timeStamp)
  }
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || saving.current || !(event.target as Element).closest('.sort-handle')) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const id = (event.target as Element).closest<HTMLElement>('[data-record-id]')?.dataset.recordId
    const index = records.findIndex((record) => record.id === id)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const target = records[index + delta]
    if (!id || !target) return
    const placement = delta > 0 ? 'after' : 'before'
    const ordered = moveRecord(records, id, target.id, placement)
    if (ordered === records) return
    setPreview(ordered.map((record) => record.id))
    void persist(id, { id: target.id, placement }).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => setPreview(null)))
    })
  }

  const ranks = new Map(preview?.map((id, index) => [id, index]))
  const ordered = preview ? [...records].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)) : records
  return {
    ordered, held,
    handlers: {
      onPointerDown: down,
      onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => end(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => end(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) end(event, true)
      },
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current?.ghost && !event.currentTarget.hasPointerCapture(event.pointerId)) end(event, true)
      },
      onContextMenuCapture: (event: React.MouseEvent) => {
        if (!drag.current && !(event.target as Element).closest('.sort-handle')) return
        event.preventDefault()
        event.stopPropagation()
      },
      onKeyDown: keydown,
      onClickCapture: (event: React.MouseEvent) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        event.preventDefault()
        event.stopPropagation()
      },
    },
  }
}
