import { Capacitor } from '@capacitor/core'
import { useEditor, EditorContent, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontSize } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import { BufferedSave } from './buffered-save'
import { FluidPopover } from './FluidPopover'
import { ChoiceMenu, FolderPicker } from './ChoiceMenu'
import { bindSelectionSafeInput, hideKeyboard, showKeyboard, useInputDock } from './input-motion'
import { registerBackHandler } from './native'
import { motionEnabled } from './motion'
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowDownToLine,
  Bold,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock3,
  FileDown,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  MoreHorizontal,
  Paperclip,
  Pin,
  Printer,
  Redo2,
  Search,
  Share2,
  Star,
  Strikethrough,
  Trash2,
  Type,
  Underline as UnderlineIcon,
  Undo2,
  X,
} from 'lucide-react'
import { LocalImage, FileAttachment } from './attachments'
import { addFile } from './media'
import {
  HIGHLIGHT_OPTIONS,
  INK_OPTIONS,
  PAPER_OPTIONS,
  normalizeHighlightToken,
  normalizeInkToken,
  normalizePaperToken,
  paperOptionFor,
  type HighlightToken,
  type InkToken,
  type PaperToken,
} from './palette'
import { canonicalJSON, docText, emptyDoc, save, type NoteDB } from './store'
import { IconButton, ColorDot, Modal, SearchField, type ModalHandle } from './ui'
import type { Doc, LocalRecord, Value } from './types'

type SearchHit = { from: number; to: number }
type NoteSearch = { query: string; index: number; hits: SearchHit[]; decorations: DecorationSet }
const searchKey = new PluginKey<NoteSearch>('note-search')

function matchingText(doc: ProseMirrorNode, query: string) {
  const hits: SearchHit[] = []
  if (!query) return hits
  const pattern = new RegExp(query.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'), 'giu')
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return
    for (const match of block.textBetween(0, block.content.size, '', '\ufffc').matchAll(pattern)) {
      const from = pos + 1 + match.index!
      hits.push({ from, to: from + match[0].length })
    }
    return false
  })
  return hits
}

function revealMatch(editor: Editor) {
  const hit = editor.view.dom.querySelector('.search-hit-current')
  const scroll = editor.view.dom.closest<HTMLElement>('.editor-scroll')
  if (!hit || !scroll) return
  const bounds = scroll.getBoundingClientRect()
  const rect = hit.getBoundingClientRect()
  if (rect.top < bounds.top + 12 || rect.bottom > bounds.bottom - 62) {
    scroll.scrollTo({
      top: scroll.scrollTop + rect.top - bounds.top - Math.max(12, scroll.clientHeight * 0.28),
      behavior: motionEnabled() ? 'smooth' : 'instant',
    })
  }
}

const SearchExtension = Extension.create({
  name: 'noteSearch',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: (): NoteSearch => ({ query: '', index: 0, hits: [], decorations: DecorationSet.empty }),
          apply(tr, old) {
            const request = tr.getMeta(searchKey) as { query?: string; index?: number } | undefined
            const query = request?.query ?? old.query
            if (!tr.docChanged && !request) return old
            const hits = tr.docChanged || query !== old.query ? matchingText(tr.doc, query) : old.hits
            const index = Math.max(0, Math.min(request?.index ?? old.index, hits.length - 1))
            const decorations = hits.length ? DecorationSet.create(tr.doc, hits.map(({ from, to }, hit) =>
              Decoration.inline(from, to, { class: hit === index ? 'search-hit search-hit-current' : 'search-hit' }),
            )) : DecorationSet.empty
            return { query, index, hits, decorations }
          },
        },
        props: {
          decorations(state) {
            return searchKey.getState(state)?.decorations
          },
        },
      }),
    ]
  },
})
const SemanticTextStyle = TextStyle.extend({
  parseHTML() {
    return [
      {
        tag: 'span',
        consuming: false,
        getAttrs: (element) => {
          const el = element as HTMLElement
          const hasInk = !!normalizeInkToken(el.getAttribute('data-ink') || el.style.color)
          const hasSize = !!el.style.fontSize
          if (!hasInk && !hasSize) return false
          return {}
        },
      },
    ]
  },
})

const SemanticColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => {
              const token = normalizeInkToken(
                element.getAttribute('data-ink') || element.style.color,
              )
              return token || null
            },
            renderHTML: (attributes) => {
              const token = normalizeInkToken(attributes.color as string | null | undefined)
              if (!token) return {}
              return { 'data-ink': token }
            },
          },
        },
      },
    ]
  },
})

const SemanticHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (element) => {
          const explicit =
            element.getAttribute('data-hl') ||
            element.getAttribute('data-color') ||
            element.style.backgroundColor
          if (!explicit) return 'yellow'
          return normalizeHighlightToken(explicit) || 'yellow'
        },
        renderHTML: (attributes) => {
          const token =
            normalizeHighlightToken(attributes.color as string | null | undefined) || 'yellow'
          return { 'data-hl': token }
        },
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'mark',
        getAttrs: (element) => {
          const el = element as HTMLElement
          const explicit =
            el.getAttribute('data-hl') ||
            el.getAttribute('data-color') ||
            el.style.backgroundColor
          if (explicit && !normalizeHighlightToken(explicit)) return false
          return {}
        },
      },
    ]
  },
})

type InactiveSelection = { focused: boolean; decorations: DecorationSet }
export const inactiveSelKey = new PluginKey<InactiveSelection>('inactive-selection')

const InactiveSelectionExtension = Extension.create({
  name: 'inactiveSelection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: inactiveSelKey,
        state: {
          init: (): InactiveSelection => ({ focused: true, decorations: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(inactiveSelKey) as boolean | undefined
            const focused = meta !== undefined ? meta : prev.focused
            if (!focused && !tr.selection.empty && !(tr.selection instanceof NodeSelection)) {
              return {
                focused,
                decorations: DecorationSet.create(tr.doc, [
                  Decoration.inline(tr.selection.from, tr.selection.to, {
                    class: 'editor-inactive-selection',
                  }),
                ]),
              }
            }
            return { focused, decorations: DecorationSet.empty }
          },
        },
        props: {
          decorations(state) {
            return inactiveSelKey.getState(state)?.decorations
          },
          handleDOMEvents: {
            focus(view) {
              if (!view.isDestroyed && !inactiveSelKey.getState(view.state)?.focused) {
                view.dispatch(view.state.tr.setMeta(inactiveSelKey, true))
              }
              return false
            },
            blur(view) {
              if (!view.isDestroyed && view.dom.isConnected && inactiveSelKey.getState(view.state)?.focused) {
                view.dispatch(view.state.tr.setMeta(inactiveSelKey, false))
              }
              return false
            },
          },
        },
        view(editorView) {
          queueMicrotask(() => {
            if (!editorView.isDestroyed && editorView.dom.isConnected) {
              const hasFocus = editorView.hasFocus()
              if (inactiveSelKey.getState(editorView.state)?.focused !== hasFocus) {
                editorView.dispatch(editorView.state.tr.setMeta(inactiveSelKey, hasFocus))
              }
            }
          })
          return {}
        },
      }),
    ]
  },
})

export const editorExtensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
  SemanticTextStyle,
  SemanticColor,
  FontSize,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  SemanticHighlight.configure({ multicolor: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  LocalImage,
  FileAttachment,
  Placeholder.configure({ placeholder: () => i18n.t('editor.bodyPlaceholder') }),
  SearchExtension,
  InactiveSelectionExtension,
]

const lineSpacings = [
  { key: 'compact', labelKey: 'editor.spacingCompact' as const, lh: '1.3', gap: '0.06em' },
  { key: 'normal', labelKey: 'editor.spacingNormal' as const, lh: '1.48', gap: '0.16em' },
  { key: 'relaxed', labelKey: 'editor.spacingRelaxed' as const, lh: '1.68', gap: '0.32em' },
  { key: 'loose', labelKey: 'editor.spacingLoose' as const, lh: '1.9', gap: '0.52em' },
] as const
type LineSpacingKey = (typeof lineSpacings)[number]['key']

const PAPER_LABEL_KEYS: Record<PaperToken, `palette.paper.${'default' | 'warm' | 'sage' | 'sky' | 'lavender'}`> = {
  '': 'palette.paper.default',
  warm: 'palette.paper.warm',
  sage: 'palette.paper.sage',
  sky: 'palette.paper.sky',
  lavender: 'palette.paper.lavender',
}
const INK_LABEL_KEYS: Record<'' | InkToken, `palette.ink.${'default' | InkToken}`> = {
  '': 'palette.ink.default',
  amber: 'palette.ink.amber',
  red: 'palette.ink.red',
  blue: 'palette.ink.blue',
  green: 'palette.ink.green',
  purple: 'palette.ink.purple',
  orange: 'palette.ink.orange',
  gray: 'palette.ink.gray',
}
const HIGHLIGHT_LABEL_KEYS: Record<'' | HighlightToken, `palette.highlight.${'none' | HighlightToken}`> = {
  '': 'palette.highlight.none',
  yellow: 'palette.highlight.yellow',
  blue: 'palette.highlight.blue',
  green: 'palette.highlight.green',
  pink: 'palette.highlight.pink',
  purple: 'palette.highlight.purple',
  orange: 'palette.highlight.orange',
}

export function NoteEditor({
  record,
  db,
  connected,
  onBack,
  onUpdate,
  onDelete,
  onHistory,
  onShare,
  folders,
  notify,
}: {
  record: LocalRecord
  db: NoteDB
  connected: boolean
  onBack: () => void
  onUpdate: (p: Partial<Value>, baseVersion?: number) => Promise<void>
  onDelete: () => void
  onHistory: () => void
  onShare: () => void
  folders: LocalRecord[]
  notify: (s: string) => void
}) {
  const { t, i18n: i18nInst } = useTranslation()
  const activeLocale = i18nInst.resolvedLanguage || i18nInst.language
  const [styleOpen, setStyle] = useState(false),
    [colorTray, setColorTray] = useState<'ink' | 'highlight' | null>(null),
    [lineSpacing, setLineSpacing] = useState<LineSpacingKey>(() => {
      const saved = localStorage.getItem('yonote:lineSpacing')
      return lineSpacings.some((s) => s.key === saved) ? (saved as LineSpacingKey) : 'normal'
    }),
    [menu, setMenu] = useState(false),
    [find, setFind] = useState(''),
    [findOpen, setFindOpen] = useState(false),
    [exportOpen, setExport] = useState(false),
    [exportKeepPaper, setExportKeepPaper] = useState(true),
    [original, setOriginal] = useState(false)
  const section = useRef<HTMLElement>(null)
  const editorMenu = useRef<HTMLButtonElement>(null)
  const editorMenuId = useId()
  const findInput = useRef<HTMLInputElement>(null)
  const exportDialog = useRef<ModalHandle>(null)
  const styleMounted = useInputDock(styleOpen, section)
  const restoreKeyboard = useRef(false)
  function closeFind() {
    setFindOpen(false)
    requestAnimationFrame(() => editorMenu.current?.focus({ preventScroll: true }))
  }
  useLayoutEffect(() => {
    if (findOpen) findInput.current?.focus({ preventScroll: true })
  }, [findOpen])
  useEffect(() => {
    return registerBackHandler('editor', () => {
      if (styleOpen) closeStyle()
      else if (findOpen) closeFind()
      else return false
      return true
    }, section.current ?? undefined)
  }, [findOpen, styleOpen])
  const [title, setTitle] = useState(record.value.title || '')
  const titleRef = useRef(title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const updateRef = useRef(onUpdate)
  updateRef.current = onUpdate
  const contentRef = useRef(canonicalJSON(record.value.content || emptyDoc))
  const lastUpdate = useRef(0)
  const surface = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPointerDown = useRef<{ x: number; y: number; insideProse: boolean } | null>(null)
  const [scrollJump, setScrollJump] = useState({ top: false, bottom: false })
  const editorRef = useRef<Editor | null>(null)
  const recordRef = useRef(record)
  recordRef.current = record
  const baseVersion = useRef(record.version)
  const writer = useMemo(
    () =>
      new BufferedSave(
        async () => {
          const current = editorRef.current
          if (!current || current.isDestroyed) return
          const content = current.getJSON() as Doc
          lastUpdate.current = Date.now()
          contentRef.current = canonicalJSON(content)
          await updateRef.current({
            title: titleRef.current,
            content,
            plainText: current.getText({ blockSeparator: '\n' }),
          }, baseVersion.current)
        },
        (error) => notify(error instanceof Error ? error.message : i18n.t('common.saveFailed')),
      ),
    [record.id],
  )
  const scheduleSave = () => {
    if (!writer.hasPending && !composing.current) {
      baseVersion.current = Math.max(baseVersion.current, recordRef.current.version)
    }
    writer.schedule()
  }
  useEffect(
    () => () => {
      if (composing.current) writer.schedule()
      void writer.dispose().catch(() => {})
    },
    [writer],
  )
  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: record.value.content || emptyDoc,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: 'note-body', 'aria-label': i18n.t('editor.bodyAria'), spellcheck: 'false' },
        handleDOMEvents: {
          compositionstart() {
            if (!writer.hasPending) {
              baseVersion.current = Math.max(baseVersion.current, recordRef.current.version)
            }
            composing.current = true
            return false
          },
          compositionend() {
            composing.current = false
            queueMicrotask(() => {
              if (editor && !editor.isDestroyed) writer.schedule()
            })
            return false
          },
          paste(_view, event) {
            const files = Array.from(event.clipboardData?.files || [])
            if (files.length) {
              event.preventDefault()
              void insertFiles(files)
              return true
            }
            return false
          },
          drop(_view, event) {
            const files = Array.from(event.dataTransfer?.files || [])
            if (files.length) {
              event.preventDefault()
              void insertFiles(files)
              return true
            }
            return false
          },
        },
      },
      onUpdate: ({ editor }) => {
        if (!composing.current) scheduleSave()
      },
    },
    [record.id],
  )
  editorRef.current = editor
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dom.setAttribute('aria-label', t('editor.bodyAria'))
    editor.view.dispatch(editor.state.tr.setMeta('i18n', activeLocale))
  }, [editor, activeLocale, t])
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return bindSelectionSafeInput(editor.view.dom)
  }, [editor])
  useEffect(() => {
    const el = titleInputRef.current
    if (!el) return
    return bindSelectionSafeInput(el)
  }, [record.id])
  const state = useEditorState({
    editor,
    selector: (ctx) =>
      ctx.editor
        ? {
            bold: ctx.editor.isActive('bold'),
            italic: ctx.editor.isActive('italic'),
            underline: ctx.editor.isActive('underline'),
            strike: ctx.editor.isActive('strike'),
            fontSize: ctx.editor.getAttributes('textStyle').fontSize as string | undefined,
            color: normalizeInkToken(ctx.editor.getAttributes('textStyle').color as string | undefined),
            highlight: ctx.editor.isActive('highlight')
              ? normalizeHighlightToken(ctx.editor.getAttributes('highlight').color as string | undefined) || 'yellow'
              : '',
            bullet: ctx.editor.isActive('bulletList'),
            ordered: ctx.editor.isActive('orderedList'),
            task: ctx.editor.isActive('taskList'),
            h1: ctx.editor.isActive('heading', { level: 1 }),
            h2: ctx.editor.isActive('heading', { level: 2 }),
            h3: ctx.editor.isActive('heading', { level: 3 }),
            undo: ctx.editor.can().undo(),
            redo: ctx.editor.can().redo(),
            hitCount: searchKey.getState(ctx.editor.state)?.hits.length ?? 0,
            hitIndex: searchKey.getState(ctx.editor.state)?.index ?? 0,
          }
        : null,
  })
  const wordCount = useMemo(() => Array.from(record.value.plainText || '').length, [record.value.plainText])
  const fontSizes = ['14px', '16px', '18px', '20px', '24px']
  if (state?.fontSize && !fontSizes.includes(state.fontSize)) fontSizes.push(state.fontSize)
  // Keep baseVersion in sync with our own acknowledged sync receipts even while typing/composing,
  // preventing single-tab self-conflicts when an in-flight save returns a newer version.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const next = canonicalJSON(record.value.content || emptyDoc)
    if (next === contentRef.current && record.version > baseVersion.current) {
      baseVersion.current = record.version
    }
    if (record.dirty || composing.current || writer.hasPending) return
    if (next !== contentRef.current && Date.now() - lastUpdate.current > 500) {
      contentRef.current = next
      if (record.version > baseVersion.current) baseVersion.current = record.version
      if (next !== canonicalJSON(editor.getJSON())) {
        const scroller = scrollRef.current
        const savedScroll = scroller?.scrollTop ?? 0
        const { from, to } = editor.state.selection
        editor.commands.setContent(record.value.content || emptyDoc, { emitUpdate: false })
        const maxPos = editor.state.doc.content.size
        try {
          editor.commands.setTextSelection({
            from: Math.min(from, maxPos),
            to: Math.min(to, maxPos),
          })
        } catch {
          // Ignore if previous offset is no longer valid in the remote document.
        }
        if (scroller) scroller.scrollTop = savedScroll
      }
    }
    if (record.value.title !== titleRef.current) {
      setTitle(record.value.title || '')
      titleRef.current = record.value.title || ''
    }
  }, [record.rev, record.version, record.dirty, editor])
  useEffect(() => {
    const scroller = scrollRef.current
    const paper = surface.current
    if (!scroller) return
    let raf = 0
    const measure = () => {
      raf = 0
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 360
      const top = scrollable && scroller.scrollTop > 180
      const bottom = scrollable && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 180
      setScrollJump((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scroller)
    if (paper) ro.observe(paper)
    return () => {
      cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', schedule)
      ro.disconnect()
    }
  }, [record.id])
  useEffect(() => {
    if (!editor) return
    const query = findOpen ? find.trim() : ''
    if (query === searchKey.getState(editor.state)?.query) return
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, index: 0 }))
    if (query) revealMatch(editor)
  }, [find, findOpen, editor])
  function stepMatch(direction: number) {
    if (!editor) return
    const search = searchKey.getState(editor.state)
    if (!search?.hits.length) return
    const count = search.hits.length
    editor.view.dispatch(editor.state.tr.setMeta(searchKey, { index: (search.index + count + direction) % count }))
    revealMatch(editor)
  }
  async function insertFiles(files: File[]) {
    try {
      for (const file of files) {
        const a = await addFile(db, record.id, file, original)
        if (a.mime.startsWith('image/') && a.mime !== 'image/svg+xml')
          editor
            ?.chain()
            .focus()
            .insertContent({ type: 'image', attrs: { attachmentId: a.id, alt: a.name } })
            .run()
        else
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: 'attachment',
              attrs: { attachmentId: a.id, name: a.name, size: a.size },
            })
            .run()
      }
      await writer.flush()
    } catch (e) {
      notify((e as Error).message)
    }
  }
  const cmd = (fn: (e: Editor) => void) => {
    if (editor) fn(editor)
  }
  const chain = (e: Editor) => styleOpen ? e.chain() : e.chain().focus()
  function closeStyle(resumeKeyboard = true) {
    if (!styleOpen) return
    setStyle(false)
    const resume = resumeKeyboard && restoreKeyboard.current
    restoreKeyboard.current = false
    if (resume) {
      editor?.view.dom.removeAttribute('inputmode')
      editor?.commands.focus(undefined, { scrollIntoView: false })
      showKeyboard()
    }
  }
  const toggleStyle = () => {
    if (styleOpen) {
      closeStyle()
    } else {
      restoreKeyboard.current = !!editor?.isFocused
      setStyle(true)
      void hideKeyboard()
    }
  }
  const block = (level: 0 | 1 | 2 | 3) =>
    cmd((e) => {
      if (level) chain(e).toggleHeading({ level }).run()
      else chain(e).setParagraph().run()
    })
  const paper = normalizePaperToken(record.value.bgColor)
  const paperMeta = paperOptionFor(paper)
  const finishEditing = () => void writer.flush().then(onBack).catch(() => {})
  return (
    <section
      ref={section}
      className={'editor-pane ' + (styleMounted ? 'style-dock-active' : '')}
      data-paper={paper || undefined}
      aria-label={t('editor.noteEditorAria')}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          closeStyle(false)
          setMenu(false)
          setFindOpen(true)
          if (findOpen) findInput.current?.focus({ preventScroll: true })
        }
      }}>
      <header className="editor-nav">
        <IconButton className="editor-back" label={t('editor.backToList')} onClick={finishEditing}>
          <ArrowLeft size={21} />
        </IconButton>
        <div className="editor-nav-content" data-find={findOpen ? '' : undefined}>
          <div className="editor-nav-default" inert={findOpen}>
            <span className="saved-label">
              <Check size={15} />
              {connected && !record.dirty ? t('editor.synced') : t('editor.savedLocal')}
            </span>
            <div className="editor-actions">
              <IconButton label={t('editor.undo')} disabled={!state?.undo} onClick={() => cmd((editor) => editor.commands.undo())}>
                <Undo2 size={19} />
              </IconButton>
              <IconButton label={t('editor.redo')} disabled={!state?.redo} onClick={() => cmd((editor) => editor.commands.redo())}>
                <Redo2 size={19} />
              </IconButton>
              <div className="menu-anchor">
                <IconButton ref={editorMenu} id={editorMenuId + '-trigger'} popup={editorMenuId}
                  label={t('editor.moreActions')} expanded={menu} onClick={() => {
                    setMenu(!menu)
                    if (!menu) {
                      closeStyle(false)
                      void hideKeyboard()
                    }
                  }}>
                  <MoreHorizontal size={23} />
                </IconButton>
                <FluidPopover anchor={editorMenu} id={editorMenuId} open={menu} onClose={() => setMenu(false)}>
                  <button role="menuitem" onClick={() => void onUpdate({ pinned: !record.value.pinned }).catch(() => {})}>
                    <Pin size={17} />
                    {record.value.pinned ? t('context.unpin') : t('context.pin')}
                  </button>
                  <button role="menuitem" onClick={() => void onUpdate({ starred: !record.value.starred }).catch(() => {})}>
                    <Star size={17} />
                    {record.value.starred ? t('context.unstar') : t('context.star')}
                  </button>
                  <button role="menuitem" onClick={() => setFindOpen(true)}>
                    <Search size={17} />
                    {t('editor.findInNote')}
                  </button>
                  <button role="menuitem" onClick={onHistory}>
                    <Clock3 size={17} />
                    {t('editor.history')}
                  </button>
                  <hr role="separator" />
                  <button role="menuitem" onClick={onShare}>
                    <Share2 size={17} />
                    {t('editor.share')}
                  </button>
                  <button role="menuitem" onClick={() => setExport(true)}>
                    <FileDown size={17} />
                    {t('editor.export')}
                  </button>
                  <button
                    role="menuitem"
                    onClick={async () => {
                      setMenu(false)
                      if (!surface.current) return
                      try {
                        const { printNote } = await import('./export')
                        await printNote(record, surface.current, { keepPaper: false })
                      } catch (e) {
                        notify(t('editor.printFailed', { message: (e as Error).message }))
                      }
                    }}
                  >
                    <Printer size={17} />
                    {t('editor.printPdf')}
                  </button>
                  <hr role="separator" />
                  <button role="menuitem" className="text-danger"
                    onClick={() => void writer.flush().then(onDelete).catch(() => {})}>
                    <Trash2 size={17} />
                    {t('editor.moveToTrash')}
                  </button>
                </FluidPopover>
              </div>
              <IconButton className="mobile-done" label={t('editor.doneEditing')} onClick={finishEditing}>
                <Check size={23} />
              </IconButton>
            </div>
          </div>
          <div className="editor-find" inert={!findOpen}>
            <SearchField
              ref={findInput}
              label={t('editor.findAria')}
              placeholder={t('editor.findPlaceholder')}
              value={find}
              onChange={setFind}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                stepMatch(event.shiftKey ? -1 : 1)
              }}
            >
              <span className="find-count" role="status">
                {find.trim() && (state?.hitCount ? `${state.hitIndex + 1}/${state.hitCount}` : t('editor.noMatch'))}
              </span>
              <IconButton label={t('editor.prevMatch')} disabled={!state?.hitCount} onClick={() => stepMatch(-1)}>
                <ChevronUp size={17} />
              </IconButton>
              <IconButton label={t('editor.nextMatch')} disabled={!state?.hitCount} onClick={() => stepMatch(1)}>
                <ChevronDown size={17} />
              </IconButton>
              <IconButton className="find-close" label={t('editor.closeFind')} onClick={closeFind}><X size={17} /></IconButton>
            </SearchField>
          </div>
        </div>
      </header>
      <div
        ref={scrollRef}
        className="editor-scroll"
        data-motion-scroll=""
        onPointerDown={(e) => {
          if (e.button !== 0) {
            scrollPointerDown.current = null
            return
          }
          scrollPointerDown.current = {
            x: e.clientX,
            y: e.clientY,
            insideProse: !!(e.target as HTMLElement).closest('.tiptap'),
          }
        }}
        onClick={(e) => {
          const down = scrollPointerDown.current
          scrollPointerDown.current = null
          if (e.target !== e.currentTarget && e.target !== surface.current) return
          if (!down || down.insideProse || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          if (!editor || editor.isDestroyed) return
          const prose = editor.view.dom
          const proseRect = prose.getBoundingClientRect()
          if (e.clientY < proseRect.top) return
          const contentBottom = prose.lastElementChild?.getBoundingClientRect().bottom ?? proseRect.top
          if (e.clientY >= contentBottom) {
            prose.removeAttribute('inputmode')
            editor.commands.focus('end')
            return
          }
          const clampedX = Math.max(proseRect.left + 2, Math.min(e.clientX, proseRect.right - 2))
          const hit = editor.view.posAtCoords({ left: clampedX, top: e.clientY })
          if (hit) {
            prose.removeAttribute('inputmode')
            editor.commands.focus(hit.pos, { scrollIntoView: false })
          }
        }}
      >
        <article
          ref={surface}
          className="note-paper"
          style={{
            '--note-lh': (lineSpacings.find((s) => s.key === lineSpacing) || lineSpacings[1]).lh,
            '--note-gap': (lineSpacings.find((s) => s.key === lineSpacing) || lineSpacings[1]).gap,
          } as React.CSSProperties}
        >
          <input
            ref={titleInputRef}
            className="note-title"
            autoFocus={!record.value.title && !record.value.plainText && matchMedia('(min-width: 701px)').matches}
            aria-label={t('editor.titleAria')}
            placeholder={t('editor.titlePlaceholder')}
            value={title}
            maxLength={500}
            onChange={(e) => {
              setTitle(e.target.value)
              titleRef.current = e.target.value
              scheduleSave()
            }}
          />
          <div className="note-meta">
            <FolderPicker label={t('editor.folderAria')} folders={folders} value={record.value.folderId || ''}
              onChange={(folderId) => void onUpdate({ folderId }).catch(() => {})} />
            <time>
              {new Date(record.value.createdAt || record.updatedAt).toLocaleString(activeLocale, {
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {record.value.starred && <Star className="accent" size={14} fill="currentColor" />}
            {record.value.pinned && <Pin className="accent" size={14} />}
          </div>
          <div
            className="note-body-wrap"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                void writer.flush().catch(() => {})
            }}
          >
            <div onFocusCapture={() => closeStyle(false)}><EditorContent editor={editor} /></div>
          </div>
          {wordCount > 0 && (
            <footer className="word-count">{t('editor.charCount', { count: wordCount })}</footer>
          )}
        </article>
      </div>
      {(scrollJump.top || scrollJump.bottom) && (
        <div className="editor-scroll-jump glass" aria-label={t('editor.quickJumpAria')}>
          {scrollJump.top && (
            <IconButton
              label={t('editor.scrollTop')}
              onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <ArrowUp size={18} />
            </IconButton>
          )}
          {scrollJump.bottom && (
            <IconButton
              label={t('editor.scrollBottom')}
              onClick={() =>
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: 'smooth',
                })
              }
            >
              <ArrowDown size={18} />
            </IconButton>
          )}
        </div>
      )}
      <div className="editor-bottom">
        <div
          className="editor-toolbar glass"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) e.preventDefault()
          }}
        >
          <IconButton label={t('editor.styleToolbar')} expanded={styleOpen} onClick={toggleStyle}>
            <Type size={22} />
          </IconButton>
          <IconButton
            label={t('editor.insertTask')}
            active={state?.task}
            onClick={() =>
              cmd((e) => {
                chain(e).toggleTaskList().run()
              })
            }
          >
            <CheckCheck size={23} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton
            label={t('editor.insertImage')}
            onClick={() => {
              if (inputRef.current) {
                inputRef.current.accept = 'image/*'
                inputRef.current.click()
              }
            }}
          >
            <ImagePlus size={22} />
          </IconButton>
          <IconButton
            label={t('editor.insertAttachment')}
            onClick={() => {
              if (inputRef.current) {
                inputRef.current.accept = '*/*'
                inputRef.current.click()
              }
            }}
          >
            <Paperclip size={22} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton label={t('editor.exportNote')} onClick={() => setExport(true)}>
            <ArrowDownToLine size={21} />
          </IconButton>
        </div>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          onChange={(e) => {
            void insertFiles(Array.from(e.target.files || []))
            e.target.value = ''
          }}
        />
      </div>
      {styleMounted && (
        <div
          className="style-panel menu-surface"
          inert={!styleOpen}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) e.preventDefault()
          }}
        >
          <div className="panel-title">
            <strong>{t('editor.stylePanelTitle')}</strong>
            <IconButton label={t('editor.closeStyle')} onClick={() => closeStyle()}>
              <ChevronDown size={19} />
            </IconButton>
          </div>
          <div className="block-styles">
            {([
              t('editor.heading1'),
              t('editor.heading2'),
              t('editor.heading3'),
              t('editor.paragraph'),
            ] as const).map((label, i) => (
              <button
                key={i}
                className={
                  [state?.h1, state?.h2, state?.h3, !state?.h1 && !state?.h2 && !state?.h3][i]
                    ? 'active'
                    : ''
                }
                onClick={() => block(([1, 2, 3, 0] as const)[i])}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="style-row">
            <IconButton
              label={t('editor.bold')}
              active={state?.bold}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleBold().run()
                })
              }
            >
              <Bold />
            </IconButton>
            <IconButton
              label={t('editor.italic')}
              active={state?.italic}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleItalic().run()
                })
              }
            >
              <Italic />
            </IconButton>
            <IconButton
              label={t('editor.underline')}
              active={state?.underline}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleUnderline().run()
                })
              }
            >
              <UnderlineIcon />
            </IconButton>
            <IconButton
              label={t('editor.strike')}
              active={state?.strike}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleStrike().run()
                })
              }
            >
              <Strikethrough />
            </IconButton>
            <ChoiceMenu
              label={t('editor.fontSize')}
              value={state?.fontSize || ''}
              choices={[{ value: '', label: t('common.default') }, ...fontSizes.map((size) => ({ value: size, label: size.replace(/px$/, '') }))]}
              onChange={(size) =>
                cmd((ed) => {
                  if (size) chain(ed).setFontSize(size).run()
                  else chain(ed).unsetFontSize().run()
                })
              }
            />
          </div>
          <div className="style-row">
            <IconButton
              label={t('editor.textColor')}
              className="color-toggle-btn"
              active={colorTray === 'ink' || !!state?.color}
              onClick={() => setColorTray((v) => (v === 'ink' ? null : 'ink'))}
            >
              <span className="color-btn-glyph">
                <Type size={19} />
                <i
                  className="color-btn-bar"
                  style={{ background: state?.color ? `var(--ink-${state.color})` : 'currentColor' }}
                  aria-hidden="true"
                />
              </span>
            </IconButton>
            <IconButton
              label={t('editor.highlightColor')}
              className="color-toggle-btn"
              active={colorTray === 'highlight' || !!state?.highlight}
              onClick={() => setColorTray((v) => (v === 'highlight' ? null : 'highlight'))}
            >
              <span className="color-btn-glyph">
                <Highlighter size={19} />
                <i
                  className="color-btn-bar"
                  style={{
                    background: state?.highlight
                      ? `var(--hl-${state.highlight}-swatch)`
                      : 'transparent',
                    opacity: state?.highlight ? 1 : 0,
                  }}
                  aria-hidden="true"
                />
              </span>
            </IconButton>
            {([
              [AlignLeft, 'left', t('editor.alignLeft')],
              [AlignCenter, 'center', t('editor.alignCenter')],
              [AlignRight, 'right', t('editor.alignRight')],
            ] as const).map(([Icon, align, label]) => {
              const I = Icon
              return (
                <IconButton
                  key={align}
                  label={label}
                  onClick={() =>
                    cmd((e) => {
                      chain(e).setTextAlign(align).run()
                    })
                  }
                >
                  <I size={21} />
                </IconButton>
              )
            })}
          </div>
          {colorTray && (
            <div className="style-swatches" role="group" aria-label={colorTray === 'ink' ? t('editor.selectTextColor') : t('editor.selectHighlightColor')}>
              <span>{colorTray === 'ink' ? t('editor.inkLabel') : t('editor.highlightLabel')}</span>
              {colorTray === 'ink'
                ? INK_OPTIONS.map((item) => (
                    <ColorDot
                      key={item.id || 'default'}
                      color={item.cssVar}
                      label={t(INK_LABEL_KEYS[item.id])}
                      className={item.id ? 'swatch-ink' : 'swatch-default-ink'}
                      selected={(state?.color || '') === item.id}
                      onClick={() =>
                        cmd((ed) => {
                          if (item.id) chain(ed).setColor(item.id).run()
                          else chain(ed).unsetColor().run()
                        })
                      }
                    />
                  ))
                : HIGHLIGHT_OPTIONS.map((item) => (
                    <ColorDot
                      key={item.id || 'clear'}
                      color={item.cssVar}
                      label={t(HIGHLIGHT_LABEL_KEYS[item.id])}
                      className={item.id ? 'swatch-hl' : 'is-clear'}
                      selected={(state?.highlight || '') === item.id}
                      onClick={() =>
                        cmd((ed) => {
                          if (item.id) chain(ed).setHighlight({ color: item.id }).run()
                          else chain(ed).unsetHighlight().run()
                        })
                      }
                    />
                  ))}
            </div>
          )}
          <div className="style-row">
            <IconButton
              label={t('editor.bulletList')}
              active={state?.bullet}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleBulletList().run()
                })
              }
            >
              <List />
            </IconButton>
            <IconButton
              label={t('editor.orderedList')}
              active={state?.ordered}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleOrderedList().run()
                })
              }
            >
              <ListOrdered />
            </IconButton>
            <IconButton
              label={t('editor.taskList')}
              active={state?.task}
              onClick={() =>
                cmd((e) => {
                  chain(e).toggleTaskList().run()
                })
              }
            >
              <ListTodo />
            </IconButton>
            <IconButton
              label={t('editor.indentDecrease')}
              onClick={() =>
                cmd((e) => {
                  chain(e)
                    .liftListItem(e.isActive('taskItem') ? 'taskItem' : 'listItem')
                    .run()
                })
              }
            >
              <IndentDecrease />
            </IconButton>
            <IconButton
              label={t('editor.indentIncrease')}
              onClick={() =>
                cmd((e) => {
                  chain(e)
                    .sinkListItem(e.isActive('taskItem') ? 'taskItem' : 'listItem')
                    .run()
                })
              }
            >
              <IndentIncrease />
            </IconButton>
          </div>
          <div className="style-spacing" role="group" aria-label={t('editor.lineSpacingAria')}>
            <span>{t('editor.lineSpacingLabel')}</span>
            <div className="spacing-pills">
              {lineSpacings.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={lineSpacing === item.key ? 'active' : ''}
                  onClick={() => {
                    setLineSpacing(item.key)
                    localStorage.setItem('yonote:lineSpacing', item.key)
                  }}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="style-backgrounds">
            <span>{t('editor.paperLabel')}</span>
            {PAPER_OPTIONS.map((item) => (
              <ColorDot
                key={item.id || 'default'}
                color={item.swatchVar}
                label={t(PAPER_LABEL_KEYS[item.id])}
                className={item.id ? 'swatch-paper' : 'swatch-paper swatch-default-paper'}
                selected={paper === item.id}
                onClick={() => void onUpdate({ bgColor: item.id })}
              />
            ))}
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={original}
              onChange={(e) => setOriginal(e.target.checked)}
            />
            {t('editor.keepOriginalImage')}
          </label>
        </div>
      )}
      {exportOpen && (
        <Modal ref={exportDialog} title={t('exportModal.title')} onClose={() => setExport(false)}>
          {paper && (
            <label className="export-paper-option">
              <input
                type="checkbox"
                checked={exportKeepPaper}
                onChange={(e) => setExportKeepPaper(e.target.checked)}
              />
              <span className="export-paper-swatch" style={{ background: paperMeta.lightSurface }} aria-hidden="true" />
              <span>{t('exportModal.keepPaper', { paper: t(PAPER_LABEL_KEYS[paperMeta.id]) })}</span>
            </label>
          )}
          <div className="export-options">
            {(['md', 'png', 'pdf'] as const).map((type) => (
              <button
                className="secondary"
                key={type}
                onClick={async () => {
                  try {
                    const keepPaper = !!paper && exportKeepPaper
                    if (type === 'pdf') exportDialog.current?.dismiss()
                    const { exportNote } = await import('./export')
                    await exportNote(type, record, editor!, surface.current!, { keepPaper })
                    if (type === 'pdf') {
                      notify(t('exportModal.pdfOpened'))
                    } else {
                      notify(t('exportModal.exported', { type: type.toUpperCase() }))
                      exportDialog.current?.dismiss()
                    }
                  } catch (e) {
                    notify(t('exportModal.failed', { message: (e as Error).message }))
                  }
                }}
              >
                <FileDown />
                {t(`exportModal.${type}`)}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  )
}
