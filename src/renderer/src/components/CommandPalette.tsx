import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Bot, Crown, FolderPlus, Globe, Megaphone, PanelBottomOpen, PanelLeft, Settings, SquareTerminal, Users, Zap } from 'lucide-react'
import { isRemote } from '../api'
import { newTerminalTab, openNewAgent, openSettings } from '../actions'
import { t } from '../i18n'
import { fuzzyScore, statusLabel } from '../model'
import { getModel, nextAttention, select, selectedThread, toggleDrawer, togglePreview, useStore } from '../store'
import { AgentAvatar, StatusDot } from './primitives'

interface Entry {
  id: string
  title: string
  sub?: string
  icon: React.ReactNode
  right?: React.ReactNode
  run: () => void
  score: number
}

export function CommandPalette() {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => useStore.setState({ paletteOpen: false })

  const entries = useMemo(() => {
    const { threads } = getModel()
    const cur = selectedThread()
    const out: Entry[] = []
    for (const t of threads) {
      const text = `${t.name} ${t.subtitle} ${t.workspace.label} ${t.kind ?? 'terminal'} ${t.agent?.name ?? ''}`
      const score = fuzzyScore(q, text)
      if (!score) continue
      out.push({
        id: t.paneId,
        title: t.name,
        sub: `${t.workspace.label} · ${t.subtitle}`,
        icon: <AgentAvatar kind={t.kind} size={20} />,
        right: t.kind && t.status !== 'idle' && t.status !== 'unknown' ? (
          <span className="palette-status">
            <StatusDot status={t.status} size={7} /> {statusLabel(t.status)}
          </span>
        ) : undefined,
        run: () => select(t.paneId),
        score: score + (t.status === 'blocked' ? 5 : t.status === 'done' ? 3 : 0)
      })
    }
    const cmds: Omit<Entry, 'score'>[] = [
      ...(!isRemote ? [
        { id: 'cmd:boss', title: t('Main boss'), icon: <Crown size={16} />, run: () => useStore.setState({ sidebarHidden: false, dialog: { type: 'boss' } }) },
        { id: 'cmd:boss-broadcast', title: t('Assignment to all project leads'), icon: <Megaphone size={16} />, run: () => useStore.setState({ sidebarHidden: false, dialog: { type: 'boss-broadcast' } }) }
      ] : []),
      { id: 'cmd:new-agent', title: t('New agent…'), icon: <Bot size={16} />, right: <span className="kbd">⌘N</span>, run: () => openNewAgent({}) },
      { id: 'cmd:new-project', title: t('New project from folder…'), icon: <FolderPlus size={16} />, right: <span className="kbd">⌘⇧N</span>, run: () => openNewAgent({ workspaceId: null, pickFolder: true }) },
      { id: 'cmd:new-terminal', title: t('New terminal tab'), icon: <SquareTerminal size={16} />, run: () => void newTerminalTab(cur?.workspaceId ?? null, cur?.cwd) },
      ...(cur
        ? [
            { id: 'cmd:team', title: t('Start team in {project}…', { project: cur.workspace.label }), icon: <Users size={16} />, run: () => useStore.setState({ dialog: { type: 'team', workspaceId: cur.workspaceId } }) },
            { id: 'cmd:broadcast', title: t('Message several agents in {project}…', { project: cur.workspace.label }), icon: <Megaphone size={16} />, run: () => useStore.setState({ dialog: { type: 'broadcast', workspaceId: cur.workspaceId } }) },
            { id: 'cmd:preview', title: t('Toggle preview'), icon: <Globe size={16} />, right: <span className="kbd">⌘⇧P</span>, run: () => togglePreview(cur.workspaceId) }
          ]
        : []),
      { id: 'cmd:attention', title: t('Go to next agent needing attention'), icon: <Zap size={16} />, right: <span className="kbd">⌘⇧]</span>, run: () => nextAttention() },
      ...(cur ? [{ id: 'cmd:drawer', title: t('Toggle terminal panel'), icon: <PanelBottomOpen size={16} />, right: <span className="kbd">⌘J</span>, run: () => toggleDrawer(cur.paneId) }] : []),
      { id: 'cmd:sidebar', title: t('Toggle sidebar'), icon: <PanelLeft size={16} />, right: <span className="kbd">⌘B</span>, run: () => useStore.setState((s) => ({ sidebarHidden: !s.sidebarHidden })) },
      { id: 'cmd:settings', title: t('Settings'), icon: <Settings size={16} />, right: <span className="kbd">⌘,</span>, run: () => openSettings() }
    ]
    for (const c of cmds) {
      const score = fuzzyScore(q, c.title)
      if (score) out.push({ ...c, score: q ? score : -1 })
    }
    return q ? out.sort((a, b) => b.score - a.score) : out
  }, [q])

  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const run = (e: Entry) => {
    close()
    e.run()
  }

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label={t('Command palette')}>
        <input
          autoFocus
          className="palette-input"
          placeholder={t('Search agents, terminals and commands…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(entries.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter' && entries[idx]) {
              e.preventDefault()
              run(entries[idx])
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {entries.map((e, i) => (
            <button key={e.id} type="button" className={clsx('palette-item', i === idx && 'active')} onMouseMove={() => setIdx(i)} onClick={() => run(e)}>
              <span className="palette-icon">{e.icon}</span>
              <span className="palette-text">
                <span className="palette-title">{e.title}</span>
                {e.sub && <span className="palette-sub">{e.sub}</span>}
              </span>
              {e.right}
            </button>
          ))}
          {!entries.length && <div className="palette-empty">{t('Nothing found')}</div>}
        </div>
      </div>
    </div>
  )
}
