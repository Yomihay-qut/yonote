import { memo, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, GripVertical, Pin, Star } from 'lucide-react'
import { currentLocale } from './i18n'
import { AttachmentThumb } from './media'
import { groupRecords, type Placement } from './list-model'
import { animateMotion } from './motion'
import { useRecordDrag, useRecordLayout } from './record-motion'
import type { Module, RecordSummary } from './types'

type Props = {
  records: RecordSummary[]
  module: Module
  view: 'list' | 'grid'
  grouped: boolean
  manual: boolean
  selecting: boolean
  checked: Set<string>
  selected: string | null
  trash: boolean
  folderNames: Map<string, string>
  transitionKey?: string
  onOpen: (id: string) => void
  onContext: (id: string) => void
  onDone: (id: string) => void
  onRestore: (id: string) => void
  onPurge: (id: string) => void
  onReorder: (source: string, target: string, placement: Placement) => Promise<boolean>
}
export function cardDate(time: string, locale: string = currentLocale()) {
  const date = new Date(time)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
}
export function RecordList({ records, grouped, view, transitionKey, onReorder, ...props }: Props) {
  const { i18n: i18nInst } = useTranslation()
  const activeLocale = i18nInst.resolvedLanguage || i18nInst.language
  const root = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const cascade = useRef<Animation[]>([])
  const grid = view === 'grid' && props.module === 'note'
  const manual = props.manual && !props.selecting && !props.trash
  const { ordered, held, handlers } = useRecordDrag(root, records, manual, grid, onReorder)
  const groups = useMemo(
    () => groupRecords(ordered, grouped && !props.manual, undefined, currentLocale()),
    [ordered, grouped, props.manual, activeLocale],
  )
  const layoutKey = JSON.stringify([grid, ...groups.map((group) => [group.label, ...group.records.map((record) => record.id)])])
  useRecordLayout(root, layoutKey, held)

  useLayoutEffect(() => {
    cascade.current.forEach((a) => a.cancel())
    cascade.current = []
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const list = root.current
    if (!list) return
    const items = Array.from(list.querySelectorAll<HTMLElement>('.note-card')).slice(0, 8)
    const active: Animation[] = []
    items.forEach((card, index) => {
      const anim = animateMotion(
        card,
        [
          { opacity: 0, transform: 'translate3d(0, 14px, 0) scale(0.975)' },
          { opacity: 1, transform: 'none' },
        ],
        {
          duration: 300,
          delay: index * 26,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          fill: 'backwards',
        },
      )
      if (anim) active.push(anim)
    })
    cascade.current = active
    return () => {
      active.forEach((a) => a.cancel())
    }
  }, [transitionKey])

  return (
    <div ref={root} className={'cards ' + (grid ? 'grid-view' : 'list-view')} {...handlers}
      onDragStart={manual ? (event) => event.preventDefault() : undefined}>
      {groups.map((group) => (
        <div className="record-group" key={group.label || 'all'}>
          {group.label && <h2 className="date-group-label">{group.label}</h2>}
          <div className="group-cards">
            {group.records.map((record) => (
              <RecordCard key={record.id} record={record} {...props} manual={manual} held={held === record.id} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
type CardProps = Omit<Props, 'records' | 'grouped' | 'view' | 'transitionKey' | 'onReorder'> & {
  record: RecordSummary
  held: boolean
}
const RecordCard = memo(
  function RecordCard({
    record: r,
    module,
    selecting,
    checked,
    selected,
    trash,
    manual,
    folderNames,
    onOpen,
    onContext,
    onDone,
    onRestore,
    onPurge,
    held,
  }: CardProps) {
    const press = useRef<{
      x: number
      y: number
      card: HTMLElement
      chargeTimer: ReturnType<typeof setTimeout>
      timer: ReturnType<typeof setTimeout>
    } | null>(null)
    const suppressClick = useRef(false)
    const triggered = useRef(false)
    useEffect(
      () => () => {
        if (press.current) {
          clearTimeout(press.current.chargeTimer)
          clearTimeout(press.current.timer)
          delete press.current.card.dataset.pressing
        }
      },
      [],
    )
    function cancel() {
      if (press.current) {
        clearTimeout(press.current.chargeTimer)
        clearTimeout(press.current.timer)
        delete press.current.card.dataset.pressing
      }
      press.current = null
    }
    function down(e: PointerEvent<HTMLDivElement>) {
      if (
        e.button !== 0 ||
        selecting ||
        trash ||
        (e.target as HTMLElement).closest('[data-card-control]')
      )
        return
      suppressClick.current = false
      triggered.current = false
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) sel.removeAllRanges()
      const card = e.currentTarget
      delete card.dataset.dragged
      const state = {
        x: e.clientX,
        y: e.clientY,
        card,
        chargeTimer: setTimeout(() => {
          if (!card.hasAttribute('data-dragged')) card.dataset.pressing = 'true'
        }, 100),
        timer: setTimeout(() => {
          delete card.dataset.pressing
          if (card.hasAttribute('data-dragged') || triggered.current) return
          triggered.current = true
          suppressClick.current = true
          onContext(r.id)
        }, 360),
      }
      press.current = state
    }
    const { t, i18n: cardI18n } = useTranslation()
  const cardLocale = cardI18n.resolvedLanguage || cardI18n.language
  const untitled = t(module === 'note' ? 'notes.untitledNote' : 'notes.untitledTodo')
  const titleText = r.value.title || untitled
  return (
      <div
        data-record-id={r.id}
        data-draggable={manual ? '' : undefined}
        data-held={held ? '' : undefined}
        className={
          'note-card ' +
          (r.id === selected ? 'chosen ' : '') +
          (r.value.done ? 'completed ' : '') +
          (checked.has(r.id) ? 'checked' : '')
        }
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          cancel()
          if (!selecting && !trash && !triggered.current) {
            triggered.current = true
            suppressClick.current = true
            onContext(r.id)
          }
        }}
        onPointerDown={down}
        onPointerMove={(e) => {
          const p = press.current
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 9) cancel()
        }}
        onPointerCancel={cancel}
        onPointerUp={cancel}
      >
        <button
          className="card-main"
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false
              return
            }
            onOpen(r.id)
          }}
          aria-label={titleText}
        >
          {selecting ? (
            <span className="select-box">{checked.has(r.id) && <Check size={15} />}</span>
          ) : module === 'note' ? (
            <span className="note-accent" />
          ) : (
            <span
              data-card-control
              className={'todo-check ' + (r.value.done ? 'is-done' : '')}
              role="checkbox"
              aria-checked={!!r.value.done}
              aria-label={t('todo.completeAria', { title: r.value.title || t('todo.breadcrumb') })}
              onClick={(e) => {
                e.stopPropagation()
                onDone(r.id)
              }}
            >
              {r.value.done && <Check size={14} />}
            </span>
          )}
          <span className="card-copy">
            <strong>{titleText}</strong>
            <span className="card-excerpt">
              {module === 'note' ? r.value.plainText?.trim() || '' : r.value.note || ''}
            </span>
            <small>
              {cardDate(r.updatedAt, cardLocale)}
              {r.value.folderId && folderNames.has(r.value.folderId) && (
                <span> · {folderNames.get(r.value.folderId)}</span>
              )}
            </small>
          </span>
          {r.thumbnailId && <AttachmentThumb id={r.thumbnailId} />}
          <span className="card-indicators">
            {r.value.pinned && <Pin size={12} />}{' '}
            {r.value.starred && <Star size={12} fill="currentColor" />}
          </span>
        </button>
        {manual && (
          <button type="button" data-card-control className="sort-handle"
            aria-label={t('list.dragSortAria', { title: r.value.title || t('list.defaultRecord') })} aria-keyshortcuts="ArrowUp ArrowDown">
            <GripVertical size={18} />
          </button>
        )}
        {trash && (
          <div className="trash-actions">
            <button onClick={() => onRestore(r.id)}>{t('common.restore')}</button>
            <button className="text-danger" onClick={() => onPurge(r.id)}>
              {t('common.purge')}
            </button>
          </div>
        )}
      </div>
    )
  },
  (a, b) =>
    a.record.id === b.record.id &&
    a.record.rev === b.record.rev &&
    a.record.version === b.record.version &&
    a.record.dirty === b.record.dirty &&
    a.selecting === b.selecting &&
    a.checked.has(a.record.id) === b.checked.has(b.record.id) &&
    (a.selected === a.record.id) === (b.selected === b.record.id) &&
    a.trash === b.trash &&
    a.manual === b.manual &&
    a.held === b.held &&
    a.folderNames === b.folderNames,
)
