import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Spring, clamp } from './motion'

type Geometry = { height: number; visible: boolean; availableHeight: number; animating: boolean }
const InputMotion = registerPlugin<{
  hide: (options?: { onlyIfVisible: boolean }) => Promise<{ handled: boolean }>
  show: () => Promise<void>
  addListener: (event: 'geometry', listener: (geometry: Geometry) => void) => Promise<PluginListenerHandle>
}>('InputMotion')
export function hideKeyboard() {
  if (Capacitor.isNativePlatform()) return InputMotion.hide().catch(() => {})
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    ;(document.activeElement as HTMLElement | null)?.blur()
  }
  return Promise.resolve()
}
export async function hideVisibleKeyboard() {
  const result = await InputMotion.hide({ onlyIfVisible: true }).catch(() => undefined)
  return result?.handled === true
}
export function showKeyboard() {
  if (Capacitor.isNativePlatform()) void InputMotion.show().catch(() => {})
}

// Prevent mobile browsers/WebViews from opening the soft keyboard when long-pressing
// or dragging selection handles to select/copy text, while preserving 1-tap editing.
export function bindSelectionSafeInput(element: HTMLElement): () => void {
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return () => {}
  const suppress = () => {
    if (element.getAttribute('inputmode') !== 'none') element.setAttribute('inputmode', 'none')
  }
  const allow = () => {
    if (element.hasAttribute('inputmode')) element.removeAttribute('inputmode')
  }
  const hasRangeSelection = () => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return (element.selectionStart ?? 0) !== (element.selectionEnd ?? 0)
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false
    const anchor = sel.anchorNode
    const focus = sel.focusNode
    return (!!anchor && element.contains(anchor)) || (!!focus && element.contains(focus))
  }

  if (document.activeElement !== element) suppress()

  let touch: { id: number; x: number; y: number; time: number; moved: boolean } | null = null
  let allowPendingClick = false

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      touch = null
      return
    }
    const t = e.touches[0]
    touch = { id: t.identifier, x: t.clientX, y: t.clientY, time: Date.now(), moved: false }
    allowPendingClick = false
  }
  const onTouchMove = (e: TouchEvent) => {
    if (!touch) return
    const t = Array.from(e.touches).find((item) => item.identifier === touch!.id)
    if (!t) return
    if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 10) touch.moved = true
  }
  const onTouchEnd = (e: TouchEvent) => {
    if (!touch) return
    const t = Array.from(e.changedTouches).find((item) => item.identifier === touch!.id)
    if (!t) return
    const elapsed = Date.now() - touch.time
    const moved = touch.moved || Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > 14
    touch = null
    // Short stationary tap with no active range selection => allow IME BEFORE focus fires.
    if (!moved && elapsed < 380 && !hasRangeSelection()) {
      allow()
      allowPendingClick = true
    } else if (hasRangeSelection() || elapsed >= 380) {
      suppress()
    }
  }
  const onTouchCancel = () => {
    touch = null
  }
  const onClick = () => {
    const wasPending = allowPendingClick
    allowPendingClick = false
    if (hasRangeSelection()) {
      suppress()
      return
    }
    allow()
    if (wasPending && document.activeElement === element) {
      const vk = (navigator as Navigator & { virtualKeyboard?: { show?: () => void } }).virtualKeyboard
      vk?.show?.()
      showKeyboard()
    }
  }
  const onSelectionChange = () => {
    if (hasRangeSelection()) {
      suppress()
      if (Capacitor.isNativePlatform()) void hideVisibleKeyboard()
    }
  }
  const onContextMenu = () => {
    suppress()
  }
  const onBlur = () => {
    allowPendingClick = false
    suppress()
  }

  element.addEventListener('touchstart', onTouchStart, { passive: true })
  element.addEventListener('touchmove', onTouchMove, { passive: true })
  element.addEventListener('touchend', onTouchEnd, { passive: true })
  element.addEventListener('touchcancel', onTouchCancel, { passive: true })
  element.addEventListener('click', onClick, { passive: true })
  element.addEventListener('contextmenu', onContextMenu, { passive: true })
  element.addEventListener('blur', onBlur)
  document.addEventListener('selectionchange', onSelectionChange)
  return () => {
    element.removeEventListener('touchstart', onTouchStart)
    element.removeEventListener('touchmove', onTouchMove)
    element.removeEventListener('touchend', onTouchEnd)
    element.removeEventListener('touchcancel', onTouchCancel)
    element.removeEventListener('click', onClick)
    element.removeEventListener('contextmenu', onContextMenu)
    element.removeEventListener('blur', onBlur)
    document.removeEventListener('selectionchange', onSelectionChange)
    allow()
  }
}

export function useAppViewport(root: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    let frame = 0
    const apply = () => {
      const viewport = window.visualViewport
      // Browser/PWA keyboards shrink the visual viewport even when 100dvh stays fixed.
      const height = viewport && viewport.scale < 1.02 ? viewport.height : innerHeight
      root.current?.style.setProperty('height', height + 'px')
    }
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    }
    apply()
    window.visualViewport?.addEventListener('resize', resize)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(frame)
      window.visualViewport?.removeEventListener('resize', resize)
      window.removeEventListener('resize', resize)
    }
  }, [])
}

export function useInputDock(open: boolean, root: RefObject<HTMLElement | null>) {
  const [present, setPresent] = useState(open)
  const mounted = open || present
  const spring = useRef<Spring | null>(null)
  const isOpen = useRef(open)
  isOpen.current = open
  const repaint = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const node = root.current!
    const toolbar = node.querySelector<HTMLElement>('.editor-bottom')!
    const scroll = node.querySelector<HTMLElement>('.editor-scroll')!
    let panel: HTMLElement | null = null
    let p = 0, panelHeight = 292
    let baseHeight = window.visualViewport?.height || innerHeight
    let width = innerWidth, geometry: Geometry | null = null, frame = 0
    const paint = () => {
      const actualHeight = window.visualViewport?.height || innerHeight
      const keyboard = Math.max(0, baseHeight - actualHeight)
      // Native insets progress supplies the intermediate position when WebView resize
      // reaches its final layout before the system keyboard animation has finished.
      const shift = geometry?.animating
        ? clamp(geometry.availableHeight - actualHeight, -geometry.height, baseHeight - actualHeight)
        : 0
      const progress = clamp(p)
      const lift = Math.max(0, (panelHeight + 4) * progress - keyboard - shift)
      const toolbarOffset = shift - lift
      toolbar.style.transform = toolbarOffset ? `translate3d(0,${toolbarOffset}px,0)` : ''
      if (panel) {
        const panelOffset = Math.max(0, keyboard + shift) + (1 - progress) * (panelHeight + 16)
        panel.style.transform = `translate3d(-50%,${panelOffset}px,0)`
        panel.style.opacity = String(progress)
      }
    }
    const reservePanelSpace = () => scroll.style.setProperty('--dock-padding', panel ? panelHeight + 'px' : '0px')
    repaint.current = () => { reservePanelSpace(); paint() }
    spring.current = new Spring(0, (v) => { p = v; paint() }, { stiffness: 520, damping: 42 })
    const resize = () => {
      const height = window.visualViewport?.height || innerHeight
      if (Math.abs(innerWidth - width) > 50) { baseHeight = height; width = innerWidth; geometry = null }
      else if (!(geometry?.visible) && height > baseHeight) baseHeight = height
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    }
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if ((entry.target as HTMLElement).classList.contains('style-panel')) {
        panelHeight = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height + 28
      }
      repaint.current()
    })
    const watch = new MutationObserver(() => {
      const next = node.querySelector<HTMLElement>('.style-panel')
      if (next === panel) return
      if (panel) observer.unobserve(panel)
      panel = next
      if (panel) {
        panelHeight = panel.offsetHeight
        observer.observe(panel)
      }
      repaint.current()
    })
    watch.observe(node, { childList: true })
    let disposed = false, listener: PluginListenerHandle | undefined
    if (Capacitor.isNativePlatform()) void InputMotion.addListener('geometry', (event) => {
      geometry = event
      if (!event.visible && !event.animating) baseHeight = Math.max(baseHeight, window.visualViewport?.height || innerHeight)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    }).then((handle) => { if (disposed) void handle.remove(); else listener = handle }).catch(() => {})
    paint()
    return () => {
      disposed = true; void listener?.remove(); spring.current?.dispose()
      observer.disconnect(); watch.disconnect(); cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
    }
  }, [])
  useLayoutEffect(() => {
    if (open) setPresent(true)
    spring.current?.to(open ? 1 : 0, () => { if (!isOpen.current) setPresent(false) })
    repaint.current()
  }, [open, mounted])
  return mounted
}
