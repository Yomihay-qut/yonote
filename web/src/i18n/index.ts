import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import { resolveServerErrorKey } from './server-errors'

export type SupportedLocale = 'zh-CN' | 'en' | 'ja' | 'ko'
export type LanguagePreference = 'system' | SupportedLocale

export const LANGUAGE_STORAGE_KEY = 'language'
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['zh-CN', 'en', 'ja', 'ko']
export const LANGUAGE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
}

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function detectSystemLocale(languages?: readonly string[]): SupportedLocale {
  const candidates =
    languages ??
    (typeof navigator !== 'undefined'
      ? navigator.languages?.length
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : []
      : [])
  for (const raw of candidates) {
    const code = String(raw || '')
      .trim()
      .toLowerCase()
    if (!code) continue
    if (code === 'zh' || code.startsWith('zh-') || code.startsWith('zh_')) return 'zh-CN'
    if (code === 'en' || code.startsWith('en-') || code.startsWith('en_')) return 'en'
    if (code === 'ja' || code.startsWith('ja-') || code.startsWith('ja_')) return 'ja'
    if (code === 'ko' || code.startsWith('ko-') || code.startsWith('ko_')) return 'ko'
  }
  return 'zh-CN'
}

export function readLanguagePreference(): LanguagePreference {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (!raw) return 'system'
    const parsed = JSON.parse(raw) as unknown
    if (parsed === 'system' || isSupportedLocale(parsed)) return parsed
  } catch {
    // Ignore malformed storage values and fall back to system detection.
  }
  return 'system'
}

export function resolveLocale(
  pref: LanguagePreference,
  languages?: readonly string[],
): SupportedLocale {
  return pref === 'system' ? detectSystemLocale(languages) : pref
}

function isTestRuntime(): boolean {
  return typeof window === 'undefined' || import.meta.env?.MODE === 'test'
}

function resolveInitialLocale(): SupportedLocale {
  if (isTestRuntime()) return 'zh-CN'
  return resolveLocale(readLanguagePreference())
}

const initialLocale = resolveInitialLocale()

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
    ja: { translation: ja },
    ko: { translation: ko },
  },
  lng: initialLocale,
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
  returnNull: false,
})

export function currentLocale(): SupportedLocale {
  const active = i18n.resolvedLanguage || i18n.language
  return isSupportedLocale(active) ? active : 'zh-CN'
}

export function syncDocumentLocale(locale: SupportedLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.title = i18n.t('app.documentTitle', { lng: locale })
}

export function applyLanguagePreference(pref: LanguagePreference): SupportedLocale {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify(pref))
  } catch {
    // Ignore storage quota errors in restricted WebViews.
  }
  const next = resolveLocale(pref)
  void i18n.changeLanguage(next)
  syncDocumentLocale(next)
  return next
}

export function translateServerError(message: string, lng?: SupportedLocale): string {
  const target = lng ?? currentLocale()
  if (!message || target === 'zh-CN') return message
  const key = resolveServerErrorKey(message)
  return key ? i18n.t(key as never, { lng: target }) : message
}

if (!isTestRuntime()) {
  syncDocumentLocale(initialLocale)
  window.addEventListener('languagechange', () => {
    if (readLanguagePreference() !== 'system') return
    const next = detectSystemLocale()
    if (next !== currentLocale()) {
      void i18n.changeLanguage(next)
    }
    syncDocumentLocale(next)
  })
}

export default i18n
