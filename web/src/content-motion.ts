import { useLayoutEffect, useRef, type RefObject } from 'react'
import { animateMotion, inertClone, motionEnabled, motionTiming } from './motion'

type Scene = { layer: HTMLElement; scroll: number[]; direction: number }

function scrollContainers(root: HTMLElement) {
  return [root, ...root.querySelectorAll<HTMLElement>('[data-motion-scroll]')]
}

// Capture the displayed content at the point a navigation commits. The old layer
// stays inert, so editing and scrolling always belong to the live view.
export function useContentMotion(ref: RefObject<HTMLElement | null>, view: string) {
  const scene = useRef<Scene | null>(null)
  const running = useRef<{ layer: HTMLElement; animations: Animation[] } | null>(null)

  function stop() {
    running.current?.animations.forEach((animation) => animation.cancel())
    running.current?.layer.remove()
    running.current = null
  }

  function capture(direction = 1) {
    const node = ref.current
    if (!node || !motionEnabled() || typeof node.animate !== 'function') return
    // Record which cards lie strictly below the visible fold so the cloned outgoing layer skips painting them.
    const liveCards = node.querySelectorAll<HTMLElement>('.note-card')
    let dropFrom = -1
    if (liveCards.length > 14) {
      const viewBottom = node.getBoundingClientRect().bottom + 120
      for (let i = 0; i < liveCards.length; i++) {
        if (liveCards[i].getBoundingClientRect().top > viewBottom) {
          dropFrom = i
          break
        }
      }
    }
    const layer = inertClone(node)
    if (dropFrom >= 0) {
      const clonedCards = layer.querySelectorAll<HTMLElement>('.note-card')
      for (let i = dropFrom; i < clonedCards.length; i++) clonedCards[i].remove()
    }
    layer.classList.add('outgoing-content')
    Object.assign(layer.style, {
      width: node.offsetWidth + 'px',
      height: node.offsetHeight + 'px',
      top: node.offsetTop + 'px',
      left: node.offsetLeft + 'px',
    })
    scene.current = { layer, scroll: scrollContainers(node).map((container) => container.scrollTop), direction }
  }

  useLayoutEffect(() => {
    const old = scene.current
    const node = ref.current
    scene.current = null
    if (!old || !node?.parentElement) return
    const opacity = running.current ? Number(getComputedStyle(node).opacity) : 0
    stop()
    node.parentElement.append(old.layer)
    scrollContainers(old.layer).forEach((container, i) => { container.scrollTop = old.scroll[i] })
    const enter = animateMotion(node, [
      { opacity: Math.min(opacity, 0.15), transform: `translate3d(${old.direction * 18}px,0,0) scale(0.988)` },
      { opacity: 1, transform: 'none' },
    ], motionTiming.enter)
    const exit = animateMotion(old.layer, [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: `translate3d(${-old.direction * 14}px,0,0) scale(0.985)` },
    ], { ...motionTiming.exit, fill: 'forwards' })
    if (!exit) old.layer.remove()
    const animations = [enter, exit].filter((animation): animation is Animation => !!animation)
    const active = { layer: old.layer, animations }
    running.current = active
    void exit?.finished.catch(() => {}).finally(() => {
      if (running.current === active) old.layer.remove()
    })
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (running.current === active) stop()
    })
  }, [view])

  useLayoutEffect(() => () => {
    stop()
    scene.current = null
  }, [])
  return capture
}
