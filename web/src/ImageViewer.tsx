import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Maximize, Minus, Plus } from 'lucide-react'
import { clamp, mix, Spring } from './motion'
import { Modal, IconButton } from './ui'

type Point = { x: number; y: number }
type ImagePose = Point & { scale: number }
const restingImage: ImagePose = { x: 0, y: 0, scale: 1 }

export function ImageViewer({
  url,
  name,
  onClose,
}: {
  url: string
  name: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1),
    [error, setError] = useState('')
  const transform = useRef(restingImage)
  const image = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const spring = useRef<Spring | null>(null)
  const target = useRef(1)
  const center = useRef<Point>({ x: 0, y: 0 })
  const size = useRef({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 })
  const pointers = useRef(new Map<number, Point>())
  useLayoutEffect(() => {
    const container = stage.current!, picture = image.current!
    const measure = () => {
      size.current = {
        width: container.clientWidth, height: container.clientHeight,
        imageWidth: picture.offsetWidth, imageHeight: picture.offsetHeight,
      }
      transform.current = constrain(transform.current)
      paint()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(picture)
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      spring.current?.dispose()
    }
  }, [])
  function constrain(pose: ImagePose) {
    if (pose.scale <= 1) return restingImage
    const metrics = size.current
    const x = Math.max(0, (metrics.imageWidth * pose.scale - metrics.width) / 2)
    const y = Math.max(0, (metrics.imageHeight * pose.scale - metrics.height) / 2)
    return { ...pose, x: clamp(pose.x, -x, x), y: clamp(pose.y, -y, y) }
  }
  function paint() {
    const s = transform.current
    if (image.current)
      image.current.style.transform = `translate3d(${s.x}px,${s.y}px,0) scale(${s.scale})`
  }
  function zoomAround(next: number, here: Point, previous = here) {
    const current = transform.current
    const scale = clamp(next, 1, 5)
    const ratio = scale / current.scale
    return constrain({ scale, x: here.x - (previous.x - current.x) * ratio, y: here.y - (previous.y - current.y) * ratio })
  }
  function zoom(next: number, point: Point = { x: 0, y: 0 }) {
    spring.current?.dispose()
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const start = transform.current
    const end = zoomAround(next, point)
    target.current = end.scale
    setScale(end.scale)
    const step = new Spring(0, (value) => {
      const p = clamp(value)
      transform.current = { x: mix(start.x, end.x, p), y: mix(start.y, end.y, p), scale: mix(start.scale, end.scale, p) }
      paint()
    })
    spring.current = step
    step.to(1, () => { spring.current = null })
  }
  function point(event: PointerEvent<HTMLDivElement>) {
    return { x: event.clientX - center.current.x, y: event.clientY - center.current.y }
  }
  function end(pointer: number) {
    pointers.current.delete(pointer)
  }
  const { t } = useTranslation()
  return (
    <Modal title={t('viewer.title')} onClose={onClose} className="image-viewer" wide>
      <div
        ref={stage}
        className="image-stage"
        onPointerDown={(e) => {
          if (e.button !== 0 || pointers.current.size >= 2) return
          e.preventDefault()
          spring.current?.dispose()
          spring.current = null
          target.current = transform.current.scale
          if (!pointers.current.size) {
            const bounds = e.currentTarget.getBoundingClientRect()
            center.current = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
          }
          e.currentTarget.setPointerCapture(e.pointerId)
          pointers.current.set(e.pointerId, point(e))
        }}
        onPointerMove={(e) => {
          const old = pointers.current.get(e.pointerId)
          if (!old) return
          const next = point(e)
          pointers.current.set(e.pointerId, next)
          if (pointers.current.size === 2) {
            const other = [...pointers.current].find(([id]) => id !== e.pointerId)![1]
            const gap = Math.hypot(old.x - other.x, old.y - other.y)
            if (gap > 1) {
              const newGap = Math.hypot(next.x - other.x, next.y - other.y)
              transform.current = zoomAround((transform.current.scale * newGap) / gap,
                { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 },
                { x: (old.x + other.x) / 2, y: (old.y + other.y) / 2 })
            }
          } else if (transform.current.scale > 1) {
            const current = transform.current
            transform.current = constrain({ ...current, x: current.x + next.x - old.x, y: current.y + next.y - old.y })
          }
          if (!frame.current) frame.current = requestAnimationFrame(() => {
            frame.current = 0
            target.current = transform.current.scale
            setScale(target.current)
            paint()
          })
        }}
        onPointerUp={(e) => end(e.pointerId)}
        onPointerCancel={(e) => end(e.pointerId)}
        onLostPointerCapture={(e) => end(e.pointerId)}
        onDoubleClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          zoom(target.current > 1 ? 1 : 2.5, {
            x: event.clientX - bounds.left - bounds.width / 2,
            y: event.clientY - bounds.top - bounds.height / 2,
          })
        }}
      >
        <img ref={image} src={url} alt={name} draggable={false} />
      </div>
      <div className="viewer-toolbar glass">
        <IconButton label={t('viewer.zoomOut')} disabled={scale === 1} onClick={() => zoom(target.current - 0.5)}>
          <Minus size={20} />
        </IconButton>
        <button className="zoom-label" onClick={() => zoom(1)} aria-label={t('viewer.actualSize')}>
          {Math.round(scale * 100)}%
        </button>
        <IconButton label={t('viewer.zoomIn')} disabled={scale === 5} onClick={() => zoom(target.current + 0.5)}>
          <Plus size={20} />
        </IconButton>
        <span className="toolbar-divider" />
        <IconButton label={t('viewer.fitScreen')} onClick={() => zoom(1)}>
          <Maximize size={19} />
        </IconButton>
        <IconButton
          label={t('viewer.saveImage')}
          onClick={async () => {
            try {
              const blob = await (await fetch(url)).blob()
              const { downloadBlob } = await import('./export')
              await downloadBlob(blob, name || t('media.imageFileDefault'))
            } catch {
              setError(t('viewer.saveFailed'))
            }
          }}
        >
          <Download size={20} />
        </IconButton>
      </div>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}
