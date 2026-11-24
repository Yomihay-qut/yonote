import { Capacitor } from '@capacitor/core'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import i18n, {
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LOCALES,
  currentLocale,
  detectSystemLocale,
  translateServerError,
  type LanguagePreference,
} from './i18n'
import { computeDiff, type DiffLine, type SplitRow } from './diff'
import {
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  History,
  Import,
  KeyRound,
  Link,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  RefreshCw,
  Shield,
  Smartphone,
  Sun,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import type { ApiKeyInfo, Device, HistoryEntry, LocalRecord, Session, User } from './types'
import { docText, migrateLocal, normalizeBase, save, type NoteDB } from './store'
import { api } from './sync'
import { formatBytes } from './media'
import { flushEdits } from './buffered-save'
import { ChoiceMenu } from './ChoiceMenu'
import { SegmentedControl } from './SegmentedControl'
import { useContentMotion } from './content-motion'
import { ColorDot, Confirm, Empty, IconButton, Modal, type ModalHandle } from './ui'

type SettingsProps = {
  db: NoteDB
  session: Session | null
  onSession: (s: Session | null) => void
  onClose: () => void
  notify: (s: string) => void
  theme: string
  setTheme: (s: string) => void
  accent: string
  setAccent: (s: string) => void
  motion: boolean
  setMotion: (b: boolean) => void
  language: LanguagePreference
  setLanguage: (l: LanguagePreference) => void
}
type UserEdit = { id: string; username: string; password: string; quota: string; disabled: boolean; admin: boolean }
type SettingsTab = 'appearance' | 'account' | 'admin'
const errorText = (e: unknown) =>
  e instanceof Error ? translateServerError(e.message) : i18n.t('common.operationFailed')
const maskKeyPrefix = (s: string) => s.slice(0, 6) + '••••'
const dateText = (s: string, locale: string = currentLocale()) =>
  new Date(s).toLocaleString(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
const isMobileDevice = (name: string) =>
  /安卓|手机|平板|モバイル|スマホ|タブレット|안드로이드|휴대폰|태블릿|android|iphone|ipad|mobile|tablet/i.test(name)
const isDesktopApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const hostLabel = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '')

export function Settings({
  db,
  session,
  onSession,
  onClose,
  notify,
  theme,
  setTheme,
  accent,
  setAccent,
  motion,
  setMotion,
  language,
  setLanguage,
}: SettingsProps) {
  const { t, i18n: i18nInst } = useTranslation()
  const activeLocale = i18nInst.resolvedLanguage || i18nInst.language
  const detectedLocale = detectSystemLocale()
  const settingsTabs = useMemo(
    () => [
      { value: 'appearance' as const, label: t('settings.tabs.appearance'), icon: <Palette size={16} /> },
      { value: 'account' as const, label: t('settings.tabs.account'), icon: <Cloud size={16} /> },
      { value: 'admin' as const, label: t('settings.tabs.admin'), icon: <Shield size={16} /> },
    ],
    [t],
  )
  const modal = useRef<ModalHandle>(null)
  const content = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const capture = useContentMotion(content, tab)
  const tabs = session?.user.admin ? settingsTabs : settingsTabs.slice(0, 2)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [server, setServer] = useState(
      () =>
        session?.base ||
        (!Capacitor.isNativePlatform() && !isDesktopApp() && location.protocol.startsWith('http')
          ? location.origin
          : ''),
    ),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [device, setDevice] = useState(
      /Android/i.test(navigator.userAgent)
        ? t('settings.deviceDefaultAndroid')
        : isDesktopApp()
          ? t('settings.deviceDefaultWindows')
          : t('settings.deviceDefaultWeb'),
    ),
    [needsSetup, setNeedsSetup] = useState(false)
  const [me, setMe] = useState<User | null>(session?.user || null),
    [devices, setDevices] = useState<Device[]>([]),
    [keys, setKeys] = useState<ApiKeyInfo[]>([]),
    [folders, setFolders] = useState<{ id: string; name: string }[]>([]),
    [users, setUsers] = useState<User[]>([])
  const [creatingKey, setCreatingKey] = useState(false),
    [keyName, setKeyName] = useState(''),
    [keyScopes, setKeyScopes] = useState<string[]>(['read', 'write', 'todo']),
    [keyFolders, setKeyFolders] = useState<string[]>([]),
    [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null),
    [showFullKey, setShowFullKey] = useState(false)
  const [edit, setEdit] = useState<UserEdit | null>(null),
    [creating, setCreating] = useState(false),
    [newName, setNewName] = useState(''),
    [newPass, setNewPass] = useState(''),
    [newQuota, setNewQuota] = useState('2')
  const [confirm, setConfirm] = useState<{
    title: string
    text: string
    action: string
    run: () => void
    danger?: boolean
  } | null>(null)
  const task = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [])
  const refresh = useCallback(async () => {
    if (!session) return
    const [account, list, keyList, localFolders] = await Promise.all([
      api<User>(session, '/api/me'),
      api<Device[]>(session, '/api/devices'),
      api<ApiKeyInfo[]>(session, '/api/keys').catch(() => [] as ApiKeyInfo[]),
      db.summaries
        .where('kind')
        .equals('folder')
        .toArray()
        .catch(() => []),
    ])
    setMe(account)
    setDevices(list)
    setKeys(keyList)
    setFolders(
      localFolders
        .filter((f) => !f.deletedAt && f.value.module !== 'todo')
        .map((f) => ({ id: f.id, name: f.value.name || i18n.t('nav.unnamedFolder') })),
    )
    if (session.user.admin) setUsers(await api<User[]>(session, '/api/admin/users'))
  }, [session, db])
  useEffect(() => {
    if (session) void task(refresh)
  }, [session, task, refresh])
  useEffect(() => {
    if (session || tab !== 'account') {
      setNeedsSetup(false)
      return
    }
    let candidate = ''
    try {
      if (server.trim()) candidate = normalizeBase(server)
      else if (!Capacitor.isNativePlatform() && !isDesktopApp() && location.protocol.startsWith('http'))
        candidate = ''
      else {
        setNeedsSetup(false)
        return
      }
    } catch {
      setNeedsSetup(false)
      return
    }
    const ctrl = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(candidate + '/api/setup', { signal: ctrl.signal })
        if (!res.ok) return
        const data = (await res.json()) as { needsSetup?: boolean }
        if (!ctrl.signal.aborted) setNeedsSetup(!!data.needsSetup)
      } catch {
        if (!ctrl.signal.aborted) setNeedsSetup(false)
      }
    }, 260)
    return () => {
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [session, tab, server])
  async function finishConnection(next: Session | null, message: string) {
    await flushEdits()
    const commit = () => {
      onSession(next)
      notify(message)
    }
    if (!modal.current?.dismiss(commit)) commit()
  }
  async function login(e: FormEvent) {
    e.preventDefault()
    await task(async () => {
      const base = normalizeBase(server)
      const endpoint = needsSetup ? '/api/setup' : '/api/login'
      const res = await fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, device }),
        signal: AbortSignal.timeout(30000),
      })
      const result = await res.json()
      if (!res.ok)
        throw Error(
          result.error
            ? translateServerError(result.error)
            : t(needsSetup ? 'settings.setupFailed' : 'settings.connectFailed'),
        )
      const next: Session = { base, token: result.token, user: result.user }
      setPassword('')
      setNeedsSetup(false)
      await finishConnection(
        next,
        t(needsSetup ? 'settings.setupSuccess' : 'settings.connectSuccess', {
          username: result.user.username,
        }),
      )
    })
  }
  function logout() {
    setConfirm({
      title: t('settings.switchLocalTitle'),
      text: t('settings.switchLocalText'),
      action: t('settings.switchLocalAction'),
      run: () => void task(() => finishConnection(null, t('settings.switchedToLocal'))),
    })
  }
  function revoke(d: Device) {
    setConfirm({
      title: t('settings.deviceRevokeTitle'),
      text: t('settings.deviceRevokeText', { name: d.name }),
      action: t('settings.deviceRevokeAction'),
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/devices/' + d.id, { method: 'DELETE' })
          if (d.current) {
            await finishConnection(null, t('settings.deviceRevokedSelf'))
          } else {
            await refresh()
            notify(t('settings.deviceRevokedOther', { name: d.name }))
          }
        }),
    })
  }
  async function createUser(e: FormEvent) {
    e.preventDefault()
    await task(async () => {
      const quota = Number(newQuota)
      if (!Number.isFinite(quota) || quota <= 0) throw Error(t('settings.adminInvalidQuota'))
      await api(session!, '/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newName.trim(),
          password: newPass,
          quota: Math.round(quota * 1024 ** 3),
        }),
      })
      setNewName('')
      setNewPass('')
      setCreating(false)
      await refresh()
      notify(t('settings.adminUserCreated'))
    })
  }
  async function updateUser(e: FormEvent) {
    e.preventDefault()
    if (!edit) return
    await task(async () => {
      const quota = Number(edit.quota)
      if (!Number.isFinite(quota) || quota <= 0) throw Error(t('settings.adminInvalidQuota'))
      const payload: { quota: number; disabled: boolean; password?: string } = {
        quota: Math.round(quota * 1024 ** 3),
        disabled: edit.disabled,
      }
      if (edit.password) payload.password = edit.password
      await api(session!, '/api/admin/users/' + edit.id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      setEdit(null)
      await refresh()
      notify(t(payload.password ? 'settings.adminSavedWithPassword' : 'settings.adminSaved'))
    })
  }
  function deleteUser(u: Pick<User, 'id' | 'username'>) {
    setConfirm({
      title: t('settings.adminDeleteTitle'),
      text: t('settings.adminDeleteText', { username: u.username }),
      action: t('settings.adminDeleteAction'),
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/admin/users/' + u.id, { method: 'DELETE' })
          if (edit?.id === u.id) {
            modal.current?.captureHeight()
            setEdit(null)
          }
          await refresh()
          notify(t('settings.adminUserDeleted', { username: u.username }))
        }),
    })
  }

  async function createApiKey(e: FormEvent) {
    e.preventDefault()
    if (!keyScopes.length) {
      setError(t('settings.keyNeedScope'))
      return
    }
    await task(async () => {
      const res = await api<{ key: string; item: ApiKeyInfo }>(session!, '/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: keyName.trim() || t('settings.keyNameDefault'),
          scopes: keyScopes,
          folderIds: keyFolders,
        }),
      })
      setKeyName('')
      setKeyScopes(['read', 'write', 'todo'])
      setKeyFolders([])
      setCreatingKey(false)
      setShowFullKey(false)
      setRevealedKey({ name: res.item.name, key: res.key })
      await refresh()
      notify(t('settings.keyCreatedNotify'))
    })
  }
  function revokeApiKey(k: ApiKeyInfo) {
    setConfirm({
      title: t('settings.keyRevokeTitle'),
      text: t('settings.keyRevokeText', { name: k.name }),
      action: t('settings.keyRevokeAction'),
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/keys/' + k.id, { method: 'DELETE' })
          await refresh()
          notify(t('settings.keyRevokedNotify', { name: k.name }))
        }),
    })
  }
  async function copyText(text: string, msg: string) {
    try {
      await navigator.clipboard.writeText(text)
      notify(msg)
    } catch {
      notify(t('common.manualCopyHint'))
    }
  }
  function toggleScope(scope: string) {
    setKeyScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    )
  }
  function toggleKeyFolder(id: string) {
    setKeyFolders((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]))
  }

  const usedRatio = me?.quota ? Math.min(100, Math.max(0, (me.used / me.quota) * 100)) : 0
  const mcpUrl = session ? (session.base || location.origin).replace(/\/$/, '') + '/mcp' : ''

  return (
    <Modal
      ref={modal}
      title={t('settings.title')}
      onClose={onClose}
      wide
      layoutKey={`${tab}:${edit?.id || ''}:${creating}:${creatingKey}:${revealedKey ? 1 : 0}:${activeLocale}`}
    >
      <SegmentedControl
        label={t('settings.categoriesAria')}
        className="settings-segments"
        options={tabs}
        value={tab}
        onChange={(next) => {
          if (next === tab) return
          modal.current?.captureHeight()
          capture(
            settingsTabs.findIndex((item) => item.value === next) >
              settingsTabs.findIndex((item) => item.value === tab)
              ? 1
              : -1,
          )
          setError('')
          setTab(next)
        }}
      />
      <div className="settings-content-window">
        <div className="settings-content" ref={content}>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {tab === 'appearance' && (
            <div className="settings-section panel-stack">
              <div className="panel-card">
                <fieldset className="theme-field">
                  <legend>{t('settings.themeLegend')}</legend>
                  <div className="theme-choices">
                    {([
                      ['system', t('settings.themeSystem'), Monitor],
                      ['light', t('settings.themeLight'), Sun],
                      ['dark', t('settings.themeDark'), Moon],
                    ] as const).map(([value, label, Icon]) => (
                      <label className="theme-choice" key={value}>
                        <input
                          type="radio"
                          name="theme"
                          value={value}
                          checked={theme === value}
                          onChange={() => setTheme(value)}
                        />
                        <span>
                          <Icon size={17} />
                          {label}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="panel-divider" />
                <div className="panel-inline-row">
                  <span className="panel-row-label">{t('settings.languageLabel')}</span>
                  <ChoiceMenu
                    label={t('settings.languageLabel')}
                    value={language}
                    choices={[
                      {
                        value: 'system',
                        label: t('settings.languageSystem', {
                          name: LANGUAGE_NATIVE_NAMES[detectedLocale],
                        }),
                      },
                      ...SUPPORTED_LOCALES.map((loc) => ({
                        value: loc,
                        label: LANGUAGE_NATIVE_NAMES[loc],
                      })),
                    ]}
                    onChange={(next) => {
                      modal.current?.captureHeight()
                      setLanguage(next as LanguagePreference)
                    }}
                  />
                </div>
                <div className="panel-divider" />
                <div className="panel-inline-row">
                  <span className="panel-row-label">{t('settings.accentLabel')}</span>
                  <div className="accent-dots">
                    {[
                      ['#e5bd42', t('settings.accentYellow')],
                      ['#79b8d2', t('settings.accentBlue')],
                      ['#8bbd9b', t('settings.accentGreen')],
                      ['#b3a1df', t('settings.accentPurple')],
                    ].map(([color, name]) => (
                      <ColorDot
                        key={color}
                        color={color}
                        selected={accent === color}
                        label={name}
                        onClick={() => setAccent(color)}
                      />
                    ))}
                  </div>
                </div>
                <div className="panel-divider" />
                <label className="panel-switch-row">
                  <span className="panel-row-label">{t('settings.motionLabel')}</span>
                  <input
                    className="pill-switch"
                    type="checkbox"
                    checked={motion}
                    onChange={(e) => setMotion(e.target.checked)}
                  />
                </label>
              </div>
              <div className="version-label">{t('app.versionLabel', { version: '1.0.0' })}</div>
            </div>
          )}

          {tab === 'account' && (
            <div className="settings-section panel-stack">
              {session ? (
                <>
                  <div className="panel-card account-card">
                    <div className="account-header">
                      <span className="account-avatar">
                        {me?.username.slice(0, 1).toUpperCase() || 'Y'}
                      </span>
                      <div className="account-meta">
                        <div className="account-name-row">
                          <h3>{me?.username}</h3>
                          {me?.admin && <span className="status-pill">{t('settings.adminBadge')}</span>}
                        </div>
                        <p className="account-host">{hostLabel(session.base || location.origin)}</p>
                      </div>
                      <IconButton
                        className="panel-refresh"
                        label={t('settings.refreshAccount')}
                        disabled={busy}
                        onClick={() => void task(refresh)}
                      >
                        <RefreshCw className={busy ? 'spin' : ''} size={17} />
                      </IconButton>
                    </div>

                    <div className="panel-divider" />

                    <div className="storage-meter">
                      <div className="storage-meter-head">
                        <span>{t('settings.storageLabel')}</span>
                        <span className="storage-value">
                          {formatBytes(me?.used || 0)} / {formatBytes(me?.quota || 0)}
                        </span>
                      </div>
                      <div
                        className="meter-track"
                        role="progressbar"
                        aria-label={t('settings.storageAria')}
                        aria-valuenow={Math.round(usedRatio)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="meter-fill" style={{ width: `${usedRatio}%` }} />
                      </div>
                    </div>

                    <div className="panel-action-grid">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: t('settings.importLocalTitle'),
                            text: t('settings.importLocalText'),
                            action: t('settings.importLocalAction'),
                            run: () =>
                              void task(async () => {
                                const n = await migrateLocal(db)
                                notify(t('settings.importLocalSuccess', { count: n }))
                              }),
                          })
                        }
                      >
                        <Import size={16} />
                        <span>{t('settings.importLocalButton')}</span>
                      </button>
                      <button type="button" className="secondary" onClick={logout}>
                        <LogOut size={16} />
                        <span>{t('settings.switchLocalButton')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="panel-group">
                    <div className="panel-group-head">
                      <h3>{t('settings.devicesHeading')}</h3>
                      <span className="count-pill">{devices.length}</span>
                    </div>
                    <div className="panel-card panel-list">
                      {devices.map((d) => {
                        const Mobile = isMobileDevice(d.name)
                        return (
                          <div className="panel-item" key={d.id}>
                            <span className="panel-item-icon">
                              {Mobile ? <Smartphone size={17} /> : <Monitor size={17} />}
                            </span>
                            <div className="panel-item-copy">
                              <div className="panel-item-title">
                                <strong>{d.name}</strong>
                                {d.current && <span className="status-pill">{t('settings.deviceCurrent')}</span>}
                              </div>
                              <p className="panel-item-sub">
                                {t('settings.deviceLastSeen', { time: dateText(d.lastSeen, activeLocale) })}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="panel-item-action danger"
                              disabled={busy}
                              onClick={() => revoke(d)}
                            >
                              {t('settings.deviceLogout')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="panel-group">
                    <div className="panel-group-head">
                      <h3>{t('settings.aiHeading')}</h3>
                      <button
                        type="button"
                        className="panel-head-btn"
                        disabled={busy}
                        onClick={() => {
                          modal.current?.captureHeight()
                          setCreatingKey((v) => !v)
                          setError('')
                        }}
                      >
                        <Plus size={14} />
                        <span>{creatingKey ? t('settings.aiCollapse') : t('settings.aiNewKey')}</span>
                      </button>
                    </div>

                    <div className="panel-card mcp-endpoint-card">
                      <div className="mcp-endpoint-copy">
                        <span className="mcp-endpoint-label">{t('settings.mcpEndpoint')}</span>
                        <code className="mcp-endpoint-url">{mcpUrl}</code>
                      </div>
                      <button
                        type="button"
                        className="secondary mcp-copy-btn"
                        onClick={() => void copyText(mcpUrl, t('settings.mcpCopySuccess'))}
                      >
                        <Copy size={14} />
                        <span>{t('common.copy')}</span>
                      </button>
                    </div>

                    {revealedKey && (
                      <div className="panel-card key-reveal-card">
                        <div className="key-reveal-head">
                          <strong>{t('settings.keyGeneratedBanner', { name: revealedKey.name })}</strong>
                          <span className="status-pill">{t('settings.keyShowOnce')}</span>
                        </div>
                        <div className="key-reveal-row">
                          <code className="key-reveal-value">
                            {showFullKey ? revealedKey.key : maskKeyPrefix(revealedKey.key) + '••••••••'}
                          </code>
                          <IconButton
                            label={showFullKey ? t('settings.keyHideFull') : t('settings.keyShowFull')}
                            onClick={() => setShowFullKey((v) => !v)}
                          >
                            {showFullKey ? <EyeOff size={16} /> : <Eye size={16} />}
                          </IconButton>
                        </div>
                        <p className="key-reveal-hint">{t('settings.keyGuide')}</p>
                        <div className="panel-action-grid">
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void copyText(revealedKey.key, t('settings.keyCopySuccess'))}
                          >
                            <Copy size={15} />
                            <span>{t('settings.keyCopy')}</span>
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() =>
                              void copyText(
                                JSON.stringify(
                                  {
                                    mcpServers: {
                                      yonote: {
                                        url: mcpUrl,
                                        headers: { Authorization: 'Bearer ' + revealedKey.key },
                                      },
                                    },
                                  },
                                  null,
                                  2,
                                ),
                                t('settings.mcpConfigCopySuccess'),
                              )
                            }
                          >
                            <Copy size={15} />
                            <span>{t('settings.mcpConfigCopy')}</span>
                          </button>
                        </div>
                        <button
                          type="button"
                          className="key-reveal-dismiss"
                          onClick={() => {
                            modal.current?.captureHeight()
                            setShowFullKey(false)
                            setRevealedKey(null)
                          }}
                        >
                          {t('settings.keyAckCollapse')}
                        </button>
                      </div>
                    )}

                    {creatingKey && (
                      <form className="panel-card form-card" onSubmit={createApiKey}>
                        <label className="form-field">
                          {t('settings.keyNameLabel')}
                          <input
                            required
                            maxLength={64}
                            value={keyName}
                            onChange={(e) => setKeyName(e.target.value)}
                            placeholder={t('settings.keyNamePlaceholder')}
                          />
                        </label>
                        <div className="form-field">
                          <span>{t('settings.keyScopesLabel')}</span>
                          <div className="chip-row">
                            {([
                              ['read', t('settings.scopeReadFull')],
                              ['write', t('settings.scopeWriteFull')],
                              ['todo', t('settings.scopeTodoFull')],
                            ] as const).map(([scope, label]) => (
                              <button
                                key={scope}
                                type="button"
                                className={
                                  'chip-toggle' + (keyScopes.includes(scope) ? ' selected' : '')
                                }
                                onClick={() => toggleScope(scope)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {folders.length > 0 && (
                          <div className="form-field">
                            <span>{t('settings.keyFoldersLabel')}</span>
                            <div className="chip-row">
                              <button
                                type="button"
                                className={
                                  'chip-toggle' + (keyFolders.length === 0 ? ' selected' : '')
                                }
                                onClick={() => setKeyFolders([])}
                              >
                                {t('settings.allFolders')}
                              </button>
                              {folders.map((f) => (
                                <button
                                  key={f.id}
                                  type="button"
                                  className={
                                    'chip-toggle' + (keyFolders.includes(f.id) ? ' selected' : '')
                                  }
                                  onClick={() => toggleKeyFolder(f.id)}
                                >
                                  {f.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <p className="key-safety-note">{t('settings.keySecurityHint')}</p>
                        <div className="panel-action-grid">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              modal.current?.captureHeight()
                              setCreatingKey(false)
                            }}
                          >
                            {t('common.cancel')}
                          </button>
                          <button type="submit" className="primary" disabled={busy}>
                            {t('settings.keyCreate')}
                          </button>
                        </div>
                      </form>
                    )}

                    <div className="panel-card panel-list">
                      {keys.length === 0 ? (
                        <div className="panel-empty-row">{t('settings.keyEmptyHint')}</div>
                      ) : (
                        keys.map((k) => {
                          const scopeLabels = k.scopes
                            .map((s) =>
                              s === 'read'
                                ? t('settings.scopeReadShort')
                                : s === 'write'
                                  ? t('settings.scopeWriteShort')
                                  : t('settings.scopeTodoShort'),
                            )
                            .join(' / ')
                          return (
                            <div className="panel-item" key={k.id}>
                              <span className="panel-item-icon">
                                <KeyRound size={17} />
                              </span>
                              <div className="panel-item-copy">
                                <div className="panel-item-title">
                                  <strong>{k.name}</strong>
                                  <span className="status-pill">{scopeLabels}</span>
                                  {k.folderIds?.length > 0 && (
                                    <span className="status-pill">
                                      {t('settings.keyFolderLimit', { count: k.folderIds.length })}
                                    </span>
                                  )}
                                </div>
                                <p className="panel-item-sub">
                                  {maskKeyPrefix(k.prefix)} ·{' '}
                                  {k.lastUsedAt
                                    ? t('settings.keyLastUsed', {
                                        time: dateText(k.lastUsedAt, activeLocale),
                                      })
                                    : t('settings.keyNeverUsed')}
                                </p>
                              </div>
                              <button
                                type="button"
                                className="panel-item-action danger"
                                disabled={busy}
                                onClick={() => revokeApiKey(k)}
                              >
                                {t('settings.keyRevoke')}
                              </button>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <form className="panel-card form-card" onSubmit={login}>
                  {needsSetup && <p className="small muted">{t('settings.setupBanner')}</p>}
                  <label className="form-field">
                    {t('settings.serverUrlLabel')}
                    <input
                      type="url"
                      value={server}
                      onChange={(e) => setServer(e.target.value)}
                      placeholder="https://notes.example.com"
                      required={Capacitor.isNativePlatform() || isDesktopApp()}
                      autoComplete="url"
                    />
                  </label>
                  <div className="form-grid-2">
                    <label className="form-field">
                      {t('settings.accountLabel')}
                      <input
                        required
                        minLength={2}
                        maxLength={64}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        placeholder={
                          needsSetup
                            ? t('settings.setupUsernamePlaceholder')
                            : t('settings.usernamePlaceholder')
                        }
                      />
                    </label>
                    <label className="form-field">
                      {t('settings.deviceNameLabel')}
                      <input
                        required
                        maxLength={100}
                        value={device}
                        onChange={(e) => setDevice(e.target.value)}
                        placeholder={t('settings.devicePlaceholder')}
                      />
                    </label>
                  </div>
                  <label className="form-field">
                    {t('settings.passwordLabel')}
                    <input
                      required
                      minLength={needsSetup ? 12 : undefined}
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete={needsSetup ? 'new-password' : 'current-password'}
                      placeholder={
                        needsSetup
                          ? t('settings.setupPasswordPlaceholder')
                          : t('settings.passwordPlaceholder')
                      }
                    />
                  </label>
                  <button className="primary full-width" disabled={busy} type="submit">
                    {busy ? (
                      <>
                        <LoaderCircle size={17} className="spin" />
                        {needsSetup ? t('settings.setupBusy') : t('settings.connectBusy')}
                      </>
                    ) : needsSetup ? (
                      t('settings.setupSubmit')
                    ) : (
                      t('settings.connectSubmit')
                    )}
                  </button>
                </form>
              )}
            </div>
          )}

          {tab === 'admin' && session?.user.admin && (
            <div className="settings-section panel-stack">
              {edit ? (
                <form onSubmit={updateUser} className="panel-card form-card">
                  <div className="panel-card-head">
                    <h4>{t('settings.adminEditHeading', { username: edit.username })}</h4>
                    <button
                      className="panel-item-action"
                      type="button"
                      onClick={() => {
                        modal.current?.captureHeight()
                        setEdit(null)
                      }}
                    >
                      {t('settings.adminBackList')}
                    </button>
                  </div>
                  <div className="form-grid-2">
                    <label className="form-field">
                      {t('settings.adminQuotaLabel')}
                      <input
                        required
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={edit.quota}
                        onChange={(e) => setEdit({ ...edit, quota: e.target.value })}
                      />
                    </label>
                    <label className="form-field">
                      {t('settings.adminResetPasswordLabel')}
                      <input
                        type="password"
                        minLength={12}
                        maxLength={256}
                        value={edit.password}
                        onChange={(e) => setEdit({ ...edit, password: e.target.value })}
                        autoComplete="new-password"
                        placeholder={t('settings.adminResetPasswordPlaceholder')}
                      />
                    </label>
                  </div>
                  <div className="panel-divider" />
                  <div className="form-footer">
                    <label className="panel-switch-inline">
                      <input
                        className="pill-switch"
                        type="checkbox"
                        disabled={edit.id === session.user.id}
                        checked={edit.disabled}
                        onChange={(e) => setEdit({ ...edit, disabled: e.target.checked })}
                      />
                      <span>{t('settings.adminDisableUser')}</span>
                    </label>
                    <div className="panel-item-actions">
                      {!edit.admin && edit.id !== session.user.id && (
                        <button
                          className="secondary text-danger"
                          disabled={busy}
                          type="button"
                          onClick={() => deleteUser(edit)}
                        >
                          {t('settings.adminDeleteUser')}
                        </button>
                      )}
                      <button className="primary" disabled={busy} type="submit">
                        {t('settings.adminSaveSettings')}
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <div className="panel-group">
                  <div className="panel-group-head">
                    <div className="panel-group-title">
                      <h3>{t('settings.adminUsersHeading')}</h3>
                      <span className="count-pill">{users.length}</span>
                    </div>
                    <button
                      type="button"
                      className={'panel-add-btn ' + (creating ? 'active' : '')}
                      onClick={() => {
                        modal.current?.captureHeight()
                        setCreating((v) => !v)
                      }}
                    >
                      {creating ? <X size={14} /> : <Plus size={15} />}
                      <span>{creating ? t('settings.aiCollapse') : t('settings.adminNewUser')}</span>
                    </button>
                  </div>

                  {creating && (
                    <form className="panel-card form-card" onSubmit={createUser}>
                      <div className="panel-card-head">
                        <h4 className="panel-card-title-icon">
                          <UserPlus size={16} />
                          <span>{t('settings.adminCreateHeading')}</span>
                        </h4>
                      </div>
                      <div className="form-grid-2">
                        <label className="form-field">
                          {t('settings.adminUsernameLabel')}
                          <input
                            required
                            minLength={2}
                            maxLength={64}
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            autoComplete="off"
                            placeholder={t('settings.adminUsernamePlaceholder')}
                          />
                        </label>
                        <label className="form-field">
                          {t('settings.adminQuotaLabel')}
                          <input
                            required
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={newQuota}
                            onChange={(e) => setNewQuota(e.target.value)}
                          />
                        </label>
                      </div>
                      <label className="form-field">
                        {t('settings.adminInitialPasswordLabel')}
                        <input
                          required
                          type="password"
                          minLength={12}
                          maxLength={256}
                          value={newPass}
                          onChange={(e) => setNewPass(e.target.value)}
                          autoComplete="new-password"
                          placeholder={t('settings.adminInitialPasswordPlaceholder')}
                        />
                      </label>
                      <div className="form-footer end">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            modal.current?.captureHeight()
                            setCreating(false)
                          }}
                        >
                          {t('common.cancel')}
                        </button>
                        <button className="primary" disabled={busy} type="submit">
                          {t('settings.adminCreateSubmit')}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="panel-card panel-list">
                    {users.map((u) => (
                      <div className="panel-item" key={u.id}>
                        <span className="panel-item-avatar">
                          {u.username.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="panel-item-copy">
                          <div className="panel-item-title">
                            <strong>{u.username}</strong>
                            {u.admin && <span className="status-pill">{t('settings.adminBadge')}</span>}
                            {u.disabled && (
                              <span className="status-pill danger">
                                {t('settings.adminDisabledBadge')}
                              </span>
                            )}
                          </div>
                          <p className="panel-item-sub">
                            {formatBytes(u.used)} / {formatBytes(u.quota)}
                          </p>
                        </div>
                        <div className="panel-item-actions">
                          <button
                            type="button"
                            className="panel-item-action"
                            onClick={() => {
                              modal.current?.captureHeight()
                              setCreating(false)
                              setEdit({
                                id: u.id,
                                username: u.username,
                                password: '',
                                quota: String(Number((u.quota / 1024 ** 3).toFixed(3))),
                                disabled: u.disabled,
                                admin: u.admin,
                              })
                            }}
                          >
                            {t('common.edit')}
                          </button>
                          {!u.admin && u.id !== session.user.id && (
                            <button
                              type="button"
                              className="panel-item-action danger"
                              disabled={busy}
                              onClick={() => deleteUser(u)}
                            >
                              {t('common.delete')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <Confirm
          title={confirm.title}
          text={confirm.text}
          action={confirm.action}
          onConfirm={confirm.run}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
        />
      )}
    </Modal>
  )
}

function renderDiffText(line: DiffLine) {
  if (!line.parts) return line.text || ' '
  return line.parts.map((p, idx) =>
    p.changed ? (
      <span key={idx} className={line.type === 'del' ? 'diff-char-del' : 'diff-char-add'}>
        {p.text}
      </span>
    ) : (
      <Fragment key={idx}>{p.text}</Fragment>
    ),
  )
}

function collapseDiffRows(rows: SplitRow[], expanded: Set<number>): (
  | { kind: 'row'; row: SplitRow; idx: number }
  | { kind: 'skip'; count: number; id: number; rows: { row: SplitRow; idx: number }[] }
)[] {
  const show = new Array<boolean>(rows.length).fill(false)
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'change') {
      const from = Math.max(0, i - 3)
      const to = Math.min(rows.length - 1, i + 3)
      for (let k = from; k <= to; k++) show[k] = true
    }
  }
  const items: (
    | { kind: 'row'; row: SplitRow; idx: number }
    | { kind: 'skip'; count: number; id: number; rows: { row: SplitRow; idx: number }[] }
  )[] = []
  let i = 0
  while (i < rows.length) {
    if (show[i]) {
      items.push({ kind: 'row', row: rows[i], idx: i })
      i++
      continue
    }
    const start = i
    const hidden: { row: SplitRow; idx: number }[] = []
    while (i < rows.length && !show[i]) {
      hidden.push({ row: rows[i], idx: i })
      i++
    }
    if (hidden.length <= 2 || expanded.has(start)) {
      for (const h of hidden) items.push({ kind: 'row', ...h })
    } else {
      items.push({ kind: 'skip', count: hidden.length, id: start, rows: hidden })
    }
  }
  return items
}

export function HistoryPanel({
  db,
  session,
  record,
  onClose,
  notify,
  onRestored,
}: {
  db: NoteDB
  session: Session | null
  record: LocalRecord
  onClose: () => void
  notify: (s: string) => void
  onRestored: () => void
}) {
  const { t, i18n: i18nInst } = useTranslation()
  const activeLocale = i18nInst.resolvedLanguage || i18nInst.language
  const modal = useRef<ModalHandle>(null)
  const [entries, setEntries] = useState<HistoryEntry[]>([]),
    [selected, setSelected] = useState<HistoryEntry | null>(null),
    [mode, setMode] = useState<'diff' | 'raw'>('diff'),
    [changesOnly, setChangesOnly] = useState(true),
    [expandedSkips, setExpandedSkips] = useState<Set<number>>(() => new Set()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!session) return
    let live = true
    setBusy(true)
    void api<HistoryEntry[]>(session, '/api/history/' + record.id)
      .then((data) => {
        if (live) {
          setEntries(data)
          // Auto-select the first entry that differs from current text if available, otherwise latest.
          const cur = record.value.plainText || docText(record.value.content || { type: 'doc' })
          const firstDiff = data.find((e) => {
            const t = e.record.value.plainText || docText(e.record.value.content || { type: 'doc' })
            return t !== cur || (e.record.value.title || '') !== (record.value.title || '')
          })
          setSelected(firstDiff || data[0] || null)
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e))
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [session, record.id])
  useEffect(() => {
    setExpandedSkips(new Set())
  }, [selected?.id])

  const currentText = useMemo(
    () => record.value.plainText || docText(record.value.content || { type: 'doc' }),
    [record.value.plainText, record.value.content],
  )
  const selectedText = useMemo(() => {
    if (!selected) return ''
    return selected.record.value.plainText || docText(selected.record.value.content || { type: 'doc' })
  }, [selected])
  const diff = useMemo(
    () => (selected ? computeDiff(selectedText, currentText) : null),
    [selected, selectedText, currentText],
  )
  const splitItems = useMemo(() => {
    if (!diff) return []
    if (!changesOnly || diff.identical) {
      return diff.rows.map((row, idx) => ({ kind: 'row' as const, row, idx }))
    }
    return collapseDiffRows(diff.rows, expandedSkips)
  }, [diff, changesOnly, expandedSkips])

  async function restore() {
    if (!selected) return
    setBusy(true)
    try {
      const current = await db.records.get(record.id)
      if (current?.dirty) throw Error(t('history.waitSyncBeforeRestore'))
      const v = selected.record.value
      await save(db, record.id, 'note', {
        title: v.title || '',
        content: v.content,
        plainText: v.plainText || docText(v.content || { type: 'doc' }),
      })
      notify(t('history.restoredNotify'))
      onRestored()
      modal.current?.dismiss()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal ref={modal} title={t('history.title')} onClose={onClose} wide className="history-modal">
      {!session ? (
        <Empty
          icon={<HardDrive size={28} />}
          title={t('history.requireAccountTitle')}
          text={t('history.requireAccountText')}
        />
      ) : (
        <div className="history-shell">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {busy ? (
            <div className="panel-loading">
              <LoaderCircle size={18} className="spin" />
              <span>{t('history.loading')}</span>
            </div>
          ) : !entries.length && !error ? (
            <Empty icon={<History size={28} />} title={t('history.emptyTitle')} text="" />
          ) : (
            <div className="history-layout">
              <aside className="history-sidebar panel-card">
                <div className="history-sidebar-head">
                  <span>{t('history.listHeading')}</span>
                  <span className="count-pill">{entries.length}</span>
                </div>
                <div className="history-list">
                  {entries.map((entry, i) => (
                    <button
                      type="button"
                      key={entry.id}
                      className={selected?.id === entry.id ? 'active' : ''}
                      onClick={() => setSelected(entry)}
                    >
                      <span className="history-item-top">
                        <strong>{dateText(entry.createdAt, activeLocale)}</strong>
                        {i === 0 && <span className="status-pill">{t('history.latestBadge')}</span>}
                      </span>
                      <small>{entry.record.value.title || t('notes.untitledNote')}</small>
                    </button>
                  ))}
                </div>
              </aside>
              {selected && diff && (
                <section className="history-preview panel-card">
                  <div className="history-preview-head">
                    <div className="history-head-left">
                      <h3>{dateText(selected.createdAt, activeLocale)}</h3>
                      <span className="diff-stat">
                        {diff.identical ? (
                          <span className="same">{t('history.sameContent')}</span>
                        ) : (
                          <>
                            <span className="add">+{diff.added}</span>
                            <span className="del">-{diff.removed}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="history-head-actions">
                      <div className="diff-mode-pills" role="tablist" aria-label={t('history.viewModeAria')}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'diff'}
                          className={'diff-mode-btn' + (mode === 'diff' ? ' active' : '')}
                          onClick={() => setMode('diff')}
                        >
                          {t('history.diffMode')}
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'raw'}
                          className={'diff-mode-btn' + (mode === 'raw' ? ' active' : '')}
                          onClick={() => setMode('raw')}
                        >
                          {t('history.rawMode')}
                        </button>
                      </div>
                      {mode === 'diff' && !diff.identical && (
                        <button
                          type="button"
                          className={'diff-filter-btn' + (changesOnly ? ' active' : '')}
                          onClick={() => setChangesOnly((v) => !v)}
                        >
                          {changesOnly ? t('history.showAll') : t('history.changesOnly')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => setConfirm(true)}
                      >
                        {t('history.restoreThis')}
                      </button>
                    </div>
                  </div>

                  {(selected.record.value.title || '') !== (record.value.title || '') && (
                    <div className="history-title-diff">
                      <span className="history-title-label">{t('history.titleChanged')}</span>
                      <span className="history-title-old">
                        {selected.record.value.title || t('notes.untitledNote')}
                      </span>
                      <span className="history-title-arrow">→</span>
                      <span className="history-title-new">
                        {record.value.title || t('notes.untitledNote')}
                      </span>
                    </div>
                  )}

                  {mode === 'raw' ? (
                    <div className="history-diff-scroll history-raw-paper">
                      <h4 className="history-raw-title">
                        {selected.record.value.title || t('notes.untitledNote')}
                      </h4>
                      <div className="history-raw-body">{selectedText || t('history.emptyBody')}</div>
                    </div>
                  ) : (
                    <>
                      {/* Wide screens: clean side-by-side notebook comparison */}
                      <div className="history-diff-scroll history-diff-split">
                        <div className="diff-col-head left">
                          {t('history.versionAt', { time: dateText(selected.createdAt, activeLocale) })}
                        </div>
                        <div className="diff-col-head">{t('history.currentVersion')}</div>
                        {splitItems.map((item) =>
                          item.kind === 'skip' ? (
                            <button
                              key={'skip-' + item.id}
                              type="button"
                              className="diff-skip-row"
                              onClick={() =>
                                setExpandedSkips((prev) => new Set(prev).add(item.id))
                              }
                            >
                              {t('history.expandUnchanged', { count: item.count })}
                            </button>
                          ) : (
                            <Fragment key={item.idx}>
                              <div
                                className={
                                  'diff-cell left ' +
                                  (item.row.left ? item.row.left.type : 'empty')
                                }
                              >
                                <span className="diff-no">{item.row.left?.no ?? ''}</span>
                                <span className="diff-sign">
                                  {item.row.left?.type === 'del' ? '−' : ''}
                                </span>
                                <span className="diff-text">
                                  {item.row.left ? renderDiffText(item.row.left) : ' '}
                                </span>
                              </div>
                              <div
                                className={
                                  'diff-cell ' + (item.row.right ? item.row.right.type : 'empty')
                                }
                              >
                                <span className="diff-no">{item.row.right?.no ?? ''}</span>
                                <span className="diff-sign">
                                  {item.row.right?.type === 'add' ? '+' : ''}
                                </span>
                                <span className="diff-text">
                                  {item.row.right ? renderDiffText(item.row.right) : ' '}
                                </span>
                              </div>
                            </Fragment>
                          ),
                        )}
                      </div>

                      {/* Narrow screens: Top (before) / Bottom (after) stacked panes */}
                      <div className="history-diff-stacked">
                        <div className="history-diff-pane">
                          <div className="diff-col-head">
                            {t('history.versionAt', { time: dateText(selected.createdAt, activeLocale) })}
                          </div>
                          <div className="history-diff-pane-list">
                            {splitItems
                              .flatMap((it) => (it.kind === 'row' ? [it.row] : it.rows.map((r) => r.row)))
                              .filter((r) => r.left && (!changesOnly || diff.identical || r.left.type !== 'same'))
                              .map((r, k) => (
                                <div key={'l-' + k} className={'diff-cell ' + r.left!.type}>
                                  <span className="diff-no">{r.left!.no}</span>
                                  <span className="diff-sign">
                                    {r.left!.type === 'del' ? '−' : ''}
                                  </span>
                                  <span className="diff-text">{renderDiffText(r.left!)}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                        <div className="history-diff-pane">
                          <div className="diff-col-head">{t('history.currentVersion')}</div>
                          <div className="history-diff-pane-list">
                            {splitItems
                              .flatMap((it) => (it.kind === 'row' ? [it.row] : it.rows.map((r) => r.row)))
                              .filter((r) => r.right && (!changesOnly || diff.identical || r.right.type !== 'same'))
                              .map((r, k) => (
                                <div key={'r-' + k} className={'diff-cell ' + r.right!.type}>
                                  <span className="diff-no">{r.right!.no}</span>
                                  <span className="diff-sign">
                                    {r.right!.type === 'add' ? '+' : ''}
                                  </span>
                                  <span className="diff-text">{renderDiffText(r.right!)}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      )}
      {confirm && (
        <Confirm
          title={t('history.confirmTitle')}
          text={t('history.confirmText')}
          action={t('history.confirmAction')}
          onConfirm={() => void restore()}
          onClose={() => setConfirm(false)}
        />
      )}
    </Modal>
  )
}

export function SharePanel({
  session,
  record,
  onClose,
  notify,
}: {
  session: Session | null
  record: LocalRecord
  onClose: () => void
  notify: (s: string) => void
}) {
  const { t, i18n: i18nInst } = useTranslation()
  const activeLocale = i18nInst.resolvedLanguage || i18nInst.language
  const [links, setLinks] = useState<{ token: string; createdAt: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revoke, setRevoke] = useState<string | null>(null)
  const base = session?.base || location.origin
  const refresh = useCallback(async () => {
    if (session)
      setLinks(
        await api<{ token: string; createdAt: string }[]>(session, '/api/shares/' + record.id),
      )
  }, [session, record.id])
  useEffect(() => {
    if (!session) return
    void refresh().catch((e) => setError(errorText(e)))
  }, [session, refresh])
  async function create() {
    if (!session) return
    setBusy(true)
    setError('')
    try {
      await api(session, '/api/shares/' + record.id, { method: 'POST' })
      await refresh()
      notify(t('share.createdNotify'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function remove(token: string) {
    if (!session) return
    setBusy(true)
    setError('')
    try {
      await api(session, '/api/shares/' + token, { method: 'DELETE' })
      await refresh()
      notify(t('share.revokedNotify'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function copy(token: string) {
    const url = base + '/s/' + token
    try {
      await navigator.clipboard.writeText(url)
      notify(t('share.copiedNotify'))
    } catch {
      setError(t('common.copyFailed'))
    }
  }
  return (
    <Modal title={t('share.title')} onClose={onClose}>
      {!session ? (
        <Empty
          icon={<Link size={28} />}
          title={t('share.requireAccountTitle')}
          text={t('share.requireAccountText')}
        />
      ) : (
        <div className="panel-stack">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="panel-group-head">
            <div className="panel-group-title">
              <h3>{t('share.publicLinksHeading')}</h3>
              <span className="count-pill">{links.length}</span>
            </div>
            <button
              type="button"
              className="primary panel-compact-btn"
              disabled={busy || record.dirty === 1}
              onClick={() => void create()}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}
              <span>{t('share.createLink')}</span>
            </button>
          </div>
          {record.dirty === 1 && <p className="panel-hint">{t('share.waitSyncHint')}</p>}
          {links.length > 0 ? (
            <div className="panel-card panel-list share-card-list">
              {links.map((item) => (
                <div className="share-card-item" key={item.token}>
                  <div className="share-card-meta">
                    <span>{dateText(item.createdAt, activeLocale)}</span>
                    <button
                      type="button"
                      className="panel-item-action danger"
                      disabled={busy}
                      onClick={() => setRevoke(item.token)}
                    >
                      <Trash2 size={14} />
                      <span>{t('share.revoke')}</span>
                    </button>
                  </div>
                  <div className="share-url-row">
                    <input
                      readOnly
                      value={base + '/s/' + item.token}
                      aria-label={t('share.linkAria')}
                      onFocus={(e) => e.target.select()}
                    />
                    <IconButton label={t('share.copyLink')} onClick={() => void copy(item.token)}>
                      <Copy size={16} />
                    </IconButton>
                    <a
                      className="icon-button"
                      href={base + '/s/' + item.token}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('share.openSharePage')}
                      title={t('share.openSharePage')}
                    >
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-empty-inline">{t('share.noLinks')}</div>
          )}
        </div>
      )}
      {revoke && (
        <Confirm
          title={t('share.revokeConfirmTitle')}
          text={t('share.revokeConfirmText')}
          action={t('share.revokeConfirmAction')}
          danger
          onConfirm={() => void remove(revoke)}
          onClose={() => setRevoke(null)}
        />
      )}
    </Modal>
  )
}
