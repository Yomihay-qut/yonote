import { describe, expect, it } from 'vitest'
import { buildPrintableHTML } from './export'

describe('buildPrintableHTML', () => {
  it('renders clean UTF-8 printable HTML with CJK fonts, escaped title, and default white @page', () => {
    const html = buildPrintableHTML({
      title: '门诊记录 <2026> & "要点"',
      date: '2026年11月22日 20:00',
      bodyHtml: '<p>正文内容</p><ul><li><p>列表项</p></li></ul>',
    })

    expect(html).toContain('<meta charset="UTF-8" />')
    expect(html).toContain('Noto Sans CJK SC')
    expect(html).toContain('<title>门诊记录 &lt;2026&gt; &amp; &quot;要点&quot;</title>')
    expect(html).toContain('<div class="doc-meta">2026年11月22日 20:00</div>')
    expect(html).toContain('@page {')
    expect(html).not.toMatch(/@page\s*\{[^}]*background:/s)
  })

  it('injects paper tint into @page and document background when keepPaper background is provided', () => {
    const html = buildPrintableHTML({
      title: '暖米纸张笔记',
      bodyHtml: '<p>测试</p>',
      backgroundColor: '#f7f2e7',
    })

    expect(html).toMatch(/@page\s*\{[^}]*background:\s*#f7f2e7;/s)
    expect(html).toContain('print-color-adjust: exact;')
    expect(html).toContain('background: #f7f2e7;')
  })

  it('avoids list-item break-inside blank page bugs while preserving semantic ink/highlight CSS', () => {
    const html = buildPrintableHTML({
      title: '分页与语义色规则',
      bodyHtml: '<p><span data-ink="amber">重点</span><mark data-hl="blue">标注</mark></p>',
    })

    expect(html).not.toMatch(/\.doc-body\s+li\s*\{[^}]*break-inside:\s*avoid/)
    expect(html).toMatch(/\.doc-body\s+h1,\s*\.doc-body\s+h2[\s\S]*?break-after:\s*avoid/)

    for (const ink of ['amber', 'red', 'blue', 'green', 'purple', 'orange', 'gray']) {
      expect(html).toContain(`[data-ink='${ink}']`)
    }
    for (const hl of ['yellow', 'blue', 'green', 'pink', 'purple', 'orange']) {
      expect(html).toContain(`mark[data-hl='${hl}']`)
    }
  })
})
