import { Capacitor } from '@capacitor/core'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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
}
type UserEdit = { id: string; username: string; password: string; quota: string; disabled: boolean; admin: boolean }
type SettingsTab = 'appearance' | 'account' | 'admin'
const settingsTabs = [
  { value: 'appearance', label: '外观', icon: <Palette size={16} /> },
  { value: 'account', label: '账号与同步', icon: <Cloud size={16} /> },
  { value: 'admin', label: '用户管理', icon: <Shield size={16} /> },
] as const
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请稍后重试')
const maskKeyPrefix = (s: string) => s.slice(0, 6) + '••••'
const dateText = (s: string) =>
  new Date(s).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
const isMobileDevice = (name: string) => /安卓|手机|平板|android|iphone|ipad|mobile|tablet/i.test(name)
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
}: SettingsProps) {
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
        (!Capacitor.isNativePlatform() && location.protocol.startsWith('http') ? location.origin : ''),
    ),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [device, setDevice] = useState(
      /Android/i.test(navigator.userAgent) ? '我的安卓设备' : '我的电脑',
    )
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
        .map((f) => ({ id: f.id, name: f.value.name || '未命名文件夹' })),
    )
    if (session.user.admin) setUsers(await api<User[]>(session, '/api/admin/users'))
  }, [session, db])
  useEffect(() => {
    if (session) void task(refresh)
  }, [session, task, refresh])
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
      const res = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, device }),
        signal: AbortSignal.timeout(30000),
      })
      const result = await res.json()
      if (!res.ok) throw Error(result.error || '连接失败，请检查地址和账号')
      const next: Session = { base, token: result.token, user: result.user }
      setPassword('')
      await finishConnection(next, '已连接 ' + result.user.username + '，正在同步')
    })
  }
  function logout() {
    setConfirm({
      title: '切换到本机空间',
      text: '此账号的本地记录会保留在这台设备，重新连接同一账号即可继续访问。',
      action: '切换',
      run: () => void task(() => finishConnection(null, '已切换到本机空间')),
    })
  }
  function revoke(d: Device) {
    setConfirm({
      title: '退出设备',
      text: '将撤销「' + d.name + '」的登录令牌。该设备下次同步时需要重新登录。',
      action: '退出设备',
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/devices/' + d.id, { method: 'DELETE' })
          if (d.current) {
            await finishConnection(null, '当前设备已退出')
          } else {
            await refresh()
            notify('已退出 ' + d.name)
          }
        }),
    })
  }
  async function createUser(e: FormEvent) {
    e.preventDefault()
    await task(async () => {
      const quota = Number(newQuota)
      if (!Number.isFinite(quota) || quota <= 0) throw Error('请输入有效配额')
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
      notify('账号已创建')
    })
  }
  async function updateUser(e: FormEvent) {
    e.preventDefault()
    if (!edit) return
    await task(async () => {
      const quota = Number(edit.quota)
      if (!Number.isFinite(quota) || quota <= 0) throw Error('请输入有效配额')
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
      notify(payload.password ? '设置已保存，旧设备已退出' : '设置已保存')
    })
  }
  function deleteUser(u: Pick<User, 'id' | 'username'>) {
    setConfirm({
      title: '删除账号',
      text: `将永久删除账号「${u.username}」及其全部备忘、待办、历史版本、分享链接与附件，此操作无法撤销。`,
      action: '永久删除',
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/admin/users/' + u.id, { method: 'DELETE' })
          if (edit?.id === u.id) {
            modal.current?.captureHeight()
            setEdit(null)
          }
          await refresh()
          notify('已删除账号 ' + u.username)
        }),
    })
  }

  async function createApiKey(e: FormEvent) {
    e.preventDefault()
    if (!keyScopes.length) {
      setError('请至少选择一项权限')
      return
    }
    await task(async () => {
      const res = await api<{ key: string; item: ApiKeyInfo }>(session!, '/api/keys', {
        method: 'POST',
        body: JSON.stringify({
          name: keyName.trim() || 'AI 助手',
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
      notify('AI 密钥已生成，请及时保存')
    })
  }
  function revokeApiKey(k: ApiKeyInfo) {
    setConfirm({
      title: '吊销 AI 密钥',
      text: '吊销「' + k.name + '」后，使用该密钥的 AI 客户端或定时任务将立刻失去访问权限。',
      action: '吊销密钥',
      danger: true,
      run: () =>
        void task(async () => {
          await api(session!, '/api/keys/' + k.id, { method: 'DELETE' })
          await refresh()
          notify('已吊销密钥 ' + k.name)
        }),
    })
  }
  async function copyText(text: string, msg: string) {
    try {
      await navigator.clipboard.writeText(text)
      notify(msg)
    } catch {
      notify('请手动复制内容')
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
      title="设置"
      onClose={onClose}
      wide
      layoutKey={`${tab}:${edit?.id || ''}:${creating}:${creatingKey}:${revealedKey ? 1 : 0}`}
    >
      <SegmentedControl
        label="设置分类"
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
                  <legend>外观主题</legend>
                  <div className="theme-choices">
                    {([
                      ['system', '跟随系统', Monitor],
                      ['light', '浅色', Sun],
                      ['dark', '深色', Moon],
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
                  <span className="panel-row-label">主题色</span>
                  <div className="accent-dots">
                    {[
                      ['#e5bd42', '日光黄'],
                      ['#79b8d2', '晴空蓝'],
                      ['#8bbd9b', '松石绿'],
                      ['#b3a1df', '雾紫'],
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
                  <span className="panel-row-label">界面动效</span>
                  <input
                    className="pill-switch"
                    type="checkbox"
                    checked={motion}
                    onChange={(e) => setMotion(e.target.checked)}
                  />
                </label>
              </div>
              <div className="version-label">便签 · v0.9.0</div>
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
                          {me?.admin && <span className="status-pill">管理员</span>}
                        </div>
                        <p className="account-host">{hostLabel(session.base || location.origin)}</p>
                      </div>
                      <IconButton
                        className="panel-refresh"
                        label="刷新账号信息"
                        disabled={busy}
                        onClick={() => void task(refresh)}
                      >
                        <RefreshCw className={busy ? 'spin' : ''} size={17} />
                      </IconButton>
                    </div>

                    <div className="panel-divider" />

                    <div className="storage-meter">
                      <div className="storage-meter-head">
                        <span>附件空间</span>
                        <span className="storage-value">
                          {formatBytes(me?.used || 0)} / {formatBytes(me?.quota || 0)}
                        </span>
                      </div>
                      <div
                        className="meter-track"
                        role="progressbar"
                        aria-label="已用存储空间"
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
                            title: '导入本机记录',
                            text: '把本机空间中的备忘、待办、文件夹和附件合并到当前账号，随后自动同步。',
                            action: '确认导入',
                            run: () =>
                              void task(async () => {
                                const n = await migrateLocal(db)
                                notify('已导入 ' + n + ' 条记录，稍后自动同步')
                              }),
                          })
                        }
                      >
                        <Import size={16} />
                        <span>导入本机记录</span>
                      </button>
                      <button type="button" className="secondary" onClick={logout}>
                        <LogOut size={16} />
                        <span>切换本机空间</span>
                      </button>
                    </div>
                  </div>

                  <div className="panel-group">
                    <div className="panel-group-head">
                      <h3>登录设备</h3>
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
                                {d.current && <span className="status-pill">当前</span>}
                              </div>
                              <p className="panel-item-sub">最近活动 · {dateText(d.lastSeen)}</p>
                            </div>
                            <button
                              type="button"
                              className="panel-item-action danger"
                              disabled={busy}
                              onClick={() => revoke(d)}
                            >
                              退出
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="panel-group">
                    <div className="panel-group-head">
                      <h3>AI 接入与密钥</h3>
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
                        <span>{creatingKey ? '收起' : '新建密钥'}</span>
                      </button>
                    </div>

                    <div className="panel-card mcp-endpoint-card">
                      <div className="mcp-endpoint-copy">
                        <span className="mcp-endpoint-label">MCP 远程地址</span>
                        <code className="mcp-endpoint-url">{mcpUrl}</code>
                      </div>
                      <button
                        type="button"
                        className="secondary mcp-copy-btn"
                        onClick={() => void copyText(mcpUrl, '已复制 MCP 地址')}
                      >
                        <Copy size={14} />
                        <span>复制</span>
                      </button>
                    </div>

                    {revealedKey && (
                      <div className="panel-card key-reveal-card">
                        <div className="key-reveal-head">
                          <strong>密钥「{revealedKey.name}」已生成</strong>
                          <span className="status-pill">仅展示一次</span>
                        </div>
                        <div className="key-reveal-row">
                          <code className="key-reveal-value">
                            {showFullKey ? revealedKey.key : maskKeyPrefix(revealedKey.key) + '••••••••'}
                          </code>
                          <IconButton
                            label={showFullKey ? '隐藏完整密钥' : '显示完整密钥'}
                            onClick={() => setShowFullKey((v) => !v)}
                          >
                            {showFullKey ? <EyeOff size={16} /> : <Eye size={16} />}
                          </IconButton>
                        </div>
                        <p className="key-reveal-hint">
                          请立即复制保存。在 Cherry Studio、Antigravity、Codex 或 RikkaHub 中添加远程 MCP（Streamable HTTP），填入上方地址与 Bearer 密钥即可直连。
                        </p>
                        <div className="panel-action-grid">
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void copyText(revealedKey.key, '已复制密钥')}
                          >
                            <Copy size={15} />
                            <span>复制密钥</span>
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
                                '已复制 MCP 配置 JSON',
                              )
                            }
                          >
                            <Copy size={15} />
                            <span>复制 MCP 配置</span>
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
                          我已保存，收起密钥
                        </button>
                      </div>
                    )}

                    {creatingKey && (
                      <form className="panel-card form-card" onSubmit={createApiKey}>
                        <label className="form-field">
                          密钥名称
                          <input
                            required
                            maxLength={64}
                            value={keyName}
                            onChange={(e) => setKeyName(e.target.value)}
                            placeholder="例如：Cherry Studio / RikkaHub / Codex"
                          />
                        </label>
                        <div className="form-field">
                          <span>允许权限</span>
                          <div className="chip-row">
                            {([
                              ['read', '读取笔记与待办'],
                              ['write', '新建与编辑笔记'],
                              ['todo', '管理待办'],
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
                            <span>可访问文件夹（不选则开放全部）</span>
                            <div className="chip-row">
                              <button
                                type="button"
                                className={
                                  'chip-toggle' + (keyFolders.length === 0 ? ' selected' : '')
                                }
                                onClick={() => setKeyFolders([])}
                              >
                                全部文件夹
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
                        <p className="key-safety-note">
                          安全隔离：密钥无法管理账号、设备或物理粉碎笔记，删除的内容会保留在「最近删除」30 天。
                        </p>
                        <div className="panel-action-grid">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              modal.current?.captureHeight()
                              setCreatingKey(false)
                            }}
                          >
                            取消
                          </button>
                          <button type="submit" className="primary" disabled={busy}>
                            生成密钥
                          </button>
                        </div>
                      </form>
                    )}

                    <div className="panel-card panel-list">
                      {keys.length === 0 ? (
                        <div className="panel-empty-row">
                          暂无 AI 密钥。点击右上角「新建密钥」，即可让 Cherry Studio、Antigravity、Codex、RikkaHub 安全读写你的备忘与待办。
                        </div>
                      ) : (
                        keys.map((k) => {
                          const scopeLabels = k.scopes
                            .map((s) => (s === 'read' ? '读' : s === 'write' ? '写' : '待办'))
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
                                      限 {k.folderIds.length} 个文件夹
                                    </span>
                                  )}
                                </div>
                                <p className="panel-item-sub">
                                  {maskKeyPrefix(k.prefix)} ·{' '}
                                  {k.lastUsedAt
                                    ? '最近调用 ' + dateText(k.lastUsedAt)
                                    : '尚未调用'}
                                </p>
                              </div>
                              <button
                                type="button"
                                className="panel-item-action danger"
                                disabled={busy}
                                onClick={() => revokeApiKey(k)}
                              >
                                吊销
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
                  <label className="form-field">
                    服务器地址
                    <input
                      type="url"
                      value={server}
                      onChange={(e) => setServer(e.target.value)}
                      placeholder="https://notes.example.com"
                      required={Capacitor.isNativePlatform()}
                      autoComplete="url"
                    />
                  </label>
                  <div className="form-grid-2">
                    <label className="form-field">
                      账号
                      <input
                        required
                        minLength={2}
                        maxLength={64}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        placeholder="用户名"
                      />
                    </label>
                    <label className="form-field">
                      设备名称
                      <input
                        required
                        maxLength={100}
                        value={device}
                        onChange={(e) => setDevice(e.target.value)}
                        placeholder="我的设备"
                      />
                    </label>
                  </div>
                  <label className="form-field">
                    密码
                    <input
                      required
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      placeholder="输入密码"
                    />
                  </label>
                  <button className="primary full-width" disabled={busy} type="submit">
                    {busy ? (
                      <>
                        <LoaderCircle size={17} className="spin" />
                        正在连接…
                      </>
                    ) : (
                      '连接账号'
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
                    <h4>编辑 · {edit.username}</h4>
                    <button
                      className="panel-item-action"
                      type="button"
                      onClick={() => {
                        modal.current?.captureHeight()
                        setEdit(null)
                      }}
                    >
                      返回列表
                    </button>
                  </div>
                  <div className="form-grid-2">
                    <label className="form-field">
                      存储配额（GB）
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
                      重置密码
                      <input
                        type="password"
                        minLength={12}
                        maxLength={256}
                        value={edit.password}
                        onChange={(e) => setEdit({ ...edit, password: e.target.value })}
                        autoComplete="new-password"
                        placeholder="留空不改 · 改后全端重登"
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
                      <span>停用账号</span>
                    </label>
                    <div className="panel-item-actions">
                      {!edit.admin && edit.id !== session.user.id && (
                        <button
                          className="secondary text-danger"
                          disabled={busy}
                          type="button"
                          onClick={() => deleteUser(edit)}
                        >
                          删除账号
                        </button>
                      )}
                      <button className="primary" disabled={busy} type="submit">
                        保存设置
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <div className="panel-group">
                  <div className="panel-group-head">
                    <div className="panel-group-title">
                      <h3>账号列表</h3>
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
                      <span>{creating ? '收起' : '新建账号'}</span>
                    </button>
                  </div>

                  {creating && (
                    <form className="panel-card form-card" onSubmit={createUser}>
                      <div className="panel-card-head">
                        <h4 className="panel-card-title-icon">
                          <UserPlus size={16} />
                          <span>开通新账号</span>
                        </h4>
                      </div>
                      <div className="form-grid-2">
                        <label className="form-field">
                          用户名
                          <input
                            required
                            minLength={2}
                            maxLength={64}
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            autoComplete="off"
                            placeholder="输入用户名"
                          />
                        </label>
                        <label className="form-field">
                          存储配额（GB）
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
                        初始密码
                        <input
                          required
                          type="password"
                          minLength={12}
                          maxLength={256}
                          value={newPass}
                          onChange={(e) => setNewPass(e.target.value)}
                          autoComplete="new-password"
                          placeholder="至少 12 位"
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
                          取消
                        </button>
                        <button className="primary" disabled={busy} type="submit">
                          创建账号
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
                            {u.admin && <span className="status-pill">管理员</span>}
                            {u.disabled && <span className="status-pill danger">已停用</span>}
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
                            编辑
                          </button>
                          {!u.admin && u.id !== session.user.id && (
                            <button
                              type="button"
                              className="panel-item-action danger"
                              disabled={busy}
                              onClick={() => deleteUser(u)}
                            >
                              删除
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
      if (current?.dirty) throw Error('请先等待当前更改同步完成')
      const v = selected.record.value
      await save(db, record.id, 'note', {
        title: v.title || '',
        content: v.content,
        plainText: v.plainText || docText(v.content || { type: 'doc' }),
      })
      notify('已恢复历史版本')
      onRestored()
      modal.current?.dismiss()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal ref={modal} title="历史版本" onClose={onClose} wide className="history-modal">
      {!session ? (
        <Empty
          icon={<HardDrive size={28} />}
          title="需连接账号"
          text="登录服务器后自动记录历史版本"
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
              <span>正在读取历史版本…</span>
            </div>
          ) : !entries.length && !error ? (
            <Empty icon={<History size={28} />} title="暂无历史版本" text="" />
          ) : (
            <div className="history-layout">
              <aside className="history-sidebar panel-card">
                <div className="history-sidebar-head">
                  <span>版本记录</span>
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
                        <strong>{dateText(entry.createdAt)}</strong>
                        {i === 0 && <span className="status-pill">最新</span>}
                      </span>
                      <small>{entry.record.value.title || '未命名备忘'}</small>
                    </button>
                  ))}
                </div>
              </aside>
              {selected && diff && (
                <section className="history-preview panel-card">
                  <div className="history-preview-head">
                    <div className="history-head-left">
                      <h3>{dateText(selected.createdAt)}</h3>
                      <span className="diff-stat">
                        {diff.identical ? (
                          <span className="same">正文与当前一致</span>
                        ) : (
                          <>
                            <span className="add">+{diff.added}</span>
                            <span className="del">-{diff.removed}</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="history-head-actions">
                      <div className="diff-mode-pills" role="tablist" aria-label="视图切换">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'diff'}
                          className={'diff-mode-btn' + (mode === 'diff' ? ' active' : '')}
                          onClick={() => setMode('diff')}
                        >
                          对比
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'raw'}
                          className={'diff-mode-btn' + (mode === 'raw' ? ' active' : '')}
                          onClick={() => setMode('raw')}
                        >
                          原文
                        </button>
                      </div>
                      {mode === 'diff' && !diff.identical && (
                        <button
                          type="button"
                          className={'diff-filter-btn' + (changesOnly ? ' active' : '')}
                          onClick={() => setChangesOnly((v) => !v)}
                        >
                          {changesOnly ? '显示全文' : '仅看改动'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => setConfirm(true)}
                      >
                        恢复此版本
                      </button>
                    </div>
                  </div>

                  {(selected.record.value.title || '') !== (record.value.title || '') && (
                    <div className="history-title-diff">
                      <span className="history-title-label">标题变更</span>
                      <span className="history-title-old">
                        {selected.record.value.title || '未命名备忘'}
                      </span>
                      <span className="history-title-arrow">→</span>
                      <span className="history-title-new">
                        {record.value.title || '未命名备忘'}
                      </span>
                    </div>
                  )}

                  {mode === 'raw' ? (
                    <div className="history-diff-scroll history-raw-paper">
                      <h4 className="history-raw-title">
                        {selected.record.value.title || '未命名备忘'}
                      </h4>
                      <div className="history-raw-body">{selectedText || '无正文内容'}</div>
                    </div>
                  ) : (
                    <>
                      {/* Wide screens: clean side-by-side notebook comparison */}
                      <div className="history-diff-scroll history-diff-split">
                        <div className="diff-col-head left">
                          历史版本 · {dateText(selected.createdAt)}
                        </div>
                        <div className="diff-col-head">当前版本</div>
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
                              展开中间 {item.count} 行未改动内容
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
                            历史版本 · {dateText(selected.createdAt)}
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
                          <div className="diff-col-head">当前版本</div>
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
          title="恢复历史版本"
          text="将替换为所选版本的标题与正文，文件夹和收藏状态保持不变。"
          action="恢复"
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
      notify('公开链接已创建')
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
      notify('链接已撤销')
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
      notify('分享链接已复制')
    } catch {
      setError('复制失败，请手动选中复制')
    }
  }
  return (
    <Modal title="分享备忘" onClose={onClose}>
      {!session ? (
        <Empty
          icon={<Link size={28} />}
          title="需连接账号"
          text="登录后可创建只读分享链接"
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
              <h3>公开链接</h3>
              <span className="count-pill">{links.length}</span>
            </div>
            <button
              type="button"
              className="primary panel-compact-btn"
              disabled={busy || record.dirty === 1}
              onClick={() => void create()}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Link size={15} />}
              <span>创建链接</span>
            </button>
          </div>
          {record.dirty === 1 && <p className="panel-hint">等待同步完成后可创建链接</p>}
          {links.length > 0 ? (
            <div className="panel-card panel-list share-card-list">
              {links.map((item) => (
                <div className="share-card-item" key={item.token}>
                  <div className="share-card-meta">
                    <span>{dateText(item.createdAt)}</span>
                    <button
                      type="button"
                      className="panel-item-action danger"
                      disabled={busy}
                      onClick={() => setRevoke(item.token)}
                    >
                      <Trash2 size={14} />
                      <span>撤销</span>
                    </button>
                  </div>
                  <div className="share-url-row">
                    <input
                      readOnly
                      value={base + '/s/' + item.token}
                      aria-label="公开分享链接"
                      onFocus={(e) => e.target.select()}
                    />
                    <IconButton label="复制链接" onClick={() => void copy(item.token)}>
                      <Copy size={16} />
                    </IconButton>
                    <a
                      className="icon-button"
                      href={base + '/s/' + item.token}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="打开分享页面"
                      title="打开分享页面"
                    >
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-empty-inline">暂无公开链接</div>
          )}
        </div>
      )}
      {revoke && (
        <Confirm
          title="撤销分享链接"
          text="撤销后，该链接将立即失效。"
          action="撤销"
          danger
          onConfirm={() => void remove(revoke)}
          onClose={() => setRevoke(null)}
        />
      )}
    </Modal>
  )
}
