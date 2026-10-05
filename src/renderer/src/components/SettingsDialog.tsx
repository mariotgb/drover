import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { RefreshCw } from 'lucide-react'
import type { AppSettings, ClaudeStatuslineState, HerdrSessionInfo } from '@shared/types'
import { api, isRemote } from '../api'
import { RemoteAccessSettings } from './RemoteAccessSettings'
import { PushSettings } from './PushSettings'
import { LANGUAGES, t, type LangSetting } from '../i18n'
import { toast, updateSettings, useStore } from '../store'
import { AppearanceSettingsPane } from './AppearanceSettings'
import { Modal } from './Modal'
import { Spinner } from './primitives'
import { RolesSettingsPane } from './RolesSettings'
import appIcon from '../assets/app-icon.png'
import { logoutRemote } from '../remote-session'
import { BossSettingsPane } from './BossDialogs'
import { CodexIntegrationWarning } from './CodexIntegrationWarning'

export function SettingsDialog({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab ?? 'general')
  const [signingOut, setSigningOut] = useState(false)
  const close = () => useStore.setState({ dialog: null })
  const tabs = [
    { id: 'general', label: t('General') },
    { id: 'appearance', label: t('Appearance') },
    { id: 'roles', label: t('Roles') },
    ...(!isRemote ? [{ id: 'boss', label: t('Main boss') }] : []),
    { id: 'notifications', label: t('Notifications') },
    ...(!isRemote ? [{ id: 'remote', label: t('Remote access') }, { id: 'herdr', label: 'herdr' }] : []),
    { id: 'integrations', label: t('Integrations') },
    { id: 'plugins', label: t('Plugins') },
    { id: 'about', label: t('About') }
  ].filter((x) => !isRemote || ['general', 'appearance', 'notifications'].includes(x.id))
  return (
    <Modal title={t('Settings')} onClose={close} width={780}>
      <div className="settings">
        <nav className="settings-nav">
          {tabs.map((x) => (
            <button key={x.id} type="button" className={clsx(tab === x.id && 'active')} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
          {isRemote && <button type="button" disabled={signingOut} onClick={async () => {
            setSigningOut(true)
            try { await logoutRemote() }
            catch (error) { toast('error', error instanceof Error ? error.message : t('Could not sign out. Try again.')); setSigningOut(false) }
          }}>{signingOut ? t('Signing out…') : t('Sign out')}</button>}
        </nav>
        <div className="settings-pane">
          {tab === 'remote' && <RemoteAccessSettings />}
          {tab === 'general' && <General />}
          {tab === 'appearance' && <AppearanceSettingsPane />}
          {tab === 'roles' && <RolesSettingsPane />}
          {tab === 'boss' && !isRemote && <BossSettingsPane />}
          {tab === 'notifications' && (isRemote ? <PushSettings /> : <Notifications />)}
          {tab === 'herdr' && <HerdrTab />}
          {tab === 'integrations' && <Integrations />}
          {tab === 'plugins' && <Plugins />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </Modal>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} className={clsx('toggle', value && 'on')} onClick={() => onChange(!value)}>
      <span />
    </button>
  )
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
        −
      </button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
        +
      </button>
    </div>
  )
}

function General() {
  const s = useStore((st) => st.settings)
  const set = (p: Partial<AppSettings>) => void updateSettings(p)
  return (
    <div className="settings-section">
      <Row label={t('Language')}>
        <select className="input select" value={s.language} onChange={(e) => set({ language: e.target.value as LangSetting })}>
          <option value="system">{t('System')}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('Send with Enter')} hint={t('When off, use ⌘Enter to send and Enter for a new line.')}>
        <Toggle value={s.sendWithEnter} onChange={(v) => set({ sendWithEnter: v })} />
      </Row>
      <Row label={t('Chat text size')}>
        <Stepper value={s.chatFontSize} min={12} max={20} onChange={(v) => set({ chatFontSize: v })} />
      </Row>
      <Row label={t('Terminal font size')}>
        <Stepper value={s.terminalFontSize} min={10} max={22} onChange={(v) => set({ terminalFontSize: v })} />
      </Row>
      <Row label={t('Show only the project lead')} hint={t('Other agents of a project fold into one row that opens on tap. Agents waiting for an answer stay in sight. Pick the lead in the agent menu.')}>
        <Toggle value={s.leadOnly} onChange={(v) => set({ leadOnly: v })} />
      </Row>
      <Row label={t('Sync focus with herdr')} hint={t('Selecting a thread focuses its pane in herdr and marks finished work as seen.')}>
        <Toggle value={s.syncFocus} onChange={(v) => set({ syncFocus: v })} />
      </Row>
      <Row label={t('Show plan usage limits')} hint={t('5-hour and weekly limits in the sidebar and composer. Read from local files only — the app never uses your tokens or calls any API.')}>
        <Toggle value={s.showLimits} onChange={(v) => set({ showLimits: v })} />
      </Row>
      {!isRemote && s.showLimits && <ClaudeLimitsRow />}
    </div>
  )
}

function ago(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return t('just now')
  if (sec < 3600) return t('{n} min ago', { n: Math.round(sec / 60) })
  if (sec < 86400) return t('{n} h ago', { n: Math.round(sec / 3600) })
  return t('{n} d ago', { n: Math.round(sec / 86400) })
}

export function ClaudeLimitsRow() {
  const [st, setSt] = useState<ClaudeStatuslineState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.claudeStatusline().then(setSt)
  }, [])
  const toggle = async (enable: boolean) => {
    setBusy(true)
    try {
      setSt(await api.setClaudeStatusline(enable))
      toast('success', enable ? t('Claude Code limits on — they appear after Claude’s next reply') : t('Claude Code status line removed'))
    } catch (e) {
      toast('error', (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const hint = st?.installed
    ? t('On. Claude Code passes the limits it receives with every reply to a local status-line script; the app reads them from ~/.drover.') +
      ' ' +
      (st.lastUpdate ? t('Last update {when}.', { when: ago(st.lastUpdate) }) : t('Waiting for the next Claude reply.'))
    : t('Adds a status line to Claude Code (statusLine in ~/.claude/settings.json, a backup is kept). Claude Code hands it the 5-hour and weekly limits it already gets with every reply. No network requests, no tokens — it is a standard Claude Code feature. Claude’s own status line will show “5h 42% · wk 6%”.')
  return (
    <>
      <Row label={t('Claude Code limits')} hint={hint}>
        {!st ? (
          <Spinner size={13} />
        ) : st.installed ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void toggle(false)}>
            {busy && <Spinner size={12} />} {t('Turn off')}
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !!st.error} onClick={() => void toggle(true)}>
            {busy && <Spinner size={12} />} {t('Turn on')}
          </button>
        )}
      </Row>
      {st?.otherCommand && !st.installed && (
        <div className="setting-hint block">{t('Your current Claude status line ({command}) keeps working — it is chained behind the script.', { command: st.otherCommand })}</div>
      )}
      {st?.error && <div className="form-error">{st.error}</div>}
    </>
  )
}

function Notifications() {
  const s = useStore((st) => st.settings)
  return (
    <div className="settings-section">
      <Row label={t('Desktop notifications')} hint={t('When an agent finishes or needs your input while you look elsewhere.')}>
        <Toggle value={s.notifications} onChange={(v) => void updateSettings({ notifications: v })} />
      </Row>
      <Row label={t('Play sound')}>
        <Toggle value={s.notificationSound} onChange={(v) => void updateSettings({ notificationSound: v })} />
      </Row>
    </div>
  )
}

function HerdrTab() {
  const s = useStore((st) => st.settings)
  const connection = useStore((st) => st.connection)
  const snapshot = useStore((st) => st.snapshot)
  const [sessions, setSessions] = useState<HerdrSessionInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => void api.sessions().then(setSessions)
  useEffect(load, [])
  return (
    <div className="settings-section">
      {!isRemote && <CodexIntegrationWarning />}
      <Row label={t('Connection')} hint={connection.socketPath}>
        <span className={clsx('conn-text', connection.status === 'connected' ? 'ok' : 'bad')}>
          {connection.status === 'connected' ? t('Connected · herdr {version}', { version: snapshot?.version ?? connection.version ?? '' }) : connection.status}
        </span>
      </Row>
      {connection.herdrPath && (
        <Row label={t('herdr binary')}>
          <code className="path">{connection.herdrPath}</code>
        </Row>
      )}
      <Row label={t('Start server automatically')} hint={t('If no herdr server is running, start one in the background. Agents keep running after you quit the app.')}>
        <Toggle value={s.autoStartServer} onChange={(v) => void updateSettings({ autoStartServer: v })} />
      </Row>
      <Row
        label={t('Stop herdr when quitting Drover')}
        hint={t('Quitting Drover (⌘Q) also stops the herdr server and every agent of this session. If agents are still working, Drover asks first. Off: agents keep running and Drover picks them up when it opens again.')}
      >
        <Toggle value={s.stopServerOnQuit} onChange={(v) => void updateSettings({ stopServerOnQuit: v })} />
      </Row>
      <div className="setting-block">
        <div className="setting-block-head">
          <span>{t('Sessions')}</span>
          <button type="button" className="icon-btn icon-btn-sm" title={t('Refresh')} onClick={load}>
            <RefreshCw size={13} />
          </button>
        </div>
        {!sessions && <Spinner />}
        {sessions?.map((x) => (
          <div key={x.name} className={clsx('session-row', s.session === x.name && 'active')}>
            <span className={clsx('conn-dot', x.running ? 'ok' : 'bad')} />
            <span className="session-name">{x.name}</span>
            <span className="session-state">{x.running ? t('running') : t('stopped')}</span>
            {s.session === x.name ? (
              <span className="session-current">{t('current')}</span>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void updateSettings({ session: x.name })}>
                {t('Switch')}
              </button>
            )}
          </div>
        ))}
      </div>
      {connection.status !== 'connected' && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const ok = await api.startServer()
            setBusy(false)
            toast(ok ? 'success' : 'error', ok ? t('herdr server started') : t('Could not start the herdr server'))
            load()
          }}
        >
          {busy && <Spinner size={13} />} {t('Start herdr server')}
        </button>
      )}
    </div>
  )
}

interface IntegrationRow {
  name: string
  status: string
  installed: boolean
  outdated: boolean
}

function parseIntegrations(out: string): IntegrationRow[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([\w-]+)(?:\s*\([^)]*\))?:\s*(.+?)(?:\s+\(\/.*\))?$/)
      if (!m) return null
      const status = m[2]
      return { name: m[1], status, installed: !/not installed/i.test(status), outdated: /outdated|update/i.test(status) }
    })
    .filter((x): x is IntegrationRow => !!x)
}

function Integrations() {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => void api.cli(['integration', 'status']).then((r) => setRows(parseIntegrations(r.stdout)))
  useEffect(load, [])
  return (
    <div className="settings-section">
      <p className="setting-hint block">
        {t('Integrations let herdr know exactly what each agent is doing (working, waiting for approval, done) and which conversation it is in — this powers the chat view and notifications.')}
      </p>
      {!rows && <Spinner />}
      {rows?.map((r) => (
        <div key={r.name} className="session-row">
          <span className={clsx('conn-dot', r.installed ? (r.outdated ? 'wait' : 'ok') : 'off')} />
          <span className="session-name">{r.name}</span>
          <span className="session-state">{r.status}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(r.name)
              const res = await api.cli(['integration', r.installed && !r.outdated ? 'uninstall' : 'install', r.name])
              setBusy(null)
              toast(res.code === 0 ? 'success' : 'error', res.code === 0 ? t('{name}: done', { name: r.name }) : res.stderr || res.stdout || t('failed'))
              load()
            }}
          >
            {busy === r.name ? <Spinner size={12} /> : null}
            {r.installed ? (r.outdated ? t('Update') : t('Uninstall')) : t('Install')}
          </button>
        </div>
      ))}
    </div>
  )
}

interface PluginInfo {
  plugin_id: string
  name?: string
  enabled?: boolean
  version?: string
  description?: string
}

function Plugins() {
  const [list, setList] = useState<PluginInfo[] | null>(null)
  const load = () =>
    void api.cli(['plugin', 'list', '--json']).then((r) => {
      try {
        const j = JSON.parse(r.stdout)
        const arr = (j.result?.plugins ?? j.plugins ?? j) as PluginInfo[]
        setList(Array.isArray(arr) ? arr : [])
      } catch {
        setList([])
      }
    })
  useEffect(load, [])
  return (
    <div className="settings-section">
      {!list && <Spinner />}
      {list && !list.length && <p className="setting-hint block">{t('No plugins installed. Install with `herdr plugin install owner/repo`.')}</p>}
      {list?.map((p) => (
        <Row key={p.plugin_id} label={p.name || p.plugin_id} hint={[p.version, p.description].filter(Boolean).join(' · ')}>
          <Toggle
            value={!!p.enabled}
            onChange={async (v) => {
              const r = await api.cli(['plugin', v ? 'enable' : 'disable', p.plugin_id])
              if (r.code !== 0) toast('error', r.stderr || t('failed'))
              load()
            }}
          />
        </Row>
      ))}
    </div>
  )
}

function About() {
  const appVersion = useStore((s) => s.appVersion)
  const snapshot = useStore((s) => s.snapshot)
  return (
    <div className="settings-section about">
      <img className="about-icon" src={appIcon} alt="" draggable={false} />
      <div className="about-name">Drover</div>
      <div className="setting-hint">
        {t('Drives your herd of coding agents.')} {t('Version {version}', { version: appVersion })}
      </div>
      <p className="setting-hint block">
        {t('A desktop client for herdr. It drives the herdr server over its socket API and streams agent terminals through `herdr terminal session control`. Conversations are read from Claude Code and Codex session files.')}
      </p>
      <div className="setting-hint">
        {t('herdr server {version} · protocol {protocol}', { version: snapshot?.version ?? '—', protocol: snapshot?.protocol ?? '—' })}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => void api.openExternal('https://herdr.dev')}>
        herdr.dev
      </button>
    </div>
  )
}
