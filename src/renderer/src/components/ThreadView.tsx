import { useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Columns2,
  Globe,
  MessageSquare,
  MoreHorizontal,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftOpen,
  Rows2,
  ShieldOff,
  SquareTerminal
} from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import { splitPane, threadMenu } from '../actions'
import { shortPath, statusLabel, type Thread } from '../model'
import { getModel, setViewMode, toggleDrawer, togglePreview, useStore } from '../store'
import { t } from '../i18n'
import { openPreviewFor, serversFor } from './PreviewPanel'
import { ChatView } from './ChatView'
import { SelectionTools } from './SelectionTools'
import { Composer } from './Composer'
import { openMenuAt } from './Menu'
import { AgentAvatar, IconButton, StatusDot } from './primitives'
import { TerminalView } from './TerminalView'
import { useMobile } from '../mobile'
import { MobileThreadHeader, QuickReplies } from './MobileNavigation'

export function ThreadView({ thread }: { thread: Thread }) {
  const mobile = useMobile()
  const explicit = useStore((s) => s.viewMode[thread.paneId])
  const supportsChat = !!agentKindDef(thread.kind)?.transcript
  const mode = supportsChat ? explicit ?? 'chat' : 'terminal'
  const drawerOpen = useStore((s) => !!s.drawer[thread.paneId])

  return (
    <div className="thread-view">
      {mobile ? <MobileThreadHeader thread={thread} mode={mode} supportsChat={supportsChat} /> : <ThreadHeader thread={thread} mode={mode} supportsChat={supportsChat} drawerOpen={drawerOpen} />}
      <div className="thread-body">
        {mode === 'chat' ? (
          <>
            <ChatView thread={thread} />
            <SelectionTools paneId={thread.paneId} />
            {!mobile && drawerOpen && <TerminalDrawer thread={thread} />}
            {mobile && thread.status === 'blocked' && <QuickReplies thread={thread} />}
            <Composer thread={thread} />
          </>
        ) : (
          <>
            <div className="terminal-main">
              <TerminalView key={thread.paneId} paneId={thread.paneId} autoFocus={!mobile} />
            </div>
            {mobile && thread.status === 'blocked' && <QuickReplies thread={thread} />}
            <Composer thread={thread} compact />
          </>
        )}
      </div>
    </div>
  )
}

function ThreadHeader({ thread, mode, supportsChat, drawerOpen }: { thread: Thread; mode: 'chat' | 'terminal'; supportsChat: boolean; drawerOpen: boolean }) {
  const home = useStore((s) => s.home)
  const sidebarHidden = useStore((s) => s.sidebarHidden)
  const title = useStore((s) => s.transcripts[thread.paneId]?.meta?.title)
  const def = agentKindDef(thread.kind)
  const sub = [thread.workspace.label, shortPath(thread.cwd, home)].filter(Boolean).join(' · ')
  return (
    <header className={clsx('thread-header drag', sidebarHidden && 'with-traffic')}>
      {sidebarHidden && (
        <IconButton className="no-drag" title={t('Show sidebar (⌘B)')} onClick={() => useStore.setState({ sidebarHidden: false })}>
          <PanelLeftOpen size={16} />
        </IconButton>
      )}
      <AgentAvatar kind={thread.kind} size={26} />
      <div className="thread-header-text">
        <div className="thread-header-title">
          <span className="title">{thread.name}</span>
          {def && <span className="kind-badge">{def.label}</span>}
          {thread.pane.bypass && <span className="kind-badge" title={t('Skip permission prompts')}><ShieldOff size={12} /> {t('Without confirmations')}</span>}
          {thread.kind && thread.status !== 'unknown' && (
            <span className={clsx('status-pill', `st-${thread.status}`)}>
              <StatusDot status={thread.status} size={7} />
              {statusLabel(thread.status)}
            </span>
          )}
        </div>
        <div className="thread-header-sub" title={thread.cwd ?? ''}>
          {title && title !== thread.name ? <span className="conv-title">{title}</span> : null}
          {title && title !== thread.name ? ' · ' : null}
          {sub}
        </div>
      </div>
      <div className="thread-header-actions no-drag">
        <PreviewButton thread={thread} />
        {supportsChat && (
          <div className="segmented" role="tablist">
            <button type="button" className={clsx(mode === 'chat' && 'active')} onClick={() => setViewMode(thread.paneId, 'chat')} title={t('Chat view')}>
              <MessageSquare size={14} /> <span className="seg-label">{t('Chat')}</span>
            </button>
            <button type="button" className={clsx(mode === 'terminal' && 'active')} onClick={() => setViewMode(thread.paneId, 'terminal')} title={t('Terminal view (⌘⇧T)')}>
              <SquareTerminal size={14} /> <span className="seg-label">{t('Terminal')}</span>
            </button>
          </div>
        )}
        {mode === 'chat' && (
          <IconButton title={drawerOpen ? t('Hide terminal panel (⌘J)') : t('Show terminal panel (⌘J)')} active={drawerOpen} onClick={() => toggleDrawer(thread.paneId)}>
            {drawerOpen ? <PanelBottomClose size={16} /> : <PanelBottomOpen size={16} />}
          </IconButton>
        )}
        <IconButton title={t('Split right — new terminal')} onClick={() => void splitPane(thread, 'right')}>
          <Columns2 size={16} />
        </IconButton>
        <IconButton title={t('Split down — new terminal')} onClick={() => void splitPane(thread, 'down')}>
          <Rows2 size={16} />
        </IconButton>
        <IconButton title={t('More')} onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, threadMenu(thread), 'right')}>
          <MoreHorizontal size={16} />
        </IconButton>
      </div>
    </header>
  )
}

function PreviewButton({ thread }: { thread: Thread }) {
  const open = useStore((s) => !!s.previewOpen[thread.workspaceId])
  const servers = useStore((s) => s.servers)
  const project = getModel().groups.find((g) => g.workspace.workspace_id === thread.workspaceId)
  const key = project?.cwd ?? thread.workspaceId
  const hasUrl = useStore((s) => !!s.previewUrl[key])
  const running = serversFor(servers, project?.cwd ?? null)
  if (!open && !hasUrl && running.length) {
    const s = running[0]
    return (
      <button type="button" className="server-pill" title={t('Open preview')} onClick={() => openPreviewFor(thread.workspaceId, s.url)}>
        <span className="server-dot" />
        localhost:{s.port}
      </button>
    )
  }
  return (
    <IconButton title={open ? t('Close preview (⌘⇧P)') : t('Open preview (⌘⇧P)')} active={open} onClick={() => togglePreview(thread.workspaceId)}>
      <Globe size={16} />
    </IconButton>
  )
}

function TerminalDrawer({ thread }: { thread: Thread }) {
  const [height, setHeight] = useState(() => {
    const v = Number(localStorage.getItem('drover:drawer-h'))
    return v > 120 ? v : 300
  })
  const drag = useRef<{ y: number; h: number } | null>(null)
  return (
    <div className="drawer" style={{ height }}>
      <div
        className="drawer-resize"
        onMouseDown={(e) => {
          drag.current = { y: e.clientY, h: height }
          const move = (ev: MouseEvent) => {
            if (!drag.current) return
            const h = Math.max(140, Math.min(window.innerHeight - 260, drag.current.h - (ev.clientY - drag.current.y)))
            setHeight(h)
          }
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            drag.current = null
            setHeight((h) => {
              localStorage.setItem('drover:drawer-h', String(h))
              return h
            })
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
      <div className="drawer-head">
        <SquareTerminal size={13} />
        <span>{t('Terminal')}</span>
        <span className="drawer-dim">{thread.agent?.name ?? thread.paneId}</span>
        <div className="spacer" />
        <IconButton size="sm" title={t('Open full terminal view')} onClick={() => setViewMode(thread.paneId, 'terminal')}>
          <SquareTerminal size={13} />
        </IconButton>
        <IconButton size="sm" title={t('Hide (⌘J)')} onClick={() => toggleDrawer(thread.paneId, false)}>
          <PanelBottomClose size={13} />
        </IconButton>
      </div>
      <TerminalView key={thread.paneId} paneId={thread.paneId} autoFocus={thread.status === 'blocked'} className="drawer-term" />
    </div>
  )
}
