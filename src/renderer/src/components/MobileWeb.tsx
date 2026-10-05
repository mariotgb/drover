import { memo, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import clsx from 'clsx'
import { Bell, Brain, FolderClosed, Globe, ListChecks, Menu as MenuIcon, MoreHorizontal, Pencil, Search, Settings, Square, SquareTerminal, Trash2, X } from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import { supportsModels } from '@shared/models'
import { isRemote } from '../api'
import { closePane, interrupt, leadMenuItem, renameAgent, renameTab, sendKeys } from '../actions'
import { projectKey, splitByLead } from '../leads'
import { attentionSort, statusLabel, type Thread, type WorkspaceGroup } from '../model'
import { getModel, openBoard, select, toggleCollapsed, useModel, useStore, useThread, useWorkspace } from '../store'
import { locale, t } from '../i18n'
import { useRemoteConnection } from '../remote-api'
import { MobileChatView } from './MobileChat'
import { Composer } from './Composer'
import { SelectionTools } from './SelectionTools'
import { openMenuAt, type MenuItem } from './Menu'
import { MobileSettings } from './MobileSettings'
import { MobileTerminal } from './MobileTerminal'
import { StatusDot } from './primitives'
import { BoardRow, MoreAgentsRow, ThreadRow } from './Sidebar'
import { BackdropLayer } from './Backdrop'
import { MobileUsage } from './Usage'
import { PreviewBanner, PreviewSheet, openPreview, previewToken } from './MobilePreview'
import { TaskBoardView } from './TaskBoardView'
import appIcon from '../assets/app-icon.png'
import { projectImportance } from '@shared/projects'
import { ProjectImportanceMarker, ProjectOrderButtons, projectImportanceMenu } from './ProjectPreferences'
import { updateSettings } from '../store'

const closeDrawer = () => useStore.setState({ mobileDrawer: false })

/** What the phone screen shows of a thread; a sibling's status (workspace aggregate) is not part of it. */
function sameView(a: Thread | null, b: Thread | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.paneId === b.paneId && a.status === b.status && a.name === b.name && a.subtitle === b.subtitle && a.kind === b.kind &&
    a.isShell === b.isShell && a.cwd === b.cwd && a.workspaceId === b.workspaceId && a.workspace.label === b.workspace.label &&
    a.tabId === b.tabId && a.tabPaneCount === b.tabPaneCount && a.agent?.name === b.agent?.name && a.pane.title === b.pane.title &&
    a.pane.terminal_title_stripped === b.pane.terminal_title_stripped && a.pane.tokens?.preview === b.pane.tokens?.preview
}
/** Threads by pane id that keep their identity while their view is unchanged. */
function useViewThreads(ids: string[]): (Thread | null)[] {
  const last = useRef<(Thread | null)[]>([])
  return useStore((s) => {
    void s.snapshot
    const model = getModel()
    const next = ids.map((id, i) => {
      const th = model.byPane.get(id) ?? null
      const prev = last.current[i] ?? null
      return prev && sameView(prev, th) ? prev : th
    })
    if (next.length === last.current.length && next.every((th, i) => th === last.current[i])) return last.current
    last.current = next
    return next
  })
}

/** Phone layout in the browser: the current agent's chat, a left drawer and full-screen sheets. */
// App re-renders on every snapshot; this tree only follows its own selectors.
export const MobileWebApp = memo(function MobileWebApp({ offline }: { offline: ReactNode }) {
  // Pane-scoped selectors: another agent's status change leaves this tree alone.
  const selected = useStore((s) => s.selectedPaneId)
  // The last chats stay mounted (hidden): switching back reuses their DOM, Markdown and scroll position.
  // Derived during render (idempotent per selection): no second render pass on every switch.
  const recent = useRef<string[]>([])
  if (selected && recent.current[0] !== selected) recent.current = [selected, ...recent.current.filter((id) => id !== selected)].slice(0, CACHED_CHATS)
  const [thread = null, ...rest] = useViewThreads(selected ? recent.current : [])
  const threadCount = useModel((m) => m.threads.length)
  const hasProjects = useModel((m) => m.groups.length > 0)
  const drawer = useStore((s) => s.mobileDrawer)
  const terminalPane = useStore((s) => s.mobileTerminal)
  const settingsOpen = useStore((s) => s.mobileSettings)
  const boardWorkspace = useStore((s) => s.boardWorkspace)
  const boardGroup = useWorkspace(boardWorkspace)
  const dialog = useStore((s) => s.dialog)
  const terminalThread = useThread(terminalPane)
  const preview = useStore((s) => s.mobilePreview)
  const sheet = settingsOpen ? 'settings' : boardGroup ? 'board' : preview ? 'preview' : terminalThread ? 'terminal' : null
  const [peek, setPeek] = useState(false)
  const swipe = useDrawerSwipe(!sheet, setPeek)

  // Show an agent right away: the one that needs an answer first.
  useEffect(() => {
    const { threads } = getModel()
    if (thread || !threads.length) return
    const next = attentionSort(threads.filter((th) => !th.isShell))[0] ?? threads[0]
    select(next.paneId, false)
  }, [thread, threadCount])
  // A notification or a task card brings that agent to the front.
  useEffect(() => { useStore.setState({ mobileDrawer: false, mobileTerminal: null, mobilePreview: null }) }, [selected])
  const cached = [thread, ...rest].filter((th): th is Thread => !!th && !!agentKindDef(th.kind)?.transcript)
  useEffect(() => { if (boardWorkspace) closeDrawer() }, [boardWorkspace])
  useEffect(() => {
    if (dialog?.type === 'settings') useStore.setState({ dialog: null, mobileSettings: true, mobileDrawer: false })
  }, [dialog])

  return (
    <div className={clsx('mw', drawer && 'drawer-open', sheet && 'sheet-open')} ref={swipe.ref} onTouchStart={swipe.start} onTouchMove={swipe.move} onTouchEnd={swipe.end} onTouchCancel={swipe.end}>
      <section className="mw-chat" inert={drawer || !!sheet} aria-hidden={drawer || !!sheet}>
        <ChatHeader thread={offline ? null : thread} />
        {offline ?? (thread ? <MobileThread thread={thread} cached={cached} /> : <EmptyChat hasProjects={hasProjects} />)}
      </section>
      <div className="mw-scrim" aria-hidden onClick={closeDrawer} />
      <MobileDrawer open={drawer} peek={peek} />
      <Sheet open={sheet === 'terminal'} label={t('Terminal')}>
        {terminalThread && <>
          <SheetHeader title={t('Terminal')} subtitle={terminalThread.name} onDone={() => useStore.setState({ mobileTerminal: null })} />
          <MobileTerminal key={terminalThread.paneId} paneId={terminalThread.paneId} />
        </>}
      </Sheet>
      <Sheet open={sheet === 'preview'} label={t('Open preview')}>
        {preview && <PreviewSheet key={`${preview.paneId}:${preview.recentId ?? ''}`} paneId={preview.paneId} recentId={preview.recentId} onClose={() => useStore.setState({ mobilePreview: null })} />}
      </Sheet>
      <Sheet open={sheet === 'board'} label={t('Tasks')}>
        {boardGroup && <TaskBoardView key={boardGroup.workspace.workspace_id} group={boardGroup} />}
      </Sheet>
      <Sheet open={settingsOpen} label={t('Settings')}>
        <MobileSettings onClose={() => useStore.setState({ mobileSettings: false })} />
      </Sheet>
    </div>
  )
})

/** Edge swipe opens the drawer, a swipe to the left closes it; the drawer follows the finger. */
function useDrawerSwipe(enabled: boolean, peek: (on: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; open: boolean; active: boolean; dx: number } | null>(null)
  const width = () => ref.current?.querySelector<HTMLElement>('.mw-drawer')?.offsetWidth ?? 320
  const start = (e: TouchEvent) => {
    const touch = e.touches[0]
    const open = useStore.getState().mobileDrawer
    drag.current = enabled && e.touches.length === 1 && (open || touch.clientX < 28) ? { x: touch.clientX, y: touch.clientY, open, active: false, dx: 0 } : null
  }
  const move = (e: TouchEvent) => {
    const d = drag.current
    if (!d || !ref.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - d.x
    const dy = touch.clientY - d.y
    if (!d.active) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      if (Math.abs(dy) > Math.abs(dx) || (d.open ? dx > 0 : dx < 0)) { drag.current = null; return }
      d.active = true
      peek(true)
      ref.current.classList.add('dragging')
    }
    d.dx = dx
    const w = width()
    const offset = Math.max(-w, Math.min(0, (d.open ? 0 : -w) + dx))
    ref.current.style.setProperty('--drawer-x', `${offset}px`)
    ref.current.style.setProperty('--drawer-p', String(1 + offset / w))
  }
  const end = () => {
    const d = drag.current
    drag.current = null
    if (!d?.active || !ref.current) return
    ref.current.classList.remove('dragging')
    ref.current.style.removeProperty('--drawer-x')
    ref.current.style.removeProperty('--drawer-p')
    const threshold = Math.min(90, width() / 3)
    if (!d.open && d.dx > threshold) useStore.setState({ mobileDrawer: true })
    if (d.open && d.dx < -threshold) closeDrawer()
    peek(false)
  }
  return { ref, start, move, end }
}

function useConnected() {
  const remote = useRemoteConnection()
  const server = useStore((s) => s.connection.status === 'connected')
  return server && (!isRemote || remote === 'connected')
}

function ChatHeader({ thread }: { thread: Thread | null }) {
  const waiting = useModel((m) => m.threads.filter((th) => th.status === 'blocked' && th.paneId !== thread?.paneId).length)
  const def = agentKindDef(thread?.kind ?? null)
  return (
    <header className="mw-head">
      <button type="button" className="mw-icon" aria-label={t('Projects and agents')} onClick={() => useStore.setState({ mobileDrawer: true })}>
        <MenuIcon size={22} />
        {waiting > 0 && <span className="mw-badge" aria-label={t('{n} agents need an answer', { n: waiting })}>{waiting}</span>}
      </button>
      <div className="mw-title">
        {thread ? <>
          <strong>{thread.name}</strong>
          <span className={`st-${thread.status}`}>
            {thread.kind && thread.status !== 'unknown' && <StatusDot status={thread.status} size={7} />}
            <span>{thread.kind ? statusLabel(thread.status) || def?.label : thread.subtitle || t('Terminal')} · {thread.workspace.label}</span>
          </span>
        </> : <strong>Drover</strong>}
      </div>
      {thread
        ? <button type="button" className="mw-icon" aria-label={t('Actions')} onClick={(e) => openMenuAt(e.currentTarget, threadActions(thread), 'right')}><MoreHorizontal size={22} /></button>
        : <span className="mw-icon" aria-hidden />}
    </header>
  )
}

function threadActions(thread: Thread): MenuItem[] {
  const chat = !!agentKindDef(thread.kind)?.transcript
  const items: MenuItem[] = []
  if (previewToken(thread)) items.push({ label: t('Open preview'), icon: <Globe size={18} />, onClick: () => openPreview(thread.paneId) })
  if (chat) items.push({ label: t('Terminal'), icon: <SquareTerminal size={18} />, onClick: () => useStore.setState({ mobileTerminal: thread.paneId }) })
  items.push({ label: t('Task board'), icon: <ListChecks size={18} />, onClick: () => openBoard(thread.workspaceId) })
  if (chat && supportsModels(thread.kind)) items.push({ label: t('Model and reasoning'), icon: <Brain size={18} />, onClick: () => window.dispatchEvent(new Event('composer:model')) })
  items.push({ label: t('Rename…'), icon: <Pencil size={18} />, onClick: () => (thread.kind ? renameAgent(thread) : renameTab(thread)) })
  const lead = leadMenuItem(thread, 18)
  if (lead) items.push(lead)
  items.push('separator')
  if (thread.kind) items.push({ label: t('Stop'), icon: <Square size={18} />, disabled: thread.status !== 'working', onClick: () => void interrupt(thread) })
  items.push({ label: thread.kind ? t('End agent…') : t('Close terminal…'), icon: <Trash2 size={18} />, danger: true, onClick: () => closePane(thread) })
  return items
}

const CACHED_CHATS = 3

function MobileThread({ thread, cached }: { thread: Thread; cached: Thread[] }) {
  const chat = !!agentKindDef(thread.kind)?.transcript
  const screens = (chat ? [thread, ...cached.filter((th) => th.paneId !== thread.paneId)].slice(0, CACHED_CHATS) : cached.slice(0, CACHED_CHATS - 1))
    .sort((a, b) => (a.paneId < b.paneId ? -1 : 1))
  return (
    <div className="thread-view">
      <PreviewBanner thread={thread} />
      <div className="thread-body">
        <div className={clsx('mw-chats', !chat && 'off')}>
          {screens.map((th) => <MobileChatView key={th.paneId} thread={th} active={chat && th.paneId === thread.paneId} />)}
        </div>
        {!chat && <MobileTerminal key={`terminal:${thread.paneId}`} paneId={thread.paneId} />}
        {thread.status === 'blocked' && <QuickReplies key={`quick:${thread.paneId}`} thread={thread} />}
        {chat && <Composer key={`composer:${thread.paneId}`} thread={thread} />}
        {chat && <SelectionTools key={`selection:${thread.paneId}`} paneId={thread.paneId} />}
      </div>
    </div>
  )
}

const KEYS: [string, string][] = [['enter', 'Enter'], ['esc', 'Esc'], ['1', '1'], ['2', '2'], ['3', '3'], ['ctrl+c', 'Ctrl+C']]

function QuickReplies({ thread }: { thread: Thread }) {
  const [busy, setBusy] = useState(false)
  const connected = useConnected()
  return (
    <div className="mw-quick" role="group" aria-label={t('{name} is waiting for your answer', { name: thread.name })}>
      <span className="mw-quick-mark" title={t('Needs input')}><Bell size={16} /></span>
      {KEYS.map(([key, label]) => (
        <button type="button" key={key} disabled={busy || !connected} onClick={async () => {
          setBusy(true)
          try { await sendKeys(thread, [key]) } finally { setBusy(false) }
        }}>{label}</button>
      ))}
    </div>
  )
}

function EmptyChat({ hasProjects }: { hasProjects: boolean }) {
  return (
    <div className="mw-empty">
      <img src={appIcon} width={64} height={64} alt="" />
      <h1>{hasProjects ? t('No agents in this workspace') : t('No projects yet')}</h1>
      <p>{t('Open a workspace on your Mac to see it here.')}</p>
      {hasProjects && <button type="button" className="btn" onClick={() => useStore.setState({ mobileDrawer: true })}><MenuIcon size={18} />{t('Projects and agents')}</button>}
    </div>
  )
}

/** The list mounts only while the drawer is open, dragged or sliding away: agent status changes don't touch a closed drawer. */
const MobileDrawer = memo(function MobileDrawer({ open, peek }: { open: boolean; peek: boolean }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open || peek) { setMounted(true); return }
    const id = setTimeout(() => setMounted(false), 380)
    return () => clearTimeout(id)
  }, [open, peek])
  return (
    <nav className="mw-drawer" aria-label={t('Projects and agents')} inert={!open} aria-hidden={!open}
      onClickCapture={(e) => { if ((e.target as HTMLElement).closest('.thread')) closeDrawer() }}>
      {(mounted || open || peek) && <DrawerContent />}
    </nav>
  )
})

function DrawerContent() {
  const { groups, threads } = useModel()
  const [query, setQuery] = useState('')
  const [reordering, setReordering] = useState(false)
  const preferences = useStore(s => s.settings)
  const connection = useStore((s) => s.connection)
  const version = useStore((s) => s.snapshot?.version ?? s.connection.version)
  const connected = useConnected()
  const leadOnly = useStore((s) => s.settings.leadOnly)
  const q = query.trim().toLocaleLowerCase(locale())
  const match = (th: Thread) => !q || `${th.name} ${th.subtitle} ${th.workspace.label}`.toLocaleLowerCase(locale()).includes(q)
  const waiting = attentionSort(threads.filter((th) => th.status === 'blocked' && match(th)))
  const shown = groups.map((group) => ({ group, items: group.threads.filter(match) })).filter(({ group, items }) => !q || items.length || group.workspace.label.toLocaleLowerCase(locale()).includes(q))
  return (
    <>
      <BackdropLayer />
      <div className="mw-drawer-head">
        <img src={appIcon} width={28} height={28} alt="" />
        <strong>Drover</strong>
        <button type="button" className="mw-icon" aria-label={t('Close')} onClick={closeDrawer}><X size={20} /></button>
      </div>
      <label className="mw-search">
        <Search size={17} />
        <input type="search" value={query} placeholder={t('Search agents')} aria-label={t('Search agents')} onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" aria-label={t('Clear search')} onClick={() => setQuery('')}><X size={16} /></button>}
      </label>
      <div className="mw-project-order-toolbar">
        <button type="button" className="btn btn-sm" aria-pressed={reordering} disabled={!connected} onClick={() => { setQuery(''); setReordering(!reordering) }}>{reordering ? t('Done') : t('Edit project order')}</button>
        {reordering && <button type="button" className="btn btn-sm" disabled={!preferences.projectOrder.length || !connected} onClick={() => void updateSettings({ projectOrder: [] })}>{t('Sort by importance')}</button>}
      </div>
      <div className="mw-drawer-list" data-reordering={reordering || undefined}>
        {waiting.length > 0 && (
          <section className="mw-waiting">
            <h2 className="mw-section-title"><Bell size={14} />{t('Waiting for an answer')}<span>{waiting.length}</span></h2>
            <div className="ws-threads flat">{waiting.map((th) => <ThreadRow key={th.paneId} thread={th} showProject />)}</div>
          </section>
        )}
        {shown.map(({ group, items }) => (
          <section className="mw-project" data-importance={projectImportance(group.cwd, preferences)} key={group.workspace.workspace_id}>
            <h2 className="mw-section-title"><FolderClosed size={14} /><ProjectImportanceMarker group={group} /><span className="mw-project-label">{group.workspace.label || t('Workspace')}</span>
              {reordering ? <ProjectOrderButtons group={group} disabled={!connected} /> : <button type="button" className="mw-icon" disabled={!connected} aria-label={t('Project importance')} onClick={e => openMenuAt(e.currentTarget, projectImportanceMenu(group))}><MoreHorizontal size={17} /></button>}
            </h2>
            {!reordering && <div className="ws-threads">
              {!q && <BoardRow group={group} />}
              {leadOnly && !q ? <LeadRows group={group} /> : items.map((th) => <ThreadRow key={th.paneId} thread={th} nested />)}
              {!items.length && !q && <div className="ws-empty">{t('No tabs')}</div>}
            </div>}
          </section>
        ))}
        {!shown.length && <p className="mw-drawer-empty">{q ? t('No results. Try another search.') : t('Open a workspace on your Mac to see it here.')}</p>}
      </div>
      <MobileUsage />
      <div className="mw-drawer-foot">
        <button type="button" className="mw-settings-btn" onClick={() => useStore.setState({ mobileSettings: true, mobileDrawer: false })}>
          <Settings size={20} />{t('Settings')}
        </button>
        <span className="mw-conn" title={connection.status}>
          <span className={clsx('conn-dot', connected ? 'ok' : connection.status === 'connecting' ? 'wait' : 'bad')} />
          {connected ? `herdr ${version ?? ''}`.trim() : t('No connection')}
        </span>
      </div>
    </>
  )
}

/** The project's lead, waiting agents and the open one; the rest behind "N more agents". */
function LeadRows({ group }: { group: WorkspaceGroup }) {
  const leads = useStore((s) => s.settings.projectLeads)
  const selected = useStore((s) => s.selectedPaneId)
  const key = projectKey(group)
  const expanded = useStore((s) => !!s.collapsed[`lead-more:${key}`])
  const { lead, shown, hidden } = splitByLead(group, leads, (th) => th.paneId === selected)
  return <>
    {shown.map((th) => <ThreadRow key={th.paneId} thread={th} nested lead={th === lead && hidden.length > 0} />)}
    {hidden.length > 0 && <MoreAgentsRow hidden={hidden} expanded={expanded} onToggle={() => toggleCollapsed(`lead-more:${key}`)} />}
    {expanded && hidden.map((th) => <ThreadRow key={th.paneId} thread={th} nested />)}
  </>
}

/** Full-screen sheet; keeps its content while sliding away. */
function Sheet({ open, label, children }: { open: boolean; label: string; children: ReactNode }) {
  const last = useRef<ReactNode>(null)
  const [present, setPresent] = useState(open)
  if (open) last.current = children
  useEffect(() => {
    if (open) { setPresent(true); return }
    const id = setTimeout(() => setPresent(false), 350)
    return () => clearTimeout(id)
  }, [open])
  return (
    <section className={clsx('mw-sheet', open && 'open')} role="dialog" aria-modal="true" aria-label={label} inert={!open} aria-hidden={!open}>
      <BackdropLayer />
      {open ? children : present ? last.current : null}
    </section>
  )
}

function SheetHeader({ title, subtitle, onDone }: { title: string; subtitle?: string; onDone: () => void }) {
  return (
    <header className="mw-sheet-head">
      <div className="mw-sheet-side" />
      <div className="mw-sheet-title"><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div>
      <div className="mw-sheet-side end"><button type="button" className="mw-text-btn strong" onClick={onDone}>{t('Done')}</button></div>
    </header>
  )
}
