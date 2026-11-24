export type PaperToken = '' | 'warm' | 'sage' | 'sky' | 'lavender'
export type InkToken = 'amber' | 'red' | 'blue' | 'green' | 'purple' | 'orange' | 'gray'
export type HighlightToken = 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'orange'

export interface PaperOption {
  readonly id: PaperToken
  readonly label: string
  readonly swatchVar: string
  readonly lightSurface: string
  readonly darkSurface: string
}

export interface InkOption {
  readonly id: '' | InkToken
  readonly label: string
  readonly cssVar: string
}

export interface HighlightOption {
  readonly id: '' | HighlightToken
  readonly label: string
  readonly cssVar: string
}

export const PAPER_OPTIONS: readonly PaperOption[] = [
  { id: '', label: '默认纸张', swatchVar: 'var(--paper-swatch-default)', lightSurface: '#ffffff', darkSurface: '#0b0d0e' },
  { id: 'warm', label: '暖米纸张', swatchVar: 'var(--paper-swatch-warm)', lightSurface: '#f7f2e7', darkSurface: '#1e1b16' },
  { id: 'sage', label: '松绿纸张', swatchVar: 'var(--paper-swatch-sage)', lightSurface: '#eef4ef', darkSurface: '#151e1a' },
  { id: 'sky', label: '晴雾纸张', swatchVar: 'var(--paper-swatch-sky)', lightSurface: '#eef3f8', darkSurface: '#151a22' },
  { id: 'lavender', label: '雾紫纸张', swatchVar: 'var(--paper-swatch-lavender)', lightSurface: '#f3eff8', darkSurface: '#1c1925' },
]

export const INK_OPTIONS: readonly InkOption[] = [
  { id: '', label: '默认文字颜色', cssVar: 'var(--text)' },
  { id: 'amber', label: '琥珀金', cssVar: 'var(--ink-amber)' },
  { id: 'red', label: '珊瑚红', cssVar: 'var(--ink-red)' },
  { id: 'blue', label: '晴空蓝', cssVar: 'var(--ink-blue)' },
  { id: 'green', label: '松石绿', cssVar: 'var(--ink-green)' },
  { id: 'purple', label: '雾紫', cssVar: 'var(--ink-purple)' },
  { id: 'orange', label: '暖橙', cssVar: 'var(--ink-orange)' },
  { id: 'gray', label: '柔灰', cssVar: 'var(--ink-gray)' },
]

export const HIGHLIGHT_OPTIONS: readonly HighlightOption[] = [
  { id: '', label: '清除高亮', cssVar: 'transparent' },
  { id: 'yellow', label: '暖黄高亮', cssVar: 'var(--hl-yellow-swatch)' },
  { id: 'blue', label: '晴蓝高亮', cssVar: 'var(--hl-blue-swatch)' },
  { id: 'green', label: '松绿高亮', cssVar: 'var(--hl-green-swatch)' },
  { id: 'pink', label: '浅粉高亮', cssVar: 'var(--hl-pink-swatch)' },
  { id: 'purple', label: '雾紫高亮', cssVar: 'var(--hl-purple-swatch)' },
  { id: 'orange', label: '暖橙高亮', cssVar: 'var(--hl-orange-swatch)' },
]

const PAPER_TOKENS = new Set<string>(['warm', 'sage', 'sky', 'lavender'])
const LEGACY_PAPER_MAP: Record<string, PaperToken> = {
  '#17191a': 'sky',
  'rgb(23,25,26)': 'sky',
  '#23211c': 'warm',
  'rgb(35,33,28)': 'warm',
  '#1d2522': 'sage',
  'rgb(29,37,34)': 'sage',
  '#22202b': 'lavender',
  'rgb(34,32,43)': 'lavender',
}

const INK_TOKENS = new Set<string>(['amber', 'red', 'blue', 'green', 'purple', 'orange', 'gray'])
const LEGACY_INK_MAP: Record<string, InkToken> = {
  // Legacy dark-mode hexes & their computed rgb() forms
  '#e5bd42': 'amber',
  '#e8c24a': 'amber',
  '#9a6700': 'amber',
  'rgb(229,189,66)': 'amber',
  'rgb(232,194,74)': 'amber',
  'rgb(154,103,0)': 'amber',
  '#e87474': 'red',
  '#f07c7c': 'red',
  '#c43b3b': 'red',
  'rgb(232,116,116)': 'red',
  'rgb(240,124,124)': 'red',
  'rgb(196,59,59)': 'red',
  '#6eb5ff': 'blue',
  '#75b8ff': 'blue',
  '#1f66c1': 'blue',
  'rgb(110,181,255)': 'blue',
  'rgb(117,184,255)': 'blue',
  'rgb(31,102,193)': 'blue',
  '#74c69d': 'green',
  '#6fd09f': 'green',
  '#1d7a4f': 'green',
  'rgb(116,198,157)': 'green',
  'rgb(111,208,159)': 'green',
  'rgb(29,122,79)': 'green',
  '#b39ddb': 'purple',
  '#bfa6ef': 'purple',
  '#6e44b8': 'purple',
  'rgb(179,157,219)': 'purple',
  'rgb(191,166,239)': 'purple',
  'rgb(110,68,184)': 'purple',
  '#f4a261': 'orange',
  '#f5a664': 'orange',
  '#b85610': 'orange',
  'rgb(244,162,97)': 'orange',
  'rgb(245,166,100)': 'orange',
  'rgb(184,86,16)': 'orange',
  '#9aa5a0': 'gray',
  '#9ba6a1': 'gray',
  '#666d6a': 'gray',
  'rgb(154,165,160)': 'gray',
  'rgb(155,166,161)': 'gray',
  'rgb(102,109,106)': 'gray',
}

const HIGHLIGHT_TOKENS = new Set<string>(['yellow', 'blue', 'green', 'pink', 'purple', 'orange'])
const LEGACY_HIGHLIGHT_MAP: Record<string, HighlightToken> = {
  'rgba(229,189,66,0.34)': 'yellow',
  'rgba(250,204,21,0.36)': 'yellow',
  'rgba(229,184,52,0.26)': 'yellow',
  'rgba(110,181,255,0.3)': 'blue',
  'rgba(110,181,255,0.30)': 'blue',
  'rgba(96,165,250,0.28)': 'blue',
  'rgba(79,156,245,0.26)': 'blue',
  'rgba(116,198,157,0.3)': 'green',
  'rgba(116,198,157,0.30)': 'green',
  'rgba(74,222,128,0.28)': 'green',
  'rgba(68,184,126,0.25)': 'green',
  'rgba(232,116,116,0.3)': 'pink',
  'rgba(232,116,116,0.30)': 'pink',
  'rgba(248,113,113,0.26)': 'pink',
  'rgba(232,102,108,0.26)': 'pink',
  'rgba(179,157,219,0.3)': 'purple',
  'rgba(179,157,219,0.30)': 'purple',
  'rgba(167,139,250,0.28)': 'purple',
  'rgba(158,128,224,0.27)': 'purple',
  'rgba(244,162,97,0.32)': 'orange',
  'rgba(251,146,60,0.3)': 'orange',
  'rgba(251,146,60,0.30)': 'orange',
  'rgba(235,136,64,0.26)': 'orange',
}

function compactColor(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '')
}

export function normalizePaperToken(raw?: string | null): PaperToken {
  if (!raw) return ''
  const key = compactColor(raw)
  if (PAPER_TOKENS.has(key)) return key as PaperToken
  return LEGACY_PAPER_MAP[key] || ''
}

export function paperOptionFor(raw?: string | null): PaperOption {
  const token = normalizePaperToken(raw)
  return PAPER_OPTIONS.find((p) => p.id === token) || PAPER_OPTIONS[0]
}

export function normalizeInkToken(raw?: string | null): '' | InkToken {
  if (!raw) return ''
  const key = compactColor(raw)
  if (INK_TOKENS.has(key)) return key as InkToken
  if (key.startsWith('var(--ink-')) {
    const token = key.slice('var(--ink-'.length, -1)
    if (INK_TOKENS.has(token)) return token as InkToken
  }
  return LEGACY_INK_MAP[key] || ''
}

export function normalizeHighlightToken(raw?: string | null): '' | HighlightToken {
  if (!raw) return ''
  const key = compactColor(raw)
  if (HIGHLIGHT_TOKENS.has(key)) return key as HighlightToken
  if (key.startsWith('var(--hl-')) {
    const token = key.slice('var(--hl-'.length, -1).replace(/-swatch$/, '')
    if (HIGHLIGHT_TOKENS.has(token)) return token as HighlightToken
  }
  return LEGACY_HIGHLIGHT_MAP[key] || ''
}
