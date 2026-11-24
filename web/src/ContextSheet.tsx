import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, Folder, Pin, Star, Trash2, X } from 'lucide-react'
import { AttachmentThumb } from './media'
import { FolderPicker } from './ChoiceMenu'
import { firstImage } from './list-model'
import { registerBackHandler } from './native'
import { useEvent, usePreventSelection } from './interaction'
import { Spring, animateMotion, cardGhost, clamp, measureCard, mix, paintMenuReveal, recordElement, roundPx, roundUnit, surfaceSpring, type CardOrigin } from './motion'
import type { LocalRecord, Value } from './types'

export function ContextSheet({ record, folders, origin, onClose, onSelect, onUpdate, onDelete }: {
  record: LocalRecord
  folders: LocalRecord[]
  origin: CardOrigin | null
  onClose: () => void
  onSelect: () => void
  onUpdate: (patch: Partial<Value>) => void
  onDelete: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  usePreventSelection(dialog)
  const stage = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const copy = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuContent = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const spring = useRef<Spring | null>(null)
  const restoreSource = useRef<() => void>(() => {})
  const closing = useRef(false)
  const finish = useEvent(onClose)
  const image = firstImage(record.value.content)
  const excerpt = (record.value.plainText || record.value.note || '').slice(0, 650)

  const dismiss = useEvent((action?: () => void) => {
    if (closing.current) return
    closing.current = true
    stage.current!.inert = true
    closeButton.current!.inert = true
    dialog.current!.dataset.closing = 'true'
    dialog.current!.dataset.animating = 'true'
    spring.current?.to(0, () => {
      delete dialog.current?.dataset.animating
      restoreSource.current()
      dialog.current?.close()
      finish()
      action?.()
    }, { stopAtTarget: true })
  })

  useLayoutEffect(() => {
    const modal = dialog.current!, bounds = stage.current!, card = preview.current!
    const text = copy.current!, actions = menu.current!, body = menuContent.current!
    const shade = backdrop.current!, exit = closeButton.current!
    const source = recordElement(record.id)
    const initial = origin || (source ? measureCard(source) : {
      x: innerWidth / 2 - 130, y: innerHeight * 0.35, width: 260, height: 74, radius: 16,
    })
    const previous = source?.style.visibility || ''
    const ghost = source ? cardGhost(source, initial) : null
    if (source) source.style.visibility = 'hidden'
    restoreSource.current = () => {
      if (source?.isConnected) source.style.visibility = previous
    }
    if (ghost) modal.append(ghost)
    modal.showModal()
    modal.focus({ preventScroll: true })
    let width = 1, height = 1, x = 0, y = 0, frame = 0

    function draw(value: number) {
      const lift = Math.max(0, value)
      const clampedLift = clamp(lift)
      const reveal = (lift - 0.16) / 0.84
      const handoff = clamp((lift - 0.06) / 0.36)
      const left = mix(initial.x, x, lift)
      const top = mix(initial.y, y, lift)
      const w = Math.max(1, mix(initial.width, width, lift))
      const h = Math.max(1, mix(initial.height, height, lift))
      const uniformScale = roundUnit(mix(clamp(initial.width / Math.max(1, width), 0.78, 1), 1, clampedLift))
      shade.style.opacity = String(roundUnit(clamp(lift * 1.25)))
      exit.style.opacity = String(roundUnit(clamp(reveal)))
      // Pure GPU compositor transform + opacity (no per-frame clip-path / border-radius rasterization).
      card.style.transform = lift === 1 ? '' : `translate3d(${roundPx(left - x)}px,${roundPx(top - y)}px,0) scale(${uniformScale})`
      card.style.clipPath = ''
      card.style.opacity = String(roundUnit(ghost ? handoff : clampedLift))
      text.style.transform = ''
      paintMenuReveal(actions, body, reveal, left - x, top + h - y - height, 'down')
      if (ghost) {
        const gScale = roundUnit(Math.max(0.5, w / Math.max(1, initial.width)))
        const gOpacity = roundUnit(1 - handoff)
        ghost.style.transform = `translate3d(${roundPx(left)}px,${roundPx(top)}px,0) scale(${gScale})`
        ghost.style.clipPath = ''
        ghost.style.opacity = String(gOpacity)
        ghost.style.visibility = gOpacity <= 0.001 ? 'hidden' : 'visible'
      }
    }
    function layout() {
      const viewport = window.visualViewport
      const insets = getComputedStyle(modal)
      const left = parseFloat(insets.paddingLeft) + 16
      const right = innerWidth - parseFloat(insets.paddingRight) - 16
      const top = (viewport?.offsetTop ?? 0) + parseFloat(insets.paddingTop) + 54
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) -
        parseFloat(insets.paddingBottom) - 14
      const room = Math.max(132, bottom - top)
      width = Math.min(Math.max(1, right - left), 420)
      bounds.style.width = width + 'px'
      card.style.minHeight = Math.min(170, room * 0.29) + 'px'
      card.style.maxHeight = Math.min(280, room * 0.43) + 'px'
      height = Math.max(1, card.offsetHeight)
      const gap = parseFloat(getComputedStyle(card).marginBottom)
      body.style.maxHeight = Math.max(44, room - height - gap - 2) + 'px'
      x = clamp(initial.x + (initial.width - width) / 2, left, Math.max(left, right - width))
      y = clamp(initial.y, top, Math.max(top, bottom - height - gap - actions.offsetHeight))
      bounds.style.left = x + 'px'
      bounds.style.top = y + 'px'
      draw(spring.current?.value ?? 0)
    }
    spring.current = new Spring(0, draw, surfaceSpring)
    modal.dataset.animating = 'true'
    layout()
    spring.current.to(1, () => {
      delete modal.dataset.animating
      if (!closing.current) card.focus({ preventScroll: true })
    })
    const actionButtons = Array.from(body.querySelectorAll<HTMLElement>('button')).slice(0, 8)
    const itemAnimations = actionButtons
      .map((btn, index) => animateMotion(
        btn,
        [{ opacity: 0, transform: 'translate3d(0,-8px,0)' }, { opacity: 1, transform: 'none' }],
        { duration: 240, delay: 75 + index * 24, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'backwards' },
      ))
      .filter((a): a is Animation => !!a)
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(layout)
    }
    const sizes = new ResizeObserver(resize)
    sizes.observe(card)
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    const removeBack = registerBackHandler('dialog', () => { dismiss(); return true }, modal)
    return () => {
      removeBack()
      itemAnimations.forEach((a) => a.cancel())
      sizes.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      spring.current?.dispose()
      ghost?.remove()
      restoreSource.current()
      modal.close()
    }
  }, [])

  const { t, i18n } = useTranslation()
  return (
    <dialog ref={dialog} className="morph-dialog" aria-label={t('context.sheetAria')} tabIndex={-1}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); dismiss() }}
      onContextMenu={(event) => event.preventDefault()}>
      <div ref={backdrop} className="context-backdrop" aria-hidden="true" onClick={(event) => { event.stopPropagation(); dismiss() }} />
      <button ref={closeButton} className="context-dismiss icon-button" aria-label={t('context.closeAria')} onClick={(event) => { event.stopPropagation(); dismiss() }}>
        <X size={20} />
      </button>
      <div ref={stage} className="context-stage">
        <div ref={preview} className="context-preview" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
          <span ref={copy} className="context-preview-copy">
            <strong>{record.value.title || t(record.kind === 'note' ? 'notes.untitledNote' : 'notes.untitledTodo')}</strong>
            <span className="context-meta">
              <span>{folders.find((folder) => folder.id === record.value.folderId)?.value.name || t('common.default')}</span>
              <time>{new Date(record.updatedAt).toLocaleDateString(i18n.resolvedLanguage || i18n.language, { month: 'long', day: 'numeric' })}</time>
            </span>
            {image && <AttachmentThumb id={image} />}
            {excerpt && <span className="context-excerpt">{excerpt}</span>}
          </span>
        </div>
        <div ref={menu} className="context-actions menu-surface">
          <div ref={menuContent} className="menu-scroll">
            <button onClick={() => dismiss(onSelect)}><CheckCheck size={19} /><span>{t('context.multiSelect')}</span></button>
            <button onClick={() => dismiss(() => onUpdate({ starred: !record.value.starred }))}>
              <Star size={19} /><span>{record.value.starred ? t('context.unstar') : t('context.star')}</span>
            </button>
            <FolderPicker label={t('context.moveToFolderAria')} folders={folders} value={record.value.folderId || ''}
              action={<><Folder size={19} /><span>{t('context.move')}</span></>}
              onChange={(folderId) => dismiss(() => onUpdate({ folderId }))} />
            <button onClick={() => dismiss(() => onUpdate({ pinned: !record.value.pinned }))}>
              <Pin size={19} /><span>{record.value.pinned ? t('context.unpin') : t('context.pin')}</span>
            </button>
            <button className="text-danger" onClick={() => dismiss(onDelete)}><Trash2 size={19} /><span>{t('context.delete')}</span></button>
          </div>
        </div>
      </div>
    </dialog>
  )
}
