import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { editorExtensions, inactiveSelKey } from './editor'
import {
  normalizeHighlightToken,
  normalizeInkToken,
  normalizePaperToken,
  paperOptionFor,
} from './palette'

function mockEl(attrs: Record<string, string> = {}, style: Record<string, string> = {}) {
  return {
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string) => name in attrs,
    style,
  } as unknown as HTMLElement
}

describe('semantic palette normalization', () => {
  it('maps semantic and legacy paper values cleanly', () => {
    expect(normalizePaperToken('')).toBe('')
    expect(normalizePaperToken('warm')).toBe('warm')
    expect(normalizePaperToken('SAGE')).toBe('sage')
    expect(normalizePaperToken('#17191a')).toBe('sky')
    expect(normalizePaperToken('#23211c')).toBe('warm')
    expect(normalizePaperToken('#1d2522')).toBe('sage')
    expect(normalizePaperToken('#22202b')).toBe('lavender')
    expect(normalizePaperToken('#ff00ff')).toBe('')
    expect(paperOptionFor('#23211c').lightSurface).toBe('#f7f2e7')
  })

  it('maps semantic and legacy ink values and rejects external colors', () => {
    expect(normalizeInkToken('amber')).toBe('amber')
    expect(normalizeInkToken('#e5bd42')).toBe('amber')
    expect(normalizeInkToken('rgb(229, 189, 66)')).toBe('amber')
    expect(normalizeInkToken('#6eb5ff')).toBe('blue')
    expect(normalizeInkToken('#9aa5a0')).toBe('gray')
    expect(normalizeInkToken('var(--ink-purple)')).toBe('purple')
    expect(normalizeInkToken('#000000')).toBe('')
    expect(normalizeInkToken('rgb(0, 0, 0)')).toBe('')
    expect(normalizeInkToken('#ffffff')).toBe('')
  })

  it('maps semantic and legacy highlight values and rejects external colors', () => {
    expect(normalizeHighlightToken('yellow')).toBe('yellow')
    expect(normalizeHighlightToken('rgba(229, 189, 66, 0.34)')).toBe('yellow')
    expect(normalizeHighlightToken('rgba(110, 181, 255, 0.30)')).toBe('blue')
    expect(normalizeHighlightToken('rgba(110,181,255,0.3)')).toBe('blue')
    expect(normalizeHighlightToken('rgba(244, 162, 97, 0.32)')).toBe('orange')
    expect(normalizeHighlightToken('var(--hl-green)')).toBe('green')
    expect(normalizeHighlightToken('#ffffff')).toBe('')
    expect(normalizeHighlightToken('rgb(255, 255, 255)')).toBe('')
  })
})

describe('TipTap semantic color & highlight schema rules', () => {
  const schema = getSchema(editorExtensions)

  it('renders legacy dark-mode hex and rgba marks as semantic data attributes', () => {
    const legacyInk = schema.marks.textStyle.create({ color: '#e5bd42' })
    const inkDom = schema.marks.textStyle.spec.toDOM!(legacyInk, true) as [string, Record<string, string>, number]
    expect(inkDom[0]).toBe('span')
    expect(inkDom[1]).toEqual({ 'data-ink': 'amber' })

    const externalBlack = schema.marks.textStyle.create({ color: '#000000' })
    const blackDom = schema.marks.textStyle.spec.toDOM!(externalBlack, true) as [string, Record<string, string>, number]
    expect(blackDom[1]).toEqual({})

    const legacyHl = schema.marks.highlight.create({ color: 'rgba(110, 181, 255, 0.30)' })
    const hlDom = schema.marks.highlight.spec.toDOM!(legacyHl, true) as [string, Record<string, string>, number]
    expect(hlDom[0]).toBe('mark')
    expect(hlDom[1]).toEqual({ 'data-hl': 'blue' })
  })

  it('strips pasted external inline colors while preserving internal semantic colors and font sizes', () => {
    const parseTextStyle = schema.marks.textStyle.spec.parseDOM![0].getAttrs as (
      node: HTMLElement,
    ) => unknown
    const parseHighlight = schema.marks.highlight.spec.parseDOM![0].getAttrs as (
      node: HTMLElement,
    ) => unknown

    // External black text with no fontSize -> rejected completely
    expect(
      parseTextStyle(
        mockEl({ style: 'color: rgb(0, 0, 0); background-color: #fff' }, { color: 'rgb(0, 0, 0)' }),
      ),
    ).toBe(false)

    // Internal semantic ink + fontSize -> preserved cleanly
    expect(
      parseTextStyle(
        mockEl({ 'data-ink': 'green', style: 'font-size: 18px' }, { fontSize: '18px' }),
      ),
    ).toEqual({ color: 'green', fontSize: '18px' })

    // External white-background mark -> rejected
    expect(
      parseHighlight(
        mockEl({ style: 'background-color: #ffffff' }, { backgroundColor: '#ffffff' }),
      ),
    ).toBe(false)

    // Internal semantic mark -> preserved
    expect(parseHighlight(mockEl({ 'data-hl': 'pink' }))).toEqual({ color: 'pink' })

    // Plain semantic <mark> -> defaults to yellow
    expect(parseHighlight(mockEl())).toEqual({ color: 'yellow' })
  })
})

describe('inactive selection highlight preservation', () => {
  it('renders an inactive selection decoration when blurred with a text selection and clears it on focus', () => {
    const schema = getSchema(editorExtensions)
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('测试选中文字保留高亮')]),
    ])
    const plugins = editorExtensions.flatMap((ext) =>
      typeof ext.config.addProseMirrorPlugins === 'function'
        ? ext.config.addProseMirrorPlugins.call({
            name: ext.name,
            options: ext.options,
            storage: ext.storage,
            editor: {} as never,
            type: undefined as never,
            parent: undefined,
          })
        : [],
    )
    const plugin = plugins.find((p) => p.spec.key === inactiveSelKey)!
    expect(plugin).toBeDefined()

    let state = EditorState.create({ schema, doc, plugins: [plugin] })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 5)))
    expect(inactiveSelKey.getState(state)?.decorations.find().length).toBe(0)

    state = state.apply(state.tr.setMeta(inactiveSelKey, false))
    const decs = inactiveSelKey.getState(state)?.decorations.find() || []
    expect(decs).toHaveLength(1)
    expect(decs[0].from).toBe(1)
    expect(decs[0].to).toBe(5)

    state = state.apply(state.tr.setMeta(inactiveSelKey, true))
    expect(inactiveSelKey.getState(state)?.decorations.find().length).toBe(0)
  })
})
