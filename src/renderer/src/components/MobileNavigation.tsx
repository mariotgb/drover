import { useState } from 'react'
import { ArrowLeft, Bot, ChevronRight, ListChecks, MessageSquare, MoreHorizontal, Settings, SquareTerminal } from 'lucide-react'
import { openSettings, sendKeys } from '../actions'
import { attentionSort, statusLabel, type Thread } from '../model'
import { openBoard, select, setViewMode, useModel, useStore } from '../store'
import { t } from '../i18n'
import { isRemote } from '../api'
import { useRemoteConnection } from '../remote-api'
import { AgentAvatar, StatusDot } from './primitives'
import { projectImportance } from '@shared/projects'
import { ProjectImportanceMarker, ProjectOrderButtons, projectImportanceMenu } from './ProjectPreferences'
import { openMenuAt } from './Menu'
import { updateSettings } from '../store'

export function MobileBack() {
  return <button type="button" className="mobile-back" onClick={() => useStore.setState({ mobileScreen: 'list', boardWorkspace: null })}><ArrowLeft size={20} /> {t('Back to agents')}</button>
}

export function MobileAgentList() {
  const { groups } = useModel()
  const [tab, setTab] = useState<'agents' | 'tasks' | 'terminal'>('agents')
  const [reordering, setReordering] = useState(false)
  const preferences = useStore(s => s.settings)
  const remoteConnection = useRemoteConnection()
  const serverConnected = useStore((s) => s.connection.status === 'connected')
  const connected = serverConnected && (!isRemote || remoteConnection === 'connected')
  return (
    <div className="mobile-home">
      <header className="mobile-home-head"><h1>Drover</h1><button type="button" className="icon-btn" aria-label={t('Settings')} onClick={() => openSettings()}><Settings size={22} /></button></header>
      <div className="mobile-list">
        <h2>{tab === 'agents' ? t('All agents') : tab === 'tasks' ? t('Task boards') : t('Terminals')}</h2>
        <div className="mw-project-order-toolbar">
          <button type="button" className="btn btn-sm" aria-pressed={reordering} disabled={!connected} onClick={() => setReordering(!reordering)}>{reordering ? t('Done') : t('Edit project order')}</button>
          {reordering && <button type="button" className="btn btn-sm" disabled={!connected || !preferences.projectOrder.length} onClick={() => void updateSettings({ projectOrder: [] })}>{t('Sort by importance')}</button>}
        </div>
        {!connected && <p role="status" className="mobile-offline">{t('No connection')}</p>}
        {groups.map((group) => {
          const threads = attentionSort(group.threads.filter((th) => tab === 'terminal' ? th.isShell : !th.isShell))
          return <section className="mobile-workspace mw-project" data-importance={projectImportance(group.cwd, preferences)} key={group.workspace.workspace_id}>
            <div className="mobile-workspace-head"><ProjectImportanceMarker group={group} /><h3>{group.workspace.label || t('Workspace')}</h3>{reordering ? <ProjectOrderButtons group={group} disabled={!connected} /> : <><button type="button" className="btn" disabled={!connected} aria-label={t('Project importance')} onClick={e => openMenuAt(e.currentTarget, projectImportanceMenu(group))}><MoreHorizontal size={18} /></button><button type="button" className="btn" disabled={!connected} onClick={() => openBoard(group.workspace.workspace_id)} aria-label={t('Tasks')}><ListChecks size={18} /></button></>}</div>
            {!reordering && (tab === 'tasks' ? <button type="button" className="mobile-thread" disabled={!connected} onClick={() => openBoard(group.workspace.workspace_id)}><ListChecks size={24} /><span className="mobile-thread-text">{t('Open task board')}</span><ChevronRight size={18} /></button> : threads.length ? threads.map((th) => <button type="button" key={th.paneId} className={`mobile-thread st-${th.status}`} disabled={!connected} onClick={() => select(th.paneId)}>
              <AgentAvatar kind={th.kind} size={34} /><span className="mobile-thread-text"><strong>{th.name}</strong><span>{th.subtitle}</span><span className="mobile-thread-status"><StatusDot status={th.status} size={8} />{statusLabel(th.status) || t('Terminal')}</span></span><ChevronRight size={18} />
            </button>) : <p className="mobile-empty">{tab === 'terminal' ? t('No terminals in this workspace') : t('No agents in this workspace')}</p>)}
          </section>
        })}
        {!groups.length && <p className="mobile-empty">{t('Open a workspace on your Mac to see it here.')}</p>}
      </div>
      <nav className="mobile-tabs" aria-label={t('Navigation')}>
        <button type="button" aria-current={tab === 'agents' ? 'page' : undefined} onClick={() => setTab('agents')}><Bot size={22} />{t('Agents')}</button>
        <button type="button" aria-current={tab === 'tasks' ? 'page' : undefined} onClick={() => setTab('tasks')}><ListChecks size={22} />{t('Tasks')}</button>
        <button type="button" aria-current={tab === 'terminal' ? 'page' : undefined} onClick={() => setTab('terminal')}><SquareTerminal size={22} />{t('Terminal')}</button>
      </nav>
    </div>
  )
}

export function MobileThreadHeader({ thread, mode, supportsChat }: { thread: Thread; mode: 'chat' | 'terminal'; supportsChat: boolean }) {
  return <header className="mobile-thread-header">
    <MobileBack />
    <div className="mobile-thread-heading"><strong>{thread.name}</strong><span><StatusDot status={thread.status} size={8} />{statusLabel(thread.status) || t('Terminal')} · {thread.workspace.label}</span></div>
    <div className="mobile-thread-tools">
      <button type="button" className="btn" onClick={() => openBoard(thread.workspaceId)} aria-label={t('Tasks')}><ListChecks size={19} /></button>
      {supportsChat && <button type="button" className="btn" onClick={() => setViewMode(thread.paneId, mode === 'chat' ? 'terminal' : 'chat')} aria-label={mode === 'chat' ? t('Terminal') : t('Chat')}>{mode === 'chat' ? <SquareTerminal size={19} /> : <MessageSquare size={19} />}</button>}
    </div>
  </header>
}

export function QuickReplies({ thread }: { thread: Thread }) {
  const [busy, setBusy] = useState(false)
  const remoteConnection = useRemoteConnection()
  const serverConnected = useStore((s) => s.connection.status === 'connected')
  const connected = serverConnected && (!isRemote || remoteConnection === 'connected')
  const keys = ['enter', 'esc', '1', '2', '3', 'ctrl+c']
  return <div className="mobile-quick-replies">
    <div role="status">{t('{name} is waiting for your answer', { name: thread.name })}</div>
    <div className="mobile-quick-buttons">{keys.map((key) => <button key={key} type="button" className="btn" disabled={busy || !connected} onClick={async () => { setBusy(true); try { await sendKeys(thread, [key]) } finally { setBusy(false) } }}>{key === 'enter' ? 'Enter' : key === 'esc' ? 'Esc' : key === 'ctrl+c' ? 'Ctrl+C' : key}</button>)}</div>
  </div>
}
