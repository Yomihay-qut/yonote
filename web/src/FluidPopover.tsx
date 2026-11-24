import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { Spring, animateMotion, clamp, menuSpring, paintMenuReveal } from './motion'
import { registerBackHandler } from './native'
import { useEvent } from './interaction'

export function FluidPopover({
  anchor,
  id,
  open,
  onClose,
  children,
  align = 'end',
  role = 'menu',
  compact = false,
}: {
  anchor: RefObject<HTMLButtonElement | null>
  id: string
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end'
  role?: 'menu' | 'listbox'
  compact?: boolean
}) {
  const [present, setPresent] = useState(open)
  const layer = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const contents = useRef<HTMLDivElement>(null)
  const motion = useRef<Spring | null>(null)
  const direction = useRef<'down' | 'up'>('down')
  const close = useEvent(onClose)
  const host = anchor.current?.closest('dialog[open]') || document.body

  useLayoutEffect(() => {
    const popup = surface.current
    const body = contents.current
    const bounds = layer.current
    const trigger = anchor.current
    if (!popup || !body || !bounds || !trigger) return
    if (!motion.current) {
      motion.current = new Spring(
        0,
        (progress) => paintMenuReveal(popup, body, progress, 0, 0, direction.current),
        menuSpring,
      )
      motion.current.set(0)
    }

    if (!open) {
      popup.dataset.animating = 'true'
      motion.current.to(0, () => {
        delete popup.dataset.animating
        motion.current?.dispose()
        motion.current = null
        setPresent(false)
      }, { stopAtTarget: true })
      return
    }

    setPresent(true)
    const options = () => Array.from(popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    const clipping = { boundary: bounds, padding: 10 }
    let live = true
    let positioned = false
    let request = 0
    let itemAnimations: Animation[] = []
    const place = () => {
      const current = ++request
      // Only clear constraints before the initial invisible measurement to avoid mid-open flicker.
      if (!positioned) {
        popup.style.maxWidth = ''
        body.style.maxHeight = ''
      }
      void computePosition(trigger, popup, {
        placement: `bottom-${align}`,
        middleware: [
          offset(6),
          flip({ ...clipping, crossAxis: false, flipAlignment: false, fallbackStrategy: 'bestFit' }),
          shift(clipping),
          size({
            ...clipping,
            apply({ availableHeight, availableWidth }) {
              if (!live || current !== request) return
              popup.style.maxWidth = Math.max(0, availableWidth) + 'px'
              body.style.maxHeight = Math.max(0, Math.floor(availableHeight) - 2) + 'px'
            },
          }),
        ],
      }).then(({ x, y, placement }) => {
        if (!live || current !== request) return
        direction.current = placement.startsWith('top') ? 'up' : 'down'
        popup.style.left = x + 'px'
        popup.style.top = y + 'px'
        const safe = bounds.getBoundingClientRect()
        const button = trigger.getBoundingClientRect()
        const originX = clamp(button.left + button.width / 2 - safe.left - x, 14, Math.max(14, popup.offsetWidth - 14))
        const origin = `${originX}px ${direction.current === 'up' ? 'bottom' : 'top'}`
        popup.style.transformOrigin = origin
        body.style.transformOrigin = origin
        if (positioned) return
        positioned = true
        popup.dataset.animating = 'true'
        motion.current?.to(1, () => {
          delete popup.dataset.animating
        })
        const rows = Array.from(body.children).filter((el): el is HTMLElement => el instanceof HTMLElement).slice(0, 6)
        const dy = direction.current === 'up' ? 8 : -8
        itemAnimations = rows
          .map((row, index) => animateMotion(
            row,
            [
              { opacity: 0, transform: `translate3d(0,${dy}px,0)` },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 240, delay: 25 + index * 20, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
          ))
          .filter((a): a is Animation => !!a)
        const items = options()
        const selected = items.find((item) => item.getAttribute('aria-selected') === 'true')
        if (selected) body.scrollTop = Math.max(0, selected.offsetTop + selected.offsetHeight - body.clientHeight)
        if (trigger.matches(':focus-visible')) (selected ?? items[0])?.focus({ preventScroll: true })
      })
    }
    const stopPositioning = autoUpdate(trigger, popup, place, { ancestorScroll: false })
    const scroll = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(trigger)) close()
    }
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !popup.contains(target) && !trigger.contains(target)) close()
    }
    const removeBack = registerBackHandler('menu', () => {
      trigger.focus({ preventScroll: true })
      close()
      return true
    }, popup)
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== trigger && !popup.contains(event.target as Node)) return
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = options()
      if (!items.length) return
      event.preventDefault()
      const focused = items.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0
        : event.key === 'End' ? items.length - 1
        : focused < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (focused + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index].focus()
    }
    const viewport = window.visualViewport
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    document.addEventListener('keydown', keydown, true)
    window.addEventListener('scroll', scroll, true)
    viewport?.addEventListener('scroll', place)
    return () => {
      live = false
      itemAnimations.forEach((a) => a.cancel())
      stopPositioning()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      document.removeEventListener('keydown', keydown, true)
      removeBack()
      window.removeEventListener('scroll', scroll, true)
      viewport?.removeEventListener('scroll', place)
    }
  }, [open, anchor, align, close])

  useLayoutEffect(() => () => {
    motion.current?.dispose()
    motion.current = null
  }, [])
  if (!open && !present) return null
  return createPortal(
    <div ref={layer} className="popover-layer">
      <div
        ref={surface}
        id={id}
        role={role}
        aria-labelledby={id + '-trigger'}
        className={'fluid-popover menu-surface' + (compact ? ' compact-menu' : '')}
        data-open={open ? '' : undefined}
        inert={!open}
        onClick={(event) => {
          if (!(event.target as Element).closest('button')) return
          if (event.detail === 0) anchor.current?.focus({ preventScroll: true })
          close()
        }}
      >
        <div className="menu-scroll" ref={contents}>{children}</div>
      </div>
    </div>,
    host,
  )
}
