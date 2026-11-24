import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Spring, clamp, motionEnabled, roundUnit } from './motion'

// Stable event functions let cards and the editor skip unrelated application renders.
export function useEvent<T extends (...args: any[]) => any>(handler: T): T {
  const ref = useRef(handler)
  ref.current = handler
  return useCallback(((...args: any[]) => ref.current(...args)) as T, [])
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

const editableSelection = '[contenteditable],.history-preview,.public-page'

function allowsTextSelection(node: EventTarget | null) {
  const target = node instanceof Element ? node : (node as Node | null)?.parentElement
  if (!target) return false
  if (target.closest(editableSelection)) return true
  const field = target.closest<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
  return !!field && field.value.length > 0
}

export function useChromeSelectionGuard() {
  useLayoutEffect(() => {
    const prevent = (event: Event) => {
      if (allowsTextSelection(event.target)) return
      event.preventDefault()
    }
    const clearStray = (event: PointerEvent) => {
      if (allowsTextSelection(event.target)) return
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) selection.removeAllRanges()
    }
    document.addEventListener('selectstart', prevent, true)
    document.addEventListener('pointerdown', clearStray, { passive: true, capture: true })
    return () => {
      document.removeEventListener('selectstart', prevent, true)
      document.removeEventListener('pointerdown', clearStray, true)
    }
  }, [])
}

export function usePreventSelection(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const surface = ref.current
    if (!surface) return
    const prevent = (event: Event) => event.preventDefault()
    surface.addEventListener('selectstart', prevent, true)
    return () => surface.removeEventListener('selectstart', prevent, true)
  }, [ref])
}

export function useGlassContact(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let target: HTMLElement | null = null
    let bounds: DOMRect | null = null
    let pointer = -1
    let frame = 0
    let nextX = 0, nextY = 0
    let drawnX = Infinity, drawnY = Infinity
    let drawnPress = ''
    const pressure = new Spring(0, (p) => {
      const next = String(roundUnit(p))
      if (next === drawnPress) return
      drawnPress = next
      target?.style.setProperty('--press', next)
    }, { stiffness: 620, damping: 38 })
    const position = () => {
      frame = 0
      if (!target || !bounds) return
      const x = Math.round(clamp(nextX - bounds.left, 0, bounds.width))
      const y = Math.round(clamp(nextY - bounds.top, 0, bounds.height))
      if (x === drawnX && y === drawnY) return
      drawnX = x
      drawnY = y
      target.style.setProperty('--contact-x', x + 'px')
      target.style.setProperty('--contact-y', y + 'px')
    }
    const move = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return
      nextX = event.clientX
      nextY = event.clientY
      if (!frame) frame = requestAnimationFrame(position)
    }
    const settle = () => {
      if (pointer === -1 && !target) return
      pointer = -1
      cancelAnimationFrame(frame)
      frame = 0
      document.removeEventListener('pointermove', move, true)
      pressure.to(0, () => {
        target?.removeAttribute('data-contact')
        target?.style.removeProperty('--press')
        target = null
        bounds = null
      })
    }
    const contact = (event: PointerEvent) => {
      if (event.button !== 0 || !motionEnabled()) return
      const element = (event.target as HTMLElement).closest<HTMLElement>(
        '.icon-button:not(:disabled),.add-button,.segment,.choice-trigger:not(:disabled),.fluid-popover button,.context-actions button')
      if (!element || pointer !== -1) return
      if (target !== element) {
        target?.removeAttribute('data-contact')
        target?.style.removeProperty('--press')
        target = null
        pressure.set(0)
      }
      target = element
      drawnPress = ''
      bounds = element.getBoundingClientRect()
      pointer = event.pointerId
      nextX = event.clientX
      nextY = event.clientY
      drawnX = drawnY = Infinity
      position()
      element.dataset.contact = 'true'
      pressure.to(1)
      document.addEventListener('pointermove', move, { passive: true, capture: true })
    }
    const release = (event: PointerEvent) => {
      if (pointer === event.pointerId) settle()
    }
    document.addEventListener('pointerdown', contact, { passive: true, capture: true })
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    window.addEventListener('blur', settle)
    return () => {
      document.removeEventListener('pointerdown', contact, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      window.removeEventListener('blur', settle)
      cancelAnimationFrame(frame)
      pressure.dispose()
      target?.removeAttribute('data-contact')
      target?.style.removeProperty('--press')
    }
  }, [enabled])
}
