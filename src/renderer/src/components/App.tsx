import { lazy, Suspense, useEffect, useState } from 'react'
import clsx from 'clsx'
import { Bot, FolderOpen, PanelLeftOpen, Play, RotateCw, X } from 'lucide-react'
import { api } from '../api'
import { agentKindDef } from '@shared/agents'
import { t } from '../i18n'
import { isSidebarNavigation } from '../office/navigation'
import { interrupt, newTerminalTab, openNewAgent, openSettings } from '../actions'
import {
  dismissToast,
  getModel,
  nextAttention,
  orderedThreads,
  select,
  selectedThread,
  setViewMode,
  stepThread,
  toast,
  toggleDrawer,
  togglePreview,
  updateSettings,
  useModel,
  useSelectedThread,
  useWorkspace,
  useStore,
  viewModeFor
} from '../store'
import { CommandPalette } from './CommandPalette'
import { MenuHost } from './Menu'
import { ConfirmDialog, PromptDialog } from './Modal'
import { NewAgentDialog } from './NewAgentDialog'
import { IconButton, Spinner } from './primitives'
import { SettingsDialog } from './SettingsDialog'
import { Sidebar } from './Sidebar'
import { ThreadView } from './ThreadView'
import { PreviewPanel } from './PreviewPanel'
import { TaskBoardView } from './TaskBoardView'
import { BroadcastDialog, TeamDialog } from './TeamDialogs'
import appIcon from '../assets/app-icon.png'
import { MobileAgentList, MobileBack } from './MobileNavigation'
import { useMobile, useMobileWeb } from '../mobile'
import { MobileWebApp } from './MobileWeb'
import { AppBackground } from './Backdrop'

const OfficeView = lazy(() => import('../office/OfficeView').then(m => ({ default: m.OfficeView })))

function handleCommand(cmd: string) {
  const t = selectedThread()
  switch (cmd) {
    case 'new-agent':
      openNewAgent({})
      break
    case 'new-workspace':
      openNewAgent({ workspaceId: null, pickFolder: true })
      break
    case 'new-terminal':
      void newTerminalTab(t?.workspaceId ?? getModel().groups[0]?.workspace.workspace_id ?? null, t?.cwd)
      break
    case 'settings':
      openSettings()
      break
    case 'command-palette':
      useStore.setState((s) => ({ paletteOpen: !s.paletteOpen }))
      break
    case 'toggle-sidebar':
      useStore.setState((s) => ({ sidebarHidden: !s.sidebarHidden }))
      break
    case 'toggle-terminal':
      if (t) {
        if (viewModeFor(t.paneId) === 'terminal') setViewMode(t.paneId, 'chat')
        else toggleDrawer(t.paneId)
      }
      break
    case 'toggle-view':
      if (t) setViewMode(t.paneId, viewModeFor(t.paneId) === 'chat' ? 'terminal' : 'chat')
      break
    case 'interrupt':
      void interrupt(t)
      break
    case 'toggle-preview':
      if (t) togglePreview(t.workspaceId)
      break
    case 'pick-element':
      if (t) {
        if (!useStore.getState().previewOpen[t.workspaceId]) togglePreview(t.workspaceId, true)
        setTimeout(() => window.dispatchEvent(new Event('preview:pick-toggle')), 50)
      }
      break
    case 'attach':
      window.dispatchEvent(new Event('composer:attach'))
      break
    case 'next-thread':
      stepThread(1)
      break
    case 'prev-thread':
      stepThread(-1)
      break
    case 'next-attention':
      nextAttention()
      break
    default: {
      const m = cmd.match(/^thread-(\d)$/)
      if (m) {
        const list = orderedThreads()
        const target = list[Number(m[1]) - 1]
        if (target) select(target.paneId)
      }
    }
  }
}

export function App() {
  const [officeAllowed, setOfficeAllowed] = useState(false)
  const [officeOpen, setOfficeOpen] = useState(false)
  const [officeVisited, setOfficeVisited] = useState(false)
  const mobile = useMobile()
  const mobileWeb = useMobileWeb()
  const mobileScreen = useStore((s) => s.mobileScreen)
  const ready = useStore((s) => s.ready)
  const sidebarHidden = useStore((s) => s.sidebarHidden)
  const dialog = useStore((s) => s.dialog)
  const hasBg = useStore((s) => s.settings.appearance.background.kind !== 'none')
  const lang = useStore((s) => s.settings.language)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const connection = useStore((s) => s.connection)
  const thread = useSelectedThread()
  const boardWorkspace = useStore((s) => s.boardWorkspace)
  const boardGroup = useWorkspace(boardWorkspace)
  const previewOpen = useStore((s) => (thread ? !!s.previewOpen[thread.workspaceId] : false))
  const previewGroup = useWorkspace(previewOpen && thread ? thread.workspaceId : null)

  useEffect(() => api.on.command(handleCommand), [])
  useEffect(() => {
    if (window.droverRemote) return
    let cancelled = false
    void api.init().then(info => { if (!cancelled) setOfficeAllowed(info.platform === 'darwin') }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])
  useEffect(() => useStore.subscribe((next, previous) => {
    if (next.selectedPaneId !== previous.selectedPaneId || next.boardWorkspace !== previous.boardWorkspace) setOfficeOpen(false)
  }), [])
  useEffect(() => api.on.selectPane(() => setOfficeOpen(false)), [])

  const showOffice = officeAllowed && !window.droverRemote && !mobile && officeOpen
  const openOfficePane = (paneId: string, mode?: 'chat' | 'terminal') => {
    const target = getModel().byPane.get(paneId)
    if (!target) return
    select(paneId)
    setViewMode(paneId, mode ?? (agentKindDef(target.kind)?.transcript ? 'chat' : 'terminal'))
    setOfficeOpen(false)
  }

  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={18} />
      </div>
    )
  }

  const connected = connection.status === 'connected'
  return (
    <div key={lang} className={clsx('app', sidebarHidden && 'sidebar-hidden', hasBg && 'has-bg')} onClickCapture={e => { if (isSidebarNavigation(e.target)) setOfficeOpen(false) }} onKeyDownCapture={e => { if (isSidebarNavigation(e.target, e.key)) setOfficeOpen(false) }}>
      <AppBackground />
      {!mobile && !sidebarHidden && <Sidebar />}
      <main className="main">
        {officeAllowed && !window.droverRemote && !mobile && <nav className="office-tabs no-drag" aria-label={t('Views')}>
          <button type="button" className="btn btn-sm" aria-pressed={!showOffice} onClick={() => setOfficeOpen(false)}>{t('Chats')}</button>
          <button type="button" className="btn btn-sm" aria-pressed={showOffice} onClick={() => { setOfficeVisited(true); setOfficeOpen(true) }}>{t('Shared office')}</button>
        </nav>}
        {officeAllowed && !window.droverRemote && !mobile && officeVisited && <Suspense fallback={showOffice ? <Spinner size={18} /> : null}>
          <OfficeView key={connection.session} active={showOffice} onOpen={openOfficePane} />
        </Suspense>}
        {showOffice ? null : mobileWeb ? <MobileWebApp offline={connected ? null : <ConnectionScreen />} /> : mobile && mobileScreen === 'list' ? (
          <MobileAgentList />
        ) : !connected ? (
          <ConnectionScreen />
        ) : boardGroup ? (
          <>
            {mobile && <MobileBack />}
            <TaskBoardView key={boardGroup.workspace.workspace_id} group={boardGroup} />
          </>
        ) : thread ? (
          <ThreadView key={thread.paneId} thread={thread} />
        ) : (
          mobile ? <MobileAgentList /> : <Welcome />
        )}
      </main>
      {!showOffice && !mobile && connected && previewGroup && <PreviewPanel key={previewGroup.workspace.workspace_id} group={previewGroup} />}
      {dialog?.type === 'new-agent' && <NewAgentDialog preset={dialog} />}
      {dialog?.type === 'settings' && !mobileWeb && <SettingsDialog initialTab={dialog.tab} />}
      {dialog?.type === 'prompt' && <PromptDialog d={dialog} />}
      {dialog?.type === 'confirm' && <ConfirmDialog d={dialog} />}
      {dialog?.type === 'team' && <TeamDialog workspaceId={dialog.workspaceId} />}
      {dialog?.type === 'broadcast' && <BroadcastDialog workspaceId={dialog.workspaceId} />}
      {paletteOpen && <CommandPalette />}
      <MenuHost />
      <Toasts />
      <Lightbox />
    </div>
  )
}

function Welcome() {
  const { groups } = useModel()
  const sidebarHidden = useStore((s) => s.sidebarHidden)
  return (
    <div className="welcome">
      <div className="welcome-drag drag">
        {sidebarHidden && (
          <IconButton className="no-drag" title={t('Show sidebar')} onClick={() => useStore.setState({ sidebarHidden: false })}>
            <PanelLeftOpen size={16} />
          </IconButton>
        )}
      </div>
      <div className="welcome-inner">
        <img className="welcome-mark" src={appIcon} alt="" draggable={false} />
        <h1>{t('What should your agents work on?')}</h1>
        <p>{t('Start Claude Code, Codex or any agent herdr supports in a project folder. Chat with it here, paste screenshots, and let it run in the background.')}</p>
        <div className="welcome-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => openNewAgent({})}>
            <Bot size={16} /> {t('New agent')}
          </button>
          <button type="button" className="btn btn-lg" onClick={() => openNewAgent({ workspaceId: null, pickFolder: true })}>
            <FolderOpen size={16} /> {t('Open project folder')}
          </button>
        </div>
        {groups.length > 0 && <p className="welcome-hint">{t('Or pick a thread in the sidebar.')}</p>}
      </div>
    </div>
  )
}

function ConnectionScreen() {
  const connection = useStore((s) => s.connection)
  const autoStart = useStore((s) => s.settings.autoStartServer)
  const [busy, setBusy] = useState(false)
  const status = connection.status
  return (
    <div className="welcome">
      <div className="welcome-drag drag" />
      <div className="welcome-inner">
        {status === 'connecting' || status === 'starting-server' ? (
          <>
            <Spinner size={22} />
            <h2>{status === 'starting-server' ? t('Starting the herdr server…') : t('Connecting to herdr…')}</h2>
          </>
        ) : status === 'no-herdr' ? (
          <>
            <h2>{t('herdr is not installed')}</h2>
            <p>{t('This app is a desktop front-end for herdr. Install it, then reconnect.')}</p>
            <pre className="install-cmd">curl -fsSL https://herdr.dev/install.sh | sh</pre>
            <div className="welcome-actions">
              <button type="button" className="btn" onClick={() => void api.openExternal('https://herdr.dev')}>
                herdr.dev
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void api.reconnect()}>
                <RotateCw size={14} /> {t('Retry')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>{status === 'server-stopped' ? t('The herdr server is not running') : t('Lost connection to herdr')}</h2>
            <p>{connection.error ?? ''}</p>
            <div className="welcome-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  const ok = await api.startServer()
                  setBusy(false)
                  if (!ok) toast('error', t('Could not start the herdr server'))
                }}
              >
                {busy ? <Spinner size={13} /> : <Play size={14} />} {t('Start herdr')}
              </button>
              <button type="button" className="btn" onClick={() => void api.reconnect()}>
                <RotateCw size={14} /> {t('Reconnect')}
              </button>
            </div>
            {!autoStart && (
              <label className="check small">
                <input type="checkbox" onChange={(e) => void updateSettings({ autoStartServer: e.target.checked })} /> {t('Start it automatically next time')}
              </label>
            )}
            <p className="welcome-hint">{t('Session: {name}', { name: connection.session })}</p>
          </>
        )}
      </div>
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((tt) => (
        <div key={tt.id} className={clsx('toast', `toast-${tt.kind}`)}>
          <span>{tt.text}</span>
          {tt.action && (
            <button type="button" className="btn btn-sm" onClick={() => { tt.action!.run(); dismissToast(tt.id) }}>
              {tt.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismissToast(tt.id)} aria-label={t('Dismiss')}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Lightbox() {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const on = (e: Event) => setSrc((e as CustomEvent<string>).detail)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSrc(null)
    }
    window.addEventListener('lightbox', on)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('lightbox', on)
      window.removeEventListener('keydown', key)
    }
  }, [])
  if (!src) return null
  return (
    <div className="lightbox" onClick={() => setSrc(null)}>
      <img src={src} alt="" />
    </div>
  )
}
