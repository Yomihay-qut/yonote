import { describe, expect, it } from 'vitest'
import zhCN from './i18n/locales/zh-CN.json'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import ko from './i18n/locales/ko.json'
import {
  SUPPORTED_LOCALES,
  detectSystemLocale,
  resolveLocale,
  translateServerError,
} from './i18n'
import { groupRecords, summarize } from './list-model'
import type { LocalRecord } from './types'

function flattenEntries(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenEntries(value as Record<string, unknown>, full))
    } else if (typeof value === 'string') {
      out[full] = value
    } else {
      throw new Error(`Unexpected value type at ${full}: ${typeof value}`)
    }
  }
  return out
}

function basePluralKey(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/, '')
}

function extractPlaceholders(text: string): string[] {
  const matches = Array.from(text.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1])
  return Array.from(new Set(matches)).sort()
}

function sampleNote(id: string, updatedAt: string, pinned = false): LocalRecord {
  return {
    id,
    kind: 'note',
    version: 1,
    rev: 1,
    dirty: 0,
    updatedAt,
    deletedAt: null,
    value: {
      title: id,
      pinned,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      plainText: id,
    },
  }
}

describe('i18n locale bundles & helpers', () => {
  const bundles = {
    'zh-CN': flattenEntries(zhCN),
    en: flattenEntries(en),
    ja: flattenEntries(ja),
    ko: flattenEntries(ko),
  }

  it('keeps identical logical keys, non-empty strings, and matching placeholders across zh-CN, en, ja, and ko', () => {
    const baseKeys = Array.from(new Set(Object.keys(bundles['zh-CN']).map(basePluralKey))).sort()

    for (const locale of SUPPORTED_LOCALES) {
      const entries = bundles[locale]
      const logicalKeys = Array.from(new Set(Object.keys(entries).map(basePluralKey))).sort()
      expect(logicalKeys, `Logical key mismatch for ${locale}`).toEqual(baseKeys)

      for (const [key, val] of Object.entries(entries)) {
        expect(val.trim().length, `Empty translation string at ${locale}:${key}`).toBeGreaterThan(0)
        const baseKey = basePluralKey(key)
        const refVal = bundles['zh-CN'][baseKey] ?? bundles['zh-CN'][`${baseKey}_other`]
        expect(extractPlaceholders(val), `Placeholder mismatch at ${locale}:${key}`).toEqual(
          extractPlaceholders(refVal),
        )
      }
    }
  })

  it('detects supported system languages and defaults to zh-CN otherwise', () => {
    expect(detectSystemLocale(['en-US', 'zh-CN'])).toBe('en')
    expect(detectSystemLocale(['en'])).toBe('en')
    expect(detectSystemLocale(['ja-JP'])).toBe('ja')
    expect(detectSystemLocale(['ko-KR'])).toBe('ko')
    expect(detectSystemLocale(['zh-Hans-CN'])).toBe('zh-CN')
    expect(detectSystemLocale(['zh-TW'])).toBe('zh-CN')
    expect(detectSystemLocale(['fr-FR', 'de-DE'])).toBe('zh-CN')
    expect(detectSystemLocale([])).toBe('zh-CN')

    expect(resolveLocale('system', ['ja-JP'])).toBe('ja')
    expect(resolveLocale('ko', ['en-US'])).toBe('ko')
  })

  it('formats date group headers across zh-CN, en, ja, and ko', () => {
    const today = new Date(2026, 10, 17, 12)
    const records = [
      sampleNote('pin', new Date(2026, 10, 17, 8).toISOString(), true),
      sampleNote('today', new Date(2026, 10, 17, 9).toISOString()),
      sampleNote('yesterday', new Date(2026, 10, 16, 22).toISOString()),
      sampleNote('old', new Date(2026, 9, 3).toISOString()),
    ].map(summarize)

    expect(groupRecords(records, true, today, 'zh-CN').map((g) => g.label)).toEqual([
      '置顶',
      '今天',
      '昨天',
      '2026年10月',
    ])
    expect(groupRecords(records, true, today, 'en').map((g) => g.label)).toEqual([
      'Pinned',
      'Today',
      'Yesterday',
      'October 2026',
    ])
    expect(groupRecords(records, true, today, 'ja').map((g) => g.label)).toEqual([
      'ピン留め',
      '今日',
      '昨日',
      '2026年10月',
    ])
    expect(groupRecords(records, true, today, 'ko').map((g) => g.label)).toEqual([
      '고정됨',
      '오늘',
      '어제',
      '2026년 10월',
    ])
  })

  it('preserves Chinese backend messages in zh-CN and translates them for other locales', () => {
    expect(translateServerError('账号或密码错误', 'zh-CN')).toBe('账号或密码错误')
    expect(translateServerError('账号或密码错误', 'en')).toBe('Invalid username or password')
    expect(translateServerError('账号或密码错误', 'ja')).toBe(
      'ユーザー名またはパスワードが正しくありません',
    )
    expect(translateServerError('账号或密码错误', 'ko')).toBe(
      '아이디 또는 비밀번호가 올바르지 않습니다',
    )
    expect(translateServerError('Custom unmapped error', 'en')).toBe('Custom unmapped error')
  })
})
