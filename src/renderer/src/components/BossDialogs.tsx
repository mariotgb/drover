import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen, RefreshCw, TriangleAlert } from 'lucide-react'
import type { BossDelivery, BossProject, BossRoster, BossSettings } from '@shared/boss'
import { agentKindDef } from '@shared/agents'
import { choiceFor, modelArgs, supportsModels, type ModelChoice } from '@shared/models'
import { api, errorText, humanizeError, isRemote } from '../api'
import { defaultBossProjects, mergeBossDeliveries } from '../boss'
import { t } from '../i18n'
import { shortPath } from '../model'
import { BOSS_HQ_INSTRUCTIONS, bossRole } from '../roles'
import { installedDefaultAgent } from '../new-agent-kind'
import { select, useStore } from '../store'
import { Modal } from './Modal'
import { ModelFields } from './ModelPicker'
import { AgentAvatar, Spinner, StatusDot } from './primitives'

function useBossData() {
  const [roster, setRoster] = useState<BossRoster | null>(null)
  const [settings, setSettings] = useState<BossSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  const load = async () => {
    if (isRemote) return
    setLoading(true)
    setError(null)
    try {
      const [r, s] = await Promise.all([api.bossRoster(), api.bossSettings()])
      if (alive.current) { setRoster(r); setSettings(s) }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
    // Mount or explicit refresh only: sending revalidates the live registry in main.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { roster, settings, error, loading, load, setRoster, setSettings, setError }
}

function LeadDescription({ project }: { project: BossProject }) {
  if (!project.lead) return <span className="field-hint">{t('No project lead')}</span>
  return <span className="boss-lead">
    <AgentAvatar kind={project.lead.kind} size={18} />
    <span>{project.lead.name}</span>
    <StatusDot status={project.lead.status} size={7} />
    {project.lead.status === 'blocked' && <span className="field-hint warn">{t('Needs your answer — skipped')}</span>}
  </span>
}

function DeliveryStatus({ delivery }: { delivery: BossDelivery }) {
  const label = (() => {
    switch (delivery.status) {
      case 'delivered': return t('Delivered')
      case 'queued': return t('Agent busy — queued')
      case 'blocked': return t('Needs your answer — skipped')
      case 'no_lead': return t('No project lead')
      case 'excluded': return t('Project excluded')
      case 'error': return t('Delivery failed')
    }
  })()
  return <div className={`boss-delivery ${delivery.status}`}>
    {delivery.status === 'delivered' ? <Check size={14} /> : delivery.status === 'queued' ? <Spinner size={13} /> : <TriangleAlert size={14} />}
    <span>{label}{delivery.error && <span className="boss-delivery-error">{humanizeError(delivery.code, delivery.error)}</span>}</span>
  </div>
}

export function BossDialog() {
  const pending = useRef(false)
  if (isRemote) return null
  return <Modal title={t('Main boss')} onClose={() => { if (!pending.current) useStore.setState({ dialog: null }) }} width={660}>
    <BossSettingsPane dialog onBusy={value => { pending.current = value }} />
  </Modal>
}

export function BossSettingsPane({ dialog = false, onBusy }: { dialog?: boolean; onBusy?: (busy: boolean) => void }) {
  const data = useBossData()
  const kinds = useStore(s => s.kinds)
  const home = useStore(s => s.home)
  const defaultKind = useStore(s => s.settings.defaultAgentKind)
  const catalog = useStore(s => s.models)
  const [kind, setKind] = useState<string | null>(() => installedDefaultAgent(defaultKind, kinds))
  const [modelChoice, setModelChoice] = useState<ModelChoice>(() => useStore.getState().settings.agentModels[kind ?? ''] ?? {})
  const pickedKind = useRef(false)
  const [folder, setFolder] = useState('')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'save' | 'open' | 'pick' | 'check' | null>(null)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => { onBusy?.(!!busy) }, [busy, onBusy])
  useEffect(() => {
    if (pickedKind.current) return
    const next = installedDefaultAgent(defaultKind, kinds)
    setKind(next)
    setModelChoice(useStore.getState().settings.agentModels[next ?? ''] ?? {})
  }, [defaultKind, kinds])
  useEffect(() => {
    if (!data.settings) return
    setFolder(data.settings.hqFolder)
    setExcluded(new Set(data.settings.excludedProjects))
    setDirty(false)
  }, [data.settings])
  if (isRemote) return null
  const installed = kinds.filter(k => k.installed)
  const missing = !kind || !installed.some(k => k.kind === kind)
  const save = async () => {
    if (busy || !data.settings) return
    setBusy('save'); data.setError(null); setNotice(null)
    try {
      const s = await api.setBossSettings({ excludedProjects: [...excluded], hqFolder: folder })
      data.setSettings(s)
      await data.load()
      setNotice(t('Boss settings saved'))
    } catch (e) { data.setError(errorText(e)) }
    finally { setBusy(null) }
  }
  const open = async () => {
    if (busy || missing || !kind || !data.settings || dirty) return
    setBusy('open'); data.setError(null); setNotice(null)
    try {
      const result = await api.openBoss({ kind, folder, args: modelArgs(kind, choiceFor(kind, modelChoice, catalog)), prompt: bossRole(kind).instructions })
      if (!result.ok || !result.paneId) { data.setError(humanizeError(result.code, result.error)); return }
      select(result.paneId)
      if (result.needsAttention) {
        useStore.setState(s => ({ drawer: { ...s.drawer, [result.paneId!]: true } }))
        data.setError(result.code || result.error ? humanizeError(result.code, result.error) : t('Open the terminal panel and answer the agent’s startup question.'))
      } else useStore.setState({ dialog: null })
    } catch (e) { data.setError(errorText(e)) }
    finally { setBusy(null) }
  }
  return <div className="form boss-form">
    <p className="setting-hint block">{t('A real agent in HQ coordinates project leads and keeps its own task board. It waits for your assignment after startup.')}</p>
    <div className="field">
      <label htmlFor="boss-kind">{t('Agent')}</label>
      <select id="boss-kind" className="input select" value={kind ?? ''} disabled={!!busy || !installed.length} onChange={e => {
        pickedKind.current = true
        setKind(e.target.value)
        setModelChoice(useStore.getState().settings.agentModels[e.target.value] ?? {})
      }}>
        {!kind && <option value="">{t('No installed agents')}</option>}
        {installed.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        {kind && missing && <option value={kind} disabled>{agentKindDef(kind)?.label ?? kind}</option>}
      </select>
      {missing && <span className="field-hint warn">{kind ? t('Install {agent} on this computer before starting the boss.', { agent: agentKindDef(kind)?.label ?? kind }) : t('Install a supported agent on this computer, then check again.')}</span>}
      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={async () => {
        setBusy('check'); data.setError(null)
        try { useStore.setState({ kinds: await api.agentKinds() }) }
        catch { data.setError(t('Could not refresh installed agents. Try again.')) }
        finally { setBusy(null) }
      }}>{busy === 'check' && <Spinner size={13} />}{t('Check again')}</button>
    </div>
    {supportsModels(kind) && <div className="field"><label>{t('Model and reasoning')}</label><ModelFields kind={kind} value={modelChoice} disabled={!!busy} onChange={value => { pickedKind.current = true; setModelChoice(value) }} /></div>}
    <p className="field-hint">{t('Agent and model choices apply when creating a new boss. An existing boss opens with its current settings.')}</p>
    <div className="field">
      <label>{t('HQ folder')}</label>
      <div className="boss-folder">
        <span className="path" title={folder}>{shortPath(folder, home) || t('Loading…')}</span>
        <button type="button" className="btn btn-sm" disabled={!!busy || !data.settings} onClick={async () => {
          setBusy('pick')
          try { const p = await api.pickFolder(folder); if (p) { setFolder(p); setDirty(true); setNotice(null) } }
          catch (e) { data.setError(errorText(e)) }
          finally { setBusy(null) }
        }}><FolderOpen size={14} />{t('Choose folder…')}</button>
      </div>
    </div>
    <div className="field">
      <div className="setting-block-head"><span>{t('Included projects')}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label={t('Refresh')} disabled={!!busy || data.loading || dirty} onClick={() => void data.load()}><RefreshCw size={13} /></button>
      </div>
      <p className="field-hint">{t('Unchecked projects receive no assignments from the boss or quick broadcast. New projects are included by default.')}</p>
      <div className="team-rows compact boss-projects">
        {data.roster?.projects.map(p => <label key={p.key} className="team-row">
          <input type="checkbox" checked={!excluded.has(p.key)} disabled={!!busy} onChange={e => {
            setExcluded(prev => { const next = new Set(prev); if (e.target.checked) next.delete(p.key); else next.add(p.key); return next })
            setDirty(true); setNotice(null)
          }} />
          <div className="team-role"><div className="team-role-name">{p.name}</div><div className="team-role-sub" title={p.cwd ?? p.key}>{shortPath(p.cwd ?? p.key, home)}</div><LeadDescription project={p} /></div>
        </label>)}
        {data.roster && !data.roster.projects.length && <p className="hint">{t('No projects yet')}</p>}
        {!data.roster && data.loading && <Spinner />}
      </div>
    </div>
    <details className="boss-instructions"><summary>{t('Built-in boss role')}</summary><pre>{BOSS_HQ_INSTRUCTIONS}</pre></details>
    {data.error && <div className="form-error" role="alert">{data.error}</div>}
    {notice && <p className="field-hint" role="status">{notice}</p>}
    <div className="form-actions">
      {dialog && <button type="button" className="btn" disabled={!!busy} onClick={() => useStore.setState({ dialog: null })}>{t('Close')}</button>}
      <button type="button" className="btn" disabled={!!busy || !dirty || !data.settings} onClick={() => void save()}>{busy === 'save' && <Spinner size={13} />}{t('Save')}</button>
      <button type="button" className="btn btn-primary" disabled={!!busy || data.loading || !data.settings || missing || dirty} onClick={() => void open()}>{busy === 'open' && <Spinner size={13} />}{busy === 'open' ? t('Opening HQ…') : t('Open HQ')}</button>
    </div>
    {dirty && <p className="field-hint">{t('Save project and folder changes before opening HQ.')}</p>}
    <button type="button" className="btn" disabled={!!busy || dirty} onClick={() => useStore.setState({ sidebarHidden: false, dialog: { type: 'boss-broadcast' } })}>{t('Assignment to all project leads')}</button>
  </div>
}

export function BossBroadcastDialog() {
  const data = useBossData()
  const home = useStore(s => s.home)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [deliveries, setDeliveries] = useState<BossDelivery[]>([])
  const [submitted, setSubmitted] = useState(false)
  const selectedOnce = useRef(false)
  const pending = useRef(false)
  const deliveryEvents = useRef(new Map<string, BossDelivery>())
  const close = () => { if (!pending.current) useStore.setState({ dialog: null }) }
  useEffect(() => {
    if (data.roster && !selectedOnce.current) { setChecked(defaultBossProjects(data.roster.projects)); selectedOnce.current = true }
  }, [data.roster])
  useEffect(() => {
    if (isRemote) return
    return api.on.bossDelivery(d => {
      deliveryEvents.current.set(d.id, d)
      setDeliveries(prev => prev.some(item => item.id === d.id) ? mergeBossDeliveries(prev, [d]) : prev)
    })
  }, [])
  if (isRemote) return null
  const targets = data.roster?.projects.filter(p => checked.has(p.key) && p.enabled && p.lead?.status !== 'blocked') ?? []
  const send = async () => {
    if (pending.current || submitted || !text.trim() || !targets.length) return
    pending.current = true; setBusy(true); data.setError(null)
    try {
      const results = await api.broadcastBoss({ text: text.trim(), projectKeys: targets.map(p => p.key) })
      const latest = results.map(d => deliveryEvents.current.get(d.id) ?? d)
      setDeliveries(prev => mergeBossDeliveries(prev, latest)); setSubmitted(true)
    } catch (e) {
      // An IPC failure can follow a partial dispatch. Do not offer a blind resend.
      setSubmitted(true); data.setError(errorText(e))
    } finally { pending.current = false; setBusy(false) }
  }
  return <Modal title={t('Assignment to all project leads')} onClose={close} width={700}>
    <div className="form boss-form">
      <p className="setting-hint block">{t('Send directly to one lead per project. Busy agents receive it in their queue; agents waiting for your answer are skipped.')}</p>
      <div className="field">
        <div className="setting-block-head"><span>{t('Projects')}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('Refresh')} disabled={busy || submitted || data.loading} onClick={() => void data.load()}><RefreshCw size={13} /></button>
        </div>
        <div className="team-rows compact boss-projects">
          {data.roster?.projects.map(p => {
            const result = deliveries.find(d => d.projectKey === p.key)
            return <label key={p.key} className="team-row">
              <input type="checkbox" checked={checked.has(p.key) && p.enabled && p.lead?.status !== 'blocked'} disabled={busy || submitted || !p.enabled || p.lead?.status === 'blocked'} onChange={e => {
                setChecked(prev => { const next = new Set(prev); if (e.target.checked) next.add(p.key); else next.delete(p.key); return next })
              }} />
              <div className="team-role"><div className="team-role-name">{p.name}</div><div className="team-role-sub" title={p.cwd ?? p.key}>{shortPath(p.cwd ?? p.key, home)}</div><LeadDescription project={p} /></div>
              {result ? <DeliveryStatus delivery={result} /> : !p.enabled ? <span className="field-hint">{t('Project excluded')}</span> : null}
            </label>
          })}
          {!data.roster && data.loading && <Spinner />}
          {data.roster && !data.roster.projects.length && <p className="hint">{t('No projects yet')}</p>}
        </div>
      </div>
      {!submitted && <div className="boss-templates">
        <span className="field-hint">{t('Templates')}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setText(t('Wake up and continue tasks from your project task board.'))}>{t('Wake up agents')}</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setText(t('Update the documentation on managing agents in your project.'))}>{t('Update agent documentation')}</button>
      </div>}
      <div className="field"><label htmlFor="boss-assignment">{t('Assignment')}</label>
        <textarea id="boss-assignment" className="input" rows={4} autoFocus value={text} disabled={busy || submitted} placeholder={t('What should the project leads do?')} onChange={e => setText(e.target.value)} onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
        }} />
      </div>
      {submitted && <p className="field-hint" role="status">{t('Delivery status only — task completion is reported by the agents.')}</p>}
      {data.error && <div className="form-error" role="alert">{data.error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={close}>{t('Close')}</button>
        {!submitted && <button type="button" className="btn" disabled={busy} onClick={() => useStore.setState({ dialog: { type: 'boss' } })}>{t('Boss settings')}</button>}
        {!submitted && <button type="button" className="btn btn-primary" disabled={busy || data.loading || !text.trim() || !targets.length} onClick={() => void send()}>{busy && <Spinner size={13} />}{busy ? t('Sending…') : t('Send assignment')}</button>}
      </div>
    </div>
  </Modal>
}
