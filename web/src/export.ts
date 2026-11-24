import type { Editor } from '@tiptap/react'
import { MarkdownManager } from '@tiptap/markdown'
import { Capacitor } from '@capacitor/core'
import { normalizePaperToken, paperOptionFor } from './palette'
import type { LocalRecord } from './types'

function safeFilename(name: string) {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  const match = clean.match(/\.[a-zA-Z0-9]{1,10}$/)
  const ext = match?.[0] || ''
  return (
    (clean.slice(0, ext ? clean.length - ext.length : clean.length).slice(0, 160) || '便签') + ext
  )
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatExportDate(record: LocalRecord): string {
  const raw = record.value.createdAt || record.updatedAt
  if (!raw) return ''
  try {
    return new Date(raw).toLocaleString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || Error('文件读取失败'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

function blobBase64(blob: Blob): Promise<string> {
  return blobToDataUrl(blob).then((url) => url.slice(url.indexOf(',') + 1))
}

async function shareNativeFile(base64: string, name: string) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ])
  // Cache files are private to the app and exposed only through the system share sheet's FileProvider grants.
  const path = 'exports/' + crypto.randomUUID() + '/' + safeFilename(name)
  const file = await Filesystem.writeFile({
    path,
    directory: Directory.Cache,
    data: base64,
    recursive: true,
  })
  await Share.share({ title: name, files: [file.uri], dialogTitle: '保存或分享 ' + name })
}

function browserDownload(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = safeFilename(name)
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function downloadBlob(blob: Blob, name: string) {
  if (Capacitor.isNativePlatform()) {
    await shareNativeFile(await blobBase64(blob), name)
    return
  }
  const url = URL.createObjectURL(blob)
  browserDownload(url, name)
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

async function downloadPNG(data: string, name: string) {
  if (Capacitor.isNativePlatform()) {
    await shareNativeFile(data.slice(data.indexOf(',') + 1), name)
  } else {
    browserDownload(data, name)
  }
}

async function extractCleanBody(surface: HTMLElement): Promise<HTMLElement> {
  const source = surface.querySelector<HTMLElement>('.tiptap') || surface
  const body = source.cloneNode(true) as HTMLElement

  // Sync live checkbox checked state to HTML attributes so innerHTML/print serialization preserves it.
  const sourceChecks = source.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  const clonedChecks = body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  clonedChecks.forEach((cb, i) => {
    const checked = sourceChecks[i]?.checked ?? cb.checked
    if (checked) cb.setAttribute('checked', '')
    else cb.removeAttribute('checked')
    cb.setAttribute('disabled', '')
  })

  // Strip editor-only interactive attributes and transient UI decorations.
  body.removeAttribute('contenteditable')
  body.removeAttribute('tabindex')
  body.removeAttribute('role')
  body.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  body.querySelectorAll('.editor-inactive-selection, .search-hit, .search-hit-current').forEach((el) => {
    el.classList.remove('editor-inactive-selection', 'search-hit', 'search-hit-current')
  })
  body.querySelectorAll('.note-image.selected, .file-attachment.selected').forEach((el) => {
    el.classList.remove('selected')
  })
  // Hide non-printable download buttons inside attachment cards.
  body.querySelectorAll('.file-attachment a').forEach((el) => el.remove())

  // Inline local blob: images as data URLs so isolated print WebViews (Android PrintManager)
  // and offscreen PNG renders never suffer from broken blob URLs or lazy loading.
  const images = Array.from(body.querySelectorAll<HTMLImageElement>('img'))
  await Promise.all(
    images.map(async (img) => {
      img.removeAttribute('loading')
      img.removeAttribute('decoding')
      img.removeAttribute('role')
      img.removeAttribute('tabindex')
      const src = img.getAttribute('src') || ''
      if (src.startsWith('blob:')) {
        try {
          const res = await fetch(src)
          if (res.ok) {
            img.src = await blobToDataUrl(await res.blob())
          }
        } catch {
          // Keep original src if blob fetch fails.
        }
      }
    }),
  )

  return body
}

export function buildPrintableHTML({
  title,
  date,
  bodyHtml,
  backgroundColor = '#ffffff',
}: {
  title: string
  date?: string
  bodyHtml: string
  backgroundColor?: string
}): string {
  const safeTitle = escapeHtml(title || '未命名备忘')
  const safeDate = date ? escapeHtml(date) : ''
  const bg = backgroundColor || '#ffffff'
  const tinted = bg.toLowerCase() !== '#ffffff' && bg.toLowerCase() !== '#fff'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  @page {
    size: A4;
    margin: 16mm 14mm;
    ${tinted ? `background: ${bg};` : ''}
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: ${bg};
    color: #272726;
    font-family: "Noto Sans CJK SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 10.5pt;
    line-height: 1.65;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .print-doc {
    display: block;
    width: 100%;
    max-width: 100%;
    color: #272726;
    overflow-wrap: anywhere;
  }
  .doc-title {
    margin: 0 0 6pt;
    font-size: 20pt;
    font-weight: 700;
    line-height: 1.35;
    color: #1c1d1c;
    break-after: avoid;
    page-break-after: avoid;
  }
  .doc-meta {
    margin: 0 0 16pt;
    font-size: 8.5pt;
    color: #737674;
    break-after: avoid;
    page-break-after: avoid;
  }
  .doc-body {
    display: block;
  }
  .doc-body p {
    margin: 0 0 0.55em;
    orphans: 3;
    widows: 3;
  }
  .doc-body h1,
  .doc-body h2,
  .doc-body h3,
  .doc-body h4 {
    margin: 1.05em 0 0.4em;
    line-height: 1.35;
    color: #1c1d1c;
    break-after: avoid;
    page-break-after: avoid;
  }
  .doc-body h1 { font-size: 16pt; }
  .doc-body h2 { font-size: 13.5pt; }
  .doc-body h3 { font-size: 11.5pt; }
  .doc-body ul,
  .doc-body ol {
    margin: 0.3em 0 0.65em;
    padding-left: 1.6em;
  }
  .doc-body li {
    margin: 0.2em 0;
  }
  .doc-body li > p {
    margin: 0 0 0.25em;
  }
  .doc-body ul[data-type='taskList'] {
    list-style: none;
    padding-left: 0;
  }
  .doc-body ul[data-type='taskList'] li {
    display: block;
    position: relative;
    padding-left: 1.65em;
    margin: 0.3em 0;
  }
  .doc-body ul[data-type='taskList'] li > label {
    position: absolute;
    left: 0;
    top: 0.12em;
  }
  .doc-body ul[data-type='taskList'] li > div {
    display: block;
  }
  .doc-body ul[data-type='taskList'] li[data-checked='true'] > div {
    color: #737674;
    text-decoration: line-through;
  }
  .doc-body input[type='checkbox'] {
    width: 12px;
    height: 12px;
    margin: 0;
    accent-color: #8a6e00;
  }
  .doc-body blockquote {
    margin: 8pt 0;
    padding: 2pt 0 2pt 12pt;
    border-left: 3px solid #c5a32b;
    color: #545d5c;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-body hr {
    border: 0;
    border-top: 1px solid rgba(0, 0, 0, 0.14);
    margin: 12pt 0;
  }
  .doc-body pre {
    margin: 8pt 0;
    padding: 9pt 11pt;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.045);
    border: 1px solid rgba(0, 0, 0, 0.1);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 9pt;
    line-height: 1.5;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-body code {
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 4px;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
  }
  .doc-body pre code {
    background: none;
    padding: 0;
  }
  .doc-body a {
    color: #8a6e00;
    text-decoration: underline;
    word-break: break-all;
  }
  .doc-body .note-image {
    margin: 10pt 0;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-body .note-image img {
    display: block;
    max-width: 100%;
    max-height: 220mm;
    height: auto;
    border-radius: 6px;
  }
  .doc-body .file-attachment {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    margin: 6pt 0;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.045);
    border: 1px solid rgba(0, 0, 0, 0.12);
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-body .file-attachment strong {
    display: block;
    font-size: 9.5pt;
  }
  .doc-body .file-attachment small {
    display: block;
    font-size: 8pt;
    color: #737674;
  }
  .doc-body [data-ink='amber'] { color: #9a6700; }
  .doc-body [data-ink='red'] { color: #c43b3b; }
  .doc-body [data-ink='blue'] { color: #1f66c1; }
  .doc-body [data-ink='green'] { color: #1d7a4f; }
  .doc-body [data-ink='purple'] { color: #6e44b8; }
  .doc-body [data-ink='orange'] { color: #b85610; }
  .doc-body [data-ink='gray'] { color: #666d6a; }
  .doc-body mark {
    border-radius: 3px;
    padding: 0 2px;
    color: inherit;
    background: rgba(250, 204, 21, 0.36);
  }
  .doc-body mark[data-hl='yellow'] { background: rgba(250, 204, 21, 0.36); }
  .doc-body mark[data-hl='blue'] { background: rgba(96, 165, 250, 0.28); }
  .doc-body mark[data-hl='green'] { background: rgba(74, 222, 128, 0.28); }
  .doc-body mark[data-hl='pink'] { background: rgba(248, 113, 113, 0.26); }
  .doc-body mark[data-hl='purple'] { background: rgba(167, 139, 250, 0.28); }
  .doc-body mark[data-hl='orange'] { background: rgba(251, 146, 60, 0.30); }
</style>
</head>
<body>
  <article class="print-doc">
    <h1 class="doc-title">${safeTitle}</h1>
    ${safeDate ? `<div class="doc-meta">${safeDate}</div>` : ''}
    <div class="doc-body">${bodyHtml}</div>
  </article>
</body>
</html>`
}

async function printHtmlInWebIframe(html: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none;'
    document.body.appendChild(iframe)

    const prevTitle = document.title
    let finished = false
    let started = false
    let fallbackTimer = 0
    let startTimer = 0
    const cleanup = () => {
      if (finished) return
      finished = true
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(startTimer)
      document.title = prevTitle
      iframe.remove()
      resolve()
    }

    const doc = iframe.contentDocument
    const win = iframe.contentWindow
    if (!doc || !win) {
      cleanup()
      reject(Error('无法初始化打印视图'))
      return
    }

    const triggerPrint = async () => {
      if (started || finished) return
      started = true
      window.clearTimeout(startTimer)
      try {
        await doc.fonts?.ready.catch(() => {})
        await Promise.all(
          Array.from(doc.images).map((img) =>
            img.complete
              ? img.decode().catch(() => {})
              : new Promise<void>((done) => {
                  img.onload = () => done()
                  img.onerror = () => done()
                }),
          ),
        )
        document.title = safeFilename(name)
        win.addEventListener('afterprint', cleanup, { once: true })
        window.addEventListener('afterprint', cleanup, { once: true })
        fallbackTimer = window.setTimeout(cleanup, 60000)
        win.focus()
        win.print()
      } catch (err) {
        if (!finished) {
          finished = true
          window.clearTimeout(fallbackTimer)
          window.clearTimeout(startTimer)
          document.title = prevTitle
          iframe.remove()
          reject(err)
        }
      }
    }

    iframe.onload = () => void triggerPrint()
    doc.open()
    doc.write(html)
    doc.close()
    startTimer = window.setTimeout(() => void triggerPrint(), 120)
  })
}

export async function printNote(
  record: LocalRecord,
  surface: HTMLElement,
  options?: { keepPaper?: boolean },
): Promise<void> {
  const title = record.value.title || '未命名备忘'
  const paperToken = options?.keepPaper ? normalizePaperToken(record.value.bgColor) : ''
  const exportBg = paperToken ? paperOptionFor(paperToken).lightSurface : '#ffffff'
  const cleanBody = await extractCleanBody(surface)
  const html = buildPrintableHTML({
    title,
    date: formatExportDate(record),
    bodyHtml: cleanBody.innerHTML,
    backgroundColor: exportBg,
  })

  if (Capacitor.isNativePlatform()) {
    const { Printer } = await import('@capgo/capacitor-printer')
    await Printer.printHtml({ name: safeFilename(title), html })
    return
  }
  await printHtmlInWebIframe(html, title)
}

export async function exportNote(
  type: 'md' | 'png' | 'pdf',
  record: LocalRecord,
  editor: Editor,
  surface: HTMLElement,
  options?: { keepPaper?: boolean },
) {
  const title = record.value.title || '未命名备忘'
  const name = safeFilename(title)
  if (type === 'md') {
    const markdown = new MarkdownManager({ extensions: editor.extensionManager.baseExtensions })
    await downloadBlob(
      new Blob(['# ' + title + '\n\n' + markdown.serialize(editor.getJSON())], {
        type: 'text/markdown;charset=utf-8',
      }),
      name + '.md',
    )
    return
  }
  if (type === 'pdf') {
    await printNote(record, surface, options)
    return
  }

  // Long-image PNG export using the same UI-free clean document content.
  const paperToken = options?.keepPaper ? normalizePaperToken(record.value.bgColor) : ''
  const exportBg = paperToken ? paperOptionFor(paperToken).lightSurface : '#ffffff'
  const cleanBody = await extractCleanBody(surface)

  const container = document.createElement('article')
  container.className = 'note-paper export-paper'
  container.setAttribute('data-theme', 'light')
  if (paperToken) container.setAttribute('data-paper', paperToken)
  container.style.cssText =
    `position:absolute;left:-10000px;top:0;width:760px;padding:52px 56px;max-width:none;min-height:0;display:block;background:${exportBg};color:#272726;--text:#272726;--muted:#737373;--secondary-text:#545d5c;--bg:${exportBg};--card:rgba(0,0,0,0.045);--line:rgba(0,0,0,0.12);--accent:#8a6e00;--accent-ink:#8a6e00;`

  const heading = document.createElement('h1')
  heading.textContent = title
  heading.style.cssText = 'font-size:30px;font-weight:700;line-height:1.45;margin:0 0 10px;color:#1c1d1c;'
  container.appendChild(heading)

  const dateText = formatExportDate(record)
  if (dateText) {
    const meta = document.createElement('div')
    meta.textContent = dateText
    meta.style.cssText = 'font-size:12px;color:#737674;margin:0 0 24px;'
    container.appendChild(meta)
  }

  cleanBody.style.color = '#272726'
  cleanBody.style.minHeight = '0'
  cleanBody
    .querySelectorAll<HTMLElement>('.file-attachment,.attachment-loading,pre,code')
    .forEach((el) => {
      el.style.background = 'rgba(0, 0, 0, 0.045)'
      el.style.borderColor = 'rgba(0, 0, 0, 0.12)'
    })
  container.appendChild(cleanBody)

  document.body.appendChild(container)
  try {
    await document.fonts.ready
    await Promise.all(
      Array.from(container.querySelectorAll('img')).map((image) => image.decode().catch(() => {})),
    )
    const { toPng } = await import('html-to-image')
    const data = await toPng(container, {
      pixelRatio: 2,
      backgroundColor: exportBg,
      cacheBust: false,
      style: { position: 'static', left: 'auto', top: 'auto', margin: '0', transform: 'none' },
    })
    await downloadPNG(data, name + '.png')
  } finally {
    container.remove()
  }
}
