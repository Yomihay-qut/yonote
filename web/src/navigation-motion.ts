import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  Spring,
  cardGhost,
  clamp,
  interpolateMorph,
  measureCard,
  mix,
  morphSpring,
  motionEnabled,
  recordElement,
  roundPx,
  roundUnit,
  type CardOrigin,
} from './motion'
import { useEvent } from './interaction'
import { showKeyboard } from './input-motion'

export function useDrawerMotion(
  open: boolean, onChange: (open: boolean) => void,
  shell: RefObject<HTMLDivElement | null>,
) {
  const [active, setActive] = useState(open)
  const spring = useRef<Spring | null>(null)
  const current = useRef(open)
  current.current = open
  const change = useEvent(onChange)
  useLayoutEffect(() => {
    const root = shell.current!
    const sidebar = root.querySelector<HTMLElement>('.sidebar')!
    const main = root.querySelector<HTMLElement>('.list-pane')!
    const compact = matchMedia('(max-width: 1150px)')
    let shade: HTMLElement | null = null
    let width = sidebar.getBoundingClientRect().width
    const paint = (p: number) => {
      if (!shade?.isConnected) shade = root.querySelector<HTMLElement>('.drawer-shade')
      if (!compact.matches) {
        main.style.transform = ''
        sidebar.style.transform = ''
        if (shade) { shade.style.transform = ''; shade.style.opacity = '' }
        return
      }
      const shift = roundPx(p * width)
      const sideShift = roundPx((p - 1) * width)
      main.style.transform = p <= 0.001 ? '' : `translate3d(${shift}px,0,0)`
      sidebar.style.transform = `translate3d(${sideShift}px,0,0)`
      if (shade) {
        shade.style.transform = p <= 0.001 ? '' : `translate3d(${shift}px,0,0)`
        shade.style.opacity = String(roundUnit(clamp(p)))
      }
    }
    spring.current = new Spring(open ? 1 : 0, paint)
    const resize = new ResizeObserver(() => {
      width = sidebar.getBoundingClientRect().width
      paint(spring.current?.value || 0)
    })
    resize.observe(sidebar)
    let gesture: { id: number; x: number; y: number; last: number; time: number; speed: number; start: number; dragging: boolean } | null = null
    let suppressClick = false
    const settle = (next: boolean) => {
      if (next) setActive(true)
      change(next)
      spring.current?.to(next ? 1 : 0, () => { if (!current.current) setActive(false) })
    }
    const down = (e: PointerEvent) => {
      suppressClick = false
      if (e.button !== 0 || gesture || !compact.matches ||
        (root.classList.contains('mobile-editor-open') && matchMedia('(max-width: 700px)').matches) ||
        document.querySelector('dialog[open]') ||
        (!current.current && !root.classList.contains('drawer-active') && e.clientX > main.offsetLeft + 24) ||
        (e.target as HTMLElement).closest('.segmented-control,input,textarea,.sort-handle,.choice-trigger')) return
      gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, last: e.clientX,
        time: e.timeStamp, speed: 0, start: spring.current?.value || 0, dragging: false }
    }
    const move = (e: PointerEvent) => {
      const g = gesture
      if (!g || g.id !== e.pointerId) return
      const dx = e.clientX - g.x, dy = e.clientY - g.y
      if (!g.dragging) {
        if (Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return }
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return
        g.dragging = true
        suppressClick = true
        setActive(true)
        root.setPointerCapture(e.pointerId)
      }
      e.preventDefault()
      const speed = (e.clientX - g.last) / Math.max(e.timeStamp - g.time, 1) * 1000 / width
      g.speed = clamp(g.speed * 0.35 + speed * 0.65, -4, 4)
      g.last = e.clientX; g.time = e.timeStamp
      spring.current?.follow(clamp(g.start + dx / width), g.speed)
    }
    const end = (e: PointerEvent) => {
      if (e.type === 'lostpointercapture' && e.target !== root) return
      const g = gesture
      if (!g || g.id !== e.pointerId) return
      gesture = null
      if (!g.dragging) return
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId)
      if (e.type !== 'pointerup') {
        suppressClick = false
        settle(current.current)
      } else {
        const speed = e.timeStamp - g.time < 80 ? g.speed : 0
        settle((spring.current?.value || 0) + clamp(speed, -3, 3) * 0.13 > 0.5)
      }
    }
    const click = (e: MouseEvent) => {
      if (suppressClick && e.detail > 0) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false }
    }
    root.addEventListener('pointerdown', down, { passive: true })
    root.addEventListener('pointermove', move, { passive: false })
    root.addEventListener('pointerup', end)
    root.addEventListener('pointercancel', end)
    root.addEventListener('lostpointercapture', end)
    root.addEventListener('click', click, true)
    return () => {
      resize.disconnect(); spring.current?.dispose()
      root.removeEventListener('pointerdown', down); root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerup', end); root.removeEventListener('pointercancel', end)
      root.removeEventListener('lostpointercapture', end)
      root.removeEventListener('click', click, true)
    }
  }, [])
  useLayoutEffect(() => {
    if (open) setActive(true)
    spring.current?.to(open ? 1 : 0, () => { if (!current.current) setActive(false) })
  }, [open])
  return active || open
}

type NoteFlight = {
  bounds: CardOrigin
  card: HTMLElement
  ghost: HTMLElement
  visibility: string
}

export function useNoteMotion(
  open: boolean,
  id: string | null,
  shell: RefObject<HTMLDivElement | null>,
  origin: RefObject<CardOrigin | null>,
  onBack: () => Promise<boolean>,
) {
  const [active, setActive] = useState(open)
  const current = useRef({ open, id })
  current.current = { open, id }
  const change = useRef<() => void>(() => {})
  const back = useEvent(onBack)

  useLayoutEffect(() => {
    const root = shell.current!
    const detail = root.querySelector<HTMLElement>('.detail-pane')!
    const detailContent = detail.querySelector<HTMLElement>('.detail-content')!
    const listPane = root.querySelector<HTMLElement>('.list-pane')!
    const list = root.querySelector<HTMLElement>('.record-list')!
    const narrow = matchMedia('(max-width: 700px)')
    let detailBox = { x: 0, y: 0, width: Math.max(1, detail.offsetWidth), height: Math.max(1, detail.offsetHeight) }
    let flight: NoteFlight | null = null
    let morphFrom: CardOrigin | null = null
    let fromAddButton = false
    let fromPreview = false
    let dragOffset = { x: 0, y: 0 }
    const measureDetail = () => {
      const rect = detail.getBoundingClientRect()
      detailBox = {
        x: rect.left,
        y: rect.top,
        width: Math.max(1, rect.width || detail.offsetWidth),
        height: Math.max(1, rect.height || detail.offsetHeight),
      }
    }
    const travel = () => Math.min(192, detailBox.width * 0.48)
    const paint = (progress: number) => {
      const p = clamp(progress)
      const bgScale = roundUnit(mix(1, 0.95, p))
      const bgOpacity = roundUnit(mix(1, 0.56, p))
      listPane.style.transform = p <= 0.001 || p >= 0.999 ? '' : `translate3d(0,0,0) scale(${bgScale})`
      listPane.style.opacity = p <= 0.001 || p >= 0.999 ? '' : String(bgOpacity)

      if (morphFrom) {
        const box = interpolateMorph(morphFrom, { ...detailBox, radius: 0 }, p)
        const dragWeight = 4 * p * (1 - p)
        const bx = box.x + dragOffset.x * dragWeight
        const by = box.y + dragOffset.y * dragWeight
        const fromCx = morphFrom.x + morphFrom.width / 2
        const fromCy = morphFrom.y + morphFrom.height / 2
        const toCx = detailBox.x + detailBox.width / 2
        const toCy = detailBox.y + detailBox.height / 2
        const startScale = fromAddButton
          ? 0.22
          : clamp(morphFrom.width / Math.max(1, detailBox.width), 0.76, 0.94)
        const s = roundUnit(mix(startScale, 1, p))
        const tx = roundPx(mix(fromCx - toCx, 0, p) + dragOffset.x * dragWeight)
        const ty = roundPx(mix(fromCy - toCy, 0, p) + dragOffset.y * dragWeight)

        // Pure GPU compositor transform + opacity (avoids per-frame full-screen clip-path rasterization).
        detail.style.clipPath = ''
        detail.style.borderRadius = ''
        detail.style.transform = p >= 0.999 && !dragOffset.x && !dragOffset.y
          ? ''
          : `translate3d(${tx}px,${ty}px,0) scale(${s})`
        detail.style.opacity = fromAddButton
          ? String(roundUnit(clamp(p * 2.4)))
          : String(roundUnit(clamp(0.18 + p * 1.15)))

        detailContent.style.transform = ''
        detailContent.style.opacity = p >= 0.999
          ? ''
          : String(roundUnit(fromPreview ? clamp(0.42 + p * 0.9) : clamp((p - 0.1) / 0.48)))

        if (flight) {
          const { bounds, ghost } = flight
          const targetScale = Math.min(1.08, detailBox.width / Math.max(1, bounds.width))
          const gOpacity = roundUnit(1 - clamp((p - 0.04) / 0.34))
          ghost.style.transform = `translate3d(${roundPx(bx)}px,${roundPx(by)}px,0) scale(${roundUnit(mix(1, targetScale, p))})`
          ghost.style.opacity = String(gOpacity)
          ghost.style.visibility = gOpacity <= 0.001 ? 'hidden' : 'visible'
        }
        return
      }

      detail.style.clipPath = ''
      detail.style.borderRadius = ''
      detail.style.transform = `translate3d(${roundPx((1 - p) * travel())}px,0,0) scale(${roundUnit(mix(0.94, 1, p))})`
      detail.style.opacity = String(roundUnit(clamp(p * 1.2)))
      detailContent.style.transform = ''
      detailContent.style.opacity = ''
    }
    const spring = new Spring(0, paint, morphSpring)
    const clearFlight = () => {
      if (!flight) return
      flight.card.style.visibility = flight.visibility
      flight.ghost.remove()
      flight = null
    }
    const captureFlight = () => {
      clearFlight()
      const card = current.current.id ? recordElement(current.current.id) : null
      if (!card) return
      const savedTransform = listPane.style.transform
      if (savedTransform) listPane.style.transform = ''
      const bounds = measureCard(card)
      const view = list.getBoundingClientRect()
      if (savedTransform) listPane.style.transform = savedTransform
      // Keep the list's scroll position when the target was reordered or is offscreen.
      if (bounds.width <= 1 || bounds.y < view.top - 1 || bounds.y + bounds.height > view.bottom + 1) return
      const ghost = cardGhost(card, bounds, 'fixed')
      flight = { card, ghost, bounds, visibility: card.style.visibility }
      card.style.visibility = 'hidden'
      root.append(ghost)
    }
    const rest = () => {
      clearFlight()
      dragOffset = { x: 0, y: 0 }
      delete root.dataset.editorMoving
      detail.style.clipPath = ''
      detail.style.transform = ''
      detail.style.opacity = ''
      detail.style.borderRadius = ''
      detailContent.style.transform = ''
      detailContent.style.opacity = ''
      listPane.style.transform = ''
      listPane.style.opacity = ''
    }
    const onOpened = () => {
      rest()
      if (!fromAddButton || !current.current.open) return
      const input = detail.querySelector<HTMLInputElement>('.note-title')
      if (input && !input.value && !detail.querySelector('.note-body')?.textContent?.trim()) {
        input.removeAttribute('inputmode')
        input.focus({ preventScroll: true })
        showKeyboard()
      }
    }
    const onClosed = () => {
      const focus = flight?.card.querySelector<HTMLButtonElement>('.card-main')
      delete root.dataset.editorActive
      morphFrom = null
      fromPreview = false
      rest()
      setActive(false)
      focus?.focus({ preventScroll: true })
    }
    change.current = () => {
      if (!narrow.matches) return
      measureDetail()
      if (current.current.open) {
        const continuing = root.hasAttribute('data-editor-active') && spring.value > 0
        fromAddButton = (origin.current?.width ?? Infinity) <= 72
        root.dataset.editorActive = 'true'
        root.dataset.editorMoving = 'true'
        setActive(true)
        if (!continuing) {
          dragOffset = { x: 0, y: 0 }
          if (fromAddButton) {
            clearFlight()
            fromPreview = false
            morphFrom = origin.current
          } else {
            captureFlight()
            const o = origin.current
            const b = flight?.bounds
            fromPreview = !!(o && (!b ||
              Math.abs(o.x - b.x) > 4 || Math.abs(o.y - b.y) > 4 ||
              Math.abs(o.width - b.width) > 4 || Math.abs(o.height - b.height) > 4))
            if (fromPreview && flight) clearFlight()
            morphFrom = o || flight?.bounds || null
          }
          spring.set(0)
        }
        spring.to(1, onOpened)
      } else if (root.hasAttribute('data-editor-active')) {
        root.dataset.editorMoving = 'true'
        if (!flight) captureFlight()
        if (flight) {
          morphFrom = flight.bounds
          fromAddButton = false
          fromPreview = false
        } else if (fromAddButton) {
          morphFrom = null
        }
        spring.to(0, onClosed)
      }
    }

    const size = new ResizeObserver(() => {
      measureDetail()
      if (root.hasAttribute('data-editor-moving')) paint(spring.value)
    })
    size.observe(detail)
    const breakpoint = () => {
      if (narrow.matches && current.current.open) {
        root.dataset.editorActive = 'true'
        setActive(true)
        spring.set(1)
        rest()
      } else {
        delete root.dataset.editorActive
        morphFrom = null
        spring.set(0)
        rest()
        setActive(false)
      }
    }
    narrow.addEventListener('change', breakpoint)
    let gesture: { id: number; x: number; y: number; last: number; time: number; velocity: number; start: number; dragging: boolean } | null = null
    const down = (event: PointerEvent) => {
      if (!current.current.open || !narrow.matches || gesture || event.button !== 0 ||
        document.querySelector('dialog[open]') ||
        (event.target as HTMLElement).closest('input,textarea,[contenteditable],.style-panel,.choice-trigger')) return
      measureDetail()
      if (event.clientX > detailBox.x + 28) return
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, last: event.clientX,
        time: event.timeStamp, velocity: 0, start: spring.value, dragging: false }
    }
    const move = (event: PointerEvent) => {
      const g = gesture
      if (!g || g.id !== event.pointerId) return
      const dx = event.clientX - g.x
      const dy = event.clientY - g.y
      if (!g.dragging) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { gesture = null; return }
        if (dx < 10 || dx < Math.abs(dy) * 1.2) return
        g.dragging = true
        fromAddButton = false
        fromPreview = false
        root.dataset.editorMoving = 'true'
        detail.setPointerCapture(event.pointerId)
        measureDetail()
        captureFlight()
        morphFrom = flight?.bounds ?? null
      }
      event.preventDefault()
      const dragRange = Math.max(240, detailBox.width * 0.72)
      const speed = (event.clientX - g.last) / Math.max(1, event.timeStamp - g.time)
      g.velocity = clamp(-speed * 1000 / dragRange, -5, 5)
      g.last = event.clientX
      g.time = event.timeStamp
      dragOffset = { x: clamp(dx * 0.18, 0, 36), y: clamp(dy * 0.14, -22, 22) }
      spring.follow(clamp(g.start - dx / dragRange, 0.14, 1), g.velocity)
    }
    const end = (event: PointerEvent) => {
      if (event.type === 'lostpointercapture' && event.target !== detail) return
      const g = gesture
      if (!g || g.id !== event.pointerId) return
      gesture = null
      if (!g.dragging) return
      if (detail.hasPointerCapture(event.pointerId)) detail.releasePointerCapture(event.pointerId)
      const velocity = event.timeStamp - g.time < 80 ? g.velocity : 0
      if (event.type === 'pointerup' && spring.value + velocity * 0.09 < 0.62) {
        spring.to(Math.min(spring.value, 0.18))
        void back().then((closed) => { if (!closed) spring.to(1, rest) })
      } else {
        spring.to(1, rest)
      }
    }
    detail.addEventListener('pointerdown', down, { passive: true })
    detail.addEventListener('pointermove', move, { passive: false })
    detail.addEventListener('pointerup', end)
    detail.addEventListener('pointercancel', end)
    detail.addEventListener('lostpointercapture', end)
    return () => {
      spring.dispose()
      rest()
      size.disconnect()
      narrow.removeEventListener('change', breakpoint)
      detail.removeEventListener('pointerdown', down)
      detail.removeEventListener('pointermove', move)
      detail.removeEventListener('pointerup', end)
      detail.removeEventListener('pointercancel', end)
      detail.removeEventListener('lostpointercapture', end)
    }
  }, [])

  useLayoutEffect(() => { change.current() }, [open])
  return open || active
}

export function useNavPillMotion(navRef: RefObject<HTMLElement | null>, activeKey: string) {
  const spring = useRef<Spring | null>(null)
  const initialized = useRef(false)
  const heightRef = useRef(44)

  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = nav?.querySelector<HTMLElement>('.nav-active-pill')
    if (!nav || !pill) return
    const paint = (top: number, velocity: number) => {
      const stretch = motionEnabled() ? Math.min(Math.abs(velocity) * 0.00018, 0.14) : 0
      pill.style.transform = `translate3d(0,${roundPx(top)}px,0) scaleY(${roundUnit(1 + stretch)})`
      pill.style.opacity = '1'
    }
    const driver = new Spring(0, paint, { stiffness: 460, damping: 34 })
    spring.current = driver
    const align = () => {
      const target = nav.querySelector<HTMLElement>('.nav-row.selected')
      if (!target) {
        pill.style.opacity = '0'
        return
      }
      const navBox = nav.getBoundingClientRect()
      const rowBox = target.getBoundingClientRect()
      heightRef.current = Math.max(36, rowBox.height)
      pill.style.height = heightRef.current + 'px'
      driver.set(rowBox.top - navBox.top + nav.scrollTop)
    }
    const resize = new ResizeObserver(align)
    resize.observe(nav)
    return () => {
      resize.disconnect()
      driver.dispose()
      spring.current = null
      initialized.current = false
    }
  }, [navRef])

  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = nav?.querySelector<HTMLElement>('.nav-active-pill')
    const driver = spring.current
    if (!nav || !pill || !driver) return
    const target = nav.querySelector<HTMLElement>('.nav-row.selected')
    if (!target) {
      pill.style.opacity = '0'
      return
    }
    const navBox = nav.getBoundingClientRect()
    const rowBox = target.getBoundingClientRect()
    const top = rowBox.top - navBox.top + nav.scrollTop
    heightRef.current = Math.max(36, rowBox.height)
    pill.style.height = heightRef.current + 'px'
    if (!initialized.current) {
      initialized.current = true
      driver.set(top)
    } else {
      driver.to(top)
    }
  }, [navRef, activeKey])
}
