import { lazy, Suspense, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Folder,
  GripVertical,
  LayoutList,
  Menu,
  MoreHorizontal,
  NotebookPen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Star,
  StickyNote,
  Trash2,
  WifiOff,
  X,
  ArrowLeft,
  ArchiveRestore,
  ArrowUpDown,
  LogIn,
  LayoutGrid,
  CalendarDays,
} from 'lucide-react'
import { v7 as uuid } from 'uuid'
const loadEditor = () => import('./editor')
const NoteEditor = lazy(() => loadEditor().then((m) => ({ default: m.NoteEditor })))
import { AttachmentContext } from './media'
import {
  createRecord,
  dbName,
  deleteFolder,
  emptyDoc,
  initialize,
  NoteDB,
  save,
  sessionRead,
  textDoc,
} from './store'
import { api, SyncEngine, type SyncState } from './sync'
const Settings = lazy(() => import('./panels').then((m) => ({ default: m.Settings })))
const HistoryPanel = lazy(() => import('./panels').then((m) => ({ default: m.HistoryPanel })))
const SharePanel = lazy(() => import('./panels').then((m) => ({ default: m.SharePanel })))
import { RecordList } from './RecordList'
import { ContextSheet } from './ContextSheet'
import { useChromeSelectionGuard, useEvent, useGlassContact, useMediaQuery, usePreventSelection } from './interaction'
import { SegmentedControl } from './SegmentedControl'
import { FluidPopover } from './FluidPopover'
import { FolderPicker } from './ChoiceMenu'
import { useDrawerMotion, useNavPillMotion, useNoteMotion } from './navigation-motion'
import { bindSelectionSafeInput, hideKeyboard, useAppViewport } from './input-motion'
import { measureCard, recordElement, type CardOrigin } from './motion'
import { summarize, sortRecords, moveRecord, type Placement, type SortOrder } from './list-model'
import { flushEdits, BufferedSave } from './buffered-save'
import { Capacitor } from '@capacitor/core'
import { handleBack, registerBackHandler, installNativeNavigation, setSystemBarTheme } from './native'
import { ColorDot, Confirm, Empty, IconButton, Modal, SearchField, type ModalHandle } from './ui'
import { useContentMotion } from './content-motion'
import type { LocalRecord, Module, Session, Value, RecordData, RecordSummary } from './types'

const accents: Record<string, string> = {
  yellow: '#e9c13b',
  blue: '#81b6ff',
  green: '#82c7a5',
  purple: '#bd9cf3',
}
const emptySummaries: RecordSummary[] = []
const modules = [{ value: 'note', label: '备忘' }, { value: 'todo', label: '待办' }] as const
function dateLabel(s: string) {
  const d = new Date(s),
    today = new Date()
  if (d.toDateString() === today.toDateString())
    return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}
function persisted<T>(key: string, fallback: T) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback
  } catch {
    return fallback
  }
}
export default function App() {
  const [session, setSession] = useState<Session | null>(sessionRead),
    [theme, setTheme] = useState<string>(() => persisted('theme', 'system')),
    [accent, setAccent] = useState<string>(() => persisted('accent', '#e5bd42')),
    [motion, setMotion] = useState<boolean>(() => persisted('motion', true))
  const [module, setModule] = useState<Module>('note'),
    [filter, setFilter] = useState('all'),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [openingId, setOpeningId] = useState<string | null>(null),
    [mobileOpen, setMobileOpen] = useState(false),
    [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [history, setHistory] = useState(false),
    [share, setShare] = useState(false),
    [folderModal, setFolderModal] = useState<LocalRecord | 'new' | null>(null),
    [folderName, setFolderName] = useState(''),
    [folderColor, setFolderColor] = useState('#e5bd42'),
    [toast, setToast] = useState(''),
    [confirm, setConfirm] = useState<{
      title: string
      text: string
      action: string
      run: () => void
    } | null>(null),
    [sort, setSort] = useState<string>(() => persisted('sort', 'updated')),
    [selecting, setSelecting] = useState(false),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [menu, setMenu] = useState(false),
    [view, setView] = useState<'list' | 'grid'>(() => persisted('view', 'list')),
    [grouped, setGrouped] = useState<boolean>(() => persisted('grouped', false)),
    [contextId, setContextId] = useState<string | null>(null),
    [sync, setSync] = useState<SyncState>({
      status: session ? 'syncing' : 'local',
      message: '正在打开…',
    }),
    [ready, setReady] = useState(false),
    [initialSyncSettled, setInitialSyncSettled] = useState(!session),
    [showLoading, setShowLoading] = useState(false)
  const db = useMemo(() => new NoteDB(dbName(session)), [session?.user.id, session?.base])
  const engine = useRef<SyncEngine | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  useChromeSelectionGuard()
  usePreventSelection(listRef)
  const detailRef = useRef<HTMLDivElement>(null)
  const listMenuId = useId()
  const listMenuAnchor = useRef<HTMLButtonElement>(null)
  const folderDialog = useRef<ModalHandle>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  useAppViewport(shellRef)
  const compact = useMediaQuery('(max-width: 1150px)')
  const narrow = useMediaQuery('(max-width: 700px)')
  const captureList = useContentMotion(listRef, JSON.stringify([db.name, module, filter]))
  const captureDetail = useContentMotion(detailRef, JSON.stringify([db.name, module, selected]))
  const editorOrigin = useRef<CardOrigin | null>(null)
  const contextOrigin = useRef<CardOrigin | null>(null)
  const navigationRequest = useRef(0)
  const loadedSelection = useRef<{ space: string; record: LocalRecord } | null>(null)
  const closeEditor = useEvent(async () => {
    const request = ++navigationRequest.current
    try {
      await flushEdits()
      engine.current?.schedule(100)
      if (request !== navigationRequest.current) return false
      await hideKeyboard()
      if (request !== navigationRequest.current) return false
      setOpeningId(null)
      setMobileOpen(false)
      return true
    } catch {
      return false
    }
  })
  const drawerActive = useDrawerMotion(drawer, setDrawer, shellRef)
  const editorActive = useNoteMotion(mobileOpen, selected, shellRef, editorOrigin, closeEditor)
  const displayed = useRef<{ space: string; record: LocalRecord } | null>(null)
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches)
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  const overview = useLiveQuery(
    async () => ({ space: db.name, rows: await db.summaries.toArray() }),
    [db],
  )
  const listLoaded = overview?.space === db.name
  const rows = listLoaded ? overview.rows : emptySummaries
  const waitingInitialSync =
    !!session && !initialSyncSettled && listLoaded && rows.length === 0 && sync.status === 'syncing'
  const listPending = !ready || !listLoaded || waitingInitialSync
  useEffect(() => {
    if (!listPending) {
      setShowLoading(false)
      return
    }
    const timer = setTimeout(() => setShowLoading(true), 180)
    return () => clearTimeout(timer)
  }, [listPending])
  const query = useDeferredValue(search.trim().toLocaleLowerCase())
  const found = useLiveQuery(
    async () => ({
      space: db.name,
      rows: query
        ? (
            await db.records
              .where('kind')
              .equals(module)
              .filter((r) =>
                [r.value.title, r.value.plainText, r.value.note]
                  .join(' ')
                  .toLocaleLowerCase()
                  .includes(query),
              )
              .toArray()
          ).map(summarize)
        : [],
    }),
    [db, module, query],
  )
  const matches = found?.space === db.name ? found.rows : emptySummaries
  const selectedRecord = useLiveQuery(
    async () => ({ space: db.name, id: selected, record: selected ? await db.records.get(selected) : undefined }),
    [db, selected],
  )
  const activeRecord = selectedRecord?.space === db.name && selectedRecord.id === selected
    ? selectedRecord.record
    : loadedSelection.current?.space === db.name ? loadedSelection.current.record : undefined
  const current =
    activeRecord?.id === selected &&
    activeRecord?.kind === module &&
    !activeRecord.deletedAt &&
    !activeRecord.value.purged
      ? activeRecord
      : undefined
  if (current) displayed.current = { space: db.name, record: current }
  const displayRecord = current || (editorActive && displayed.current?.space === db.name &&
    displayed.current.record.kind === module && displayed.current.record.id === selected
    ? displayed.current.record : undefined)
  useLayoutEffect(() => {
    if (current && openingId === current.id) {
      setMobileOpen(true)
      setOpeningId(null)
    }
  }, [current?.id, openingId])
  const loadedContext = useLiveQuery(
    async () => ({
      space: db.name,
      record: contextId ? await db.records.get(contextId) : undefined,
    }),
    [db, contextId],
  )
  const contextValue = loadedContext?.space === db.name ? loadedContext.record : undefined
  const contextRecord =
    contextValue?.id === contextId && contextValue?.kind === module ? contextValue : undefined
  const folderKey = rows
    .filter((r) => r.kind === 'folder')
    .map((r) => r.id + ':' + r.rev + ':' + r.version)
    .join('|')
  useNavPillMotion(navRef, `${module}:${filter}:${folderKey}`)
  useGlassContact(motion)
  const nativeBack = useEvent(() => {
    if (drawer && compact) {
      setDrawer(false)
      return true
    } else if (mobileOpen && narrow) {
      void closeEditor()
      return true
    } else if (selecting) {
      setSelecting(false)
      setChecked(new Set())
      return true
    }
    return false
  })
  useEffect(() => {
    const remove = installNativeNavigation()
    const removeBack = registerBackHandler('page', nativeBack)
    return () => {
      remove()
      removeBack()
    }
  }, [])

  // Intercept mobile browser edge-swipe-back (popstate) so swiping back closes the editor/overlay
  // instead of exiting straight to the browser homepage. Restrict to narrow/coarse touch viewports
  // so desktop modal closes (e.g. HistoryPanel diff) never trigger async window.history.back() churn.
  const touchBrowser = useMediaQuery('(pointer: coarse)')
  const webBackGuarded =
    !Capacitor.isNativePlatform() &&
    (narrow || touchBrowser) &&
    ((mobileOpen && narrow) ||
      (drawer && compact) ||
      settings ||
      history ||
      share ||
      !!folderModal ||
      !!contextId ||
      selecting)
  const webBackGuardedRef = useRef(webBackGuarded)
  webBackGuardedRef.current = webBackGuarded
  const pendingGuardPops = useRef(0)
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return
    const onPopState = () => {
      if (pendingGuardPops.current > 0) {
        pendingGuardPops.current--
        return
      }
      if (handleBack()) {
        // If another layer (e.g., mobile editor under a dialog/style panel) remains open, re-arm the guard.
        queueMicrotask(() => {
          if (webBackGuardedRef.current && !window.history.state?.yonoteGuard) {
            window.history.pushState({ yonoteGuard: true }, '')
          }
        })
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return
    if (webBackGuarded) {
      if (!window.history.state?.yonoteGuard) {
        window.history.pushState({ yonoteGuard: true }, '')
      }
    } else if (window.history.state?.yonoteGuard) {
      pendingGuardPops.current++
      window.history.back()
    }
  }, [webBackGuarded])

  useEffect(() => {
    const flush = () => {
      void flushEdits()
        .then(() => engine.current?.schedule(100))
        .catch(() => {})
    }
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => void loadEditor(), { timeout: 4000 })
      : setTimeout(() => void loadEditor(), 2000)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  }, [])
  useEffect(() => {
    localStorage.setItem('view', JSON.stringify(view))
    localStorage.setItem('grouped', JSON.stringify(grouped))
  }, [view, grouped])
  const folders = useMemo(
    () =>
      rows
        .filter((r) => r.kind === 'folder' && !r.deletedAt && r.value.module === module)
        .sort((a, b) => (a.value.sort || 0) - (b.value.sort || 0)),
    [db, folderKey, module],
  )
  const folderNames = useMemo(
    () => new Map(folders.map((f) => [f.id, f.value.name || ''])),
    [folders],
  )
  const items = useMemo(() => rows.filter((r) => r.kind === module && !r.value.purged), [rows, module])
  const counts = useMemo(() => {
    const byFolder = new Map<string, number>()
    let all = 0, starred = 0, done = 0, trash = 0
    for (const record of items) {
      if (record.deletedAt) { trash++; continue }
      if (module === 'todo' && record.value.done) { done++; continue }
      all++
      if (record.value.starred) starred++
      const folder = record.value.folderId || ''
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1)
    }
    return { all, starred, done, trash, byFolder }
  }, [items, module])
  const notify = useEvent((s: string) => setToast(s))
  useEffect(() => {
    let live = true
    setReady(false)
    setInitialSyncSettled(!session)
    initialize(db, !session)
      .then(() => {
        if (live) {
          setReady(true)
          const se = new SyncEngine(db, session, (s) => {
            if (live) {
              setSync(s)
              if (s.status !== 'syncing') setInitialSyncSettled(true)
            }
          })
          engine.current = se
          se.start()
        }
      })
      .catch((e) => notify('本地存储打开失败：' + e.message))
    return () => {
      live = false
      engine.current?.stop()
      db.close()
    }
  }, [db])
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const listener = () => setSystemDark(query.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.setProperty(
      '--accent',
      accents[accent] || (accent.startsWith('#') ? accent : accents.yellow),
    )
    document.documentElement.dataset.motion = String(motion)
    localStorage.setItem('theme', JSON.stringify(theme))
    localStorage.setItem('accent', JSON.stringify(accent))
    localStorage.setItem('motion', JSON.stringify(motion))
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        document.documentElement.dataset.theme === 'light' ? '#f9faf8' : '#0b0d0e',
      )
  }, [theme, resolvedTheme, accent, motion])
  useEffect(() => setSystemBarTheme(resolvedTheme === 'light'), [resolvedTheme])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2100)
    return () => clearTimeout(t)
  }, [toast])
  useEffect(() => {
    localStorage.setItem('sort', JSON.stringify(sort))
  }, [sort])
  function resetWorkspace() {
    setFilter('all')
    setSelected(null)
    setOpeningId(null)
    setMobileOpen(false)
    setHistory(false)
    setShare(false)
    setChecked(new Set())
    setSelecting(false)
    setContextId(null)
  }
  useEffect(() => { resetWorkspace() }, [db])
  useEffect(() => { if (!compact) setDrawer(false) }, [compact])

  async function switchModule(next: Module) {
    const request = ++navigationRequest.current
    if (next === module) return true
    await flushEdits()
    if (request !== navigationRequest.current) return false
    const direction = next === 'todo' ? 1 : -1
    captureList(direction)
    if (!narrow) captureDetail(direction)
    if (listRef.current) listRef.current.scrollTop = 0
    resetWorkspace()
    setModule(next)
    return true
  }
  const visible = useMemo(() => sortRecords(
    (query ? matches : items).filter((r) => {
      if (r.kind !== module) return false
      if (filter === 'trash') return !!r.deletedAt
      if (r.deletedAt) return false
      if (filter === 'starred' && !r.value.starred) return false
      if (filter === 'done' && !r.value.done) return false
      if (module === 'todo' && filter !== 'done' && r.value.done) return false
      if (
        filter !== 'all' &&
        filter !== 'starred' &&
        filter !== 'done' &&
        filter !== 'trash' &&
        (r.value.folderId || '') !== filter
      )
        return false
      return true
    }),
    sort as SortOrder,
  ), [query, matches, items, filter, module, sort])
  const label =
    filter === 'all'
      ? module === 'note'
        ? '全部备忘'
        : '全部待办'
      : filter === 'starred'
        ? '我的收藏'
        : filter === 'trash'
          ? '最近删除'
          : filter === 'done'
            ? '已完成'
            : filter === ''
              ? '默认'
              : folders.find((f) => f.id === filter)?.value.name || '全部备忘'
  const update = useEvent(async function update(
    id: string,
    kind: LocalRecord['kind'],
    patch: Partial<Value>,
    deletedAt?: string | null,
    baseVersion?: number,
  ) {
    try {
      await save(db, id, kind, patch, deletedAt, baseVersion)
      const isTextEdit =
        deletedAt === undefined &&
        (patch.content !== undefined ||
          patch.plainText !== undefined ||
          patch.title !== undefined ||
          patch.note !== undefined)
      // Keep local IndexedDB saves instant, but wait for 10s of typing idle before pushing full note payloads to cloud.
      // Explicit actions (back/done/switch/background/pin/delete) sync immediately.
      engine.current?.schedule(isTextEdit ? 10000 : 650)
    } catch (e) {
      notify('保存失败，请保留页面：' + (e as Error).message)
      throw e
    }
  })
  async function add() {
    try {
      setHistory(false)
      setShare(false)
      setContextId(null)
      const request = ++navigationRequest.current
      if (module === 'note') await loadEditor()
      if (listRef.current) listRef.current.scrollTop = 0
      await flushEdits()
      const id = await createRecord(db, module, folders.some((f) => f.id === filter) ? filter : '')
      const record = await db.records.get(id)
      if (request !== navigationRequest.current) return
      if (record) loadedSelection.current = { space: db.name, record }
      const trigger = shellRef.current?.querySelector<HTMLElement>('.add-button')
      editorOrigin.current = trigger ? measureCard(trigger) : null
      if (!narrow) captureDetail()
      setSelected(id)
      setOpeningId(id)
      engine.current?.schedule()
    } catch (e) {
      notify((e as Error).message)
    }
  }
  const choose = useEvent(async function choose(id: string, customOrigin?: CardOrigin) {
    if (selecting) {
      setChecked((old) => {
        const n = new Set(old)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      })
      return
    }
    setHistory(false)
    setShare(false)
    setContextId(null)
    const request = ++navigationRequest.current
    try {
      await Promise.all([
        flushEdits().catch(() => {}),
        module === 'note' ? loadEditor() : undefined,
      ])
      if (id !== selected) engine.current?.schedule(150)
      const record = await db.records.get(id)
      if (request !== navigationRequest.current || !record || record.deletedAt || record.value.purged) return
      loadedSelection.current = { space: db.name, record }
    } catch {
      return
    }
    const source = recordElement(id)
    editorOrigin.current = customOrigin || (source ? measureCard(source) : null)
    if (!narrow && id !== selected) captureDetail()
    setSelected(id)
    if (filter !== 'trash') setOpeningId(id)
  })
  async function nav(id: string) {
    const request = ++navigationRequest.current
    try {
      await flushEdits()
    } catch {
      return
    }
    if (request !== navigationRequest.current) return
    if (id !== filter) {
      captureList()
      if (!narrow && selected) captureDetail(-1)
      if (listRef.current) listRef.current.scrollTop = 0
    }
    setFilter(id)
    setSelected(null)
    setOpeningId(null)
    setMobileOpen(false)
    setDrawer(false)
    setSelecting(false)
    setChecked(new Set())
  }
  function editFolder(f: LocalRecord | 'new') {
    setFolderModal(f)
    setFolderName(f === 'new' ? '' : f.value.name || '')
    setFolderColor(f === 'new' ? '#e5bd42' : f.value.color || '#e5bd42')
  }
  async function batch(action: 'trash' | 'restore' | 'move', folderId = '') {
    for (const id of checked) {
      const r = rows.find((r) => r.id === id)
      if (r)
        await update(
          id,
          r.kind,
          action === 'move' ? { folderId } : {},
          action === 'trash' ? new Date().toISOString() : action === 'restore' ? null : undefined,
        )
    }
    setSelecting(false)
    setChecked(new Set())
    notify(action === 'trash' ? '已移入最近删除' : action === 'restore' ? '已恢复' : '已移动')
  }
  async function purge(r: LocalRecord) {
    try {
      if (session) {
        await engine.current?.run()
        await api(session, '/api/records/' + r.id, { method: 'DELETE' })
      }
      await db.transaction('rw', db.records, db.summaries, db.outbox, db.attachments, async () => {
        await db.records.delete(r.id)
        await db.summaries.delete(r.id)
        await db.outbox.delete(r.id)
        const remaining = await db.records.toArray()
        const references = remaining
          .map((item) => JSON.stringify(item.value.content || {}))
          .join('')
        const files = await db.attachments.where('noteId').equals(r.id).toArray()
        for (const file of files) {
          if (!references.includes(file.id)) await db.attachments.delete(file.id)
        }
      })
      setSelected(null)
      engine.current?.schedule()
      notify('已彻底删除')
    } catch (e) {
      notify((e as Error).message)
    }
  }
  const reorder = useEvent(async (source: string, target: string, placement: Placement) => {
    if (sort !== 'manual' || source === target || filter === 'trash') return false
    try {
      const changed = await db.transaction('rw', db.records, db.summaries, db.outbox, async () => {
        const items = sortRecords((await db.summaries.toArray()).filter((record) =>
          record.kind === module && !record.deletedAt && !record.value.purged), 'manual')
        const ordered = moveRecord(items, source, target, placement)
        if (ordered === items) return false
        for (const [index, record] of ordered.entries()) {
          if (record.value.sort !== index) await save(db, record.id, record.kind, { sort: index })
        }
        return true
      })
      if (changed) engine.current?.schedule()
      return changed
    } catch (error) {
      notify('排序保存失败：' + (error as Error).message)
      return false
    }
  })
  function connect(s: Session | null) {
    localStorage.setItem('yonote-session', JSON.stringify(s))
    setSession(s)
  }
  const openContext = useEvent((id: string) => {
    window.getSelection()?.removeAllRanges()
    const source = recordElement(id)
    contextOrigin.current = source ? measureCard(source) : null
    setContextId(id)
  })
  const toggleDone = useEvent((id: string) => {
    const r = rows.find((r) => r.id === id)
    if (r)
      void update(id, 'todo', {
        done: !r.value.done,
        doneAt: !r.value.done ? new Date().toISOString() : null,
      })
  })
  const restore = useEvent((id: string) => {
    const r = rows.find((r) => r.id === id)
    if (r) void update(id, r.kind, {}, null)
  })
  const confirmPurge = useEvent((id: string) => {
    const r = rows.find((r) => r.id === id)
    if (r)
      setConfirm({
        title: '彻底删除？',
        text: '记录、附件和历史版本将永久移除。',
        action: '删除',
        run: () => void purge(r),
      })
  })
  const syncLabel = {
    local: '账号与同步', synced: '已同步', syncing: '正在同步', offline: '离线', error: '同步待处理',
  }[sync.status]
  const localContext = useMemo(() => ({ db, session }), [db, session])
  return (
    <AttachmentContext.Provider value={localContext}>
      <div ref={shellRef} className={'app-shell ' + (mobileOpen ? 'mobile-editor-open ' : '') + (compact && drawerActive ? 'drawer-active' : '')}>
        {compact && drawerActive && (
          <button
            className="drawer-shade"
            aria-label="收起文件夹"
            onClick={() => setDrawer(false)}
          />
        )}
        <aside className={'sidebar ' + (drawer ? 'open' : '')}>
          <div className="brand">
            <span className="brand-icon">
              <StickyNote size={23} />
            </span>
            <span>
              便签
            </span>
            <IconButton
              className="drawer-close"
              label="收起文件夹"
              onClick={() => setDrawer(false)}
            >
              <X size={20} />
            </IconButton>
          </div>

          <nav ref={navRef} aria-label="文件夹导航">
            <span className="nav-active-pill" aria-hidden="true" />
            <button
              className={'nav-row ' + (filter === 'all' ? 'selected' : '')}
              aria-current={filter === 'all' || undefined}
              onClick={() => nav('all')}
            >
              {module === 'note' ? <NotebookPen /> : <CheckCircle2 />}
              <span>{module === 'note' ? '全部备忘' : '全部待办'}</span>
              <small>{counts.all}</small>
            </button>
            {module === 'note' ? (
              <button
                className={'nav-row ' + (filter === 'starred' ? 'selected' : '')}
                aria-current={filter === 'starred' || undefined}
                onClick={() => nav('starred')}
              >
                <Star />
                <span>我的收藏</span>
                <small>{counts.starred}</small>
              </button>
            ) : (
              <button
                className={'nav-row ' + (filter === 'done' ? 'selected' : '')}
                aria-current={filter === 'done' || undefined}
                onClick={() => nav('done')}
              >
                <CheckCheck />
                <span>已完成</span>
                <small>{counts.done}</small>
              </button>
            )}
            <button
              className={'nav-row ' + (filter === 'trash' ? 'selected' : '')}
              aria-current={filter === 'trash' || undefined}
              onClick={() => nav('trash')}
            >
              <Trash2 />
              <span>最近删除</span>
              <small>{counts.trash}</small>
            </button>
            <div className="folder-heading">
              <span>文件夹</span>
              <IconButton label="新建文件夹" onClick={() => editFolder('new')}>
                <Plus size={16} />
              </IconButton>
            </div>
            <button
              className={'nav-row ' + (filter === '' ? 'selected' : '')}
              aria-current={filter === '' || undefined}
              onClick={() => nav('')}
            >
              <Folder className="accent" />
              <span>默认</span>
              <small>{counts.byFolder.get('') ?? 0}</small>
            </button>
            {folders.map((f) => (
              <div className="folder-row" key={f.id}>
                <button
                  className={'nav-row ' + (filter === f.id ? 'selected' : '')}
                  aria-current={filter === f.id || undefined}
                  onClick={() => nav(f.id)}
                >
                  <Folder style={{ color: f.value.color }} />
                  <span>{f.value.name}</span>
                  <small>{counts.byFolder.get(f.id) ?? 0}</small>
                </button>
                <button
                  className="folder-edit"
                  aria-label={'编辑文件夹 ' + f.value.name}
                  onClick={() => editFolder(f)}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="account-button" onClick={() => setSettings(true)}>
              <span className="avatar">
                {session?.user.username.slice(0, 1).toUpperCase() || 'Y'}
              </span>
              <span className="account-copy">
                {session?.user.username || '本机空间'}
                <small>{session && <span className={'status-dot ' + sync.status} />}{syncLabel}</small>
              </span>
              {!session && <SettingsIcon size={18} />}
            </button>
            {session && (
              <IconButton label="立即同步" onClick={() => void engine.current?.run()}>
                <RefreshCw size={16} className={sync.status === 'syncing' ? 'spin' : ''} />
              </IconButton>
            )}
          </div>
        </aside>
        <main className="list-pane" inert={(mobileOpen && narrow) || (drawer && compact)}>
          <header className="list-top">
            <IconButton
              className="drawer-trigger"
              label="打开文件夹"
              expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <Menu size={21} />
            </IconButton>
            <SegmentedControl label="备忘与待办" className="module-segments" value={module}
              options={modules} onChange={switchModule} />
            <div className="menu-anchor">
              <IconButton ref={listMenuAnchor} id={listMenuId + '-trigger'} popup={listMenuId}
                label="列表菜单" expanded={menu} onClick={() => setMenu(!menu)}>
                <MoreHorizontal size={24} />
              </IconButton>
              <FluidPopover anchor={listMenuAnchor} id={listMenuId} open={menu} onClose={() => setMenu(false)}>
                {module === 'note' && (
                  <button role="menuitem" onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
                    {view === 'list' ? <LayoutGrid size={18} /> : <LayoutList size={18} />}
                    <span>{view === 'list' ? '宫格视图' : '列表视图'}</span>
                  </button>
                )}
                <button
                  role="menuitemcheckbox"
                  aria-checked={grouped}
                  onClick={() => {
                    setGrouped(!grouped)
                    if (!grouped && sort === 'manual') setSort('updated')
                  }}
                >
                  <CalendarDays size={18} />
                  <span>按日期分组</span>
                  {grouped && <Check size={16} />}
                </button>
                <button role="menuitem" onClick={() => setSelecting(!selecting)}>
                  <CheckCheck size={17} />
                  {selecting ? '结束多选' : '多选'}
                </button>
                <div className="sort-options" role="group" aria-label="排序方式">
                  <span>排序方式</span>
                  {([
                    ['updated', '修改时间'],
                    ['created', '创建时间'],
                    ['title', '标题'],
                    ['manual', '手动'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      role="menuitemradio"
                      aria-checked={sort === value}
                      onClick={() => {
                        setSort(value)
                        if (value === 'manual') setGrouped(false)
                      }}
                    >
                      {label}
                      {sort === value && <Check size={15} />}
                    </button>
                  ))}
                </div>
                <button role="menuitem" onClick={() => setSettings(true)}>
                  <SettingsIcon size={17} />
                  设置与账号
                </button>
              </FluidPopover>
            </div>
          </header>
          <div className="list-heading">
            <h1>{label}</h1>
            <div className="list-subtitle">
              <span>
                {listPending ? '\u00A0' : `${visible.length} ${module === 'note' ? '条备忘' : '条待办'}`}
              </span>
              <span role={session && sync.status !== 'synced' ? 'status' : undefined}>
                {session && sync.status !== 'synced' && sync.status !== 'local'
                  ? syncLabel
                  : filter === 'trash'
                    ? '30 天'
                    : { updated: '修改时间', created: '创建时间', title: '标题', manual: '手动' }[sort]}
              </span>
            </div>
          </div>
          <SearchField
            label={module === 'note' ? '搜索备忘' : '搜索待办'}
            placeholder={module === 'note' ? '搜索备忘' : '搜索待办'}
            value={search}
            onChange={setSearch}
          />
          {selecting && (
            <div className="bulk-bar">
              <button
                onClick={() =>
                  setChecked(
                    new Set(checked.size === visible.length ? [] : visible.map((r) => r.id)),
                  )
                }
              >
                全选 · {checked.size}
              </button>
              <FolderPicker folders={folders} label="批量移动到文件夹" placeholder="移动到…"
                disabled={!checked.size} onChange={(value) => void batch('move', value)} />
              <IconButton
                label={filter === 'trash' ? '批量恢复' : '批量删除'}
                disabled={!checked.size}
                onClick={() => void batch(filter === 'trash' ? 'restore' : 'trash')}
              >
                {filter === 'trash' ? <ArchiveRestore size={18} /> : <Trash2 size={18} />}
              </IconButton>
              <IconButton
                label="结束多选"
                onClick={() => {
                  setSelecting(false)
                  setChecked(new Set())
                }}
              >
                <X size={17} />
              </IconButton>
            </div>
          )}
          <div className="record-window">
          <div className="record-list" ref={listRef}>
            {listPending ? (
              showLoading ? (
                <div className="list-skeleton" aria-busy="true" aria-label="正在加载">
                  <div className="list-skeleton-card"><span /><span /></div>
                  <div className="list-skeleton-card"><span /><span /></div>
                  <div className="list-skeleton-card"><span /><span /></div>
                </div>
              ) : null
            ) : visible.length === 0 ? (
              <Empty
                icon={
                  search ? (
                    <Search size={28} />
                  ) : module === 'note' ? (
                    <NotebookPen size={28} />
                  ) : (
                    <CheckCircle2 size={28} />
                  )
                }
                title={
                  search
                    ? '没有找到相关记录'
                    : filter === 'trash'
                      ? '最近删除为空'
                      : module === 'note'
                        ? '暂无备忘'
                        : '暂无待办'
                }
                text=""
              />
            ) : (
              <RecordList
                records={visible}
                module={module}
                view={view}
                grouped={grouped}
                manual={sort === 'manual'}
                selecting={selecting}
                checked={checked}
                selected={selected}
                trash={filter === 'trash'}
                folderNames={folderNames}
                transitionKey={`${module}:${filter}:${view}`}
                onOpen={choose}
                onContext={openContext}
                onDone={toggleDone}
                onRestore={restore}
                onPurge={confirmPurge}
                onReorder={reorder}
              />
            )}
          </div>
          </div>
          {filter !== 'trash' && (
            <div className="add-area">
              <button
                className="add-button"
                aria-label={module === 'note' ? '新建备忘' : '新建待办'}
                onClick={() => void add()}
              >
                <Plus size={30} />
              </button>
            </div>
          )}
        </main>
        <div className="detail-pane">
          <div className="detail-content" ref={detailRef}>
          <Suspense
            fallback={
              <div className="editor-skeleton">
                <div />
                <div />
                <div />
              </div>
            }
          >
            {displayRecord ? (
              module === 'note' ? (
                <NoteEditor
                  key={displayRecord.id}
                  record={displayRecord}
                  db={db}
                  connected={!!session}
                  onBack={closeEditor}
                  onUpdate={(patch, base) => update(displayRecord.id, 'note', patch, undefined, base)}
                  onDelete={() => {
                    void update(displayRecord.id, 'note', {}, new Date().toISOString())
                    setMobileOpen(false)
                    notify('已移入最近删除')
                  }}
                  onHistory={() => setHistory(true)}
                  onShare={() => setShare(true)}
                  folders={folders}
                  notify={notify}
                />
              ) : (
                <TodoEditor
                  key={displayRecord.id}
                  record={displayRecord}
                  folders={folders}
                  onBack={closeEditor}
                  onUpdate={(p, base) => update(displayRecord.id, 'todo', p, undefined, base)}
                  onDelete={() => {
                    void update(displayRecord.id, 'todo', {}, new Date().toISOString())
                    setMobileOpen(false)
                  }}
                />
              )
            ) : selected ? (
              <div className="editor-skeleton">
                <div />
                <div />
                <div />
              </div>
            ) : (
              <div className="desktop-welcome">
                <div className="welcome-art">
                  <div className="welcome-orbit" />
                  <StickyNote size={58} strokeWidth={1} />
                  <span className="welcome-spark">✦</span>
                </div>
                <h2>便签</h2>

                <button className="primary" onClick={() => void add()}>
                  <Plus size={17} />
                  新建{module === 'note' ? '备忘' : '待办'}
                </button>
              </div>
            )}
          </Suspense>
          </div>
        </div>
        <Suspense fallback={null}>
          {contextRecord && (
            <ContextSheet
              record={contextRecord}
              origin={contextOrigin.current}
              folders={folders}
              onClose={() => setContextId(null)}
              onSelect={() => {
                setSelecting(true)
                setChecked(new Set([contextRecord.id]))
              }}
              onUpdate={(patch) => void update(contextRecord.id, contextRecord.kind, patch)}
              onDelete={() =>
                void update(contextRecord.id, contextRecord.kind, {}, new Date().toISOString())
              }
            />
          )}
          {settings && (
            <Settings
              db={db}
              session={session}
              onSession={connect}
              onClose={() => setSettings(false)}
              notify={notify}
              theme={theme}
              setTheme={setTheme}
              accent={accent}
              setAccent={setAccent}
              motion={motion}
              setMotion={setMotion}
            />
          )}
          {history && current && (
            <HistoryPanel
              db={db}
              session={session}
              record={current}
              onClose={() => setHistory(false)}
              notify={notify}
              onRestored={() => engine.current?.schedule()}
            />
          )}
          {share && current && (
            <SharePanel
              session={session}
              record={current}
              onClose={() => setShare(false)}
              notify={notify}
            />
          )}
        </Suspense>
        {folderModal && (
          <Modal
            ref={folderDialog}
            title={folderModal === 'new' ? '新建文件夹' : '编辑文件夹'}
            onClose={() => setFolderModal(null)}
          >
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (!folderName.trim()) return
                const id = folderModal === 'new' ? uuid() : folderModal.id
                await update(id, 'folder', {
                  name: folderName.trim(),
                  module,
                  color: folderColor,
                  sort: folderModal === 'new' ? Date.now() : folderModal.value.sort,
                })
                folderDialog.current?.dismiss()
              }}
            >
              <label className="form-field">
                文件夹名称
                <input
                  autoFocus
                  required
                  maxLength={50}
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="名称"
                />
              </label>
              <div className="color-options">
                {['#e5bd42', '#e6839a', '#79b8d2', '#82c7a5', '#bd9cf3'].map((c) => (
                  <ColorDot
                    key={c}
                    color={c}
                    label={'文件夹颜色 ' + c}
                    selected={folderColor === c}
                    onClick={() => setFolderColor(c)}
                  />
                ))}
              </div>
              <div className="button-row">
                {folderModal !== 'new' && (
                  <button
                    type="button"
                    className="text-danger secondary"
                    onClick={() =>
                      setConfirm({
                        title: '删除文件夹？',
                        text: '其中的记录将移到「默认」文件夹。',
                        action: '删除文件夹',
                        run: () => {
                          void deleteFolder(db, folderModal.id).then(() =>
                            engine.current?.schedule(),
                          )
                          folderDialog.current?.dismiss()
                          setFilter('all')
                        },
                      })
                    }
                  >
                    删除文件夹
                  </button>
                )}
                <button className="primary" type="submit">
                  保存
                </button>
              </div>
            </form>
          </Modal>
        )}
        {confirm && (
          <Confirm
            title={confirm.title}
            text={confirm.text}
            action={confirm.action}
            danger
            onConfirm={confirm.run}
            onClose={() => setConfirm(null)}
          />
        )}
        {toast && (
          <div className="toast glass" role="status">
            <CheckCircle2 size={17} />
            {toast}
          </div>
        )}
      </div>
    </AttachmentContext.Provider>
  )
}

function TodoEditor({
  record,
  folders,
  onBack,
  onUpdate,
  onDelete,
}: {
  record: LocalRecord
  folders: LocalRecord[]
  onBack: () => void
  onUpdate: (p: Partial<Value>, baseVersion?: number) => Promise<void>
  onDelete: () => void
}) {
  const [draft, setDraft] = useState({
    title: record.value.title || '',
    note: record.value.note || '',
  })
  const latest = useRef(draft)
  latest.current = draft
  const updateRef = useRef(onUpdate)
  updateRef.current = onUpdate
  const base = useRef(record.version)
  const recordRef = useRef(record)
  recordRef.current = record
  const titleEl = useRef<HTMLInputElement>(null)
  const noteEl = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const cleanups: (() => void)[] = []
    if (titleEl.current) cleanups.push(bindSelectionSafeInput(titleEl.current))
    if (noteEl.current) cleanups.push(bindSelectionSafeInput(noteEl.current))
    return () => cleanups.forEach((fn) => fn())
  }, [record.id])
  const writer = useMemo(
    () =>
      new BufferedSave(
        () => updateRef.current(latest.current, base.current),
        () => {},
      ),
    [record.id],
  )
  useEffect(
    () => () => {
      void writer.dispose().catch(() => {})
    },
    [writer],
  )
  useEffect(() => {
    if (
      record.version > base.current &&
      (record.value.title || '') === latest.current.title &&
      (record.value.note || '') === latest.current.note
    ) {
      base.current = record.version
    }
    if (!record.dirty && !writer.hasPending) {
      const value = { title: record.value.title || '', note: record.value.note || '' }
      latest.current = value
      base.current = record.version
      setDraft(value)
    }
  }, [record.version, record.dirty])
  function change(patch: Partial<typeof draft>) {
    if (!writer.hasPending) base.current = recordRef.current.version
    latest.current = { ...latest.current, ...patch }
    setDraft(latest.current)
    writer.schedule()
  }
  const back = () =>
    void writer
      .flush()
      .then(onBack)
      .catch(() => {})
  return (
    <section className="editor-pane" aria-label="待办编辑器">
      <header className="editor-nav">
        <IconButton className="editor-back" label="返回待办列表" onClick={back}>
          <ArrowLeft size={21} />
        </IconButton>
        <span className="editor-breadcrumb">待办</span>
        <div className="editor-actions">
          <IconButton label="移入最近删除" onClick={onDelete}>
            <Trash2 size={19} />
          </IconButton>
          <IconButton className="mobile-done" label="完成编辑" onClick={back}>
            <Check size={21} />
          </IconButton>
        </div>
      </header>
      <div className="editor-scroll todo-scroll" data-motion-scroll="">
        <div className="todo-detail">
          <div className="todo-title-row">
            <button
              type="button"
              className="task-status"
              aria-pressed={!!record.value.done}
              aria-label={record.value.done ? '标为未完成' : '标记完成'}
              onClick={() =>
                void onUpdate({
                  done: !record.value.done,
                  doneAt: !record.value.done ? new Date().toISOString() : null,
                }).catch(() => {})
              }
            >
              <span><Check size={15} strokeWidth={2.6} /></span>
            </button>
            <input
              ref={titleEl}
              autoFocus={!record.value.title && !record.value.note && matchMedia('(min-width: 701px)').matches}
              aria-label="待办事项"
              className="note-title"
              placeholder="待办事项"
              maxLength={500}
              value={draft.title}
              onChange={(e) => change({ title: e.target.value })}
            />
          </div>
          <div className="note-meta">
            <FolderPicker label="待办文件夹" folders={folders} value={record.value.folderId || ''}
              onChange={(folderId) => void onUpdate({ folderId }).catch(() => {})} />
            <span>
              {record.value.done
                ? '完成于 ' + dateLabel(record.value.doneAt || record.updatedAt)
                : '创建于 ' + dateLabel(record.value.createdAt || record.updatedAt)}
            </span>
          </div>
          <textarea
            ref={noteEl}
            aria-label="待办备注"
            className="todo-notes"
            placeholder="添加备注"
            value={draft.note}
            onChange={(e) => change({ note: e.target.value })}
          />
        </div>
      </div>
    </section>
  )
}
