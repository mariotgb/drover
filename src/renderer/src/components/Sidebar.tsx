import { memo, useCallback, useRef, useState, type MouseEvent, type DragEvent } from 'react'
import clsx from 'clsx'
import {
  ChevronRight,
  FolderClosed,
  FolderPlus,
  LayoutList,
  ListChecks,
  ListFilter,
  MoreHorizontal,
  PenSquare,
  Plus,
  Search,
  Settings,
  Columns2,
  Crown
} from 'lucide-react'
import { GripVertical, ShieldOff } from 'lucide-react'
import { projectFolders, projectImportance } from '@shared/projects'
import { moveProject, ProjectImportanceMarker } from './ProjectPreferences'
import { CodexIntegrationWarning } from './CodexIntegrationWarning'
import '../styles/importance.css'
import { newAgentMenu, openNewAgent, openSettings, threadMenu, workspaceMenu } from '../actions'
import { attentionSort, basename, shortPath, type Thread, type WorkspaceGroup } from '../model'
import { getModel, openBoard, select, toggleCollapsed, updateSettings, useModel, useStore } from '../store'
import { useBoard } from './TaskBoardView'
import { openMenu, openMenuAt } from './Menu'
import { AgentAvatar, IconButton, StatusDot } from './primitives'
import { UsageWidget } from './Usage'
import { t, tp } from '../i18n'
import { splitByLead, projectKey } from '../leads'
import { isRemote } from '../api'
import { BossBroadcastDialog, BossDialog } from './BossDialogs'

export function Sidebar() {
  const { groups, threads } = useModel()
  const mode = useStore((s) => s.settings.sidebarMode)
  const connection = useStore((s) => s.connection)
  const width = useStore((s) => s.settings.sidebarWidth)
  const dialog = useStore((s) => s.dialog)
  const dragging = useRef<string | null>(null)
  const [drop, setDrop] = useState<{ cwd: string; after: boolean } | null>(null)
  const [dragSource, setDragSource] = useState<string | null>(null)
  const finishDrag = () => { dragging.current = null; setDragSource(null); setDrop(null) }

  return (
    <><aside className="sidebar" style={{ width }}>
      <div className="sidebar-top drag">
        <div className="traffic-space" />
        <div className="sidebar-top-actions no-drag">
          <IconButton title={t('Search threads (⌘K)')} onClick={() => useStore.setState({ paletteOpen: true })}>
            <Search size={16} />
          </IconButton>
          <IconButton title={t('New agent (⌘N)')} onClick={() => openNewAgent({})}>
            <PenSquare size={16} />
          </IconButton>
        </div>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="sidebar-new" onClick={() => openNewAgent({})} onContextMenu={(e) => openMenu(e, newAgentMenu())}>
          <Plus size={16} />
          <span>{t('New agent')}</span>
          <span className="shortcut">⌘N</span>
        </button>
        {!isRemote && <button type="button" className="sidebar-new" onClick={() => useStore.setState({ dialog: { type: 'boss' } })}>
          <Crown size={16} />
          <span>{t('Main boss')}</span>
        </button>}
      </div>

      <div className="sidebar-section-head">
        <span>{mode === 'status' ? t('Agents') : t('Projects')}</span>
        <div className="section-tools">
          <IconButton
            size="sm"
            title={mode === 'status' ? t('Group by project') : t('Sort by attention')}
            onClick={() => void updateSettings({ sidebarMode: mode === 'status' ? 'workspaces' : 'status' })}
          >
            {mode === 'status' ? <LayoutList size={14} /> : <ListFilter size={14} />}
          </IconButton>
          <IconButton size="sm" title={t('New project')} onClick={() => openNewAgent({ workspaceId: null, pickFolder: true })}>
            <FolderPlus size={14} />
          </IconButton>
        </div>
      </div>

      <nav className="sidebar-list" aria-label={t('Projects and agents')} data-dragging={!!dragSource || undefined}>
        {mode === 'status' ? (
          <StatusList threads={attentionSort(threads)} />
        ) : (
          groups.map((g) => <WorkspaceSection key={g.workspace.workspace_id} group={g}
            dragging={dragSource === g.cwd} drop={drop?.cwd === g.cwd ? (drop.after ? 'after' : 'before') : null}
            onDragStart={(e) => {
              if (!g.cwd) { e.preventDefault(); return }
              dragging.current = g.cwd; setDragSource(g.cwd)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('application/x-drover-project', g.cwd)
            }}
            onDragOver={(e) => {
              if (!dragging.current || !g.cwd || dragging.current === g.cwd) return
              e.preventDefault(); e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              setDrop({ cwd: g.cwd, after: e.clientY > rect.top + rect.height / 2 })
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging.current && g.cwd) {
                const rect = e.currentTarget.getBoundingClientRect()
                moveProject(dragging.current, g.cwd, e.clientY > rect.top + rect.height / 2)
              }
              finishDrag()
            }} onDragEnd={finishDrag} />)
        )}
        {connection.status === 'connected' && !groups.length && (
          <div className="sidebar-empty">{t('No projects yet. Create an agent to get started.')}</div>
        )}
      </nav>

      {!isRemote && <CodexIntegrationWarning />}
      <UsageWidget />
      <SidebarFooter />
      <ResizeHandle />
    </aside>
    {!isRemote && dialog?.type === 'boss' && <BossDialog />}
    {!isRemote && dialog?.type === 'boss-broadcast' && <BossBroadcastDialog />}
    </>
  )
}

function WorkspaceSection({ group, dragging, drop, onDragStart, onDragOver, onDrop, onDragEnd }: {
  group: WorkspaceGroup; dragging: boolean; drop: 'before' | 'after' | null
  onDragStart: (e: DragEvent<HTMLDivElement>) => void; onDragOver: (e: DragEvent<HTMLElement>) => void
  onDrop: (e: DragEvent<HTMLElement>) => void; onDragEnd: () => void
}) {
  const ws = group.workspace
  const collapsed = useStore((s) => !!s.collapsed[ws.workspace_id])
  const home = useStore((s) => s.home)
  const attention = group.threads.filter((t) => t.status === 'blocked' || t.status === 'done').length
  const working = group.threads.some((t) => t.status === 'working')
  const leadOnly = useStore((s) => s.settings.leadOnly)
  const importance = useStore(s => projectImportance(group.cwd, s.settings))
  return (
    <section className={clsx('ws', dragging && 'project-dragging', drop && `project-drop-${drop}`)} data-importance={importance}
      onDragOver={onDragOver} onDrop={onDrop}>
      <div
        className="ws-head"
        draggable={!!group.cwd}
        onDragStart={onDragStart} onDragEnd={onDragEnd}
        role="button" tabIndex={0} aria-expanded={!collapsed}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(ws.workspace_id) }
          if (group.cwd && e.altKey && e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault()
            // Resolve the current order at keydown, including phone updates.
            const folders = projectFolders(getModel().groups)
            const index = folders.indexOf(group.cwd)
            const target = folders[index + (e.key === 'ArrowUp' ? -1 : 1)]
            if (target) moveProject(group.cwd, target, e.key === 'ArrowDown')
          }
        }}
        onClick={() => toggleCollapsed(ws.workspace_id)}
        onContextMenu={(e) => openMenu(e, workspaceMenu(group))}
        title={shortPath(group.cwd, home)}
      >
        {group.cwd && <span className="project-grip" title={t('Drag to reorder projects')}><GripVertical size={12} /></span>}
        <ChevronRight size={13} className={clsx('chev', !collapsed && 'open')} />
        <FolderClosed size={14} className="ws-icon" />
        <ProjectImportanceMarker group={group} />
        <span className="ws-label">{ws.label || basename(group.cwd)}</span>
        {collapsed && working && <StatusDot status="working" size={7} />}
        {collapsed && attention > 0 && <span className="ws-badge">{attention}</span>}
        {ws.worktree && <span className="ws-tag">worktree</span>}
        <div className="ws-tools" onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" title={t('New agent in this project')} onClick={() => openNewAgent({ workspaceId: ws.workspace_id })}>
            <Plus size={14} />
          </IconButton>
          <IconButton size="sm" title={t('More')} onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, workspaceMenu(group))}>
            <MoreHorizontal size={14} />
          </IconButton>
        </div>
      </div>
      {!collapsed && leadOnly && <LeadThreads group={group} />}
      {!collapsed && !leadOnly && (
        <div className="ws-threads">
          <BoardRow group={group} />
          {group.tabs.map((tg) =>
            tg.threads.length > 1 ? (
              <div key={tg.tab.tab_id} className="tab-group">
                <div className="tab-group-head">
                  <Columns2 size={12} />
                  <span>{tg.customLabel || t('Tab {n}', { n: tg.tab.number })}</span>
                </div>
                {tg.threads.map((t) => (
                  <ThreadRow key={t.paneId} thread={t} nested />
                ))}
              </div>
            ) : (
              tg.threads.map((t) => <ThreadRow key={t.paneId} thread={t} />)
            )
          )}
          {!group.threads.length && <div className="ws-empty">{t('No tabs')}</div>}
        </div>
      )}
    </section>
  )
}

/** "Show only the project lead": the lead, agents that wait for an answer and the open one; the rest fold away. */
function LeadThreads({ group }: { group: WorkspaceGroup }) {
  const leads = useStore((s) => s.settings.projectLeads)
  const selected = useStore((s) => s.selectedPaneId)
  const key = projectKey(group)
  const expanded = useStore((s) => !!s.collapsed[`lead-more:${key}`])
  const { lead, shown, hidden } = splitByLead(group, leads, (th) => th.paneId === selected)
  return (
    <div className="ws-threads">
      <BoardRow group={group} />
      {shown.map((th) => <ThreadRow key={th.paneId} thread={th} lead={th === lead && hidden.length > 0} />)}
      {hidden.length > 0 && <MoreAgentsRow hidden={hidden} expanded={expanded} onToggle={() => toggleCollapsed(`lead-more:${key}`)} />}
      {expanded && hidden.map((th) => <ThreadRow key={th.paneId} thread={th} nested />)}
      {!group.threads.length && <div className="ws-empty">{t('No tabs')}</div>}
    </div>
  )
}

/** "3 more agents" with their status dots; opens the folded list. */
export function MoreAgentsRow({ hidden, expanded, onToggle }: { hidden: Thread[]; expanded: boolean; onToggle: () => void }) {
  const agents = hidden.filter((th) => th.kind).length
  const terminals = hidden.length - agents
  const label = [agents ? tp({ one: '{n} more agent', other: '{n} more agents' }, agents) : '', terminals ? tp({ one: '{n} terminal', other: '{n} terminals' }, terminals) : ''].filter(Boolean).join(' · ')
  return (
    <div role="button" tabIndex={0} aria-expanded={expanded} className={clsx('more-row', expanded && 'open')} onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
      <span className="more-row-icon"><ChevronRight size={14} /></span>
      <span className="more-row-label">{label}</span>
      <span className="more-row-dots" aria-hidden>
        {hidden.filter((th) => th.kind).slice(0, 6).map((th) => <StatusDot key={th.paneId} status={th.status} size={7} />)}
      </span>
    </div>
  )
}

/** The project's task board: shown once there are tasks or a team. */
export function BoardRow({ group }: { group: WorkspaceGroup }) {
  const board = useBoard(group.cwd)
  const open = useStore((s) => s.boardWorkspace === group.workspace.workspace_id)
  const tasks = board?.tasks ?? []
  const agents = group.threads.filter((th) => th.kind).length
  if (!group.cwd || (!tasks.length && agents < 2 && !open)) return null
  const active = tasks.filter((x) => x.status === 'in_progress' || x.status === 'review').length
  const blocked = tasks.filter((x) => x.status === 'blocked').length
  const done = tasks.filter((x) => x.status === 'done').length
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx('thread board-row', open && 'selected')}
      onClick={() => openBoard(group.workspace.workspace_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openBoard(group.workspace.workspace_id)
      }}
    >
      <span className="board-row-icon">
        <ListChecks size={14} />
      </span>
      <div className="thread-text">
        <div className="thread-name">
          <span className="name">{t('Tasks')}</span>
          {blocked > 0 && <span className="pill pill-blocked">{t('{n} blocked', { n: blocked })}</span>}
        </div>
        <div className="thread-sub">
          {tasks.length ? t('{active} in progress · {done}/{total} done', { active, done, total: tasks.length }) : t('What the agents are doing')}
        </div>
      </div>
    </div>
  )
}

function StatusList({ threads }: { threads: Thread[] }) {
  return (
    <div className="ws-threads flat">
      {threads.map((t) => (
        <ThreadRow key={t.paneId} thread={t} showProject />
      ))}
    </div>
  )
}

export const ThreadRow = memo(function ThreadRow({ thread: th, nested, showProject, lead }: { thread: Thread; nested?: boolean; showProject?: boolean; lead?: boolean }) {
  const selected = useStore((s) => s.selectedPaneId === th.paneId && !s.boardWorkspace)
  const onContext = useCallback((e: MouseEvent) => {
    e.preventDefault()
    openMenu(e, threadMenu(th))
  }, [th])
  const attention = th.status === 'blocked' || th.status === 'done'
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx('thread', selected && 'selected', nested && 'nested', attention && 'attention', `st-${th.status}`)}
      onClick={() => select(th.paneId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') select(th.paneId)
      }}
      onContextMenu={onContext}
    >
      <AgentAvatar kind={th.kind} size={20} />
      <div className="thread-text">
        <div className="thread-name">
          <span className="name">{th.name}</span>
          {lead && <Crown size={12} className="lead-crown" aria-label={t('Project lead')} />}
          {th.pane.bypass && <ShieldOff size={12} className="bypass-icon" aria-label={t('Skip permission prompts')}><title>{t('Skip permission prompts')}</title></ShieldOff>}
          {th.status === 'blocked' && <span className="pill pill-blocked">{t('input')}</span>}
        </div>
        <div className="thread-sub">{showProject ? `${th.workspace.label} · ${th.subtitle}` : th.subtitle}</div>
      </div>
      <div className="thread-status">
        {th.kind && th.status !== 'idle' && th.status !== 'unknown' && <StatusDot status={th.status} size={8} />}
      </div>
      <button
        type="button"
        className="thread-more"
        title={t('More')}
        onClick={(e) => {
          e.stopPropagation()
          openMenuAt(e.currentTarget, threadMenu(th))
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
})

function SidebarFooter() {
  const connection = useStore((s) => s.connection)
  const snapshot = useStore((s) => s.snapshot)
  const label =
    connection.status === 'connected'
      ? `herdr ${snapshot?.version ?? connection.version ?? ''}`.trim()
      : connection.status === 'starting-server'
        ? t('Starting herdr…')
        : connection.status === 'connecting'
          ? t('Connecting…')
          : connection.status === 'no-herdr'
            ? t('herdr not found')
            : t('Disconnected')
  return (
    <div className="sidebar-footer">
      <button type="button" className="footer-status" onClick={() => openSettings('herdr')} title={connection.socketPath}>
        <span className={clsx('conn-dot', connection.status === 'connected' ? 'ok' : connection.status === 'connecting' || connection.status === 'starting-server' ? 'wait' : 'bad')} />
        <span className="footer-label">{label}</span>
        {connection.session !== 'default' && <span className="footer-session">{connection.session}</span>}
      </button>
      <IconButton title={t('Settings (⌘,)')} onClick={() => openSettings()}>
        <Settings size={16} />
      </IconButton>
    </div>
  )
}

function ResizeHandle() {
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      className="sidebar-resize"
      onMouseDown={(e) => {
        start.current = { x: e.clientX, w: useStore.getState().settings.sidebarWidth }
        const move = (ev: globalThis.MouseEvent) => {
          if (!start.current) return
          const w = Math.max(220, Math.min(460, start.current.w + ev.clientX - start.current.x))
          document.documentElement.style.setProperty('--sidebar-width', `${w}px`)
          useStore.setState((s) => ({ settings: { ...s.settings, sidebarWidth: w } }))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          if (start.current) void updateSettings({ sidebarWidth: useStore.getState().settings.sidebarWidth })
          start.current = null
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}
