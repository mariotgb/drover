import '../styles/office.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { List, Maximize, RotateCcw, Search } from 'lucide-react'
import { t } from '../i18n'
import type { OfficeState, OfficeUpdate } from '@shared/office'
import { useStore } from '../store'
import { officeBridge } from './api'
import { OfficeEngine, type WorldLabel } from './engine'
import { roleLabel, statusLabel, coverageLabel, kindLabel, opensChat } from './labels'

export interface OfficeViewProps { active: boolean; onOpen(paneId: string): void }
export function OfficeView({ active, onOpen }: OfficeViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<OfficeEngine | null>(null)
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const [worldLabels, setWorldLabels] = useState<WorldLabel[]>([])
  const [state, setState] = useState<OfficeState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const [showTerminals, setShowTerminals] = useState(false)
  const [search, setSearch] = useState('')
  const [documentVisible, setDocumentVisible] = useState(!document.hidden)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const focused = useStore(s => s.windowFocused)
  const connected = useStore(s => s.connection.status === 'connected')
  const visible = active && documentVisible

  useEffect(() => {
    const visibility = () => setDocumentVisible(!document.hidden)
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => setReducedMotion(media.matches)
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', motion)
    return () => { document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion) }
  }, [])
  useEffect(() => {
    if (!canvas.current) return
    const renderer = new OfficeEngine(canvas.current, { onOpen: id => onOpenRef.current(id), onHover: setHovered, onLabels: setWorldLabels })
    engine.current = renderer
    return () => { engine.current = null; renderer.dispose() }
  }, [])
  useEffect(() => { engine.current?.setOptions(showTerminals, reducedMotion) }, [showTerminals, reducedMotion])
  useEffect(() => { engine.current?.setConnected(connected) }, [connected])
  useEffect(() => { engine.current?.setVisibility(visible, focused) }, [visible, focused])
  useEffect(() => {
    if (!visible || !connected) return
    const bridge = officeBridge()
    if (!bridge) { setError(t('The office is currently unavailable.')); return }
    let cancelled = false, received = false
    setError(null)
    const accept = (update: OfficeUpdate) => {
      if (cancelled) return
      engine.current?.update(received ? update : { ...update, animations: [] })
      received = true
      setState(update.state)
    }
    const unsubscribe = bridge.on.office(accept)
    void bridge.officeInit().then(initial => { if (initial && !received) accept({ state: initial, animations: [] }); else if (!initial && !cancelled) setError(t('The office is only available in the Mac app.')) }).catch(() => { if (!cancelled) setError(t('Could not load the office. Close this tab and open it again.')) })
    return () => { cancelled = true; unsubscribe(); bridge.officeStop() }
  }, [visible, connected])

  const departments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return state?.departments.map(department => {
      const matchDepartment = department.name.toLocaleLowerCase().includes(query)
      const agents = state.agents.filter(a => a.departmentId === department.id && (matchDepartment || `${a.name} ${kindLabel(a.kind)} ${roleLabel(a)} ${statusLabel(a.status)}`.toLocaleLowerCase().includes(query)))
      const terminals = showTerminals ? state.seats.filter(s => s.departmentId === department.id && s.terminal && s.paneId && (matchDepartment || s.paneId.toLocaleLowerCase().includes(query))) : []
      return { department, agents, terminals, visible: !query || matchDepartment || agents.length > 0 || terminals.length > 0 }
    }).filter(d => d.visible) ?? []
  }, [state, search, showTerminals])
  const hoverAgent = state?.agents.find(a => a.paneId === hovered)

  return (
    <section className="office office-view" hidden={!active} aria-label={t('Shared office')} style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <header className="office-head office-toolbar" style={{ flexWrap: 'wrap' }}>
        <h1 className="office-title">{t('Shared office')}</h1>
        <div className="office-tools office-camera-controls" role="group" aria-label={t('Camera')}>
          {[1, 2, 3].map(zoom => <button type="button" className="office-tool" key={zoom} onClick={() => engine.current?.zoom(zoom)} aria-label={t('Zoom {zoom}', { zoom })}>×{zoom}</button>)}
          <button type="button" className="office-tool" onClick={() => engine.current?.fit()}><Maximize size={14} />{t('Fit office')}</button>
          <button type="button" className="office-tool" onClick={() => engine.current?.reset()}><RotateCcw size={14} />{t('Reset camera')}</button>
        </div>
        <button type="button" className="office-tool" onClick={() => engine.current?.repack()}>{t('Rearrange seats')}</button>
        <button type="button" className="office-tool" aria-pressed={showList} aria-controls="office-agent-list" onClick={() => setShowList(v => !v)}><List size={14} />{t('List')}</button>
        <label className="check small"><input type="checkbox" checked={showTerminals} onChange={e => setShowTerminals(e.target.checked)} />{t('Show terminals')}</label>
        <ul className="office-legend" aria-label={t('Agent statuses')}>
          {(['working', 'blocked', 'idle', 'done', 'unknown', 'disconnect'] as const).map(status => <li key={status} className={`office-legend-item st-${status}`}><span className="office-mark" aria-hidden="true" />{statusLabel(status)}</li>)}
        </ul>
      </header>
      <div className="office-body" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="office-stage office-world">
          <canvas ref={canvas} aria-hidden="true" className="office-canvas" style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', imageRendering: 'pixelated' }} />
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
            {worldLabels.map(label => <span key={label.id} title={label.kind === 'user' ? t('You') : label.name} style={{ position: 'absolute', left: label.x, top: label.y, transform: 'translate(-50%, -50%)', fontSize: 11, lineHeight: '14px', color: '#fbe6c4', background: '#5b3d2a', padding: '0 3px', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label.kind === 'user' ? t('You') : label.name}</span>)}
          </div>
          {hoverAgent && <div className="office-tooltip" role="tooltip" style={{ bottom: 12, left: 12, transform: 'none' }}>
            <strong>{hoverAgent.name}</strong> · {kindLabel(hoverAgent.kind)}<br />{roleLabel(hoverAgent)} · {statusLabel(connected ? hoverAgent.status : 'disconnect')}
          </div>}
          {(!connected || error || !state || !state.departments.length) && <div className={connected ? 'office-empty' : 'office-stale'} role="status">
            {!connected ? t('Connection lost. The displayed data is stale.') : error ?? (!state ? t('Loading departments…') : t('No projects yet. Open a project to see it in the office.'))}
          </div>}
        </div>
        <aside id="office-agent-list" className="office-list" aria-label={t('Departments and agents')} hidden={!showList} style={{ display: showList ? 'flex' : 'none' }}>
          <label className="office-search"><Search size={14} /><span className="office-live">{t('Search departments and agents')}</span><input className="input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Name, role or status')} /></label>
          {departments.map(({ department, agents, terminals }) => <section className="office-dept office-department" key={department.id} aria-label={department.name}>
            <h2 className="office-dept-head" style={{ margin: 0 }}><span className="office-dept-name">{department.name}</span><span className="office-dept-count" aria-hidden="true">{agents.length + terminals.length}</span></h2>
            {!agents.length && !terminals.length && <p className="muted">{t('No agents')}</p>}
            <ul className="office-agents" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {agents.map(a => <li key={a.id} className="office-agent" data-status={a.status}>
                <span className="office-agent-text">
                  <strong className="office-agent-name">{a.name}</strong>
                  <span className="office-agent-meta" title={roleLabel(a)}>{kindLabel(a.kind)} · {roleLabel(a)}</span>
                  <span className={`office-status st-${connected ? a.status : 'disconnect'}`}><span className="office-mark" aria-hidden="true" />{connected ? statusLabel(a.status) : statusLabel('disconnect')}</span>
                  {coverageLabel(a.transcriptCoverage) && <span className="office-agent-meta" title={coverageLabel(a.transcriptCoverage)}>{coverageLabel(a.transcriptCoverage)}</span>}
                </span>
                <button type="button" className="office-agent-open" disabled={!connected} onClick={() => onOpen(a.paneId)} aria-label={opensChat(a) ? t('Open chat: {name}', { name: a.name }) : t('Open terminal: {name}', { name: a.name })}>{opensChat(a) ? t('Open chat') : t('Open terminal')}</button>
              </li>)}
              {terminals.map(s => <li className="office-agent office-terminal" key={s.id}><span className="office-agent-text"><strong className="office-agent-name">{t('Terminal')}</strong><span className="office-agent-meta">{s.paneId}</span></span><button type="button" className="office-agent-open" disabled={!connected} onClick={() => onOpen(s.paneId!)} aria-label={t('Open terminal: {name}', { name: s.paneId! })}>{t('Open terminal')}</button></li>)}
            </ul>
          </section>)}
          {state && search && !departments.length && <p role="status">{t('No matches')}</p>}
        </aside>
      </div>
      <p className="office-help muted">{t('Drag the office or scroll your trackpad to move. Links show observed events.')}</p>
    </section>
  )
}
