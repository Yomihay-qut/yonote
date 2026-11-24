import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  interpolateMorph,
  menuSpring,
  paintMenuReveal,
  rubberBand,
  Spring,
  surfaceSpring,
} from './motion'
import { findReorderTarget } from './record-motion'

const { frames } = vi.hoisted(() => ({
  frames: new Map<(frame: { timestamp: number }) => void, boolean>(),
}))
vi.mock('motion', async (load) => ({
  ...await load<typeof import('motion')>(),
  frame: { update: (callback: (frame: { timestamp: number }) => void, keep = false) => frames.set(callback, keep) },
  cancelFrame: (callback: (frame: { timestamp: number }) => void) => frames.delete(callback),
}))

let timestamp = 0
function advance(ms: number) {
  timestamp += ms
  for (const [render, keep] of [...frames]) {
    if (!keep) frames.delete(render)
    render({ timestamp })
  }
}

beforeEach(() => {
  timestamp = 0
  vi.spyOn(performance, 'now').mockImplementation(() => timestamp)
  vi.stubGlobal('document', { documentElement: { dataset: {} } })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => {
  frames.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('gesture integration with Motion', () => {
  it('opens with restrained overshoot, uniform surface scaling and clear non-scaled contents', () => {
    const surface = { style: {} } as HTMLElement, contents = { style: {} } as HTMLElement
    const driver = new Spring(0, (value) => paintMenuReveal(surface, contents, value, 0, 0, 'down'), menuSpring)
    driver.to(1)
    for (let i = 0; i < 28; i++) advance(1000 / 120)
    expect(driver.value).toBeGreaterThan(1)
    expect(driver.value).toBeLessThan(1.06)
    const scaleMatch = surface.style.transform.match(/scale\(([^)]+)\)/)
    expect(scaleMatch?.[1]).not.toContain(',')
    expect(Number(scaleMatch?.[1])).toBeGreaterThan(1)
    expect(contents.style.transform).toBe('')
    expect(surface.style.opacity).toBe('1')

    const upSurface = { style: {} } as HTMLElement, upContents = { style: {} } as HTMLElement
    paintMenuReveal(upSurface, upContents, 0, 0, 0, 'up')
    expect(upSurface.style.transform).toContain('translate3d(0px,14px,0)')
    const downSurface = { style: {} } as HTMLElement, downContents = { style: {} } as HTMLElement
    paintMenuReveal(downSurface, downContents, 0, 0, 0, 'down')
    expect(downSurface.style.transform).toContain('translate3d(0px,-14px,0)')
    paintMenuReveal(downSurface, downContents, 1)
    expect(downSurface.style.transform).toBe('none')
    expect(downContents.style.opacity).toBe('')
  })

  it('applies progressive rubber-band damping for negative drag distances', () => {
    expect(rubberBand(0)).toBe(0)
    expect(rubberBand(42)).toBe(42)
    const r1 = rubberBand(-20, 32, 64)
    const r2 = rubberBand(-200, 32, 64)
    expect(r1).toBeLessThan(0)
    expect(r1).toBeGreaterThan(-32)
    expect(r2).toBeLessThan(r1)
    expect(r2).toBeGreaterThan(-32)
  })

  it('interpolates container morph geometry and clamps insets on spring overshoot', () => {
    const from = { x: 24, y: 200, width: 342, height: 108, radius: 20 }
    const to = { x: 0, y: 0, width: 390, height: 844, radius: 0 }
    const start = interpolateMorph(from, to, 0)
    expect(start).toEqual({
      x: 24,
      y: 200,
      width: 342,
      height: 108,
      radius: 20,
      insetTop: 200,
      insetRight: 24,
      insetBottom: 536,
      insetLeft: 24,
    })
    const end = interpolateMorph(from, to, 1)
    expect(end).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      radius: 0,
      insetTop: 0,
      insetRight: 0,
      insetBottom: 0,
      insetLeft: 0,
    })
    const overshoot = interpolateMorph(from, to, 1.04)
    expect(overshoot.insetTop).toBeGreaterThanOrEqual(0)
    expect(overshoot.insetRight).toBeGreaterThanOrEqual(0)
    expect(overshoot.insetBottom).toBeGreaterThanOrEqual(0)
    expect(overshoot.insetLeft).toBeGreaterThanOrEqual(0)
    expect(overshoot.radius).toBe(0)
  })

  it('detects reorder targets stably across unequal-height cards without oscillation and in grid mode', () => {
    // Dragging tall card A (150px) down across short card B (60px)
    const before = [
      { id: 'a', left: 0, top: 0, width: 350, height: 150 },
      { id: 'b', left: 0, top: 162, width: 350, height: 60 },
    ]
    const hitDown = findReorderTarget(before, 'a', { left: 0, top: 45, width: 350, height: 150 }, false)
    expect(hitDown).toEqual({ targetId: 'b', placement: 'after' })

    // After swap at the exact same drag coordinate, hysteresis prevents oscillating back
    const afterSwap = [
      { id: 'b', left: 0, top: 0, width: 350, height: 60 },
      { id: 'a', left: 0, top: 72, width: 350, height: 150 },
    ]
    expect(findReorderTarget(afterSwap, 'a', { left: 0, top: 45, width: 350, height: 150 }, false)).toBeNull()

    // Dragging short card B up across tall card A and verifying no reverse flip at same position
    const hitUp = findReorderTarget(afterSwap, 'b', { left: 0, top: 72, width: 350, height: 60 }, false)
    // Wait: at top=72 vs A top=72? When B starts at 162 (in [A,B]), dragging up to top=72 crosses A midpoint (75)
    expect(hitUp).toBeNull()
    const beforeUp = [
      { id: 'a', left: 0, top: 0, width: 350, height: 150 },
      { id: 'b', left: 0, top: 162, width: 350, height: 60 },
    ]
    expect(findReorderTarget(beforeUp, 'b', { left: 0, top: 72, width: 350, height: 60 }, false)).toEqual({
      targetId: 'a',
      placement: 'before',
    })
    expect(findReorderTarget(afterSwap, 'b', { left: 0, top: 72, width: 350, height: 60 }, false)).toBeNull()

    // Grid mode 2D center hit
    const gridSlots = [
      { id: 'g1', left: 0, top: 0, width: 170, height: 176 },
      { id: 'g2', left: 182, top: 0, width: 170, height: 176 },
    ]
    expect(findReorderTarget(gridSlots, 'g1', { left: 185, top: 4, width: 170, height: 176 }, true)).toEqual({
      targetId: 'g2',
      placement: 'after',
    })
  })

  it('retains release velocity, retargets continuously and completes only the latest request', () => {
    const previous = vi.fn(), complete = vi.fn()
    const driver = new Spring(0.65, vi.fn(), surfaceSpring)
    driver.follow(0.65, 2.6)
    driver.to(1, previous)
    advance(8)
    expect(driver.value).toBeGreaterThan(0.65)
    const { value, velocity } = driver
    driver.to(0, complete)
    expect(driver.value).toBe(value)
    expect(driver.velocity).toBe(velocity)
    advance(8)
    expect(Math.abs(driver.value - value)).toBeLessThan(0.04)
    for (let i = 0; i < 80 && frames.size; i++) advance(1000 / 60)
    expect(previous).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(driver.value).toBe(0)
    expect(frames.size).toBe(0)
  })

  it('coalesces pointer samples and cancels work on disposal', () => {
    const paint = vi.fn()
    const driver = new Spring(0, paint)
    driver.follow(0.3, 1)
    driver.follow(0.68, 3)
    expect(frames.size).toBe(1)
    advance(16)
    expect(paint).toHaveBeenCalledExactlyOnceWith(0.68, 3)
    driver.follow(0.8, 2)
    driver.dispose()
    expect(frames.size).toBe(0)
  })

  it('clamps single-frame mount hiccups without teleporting, while snapping on tab stalls', () => {
    const complete = vi.fn()
    const driver = new Spring(0, vi.fn())
    driver.to(1, complete)
    // Simulate an 80ms React/TipTap mount spike: clamped to 32ms virtual dt so the spring still launches smoothly
    advance(80)
    expect(driver.value).toBeGreaterThan(0)
    expect(driver.value).toBeLessThan(0.5)
    expect(complete).not.toHaveBeenCalled()
    // True >250ms stall still completes immediately
    advance(400)
    expect(driver.value).toBe(1)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('completes a stalled frame and honors the reduced-motion preference', () => {
    const complete = vi.fn()
    const driver = new Spring(0, vi.fn())
    driver.to(1, complete)
    advance(400)
    expect(driver.value).toBe(1)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    driver.to(0, complete)
    expect(driver.value).toBe(0)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(0)
  })

  it('releases a closing surface on its first arrival at the target', () => {
    const complete = vi.fn()
    const driver = new Spring(1, vi.fn(), surfaceSpring)
    driver.to(0, complete, { stopAtTarget: true })
    for (let i = 0; i < 14 && frames.size; i++) advance(1000 / 60)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(driver.value).toBe(0)
    expect(frames.size).toBe(0)
  })
})
