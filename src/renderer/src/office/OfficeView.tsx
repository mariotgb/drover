import '../styles/office.css'
import './hud.css'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { Check, ChevronLeft, ChevronRight, Crosshair, Link2, List, Maximize, MessageSquare, Search, Send, Terminal, X } from 'lucide-react'
import { t } from '../i18n'
import type { OfficeAgent, OfficeState, OfficeStatus, OfficeUpdate } from '@shared/office'
import { useModel, useStore, watchBoard } from '../store'
import { isDarkTheme, onAppearanceChange } from '../appearance'
import { officeBridge } from './api'
import { OfficeEngine, type MapSnapshot, type WorldLabel } from './engine'
import { roleLabel, statusLabel, coverageLabel, kindLabel, opensChat } from './labels'
import { eventAge, journalText, officeText } from './text'
import { officeProjectPreferences } from './project-preferences'
import { adjacentHall } from './navigation'
import { OfficeViewData, officeViewState, sameOfficeView, visibleOfficeEvents } from './view-state'
import { officeClock } from './clock'
import { reconcileOffice } from './reconcile'

export interface OfficeViewProps { active: boolean; onOpen(paneId: string, mode?: 'chat' | 'terminal'): void }
const AgentPortrait = memo(function AgentPortrait({ agent, engine, revision }: { agent: OfficeAgent; engine: RefObject<OfficeEngine | null>; revision: unknown }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (canvas.current) engine.current?.portrait(agent.paneId, canvas.current) }, [agent.paneId, agent.kind, agent.role, engine, revision])
  return <span className="office-member-face"><canvas ref={canvas} width={32} height={48} aria-hidden="true" /></span>
})
export function OfficeView({ active, onOpen }: OfficeViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null), mapCanvas = useRef<HTMLCanvasElement>(null), engine = useRef<OfficeEngine | null>(null)
  const open = useRef(onOpen), initialHall = useRef(false); open.current = onOpen
  const [worldLabels, setWorldLabels] = useState<WorldLabel[]>([]), [map, setMap] = useState<MapSnapshot | null>(null)
  const [state, setState] = useState<OfficeState | null>(null), [error, setError] = useState<string | null>(null)
  const viewState = useRef<OfficeState | null>(null)
  const [hovered, setHovered] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true), [showTerminals, setShowTerminals] = useState(false), [showLinks, setShowLinks] = useState(true)
  const [search, setSearch] = useState(''), [hall, setHall] = useState<string | null>(null), [status, setStatus] = useState<OfficeStatus | null>(null)
  const [documentVisible, setDocumentVisible] = useState(!document.hidden), [dark, setDark] = useState(isDarkTheme)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [portraitRevision, setPortraitRevision] = useState(0)
  const [retry, setRetry] = useState(0), data = useRef(new OfficeViewData()).current
  const focused = useStore(s => s.windowFocused), connected = useStore(s => s.connection.status === 'connected'), lang = useStore(s => s.settings.language)
  const groupKeys = useModel(m => m.groups.map(g => JSON.stringify([g.workspace.workspace_id, g.cwd])))
  const groups = useMemo(() => groupKeys.map(k => { const [id, cwd] = JSON.parse(k); return { workspace: { workspace_id: id }, cwd } }), [groupKeys])
  const projectOrder = useStore(s => s.settings.projectOrder), projectImportance = useStore(s => s.settings.projectImportance)
  const projectPreferences = useMemo(() => officeProjectPreferences(state, groups, { projectOrder, projectImportance }), [state?.departments, groups, projectOrder, projectImportance])
  const hallIds = projectPreferences.departments.map(d => d.id), hallStep = useRef<(direction: number) => void>(() => {})
  hallStep.current = direction => setHall(current => adjacentHall(hallIds, current, direction))
  useEffect(() => { engine.current?.setProjectPreferences(projectPreferences.departments.map(d => d.id), projectPreferences.importance) }, [projectPreferences])
  useEffect(() => { engine.current?.setHall(hall) }, [hall, state?.departments])
  useEffect(() => { if (hall && selected && state?.agents.find(a => a.paneId === selected)?.departmentId !== hall) setSelected(null) }, [hall, selected, state?.agents])
  const selectedPaneId = useStore(s => s.selectedPaneId), selectedWorkspace = useModel(m => selectedPaneId ? m.byPane.get(selectedPaneId)?.workspaceId : null), visible = active && documentVisible
  const boardRoots = [...new Set(state?.departments.flatMap(d => groups.filter(g => (d.workspaceIds ?? [d.workspaceId]).includes(g.workspace.workspace_id)).flatMap(g => g.cwd ? [g.cwd] : [])) ?? [])].sort().join('\0')
  const myHall = state?.departments.find(d => d.workspaceIds.includes(selectedWorkspace ?? ''))?.id ?? state?.departments[0]?.id ?? null
  useEffect(() => {
    const visibility = () => setDocumentVisible(!document.hidden), media = window.matchMedia('(prefers-reduced-motion: reduce)'), motion = () => setReducedMotion(media.matches)
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', motion)
    const off = onAppearanceChange(() => setDark(isDarkTheme()))
    return () => { document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion); off() }
  }, [])
  useEffect(() => {
    if (!canvas.current) return
    const renderer = new OfficeEngine(canvas.current, { onOpen: id => open.current(id), onSelect: setSelected, onHover: setHovered, onLabels: setWorldLabels, onMap: setMap, onHallStep: direction => hallStep.current(direction) })
    engine.current = renderer
    return () => { engine.current = null; renderer.dispose() }
  }, [])
  useEffect(() => {
    const target = canvas.current; if (!target) return
    const apply = () => engine.current?.setOptions(showTerminals, reducedMotion, showLinks, showList ? target.getBoundingClientRect().width <= 900 ? 274 : 312 : 0)
    apply(); const observer = new ResizeObserver(apply); observer.observe(target)
    return () => observer.disconnect()
  }, [showTerminals, reducedMotion, showLinks, showList])
  useEffect(() => { let cancelled = false; void engine.current?.setTheme(dark).then(() => { if (!cancelled) setPortraitRevision(n => n + 1) }); return () => { cancelled = true } }, [dark])
  useEffect(() => { engine.current?.setConnected(connected) }, [connected])
  useEffect(() => { engine.current?.setVisibility(visible, focused) }, [visible, focused])
  useEffect(() => { if (!visible || !connected || !boardRoots) return; const release = boardRoots.split('\0').map(watchBoard); return () => release.forEach(off => off()) }, [visible, connected, boardRoots])
  useEffect(() => {
    engine.current?.setDepartment(hall ?? myHall)
    if (myHall && !hall && !initialHall.current) { initialHall.current = true; engine.current?.home() }
  }, [myHall, hall])
  useEffect(() => { engine.current?.select(selected) }, [selected])
  useEffect(() => { if (mapCanvas.current) engine.current?.paintMap(mapCanvas.current) }, [map, dark])
  useEffect(() => {
    if (!visible || !connected) return
    const bridge = officeBridge(); if (!bridge) { setError(t('The office is currently unavailable.')); return }
    let cancelled = false, received = false, recovering = false, current: OfficeState | null = null; setError(null)
    const publish = (next: OfficeState, animations: OfficeUpdate['animations'], baseline: boolean) => {
      if (baseline) engine.current?.resetBaseline()
      engine.current?.update({ state: next, animations: baseline ? [] : animations })
      current = next; received = true; data.update(next)
      const view = officeViewState(viewState.current, next)
      if (view !== viewState.current) { viewState.current = view; setState(view) }
    }
    const recover = async () => {
      if (recovering) return
      recovering = true
      try {
        const initial = await bridge.officeInit()
        if (cancelled) return
        if (initial) publish(reconcileOffice(null, { state: initial, animations: [] })!, [], true)
        else setError(t('The office is only available in the Mac app.'))
      } catch { if (!cancelled) setError(t('Could not load the office. Close this tab and open it again.')) }
      finally { recovering = false }
    }
    const accept = (update: OfficeUpdate) => {
      if (cancelled || recovering) return
      const next = reconcileOffice(current, update)
      if (!next) { void recover(); return }
      publish(next, update.animations, !received)
    }
    const off = bridge.on.office(accept)
    // During initial subscription a newer full update may beat officeInit.
    void bridge.officeInit().then(initial => {
      if (cancelled || received || recovering) return
      if (initial) publish(reconcileOffice(null, { state: initial, animations: [] })!, [], true)
      else setError(t('The office is only available in the Mac app.'))
    }).catch(() => { if (!cancelled) setError(t('Could not load the office. Close this tab and open it again.')) })
    return () => { cancelled = true; off(); bridge.officeStop() }
  }, [visible, connected, retry, data])
  // Closing panes/projects also closes stale cards and filters.
  useEffect(() => {
    if (!state) return
    if (selected && !state.agents.some(a => a.paneId === selected)) setSelected(null)
    if (hall && !state.departments.some(d => d.id === hall)) setHall(null)
  }, [state, selected, hall])
  const departments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return projectPreferences.departments.filter(d => !hall || d.id === hall).map(department => ({
      department,
      agents: state?.agents.filter(a => a.departmentId === department.id && (!status || (connected ? a.status : 'disconnect') === status) && (!query || `${department.name} ${a.name} ${kindLabel(a.kind)} ${roleLabel(a)} ${statusLabel(connected ? a.status : 'disconnect')}`.toLocaleLowerCase().includes(query))) ?? [],
      terminals: showTerminals && !status ? state?.seats.filter(s => s.departmentId === department.id && s.terminal && s.paneId && (!query || `${department.name} ${s.paneId}`.toLocaleLowerCase().includes(query))) ?? [] : []
    })) ?? []
  }, [state, projectPreferences, search, hall, status, showTerminals, lang, connected])
  const cardAgent = state?.agents.find(a => a.paneId === selected), hoverAgent = state?.agents.find(a => a.paneId === hovered)
  const counts = connected ? state?.statusCounts ?? { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0, disconnect: 0 } : { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0, disconnect: state?.agents.length ?? 0 }

  const selectAgent = useCallback((id: string | null) => setSelected(id), [])
  const actions = useCallback((a: OfficeAgent, className = 'office-member-actions') => <div className={className}>
    {opensChat(a) && <button type="button" className="office-btn primary" disabled={!connected} onClick={() => onOpen(a.paneId, 'chat')}><MessageSquare size={14} />{t('Open chat')}</button>}
    <button type="button" className="office-btn" onClick={() => { setSelected(a.paneId); engine.current?.locate(a.paneId) }}><Crosshair size={14} />{officeText('On map')}</button>
    <button type="button" className="office-btn" disabled={!connected} aria-label={t('Open terminal: {name}', { name: a.name })} title={t('Terminal')} onClick={() => onOpen(a.paneId, 'terminal')}><Terminal size={14} /></button>
  </div>, [connected, onOpen])
  const visitHall = (id: string | null) => { setHall(id); engine.current?.setHall(id); engine.current?.fit() }
  return <section className="office office-view office-v2" hidden={!active} aria-label={t('Shared office')} data-office-theme={dark ? 'neon' : 'cozy'} data-single-hall={!!hall} tabIndex={0} onKeyDown={e => {
    if (!active || !hall || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
    e.preventDefault(); hallStep.current(e.key === 'ArrowRight' ? 1 : -1)
  }}>
    <div className="office-stage office-world">
      <BoardCounts engine={engine} departments={state?.departments ?? EMPTY_DEPARTMENTS} groups={groups} />
      <canvas ref={canvas} className="office-canvas" aria-hidden="true" />
      <div className="office-world-labels" aria-hidden="true">{worldLabels.map(label => <span key={label.id} className={`office-world-label office-world-label-${label.kind}`} style={{ left: label.x, top: label.y }}>{label.kind === 'user' ? t('You') : label.name}</span>)}</div>
      <div className={`office-hud${showList ? ' with-team' : ''}`}>
        <header className="office-panel office-toolbar">
          <div className="office-toolbar-row">
            <h1 className="office-title">{t('Shared office')}</h1>
            <div className="office-hall-filter" role="group" aria-label={officeText('Hall filter')}>
              <button type="button" className={`office-chip${!hall ? ' active' : ''}`} aria-pressed={!hall} onClick={() => visitHall(null)}>{officeText('All halls')}</button>
              {projectPreferences.departments.map(d => <button key={d.id} type="button" className={`office-chip${hall === d.id ? ' active' : ''}`} data-importance={projectPreferences.importance.get(d.id)} aria-pressed={hall === d.id} onClick={() => visitHall(d.id)}>{d.name} <span>{state?.agents.filter(a => a.departmentId === d.id).length}</span></button>)}
            </div>
          </div>
          <div className="office-toolbar-row" role="group" aria-label={t('Camera')}>
            {hall && <div className="office-hall-navigation" role="group" aria-label={t('Single hall')}>
              <button type="button" className="office-btn" disabled={hallIds.length < 2} aria-label={t('Previous hall')} title={t('Previous hall')} onClick={() => hallStep.current(-1)}><ChevronLeft size={16} /></button>
              <span>{t('Single hall')} · {hallIds.indexOf(hall) + 1}/{hallIds.length}</span>
              <button type="button" className="office-btn" disabled={hallIds.length < 2} aria-label={t('Next hall')} title={t('Next hall')} onClick={() => hallStep.current(1)}><ChevronRight size={16} /></button>
            </div>}
            <div className="office-seg">{[1, 2, 3].map(z => <button type="button" className={`office-btn${map?.camera.zoom === z ? ' active' : ''}`} key={z} aria-pressed={map?.camera.zoom === z} onClick={() => engine.current?.zoom(z)} aria-label={t('Zoom {zoom}', { zoom: z })}>×{z}</button>)}</div>
            <button type="button" className="office-btn" onClick={() => engine.current?.fit()}><Maximize size={14} />{hall ? t('Fit hall') : t('Fit office')}</button>
            <button type="button" className="office-btn" onClick={() => visitHall(myHall)}><Crosshair size={14} />{officeText('My hall')}</button>
            <button type="button" className={`office-btn${showLinks ? ' active' : ''}`} aria-pressed={showLinks} onClick={() => setShowLinks(v => !v)}><Link2 size={14} />{officeText('Links')}</button>
            <button type="button" className={`office-btn${showTerminals ? ' active' : ''}`} aria-pressed={showTerminals} aria-label={t('Show terminals')} title={t('Show terminals')} onClick={() => setShowTerminals(v => !v)}><Terminal size={14} /></button>
            <button type="button" className="office-btn" aria-pressed={showList} aria-controls="office-agent-list" onClick={() => setShowList(v => !v)}><List size={14} />{officeText('Team')}</button>
          </div>
        </header>
        {showList && <OfficeTeam departments={departments} total={state?.agents.length ?? 0} counts={counts} status={status} setStatus={setStatus} search={search} setSearch={setSearch} importance={projectPreferences.importance} selected={selected} selectAgent={selectAgent} engine={engine} portraitRevision={`${dark}:${lang}:${portraitRevision}`} connected={connected} active={visible} actions={actions} onOpen={onOpen} />}
        <OfficeJournal data={data} hall={hall} active={visible} lang={lang} />
        <aside className="office-panel office-map" aria-label={officeText('Map')}>
          <h2>{officeText('Map')}</h2>
          <button type="button" className="office-map-view" aria-label={officeText('Move camera on map')} onClick={e => { if (!mapCanvas.current) return; if (e.detail === 0) { if (map) engine.current?.center({ x: map.bounds.x + map.bounds.width / 2, y: map.bounds.y + map.bounds.height / 2 }); return }; const r = mapCanvas.current.getBoundingClientRect(); engine.current?.mapPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height) }} onKeyDown={e => {
            if (!map || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
            if (hall && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); hallStep.current(e.key === 'ArrowRight' ? 1 : -1); return }
            e.preventDefault(); const p = { x: (map.width / 2 - map.camera.x) / map.camera.zoom, y: (map.height / 2 - map.camera.y) / map.camera.zoom }
            p.x += e.key === 'ArrowLeft' ? -48 : e.key === 'ArrowRight' ? 48 : 0; p.y += e.key === 'ArrowUp' ? -48 : e.key === 'ArrowDown' ? 48 : 0
            engine.current?.center(p)
          }}><canvas ref={mapCanvas} width={210} height={112} aria-hidden="true" /></button>
        </aside>
        {cardAgent && <aside className="office-panel office-card" aria-label={officeText('Agent card')} onKeyDown={e => { if (e.key === 'Escape') setSelected(null) }}>
          <button type="button" className="office-btn office-card-close" aria-label={officeText('Close card')} onClick={() => setSelected(null)}><X size={14} /></button>
          <div className="office-card-heading"><AgentPortrait agent={cardAgent} engine={engine} revision={`${dark}:${lang}:${portraitRevision}`} /><div className="office-card-identity"><strong className="office-card-name">{cardAgent.name}</strong><div className="office-card-meta">{kindLabel(cardAgent.kind)} · {roleLabel(cardAgent)}</div><span className={`office-member-status st-${connected ? cardAgent.status : 'disconnect'}`}><span className="office-mark" aria-hidden="true" />{statusLabel(connected ? cardAgent.status : 'disconnect')}</span></div></div>
          <div className="office-card-task"><span>{officeText('Last task')}</span><p>{cardAgent.lastTask ?? officeText('No assigned task')}</p></div>
          {coverageLabel(cardAgent.transcriptCoverage) && <p className="office-card-meta">{coverageLabel(cardAgent.transcriptCoverage)}</p>}
          {actions(cardAgent, 'office-card-actions')}
        </aside>}
        {hoverAgent && !cardAgent && <div className="office-tooltip" role="tooltip"><strong>{hoverAgent.name}</strong><br />{roleLabel(hoverAgent)} · {statusLabel(connected ? hoverAgent.status : 'disconnect')}</div>}
        {!!counts.blocked && connected && <button type="button" className="office-btn office-waiting" onClick={() => { setStatus('blocked'); setShowList(true); setHall(null) }}>{officeText('{n} waiting', { n: counts.blocked })}</button>}
      </div>
      {!connected && <div className="office-stale" role="status">{t('Connection lost. The displayed data is stale.')}</div>}
      {error && <div className="office-empty" role="alert">{error}<br /><button type="button" className="office-btn" onClick={() => setRetry(n => n + 1)}>{officeText('Retry')}</button></div>}
      {!error && state && !state.departments.length && <div className="office-empty">{t('No projects yet. Open a project to see it in the office.')}</div>}
      {!error && !state && <div className="office-empty" role="status">{t('Loading departments…')}</div>}
      <div className="office-live" role="status" aria-live="polite">{cardAgent ? `${cardAgent.name}: ${statusLabel(connected ? cardAgent.status : 'disconnect')}` : ''}</div>
    </div>
  </section>
}

const EMPTY_DEPARTMENTS: OfficeState['departments'] = []
type ProjectGroup = { workspace: { workspace_id: string }; cwd: string | null }
function BoardCounts({ engine, departments, groups }: { engine: RefObject<OfficeEngine | null>; departments: OfficeState['departments']; groups: ProjectGroup[] }) {
  const boards = useStore(s => s.boards)
  useEffect(() => {
    const counts = new Map<string, [number, number, number]>()
    for (const d of departments) {
      const roots = [...new Set(groups.filter(g => d.workspaceIds.includes(g.workspace.workspace_id)).flatMap(g => g.cwd ? [g.cwd] : []))]
      const tasks = roots.flatMap(root => boards[root]?.tasks ?? [])
      counts.set(d.id, [tasks.filter(task => task.status === 'todo').length, tasks.filter(task => ['in_progress', 'review', 'blocked'].includes(task.status)).length, tasks.filter(task => task.status === 'done').length])
    }
    engine.current?.setBoardCounts(counts)
  }, [boards, groups, departments])
  return null
}
function EventAge({ at, active }: { at: number | null; active: boolean }) {
  const subscribe = useCallback((listener: () => void) => active ? officeClock.subscribe(listener) : () => {}, [active])
  const get = useCallback(() => at === null ? officeText('No events in 30 minutes') : eventAge(at, officeClock.get()), [at])
  return <>{useSyncExternalStore(subscribe, get)}</>
}
function useOfficeProjection<T>(data: OfficeViewData, select: (state: OfficeState | null) => T): T {
  const cached = useRef<{ value: T } | null>(null)
  const get = useCallback(() => {
    const value = select(data.get())
    if (!cached.current || !sameOfficeView(cached.current.value, value)) cached.current = { value }
    return cached.current.value
  }, [data, select])
  return useSyncExternalStore(data.subscribe, get)
}
const OfficeJournal = memo(function OfficeJournal({ data, hall, active, lang }: { data: OfficeViewData; hall: string | null; active: boolean; lang: string }) {
  const select = useCallback((state: OfficeState | null) => visibleOfficeEvents(state, hall).map(e => ({ ...e, text: state ? journalText(e, state) : '' })), [hall, lang])
  const events = useOfficeProjection(data, select)
  return <aside className="office-panel office-journal-panel" aria-label={officeText('Journal')}>
    <h2>{officeText('Journal')}</h2>
    {!events.length && <p>{officeText('No events in 30 minutes')}</p>}
    <ol className="office-journal">{events.map(e => <li key={e.id} className={`office-journal-item ev-${e.kind}`}>
      <span className="office-journal-icon" aria-hidden="true">{e.kind === 'prompt_attempt' ? <X size={13} /> : e.kind === 'ssh_attempt' ? <Terminal size={13} /> : e.kind === 'agent_status' && e.status === 'done' ? <Check size={13} /> : <Send size={13} />}</span>
      <span>{e.text}</span><time dateTime={new Date(e.ts).toISOString()}><EventAge at={e.ts} active={active} /></time>
    </li>)}</ol>
  </aside>
})
interface TeamProps {
  departments: { department: OfficeState['departments'][number]; agents: OfficeAgent[]; terminals: OfficeState['seats'] }[]
  total: number; counts: OfficeState['statusCounts']; status: OfficeStatus | null
  setStatus: React.Dispatch<React.SetStateAction<OfficeStatus | null>>
  search: string; setSearch(value: string): void; importance: Map<string, import('@shared/projects').ProjectImportance>
  selected: string | null; selectAgent(value: string | null): void; engine: RefObject<OfficeEngine | null>; portraitRevision: string
  connected: boolean; active: boolean; actions(agent: OfficeAgent): React.ReactNode; onOpen: OfficeViewProps['onOpen']
}
const OfficeTeam = memo(function OfficeTeam({ departments, total, counts, status, setStatus, search, setSearch, importance, selected, selectAgent, engine, portraitRevision, connected, active, actions, onOpen }: TeamProps) {
  return <aside id="office-agent-list" className="office-panel office-team" aria-label={officeText('Team')}>
          <h2 className="office-team-head">{officeText('Team')} <span>{total}</span></h2>
          <div className="office-filters" role="group" aria-label={officeText('Status filter')}>
            {(['working', 'blocked', 'done', 'idle', 'unknown', 'disconnect'] as const).filter(s => counts[s] || ['working', 'blocked', 'done', 'idle'].includes(s)).map(s => <button key={s} type="button" className={`office-filter st-${s}${status === s ? ' active' : ''}`} aria-pressed={status === s} onClick={() => setStatus(previous => previous === s ? null : s)}><span className="office-mark" aria-hidden="true" /><b>{counts[s]}</b>{statusLabel(s)}</button>)}
          </div>
          <label className="office-search"><Search size={14} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Name, role or status')} aria-label={t('Search departments and agents')} /></label>
          <div className="office-team-list">{departments.filter(d => d.agents.length || d.terminals.length).map(({ department, agents, terminals }) => <section key={department.id} aria-label={department.name}>
            <h3 className="office-team-dept" data-importance={importance.get(department.id)}><span>{department.name}</span><span>{agents.length}</span></h3>
            <ul className="office-agents">{agents.map(a => <li key={a.id} className={`office-member${selected === a.paneId ? ' selected' : ''}`}>
              <button type="button" className="office-member-select" aria-label={`${officeText('Agent card')} · ${a.name}`} aria-pressed={selected === a.paneId} onClick={() => selectAgent(a.paneId)}>
                <AgentPortrait agent={a} engine={engine} revision={portraitRevision} />
                <span className="office-agent-text"><strong className="office-member-name">{a.name}</strong><span className="office-member-meta">{kindLabel(a.kind)} · {roleLabel(a)}</span><span className={`office-member-status st-${connected ? a.status : 'disconnect'}`}><span className="office-mark" aria-hidden="true" />{statusLabel(connected ? a.status : 'disconnect')}</span></span>
              </button>
              <span className="office-member-event"><EventAge at={a.lastEventAt} active={active} /></span>
              {(selected === a.paneId || !opensChat(a)) && actions(a)}
            </li>)}{terminals.map(s => <li key={s.id} className="office-member office-terminal"><Terminal size={16} /><span>{t('Terminal')}</span><button type="button" className="office-btn" disabled={!connected} onClick={() => onOpen(s.paneId!, 'terminal')}>{t('Open terminal')}</button></li>)}</ul>
          </section>)}</div>
          {!departments.some(d => d.agents.length || d.terminals.length) && <p>{officeText('No matching agents')}</p>}
        </aside>
})
