import { useLayoutEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { Spring, clamp, motionEnabled } from './motion'

type Option<T extends string> = { value: T; label: string; icon?: ReactNode }
type Drag = {
  id: number
  x: number
  y: number
  start: number
  width: number
  last: number
  time: number
  velocity: number
  moved: boolean
}

export function SegmentedControl<T extends string>({
  value, options, onChange, label, className = '',
}: {
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => boolean | void | Promise<boolean | void>
  label: string
  className?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  const spring = useRef<Spring | null>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const request = useRef(0)
  const selected = Math.max(0, options.findIndex((option) => option.value === value))
  const current = useRef(selected)
  current.current = selected

  useLayoutEffect(() => {
    const node = indicator.current!
    const slide = new Spring(current.current, (index, velocity) => {
      const stretch = motionEnabled() ? Math.min(Math.abs(velocity) * 0.012, 0.075) : 0
      node.style.transform = `translate3d(${index * 100}%,0,0) scaleX(${1 + stretch})`
    })
    spring.current = slide
    slide.set(current.current)
    return () => { slide.dispose(); spring.current = null }
  }, [])
  useLayoutEffect(() => {
    if (!drag.current) spring.current?.to(selected)
  }, [selected])

  async function commit(index: number) {
    const id = ++request.current
    try {
      const accepted = await onChange(options[index].value)
      if (request.current === id && (accepted === false || index === current.current)) {
        spring.current?.to(current.current)
      }
    } catch {
      if (request.current === id) spring.current?.to(current.current)
    }
  }

  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || drag.current) return
    suppressClick.current = false
    drag.current = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      start: spring.current?.value ?? selected,
      width: Math.max(1, (event.currentTarget.clientWidth - 8) / options.length),
      last: event.clientX, time: event.timeStamp, velocity: 0, moved: false,
    }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    if (!active.moved) {
      if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) { drag.current = null; return }
      if (Math.abs(dx) < 5 || Math.abs(dx) < Math.abs(dy) * 1.15) return
      active.moved = true
      suppressClick.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    const speed = (event.clientX - active.last) * 1000 / (Math.max(1, event.timeStamp - active.time) * active.width)
    active.velocity = clamp(active.velocity * 0.35 + speed * 0.65, -6, 6)
    active.last = event.clientX
    active.time = event.timeStamp
    spring.current?.follow(clamp(active.start + dx / active.width, 0, options.length - 1), active.velocity)
  }
  function end(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    drag.current = null
    if (!active.moved) return
    if (cancelled) { spring.current?.to(current.current); return }
    const speed = event.timeStamp - active.time < 85 ? active.velocity : 0
    const index = Math.round(clamp((spring.current?.value ?? selected) + speed * 0.08, 0, options.length - 1))
    root.current?.querySelectorAll('button')[index].focus({ preventScroll: true })
    void commit(index)
  }

  return (
    <div
      ref={root}
      className={'segmented-control ' + className}
      style={{ '--segments': options.length } as CSSProperties}
      role="tablist"
      aria-label={label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={(event) => end(event, true)}
      onLostPointerCapture={(event) => { if (event.target === event.currentTarget) end(event, true) }}
      onPointerLeave={(event) => { if (!drag.current?.moved) end(event, true) }}
    >
      <span ref={indicator} className="segment-indicator" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          type="button"
          role="tab"
          className="segment"
          key={option.value}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={(event) => {
            if (event.detail && suppressClick.current) { suppressClick.current = false; return }
            void commit(index)
          }}
          onKeyDown={(event) => {
            const last = options.length - 1
            const positions = { ArrowLeft: (index + last) % options.length,
              ArrowRight: (index + 1) % options.length, Home: 0, End: last }
            const next = positions[event.key as keyof typeof positions]
            if (next === undefined) return
            event.preventDefault()
            root.current?.querySelectorAll('button')[next].focus({ preventScroll: true })
            void commit(next)
          }}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}
