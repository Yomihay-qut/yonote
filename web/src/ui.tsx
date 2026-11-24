import { useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react'
import { Check, Search, X } from 'lucide-react'
import { registerBackHandler } from './native'
import { useEvent } from './interaction'
import { animateMotion, clamp, mix, modalSpring, roundPx, roundUnit, rubberBand, Spring } from './motion'

export function IconButton({
  ref,
  id,
  label,
  children,
  onClick,
  active,
  expanded,
  disabled,
  popup,
  className = '',
}: {
  ref?: Ref<HTMLButtonElement>
  id?: string
  label: string
  children: ReactNode
  onClick?: () => void
  active?: boolean
  expanded?: boolean
  disabled?: boolean
  popup?: string
  className?: string
}) {
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      aria-haspopup={popup ? 'menu' : undefined}
      aria-controls={popup && expanded ? popup : undefined}
      disabled={disabled}
      onClick={onClick}
      className={'icon-button ' + (active || expanded ? 'active ' : '') + className}
    >
      {children}
    </button>
  )
}

export function SearchField({
  ref, label, placeholder, value, onChange, onKeyDown, autoFocus, children,
}: {
  ref?: Ref<HTMLInputElement>
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  autoFocus?: boolean
  children?: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => input.current!, [])
  return (
    <div className="search-field" role="search" aria-label={label}>
      <Search size={18} aria-hidden="true" />
      <input
        ref={input}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        enterKeyHint="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value && (
        <IconButton label="清空搜索" onClick={() => {
          onChange('')
          input.current?.focus({ preventScroll: true })
        }}><X size={16} /></IconButton>
      )}
      {children}
    </div>
  )
}

export type ModalHandle = {
  dismiss: (after?: () => void) => boolean
  captureHeight: () => void
}
type SheetPose = { y: number; scale: number; opacity: number; dim: number }
type SheetDrag = {
  id: number
  start: number
  from: SheetPose
  range: number
  last: number
  time: number
  speed: number
}
const smallScreen = () => matchMedia('(max-width: 700px)').matches
const sheetPosition = (offset: number, scale = 1) => `translate3d(0,${roundPx(offset)}px,0) scale(${roundUnit(scale)})`
const restingSheet: SheetPose = { y: 0, scale: 1, opacity: 1, dim: 1 }
function allScrollAtTop(target: Element | null, boundary: HTMLElement) {
  let el: Element | null = target
  while (el && el !== boundary.parentElement) {
    if (el.scrollTop > 1) return false
    if (el === boundary) break
    el = el.parentElement
  }
  return boundary.scrollTop <= 1
}

export function Modal({
  ref,
  title,
  children,
  onClose,
  wide = false,
  className = '',
  layoutKey,
}: {
  ref?: Ref<ModalHandle>
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  className?: string
  layoutKey?: string
}) {
  const stage = useRef<HTMLDialogElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const shade = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const settling = useRef<Spring | null>(null)
  const slideSpeed = useRef(0)
  const drag = useRef<SheetDrag | null>(null)
  const dragFrame = useRef(0)
  const beforeHeight = useRef(0)
  const resizeAnimation = useRef<Animation | undefined>(undefined)
  const close = useEvent(onClose)
  const pullable = className !== 'image-viewer'

  function stop() {
    settling.current?.dispose()
    settling.current = null
  }
  function readPose() {
    const style = getComputedStyle(panel.current!)
    const matrix = new DOMMatrixReadOnly(style.transform === 'none' ? undefined : style.transform)
    return { y: matrix.m42, scale: matrix.a, opacity: Number(style.opacity), dim: Number(getComputedStyle(shade.current!).opacity) }
  }
  function paint(pose: SheetPose) {
    panel.current!.style.transform = sheetPosition(pose.y, pose.scale)
    panel.current!.style.opacity = String(roundUnit(pose.opacity))
    shade.current!.style.opacity = String(roundUnit(pose.dim))
  }
  function settle(from: SheetPose, to: SheetPose, speed: number, done?: () => void) {
    stop()
    if (stage.current) stage.current.dataset.animating = 'true'
    const distance = to.y - from.y
    const spring = new Spring(0, (value, velocity) => {
      slideSpeed.current = velocity * distance / 1000
      const p = clamp(value)
      paint({
        y: mix(from.y, to.y, value), scale: mix(from.scale, to.scale, value),
        opacity: mix(from.opacity, to.opacity, p), dim: mix(from.dim, to.dim, p),
      })
    }, modalSpring)
    settling.current = spring
    spring.set(0, Math.abs(distance) > 4 ? clamp(speed * 1000 / distance, -2.2, 8) : 0)
    spring.to(1, () => {
      settling.current = null
      if (stage.current) delete stage.current.dataset.animating
      done?.()
    }, { stopAtTarget: to.opacity === 0 })
  }

  const dismiss = useEvent((after?: () => void) => {
    if (closing.current || !stage.current?.open) return false
    closing.current = true
    cancelAnimationFrame(dragFrame.current)
    const pull = drag.current
    drag.current = null
    const from = readPose()
    panel.current!.inert = true
    // Immediately stop intercepting pointer events so the workspace responds right away while fading out.
    if (stage.current) stage.current.style.pointerEvents = 'none'
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) sel.removeAllRanges()
    const to = {
      y: pull ? from.y + 92 : smallScreen() ? 56 : 22,
      scale: pull ? from.scale * 0.96 : smallScreen() ? 0.97 : 0.935,
      opacity: 0, dim: 0,
    }
    let finished = false
    let guard: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (finished) return
      finished = true
      if (guard !== undefined) clearTimeout(guard)
      stop()
      if (stage.current) {
        delete stage.current.dataset.animating
        stage.current.style.pointerEvents = ''
        if (stage.current.open) stage.current.close()
      }
      close()
      after?.()
    }
    // Guarantee the top-layer <dialog> always closes even if rAF/spring is throttled or interrupted.
    guard = setTimeout(finish, 420)
    settle(from, to, pull?.speed ?? slideSpeed.current, finish)
    return true
  })
  useImperativeHandle(ref, () => ({
    dismiss,
    captureHeight: () => { beforeHeight.current = panel.current?.offsetHeight ?? 0 },
  }), [dismiss])

  useLayoutEffect(() => {
    const from = beforeHeight.current
    const sheet = panel.current
    beforeHeight.current = 0
    if (!sheet || !from || closing.current) return
    resizeAnimation.current?.cancel()
    const to = sheet.offsetHeight
    if (Math.abs(to - from) <= 1) return
    sheet.dataset.resizing = 'true'
    const anim = animateMotion(
      sheet,
      [{ height: from + 'px' }, { height: to + 'px' }],
      { duration: 300, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
    resizeAnimation.current = anim
    if (!anim) {
      delete sheet.dataset.resizing
      return
    }
    void anim.finished.catch(() => {}).finally(() => {
      if (resizeAnimation.current === anim) delete sheet.dataset.resizing
    })
  }, [layoutKey])

  function draggedPose(active: SheetDrag): SheetPose {
    const offset = rubberBand(active.last - active.start, 28, 56)
    const progress = clamp(Math.max(0, offset) / active.range)
    return {
      ...active.from,
      y: active.from.y + offset,
      scale: active.from.scale * mix(1, 0.96, progress),
      dim: active.from.dim * (1 - progress),
    }
  }

  useLayoutEffect(() => {
    const dialog = stage.current!
    const sheet = panel.current!
    const viewport = window.visualViewport
    const layout = () => {
      const top = viewport?.offsetTop || 0
      const bottom = Math.max(0, innerHeight - top - (viewport?.height || innerHeight))
      dialog.style.setProperty('--modal-top', top + 'px')
      dialog.style.setProperty('--modal-bottom', bottom + 'px')
    }
    layout()
    closing.current = false
    dialog.showModal()
    settle({ y: smallScreen() ? 64 : 28, scale: smallScreen() ? 0.97 : 0.92, opacity: 0, dim: 0 },
      restingSheet, 0)
    viewport?.addEventListener('resize', layout)
    viewport?.addEventListener('scroll', layout)
    const removeBack = registerBackHandler('dialog', () => { dismiss(); return true }, dialog)

    let touch: {
      id: number
      startX: number
      startY: number
      target: Element | null
      pulling: boolean
      activeDrag?: SheetDrag
    } | null = null
    const onTouchStart = (event: TouchEvent) => {
      if (!pullable || closing.current || drag.current || touch || event.touches.length !== 1) return
      const t = event.touches[0]
      const el = event.target as Element | null
      if (!el || el.closest('.modal-heading,input,textarea,select,[contenteditable],.segmented-control')) return
      touch = { id: t.identifier, startX: t.clientX, startY: t.clientY, target: el, pulling: false }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!touch) return
      const t = Array.from(event.touches).find((item) => item.identifier === touch!.id)
      if (!t) return
      const dx = t.clientX - touch.startX
      const dy = t.clientY - touch.startY
      if (!touch.pulling) {
        if (dy < -4 || (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy))) {
          touch = null
          return
        }
        if (dy < 8 || dy < Math.abs(dx) * 1.15) return
        if (!allScrollAtTop(touch.target, sheet)) {
          touch = null
          return
        }
        touch.pulling = true
        dialog.dataset.animating = 'true'
        const from = readPose()
        stop()
        paint(from)
        const active: SheetDrag = {
          id: touch.id,
          start: t.clientY,
          from,
          range: clamp(sheet.clientHeight * 0.66, 160, 320),
          last: t.clientY,
          time: event.timeStamp,
          speed: 0,
        }
        touch.activeDrag = active
        drag.current = active
      }
      const active = touch.activeDrag
      if (!active) return
      event.preventDefault()
      const elapsed = Math.max(1, event.timeStamp - active.time)
      active.speed = active.speed * 0.35 + ((t.clientY - active.last) / elapsed) * 0.65
      active.last = t.clientY
      active.time = event.timeStamp
      if (!dragFrame.current) {
        dragFrame.current = requestAnimationFrame(() => {
          dragFrame.current = 0
          if (drag.current === active) paint(draggedPose(active))
        })
      }
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (!touch) return
      const t = Array.from(event.changedTouches).find((item) => item.identifier === touch!.id)
      if (!t) return
      const currentTouch = touch
      touch = null
      const active = currentTouch.activeDrag
      if (!currentTouch.pulling || !active || drag.current !== active) return
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = 0
      const cancelled = event.type === 'touchcancel'
      const distance = t.clientY - active.start
      const speed = event.timeStamp - active.time < 85 ? active.speed : 0
      active.speed = speed
      if (!cancelled) active.last = t.clientY
      const pose = draggedPose(active)
      paint(pose)
      if (!cancelled && distance > 12 && distance + clamp(speed, 0, 1.2) * 95 > 82) dismiss()
      else {
        drag.current = null
        settle(pose, restingSheet, cancelled ? 0 : speed)
      }
    }
    if (pullable) {
      sheet.addEventListener('touchstart', onTouchStart, { passive: true })
      sheet.addEventListener('touchmove', onTouchMove, { passive: false })
      sheet.addEventListener('touchend', onTouchEnd)
      sheet.addEventListener('touchcancel', onTouchEnd)
    }

    return () => {
      removeBack()
      stop()
      resizeAnimation.current?.cancel()
      cancelAnimationFrame(dragFrame.current)
      viewport?.removeEventListener('resize', layout)
      viewport?.removeEventListener('scroll', layout)
      if (pullable) {
        sheet.removeEventListener('touchstart', onTouchStart)
        sheet.removeEventListener('touchmove', onTouchMove)
        sheet.removeEventListener('touchend', onTouchEnd)
        sheet.removeEventListener('touchcancel', onTouchEnd)
      }
      dialog.close()
    }
  }, [])

  function grab(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || closing.current || drag.current || !pullable ||
      (event.target as Element).closest('button')) return
    const from = readPose()
    stop()
    paint(from)
    drag.current = {
      id: event.pointerId, start: event.clientY, from,
      range: clamp(panel.current!.clientHeight * 0.66, 160, 320),
      last: event.clientY, time: event.timeStamp, speed: 0,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function pull(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    const elapsed = Math.max(1, event.timeStamp - active.time)
    active.speed = active.speed * 0.35 + (event.clientY - active.last) / elapsed * 0.65
    active.last = event.clientY
    active.time = event.timeStamp
    if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0
      paint(draggedPose(active))
    })
  }
  function release(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    cancelAnimationFrame(dragFrame.current)
    dragFrame.current = 0
    const distance = event.clientY - active.start
    const speed = event.timeStamp - active.time < 85 ? active.speed : 0
    active.speed = speed
    if (!cancelled) active.last = event.clientY
    const pose = draggedPose(active)
    paint(pose)
    if (!cancelled && distance > 12 && distance + clamp(speed, 0, 1.2) * 95 > 82) dismiss()
    else {
      drag.current = null
      settle(pose, restingSheet, cancelled ? 0 : speed)
    }
  }

  return (
    <dialog
      ref={stage}
      className="modal-stage"
      aria-label={title}
      onCancel={(e) => {
        e.stopPropagation()
        e.preventDefault()
        dismiss()
      }}
    >
      <div ref={shade} className="modal-shade" aria-hidden="true" onClick={() => dismiss()} />
      <div ref={panel} className={'modal menu-surface ' + (wide ? 'wide ' : '') + className}>
        <div className={'modal-heading' + (pullable ? ' pullable' : '')} onPointerDown={grab} onPointerMove={pull}
          onPointerUp={release} onPointerCancel={(event) => release(event, true)}
          onLostPointerCapture={(event) => release(event, true)}>
          <h2>{title}</h2>
          <IconButton label="关闭" onClick={() => dismiss()}>
            <X size={20} />
          </IconButton>
        </div>
        {children}
      </div>
    </dialog>
  )
}
export function Confirm({
  title,
  text,
  action = '确认',
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string
  text: string
  action?: string
  onConfirm: () => void
  onClose: () => void
  danger?: boolean
}) {
  const modal = useRef<ModalHandle>(null)
  return (
    <Modal ref={modal} title={title} onClose={onClose}>
      <p className="muted confirm-text">{text}</p>
      <div className="button-row end">
        <button className="secondary" onClick={() => modal.current?.dismiss()}>
          取消
        </button>
        <button
          className={danger ? 'danger' : 'primary'}
          onClick={() => modal.current?.dismiss(onConfirm)}
        >
          {action}
        </button>
      </div>
    </Modal>
  )
}
export function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode
  title: string
  text: string
  children?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  )
}
export function ColorDot({
  color,
  selected,
  onClick,
  label,
  className = '',
  checkColor,
}: {
  color: string
  selected: boolean
  onClick: () => void
  label: string
  className?: string
  checkColor?: string
}) {
  return (
    <button
      type="button"
      className={'color-dot' + (className ? ' ' + className : '')}
      style={{ background: color, ...(checkColor ? { color: checkColor } : {}) }}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
    >
      {selected && <Check size={16} strokeWidth={2.4} />}
    </button>
  )
}
