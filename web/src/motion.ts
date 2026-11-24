import { cancelFrame, frame, spring, type FrameData } from 'motion'

export type SpringConfig = { stiffness: number; damping: number }
export const fluidSpring: SpringConfig = { stiffness: 540, damping: 40 }
export const surfaceSpring: SpringConfig = { stiffness: 360, damping: 25 }
export const morphSpring: SpringConfig = { stiffness: 380, damping: 34 }
export const menuSpring: SpringConfig = { stiffness: 360, damping: 27 }
export const modalSpring: SpringConfig = { stiffness: 380, damping: 28 }
export const motionTiming = {
  enter: { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  exit: { duration: 155, easing: 'cubic-bezier(0.32, 0, 0.67, 0)' },
  move: { duration: 280, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
}
export const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n))
export const mix = (a: number, b: number, p: number) => a + (b - a) * p
export const roundPx = (n: number) => Math.round(n * 100) / 100
export const roundUnit = (n: number) => Math.round(n * 1000) / 1000
export function rubberBand(distance: number, max = 32, stiffness = 64): number {
  if (distance >= 0) return distance
  const abs = Math.abs(distance)
  return -((abs * max) / (abs + stiffness))
}

export function interpolateMorph(
  from: CardOrigin,
  to: { x: number; y: number; width: number; height: number; radius?: number },
  progress: number,
) {
  const x = mix(from.x, to.x, progress)
  const y = mix(from.y, to.y, progress)
  const width = Math.max(1, mix(from.width, to.width, progress))
  const height = Math.max(1, mix(from.height, to.height, progress))
  const radius = Math.max(0, mix(from.radius, to.radius ?? 0, progress))
  const insetTop = Math.max(0, y - to.y)
  const insetLeft = Math.max(0, x - to.x)
  const insetRight = Math.max(0, to.x + to.width - (x + width))
  const insetBottom = Math.max(0, to.y + to.height - (y + height))
  return { x, y, width, height, radius, insetTop, insetRight, insetBottom, insetLeft }
}

export function motionEnabled() {
  return document.documentElement.dataset.motion !== 'false' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function animateMotion(
  element: HTMLElement,
  frames: Keyframe[],
  timing: KeyframeAnimationOptions = motionTiming.move,
) {
  return motionEnabled() && typeof element.animate === 'function'
    ? element.animate(frames, timing)
    : undefined
}

export function inertClone<T extends HTMLElement>(element: T) {
  const clone = element.cloneNode(true) as T
  clone.removeAttribute('id')
  clone.removeAttribute('data-record-id')
  clone.querySelectorAll('[id], [data-record-id]').forEach((node) => {
    node.removeAttribute('id')
    node.removeAttribute('data-record-id')
  })
  clone.inert = true
  clone.setAttribute('aria-hidden', 'true')
  return clone
}

// Uniformly scale the surface from its anchor and softly reveal contents without inverse scaling jitter.
export function paintMenuReveal(
  surface: HTMLElement,
  contents: HTMLElement,
  value: number,
  offsetX = 0,
  offsetY = 0,
  direction: 'down' | 'up' = 'down',
) {
  const progress = Math.max(0, value)
  const p = clamp(progress)
  const s = roundUnit(mix(0.78, 1, progress))
  const slideY = roundPx((1 - p) * (direction === 'up' ? 14 : -14))
  surface.style.opacity = String(roundUnit(clamp(progress * 1.5)))
  surface.style.transform = value === 1 && !offsetX && !offsetY
    ? 'none'
    : `translate3d(${roundPx(offsetX)}px,${roundPx(offsetY + slideY)}px,0) scale(${s})`
  contents.style.transform = ''
  contents.style.opacity = value === 1 ? '' : String(roundUnit(clamp((p - 0.1) / 0.62)))
}

// Bridges Motion's numeric spring and frame scheduler to our gesture and surface lifecycle.
export class Spring {
  value: number
  velocity = 0
  private animation?: ReturnType<typeof spring>
  private target: number
  private elapsed = 0
  private lastFrame = 0
  private done?: () => void
  private stopAtTarget = false
  private disposed = false

  constructor(
    initial: number,
    private render: (value: number, velocity: number) => void,
    private config = fluidSpring,
  ) {
    this.value = this.target = initial
  }
  private stop() {
    cancelFrame(this.tick)
    cancelFrame(this.paint)
    this.animation = undefined
    this.done = undefined
  }
  private paint = () => this.render(this.value, this.velocity)

  set(value: number, velocity = 0) {
    if (this.disposed) return
    this.stop()
    this.value = value
    this.velocity = velocity
    this.paint()
  }
  follow(value: number, velocity = 0) {
    if (this.disposed) return
    if (this.animation) this.stop()
    this.value = value
    this.velocity = velocity
    frame.update(this.paint)
  }
  to(target: number, done?: () => void, { stopAtTarget = false } = {}) {
    if (this.disposed) return
    if (!motionEnabled() || (this.value === target && this.velocity === 0)) {
      this.set(target)
      done?.()
      return
    }
    if (this.animation && target === this.target && stopAtTarget === this.stopAtTarget) {
      this.done = done
      return
    }
    this.stop()
    this.done = done
    this.target = target
    this.stopAtTarget = stopAtTarget
    this.elapsed = 0
    this.lastFrame = performance.now()
    this.animation = spring({
      ...this.config,
      keyframes: [this.value, target],
      velocity: this.velocity,
      restDelta: 0.0015,
      restSpeed: 0.025,
    })
    frame.update(this.tick, true)
  }
  private tick = ({ timestamp }: FrameData) => {
    const animation = this.animation
    if (!animation) return
    const rawDt = Math.max(0, timestamp - this.lastFrame)
    if (rawDt > 250) {
      const complete = this.done
      this.set(this.target)
      complete?.()
      return
    }
    // Clamp per-frame delta to 32ms so a slow React mount or GC pause never teleports half the spring.
    this.elapsed += Math.min(rawDt, 32)
    this.lastFrame = timestamp
    const { value, done } = animation.next(this.elapsed)
    const previous = this.target - this.value
    const crossed = this.stopAtTarget && previous !== 0 && previous * (this.target - value) <= 0
    if (done || crossed) {
      const complete = this.done
      this.set(this.target)
      complete?.()
      return
    }
    this.value = value
    this.velocity = animation.velocity?.(this.elapsed) ?? this.velocity
    this.paint()
  }
  dispose() {
    this.disposed = true
    this.stop()
  }
}

export type CardOrigin = { x: number; y: number; width: number; height: number; radius: number }
export function recordElement(id: string) {
  return document.querySelector<HTMLElement>(`[data-record-id="${CSS.escape(id)}"]`)
}
export function measureCard(element: HTMLElement): CardOrigin {
  const box = element.getBoundingClientRect()
  return { x: box.x, y: box.y, width: box.width, height: box.height,
    radius: parseFloat(getComputedStyle(element).borderRadius) || 18 }
}

// Measured once at a transition boundary; the animation only moves the frozen layer.
export function cardGhost(
  element: HTMLElement,
  origin: CardOrigin,
  position: 'fixed' | 'absolute' = 'fixed',
) {
  const ghost = inertClone(element)
  ghost.classList.add('card-ghost')
  ghost.classList.add(element.closest('.grid-view') ? 'grid-view' : 'list-view')
  ghost.classList.remove('chosen', 'pressed')
  Object.assign(ghost.style, {
    position, left: '0px', top: '0px', margin: '0', transform: '',
    width: origin.width + 'px', height: origin.height + 'px', borderRadius: origin.radius + 'px',
    contentVisibility: 'visible', transformOrigin: 'top left',
    pointerEvents: 'none', transition: 'none', zIndex: '70',
    visibility: 'visible',
  })
  return ghost
}
