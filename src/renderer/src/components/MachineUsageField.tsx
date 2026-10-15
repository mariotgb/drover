// Machine card: who may use this machine. Advisory: Drover's guides and helper follow it; it is not a lock.
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check, Search } from 'lucide-react'
import { errorText } from '../api'
import { locale, t, tp } from '../i18n'
import { useModel } from '../store'
import type { Machine, MachinesApi } from '../machines'
import { AgentAvatar } from './primitives'

import type { MachineAgentRef as AgentRef, MachineUsage as Usage, MachineUsageMode as UsageMode } from '@shared/machines'

const usageOf = (m: Machine): Usage => m.usage ?? { mode: 'all', agents: [] }
const same = (a: AgentRef, b: AgentRef) => a.project === b.project && a.name === b.name
const key = (a: AgentRef) => `${a.project}\0${a.name}`

interface Row extends AgentRef { kind: string | null; running: boolean }
/** Every agent Drover knows, by project: open ones from herdr, plus chosen ones that are not running now.
 * The rule matches herdr's own agent name (not a tab label), so unnamed agents cannot be picked; they are counted. */
function useAgentRows(chosen: AgentRef[]) {
  const groups = useModel((model) => model.groups)
  return useMemo(() => {
    const projects = new Map<string, { label: string; rows: Map<string, Row> }>()
    let unnamed = 0
    const project = (cwd: string, label?: string) => {
      let p = projects.get(cwd)
      if (!p) { p = { label: label || cwd.split('/').pop() || cwd, rows: new Map() }; projects.set(cwd, p) }
      return p
    }
    for (const g of groups) {
      if (!g.cwd) continue
      const p = project(g.cwd, g.workspace.label)
      for (const tab of g.tabs) for (const th of tab.threads) {
        if (!th.kind) continue
        const name = th.agent?.name?.trim()
        if (name) p.rows.set(name, { project: g.cwd, name, kind: th.kind, running: true }); else unnamed++
      }
    }
    for (const a of chosen) { const p = project(a.project); if (!p.rows.has(a.name)) p.rows.set(a.name, { ...a, kind: null, running: false }) }
    return { unnamed, projects: [...projects].filter(([, p]) => p.rows.size).map(([cwd, p]) => ({ cwd, label: p.label, rows: [...p.rows.values()].sort((a, b) => a.name.localeCompare(b.name, locale())) })) }
  }, [groups, chosen])
}

export function MachineUsageField({ api, machine: m }: { api: MachinesApi; machine: Machine }) {
  // Optional so an older main (or a test double) without it shows the field read-only.
  const setUsage = (api as Partial<Pick<MachinesApi, 'setUsage'>>).setUsage
  const saved = usageOf(m)
  // Switching to "Selected agents" needs at least one agent: pick locally, then save.
  const [picking, setPicking] = useState<AgentRef[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const mode = picking ? 'agents' : saved.mode
  const chosen = picking ?? saved.agents
  const { projects, unnamed } = useAgentRows(chosen)
  const save = (usage: Usage) => {
    if (!setUsage) return Promise.resolve(false)
    setError('')
    return setUsage.call(api, m.id, usage, { confirmed: true }).then(() => true, (e) => { setError(errorText(e)); return false })
  }
  const choose = (next: UsageMode) => {
    if (next === 'agents') { if (saved.mode !== 'agents') setPicking(saved.agents); return }
    setPicking(null)
    if (next !== saved.mode) void save({ mode: next, agents: [] })
  }
  const toggle = (a: AgentRef) => {
    const next = chosen.some((c) => same(c, a)) ? chosen.filter((c) => !same(c, a)) : [...chosen, { project: a.project, name: a.name }]
    if (picking) setPicking(next)
    else if (next.length) void save({ mode: 'agents', agents: next })
  }
  const modes: { id: UsageMode; label: string; hint: string }[] = [
    { id: 'all', label: t('All agents'), hint: t('Every agent is told about this machine.') },
    { id: 'roles', label: t('Only team leads, orchestrators and DevOps'), hint: t('Only agents with these roles are told about it; the Main boss counts as a lead. Others read “not available to you, ask the lead”.') },
    { id: 'agents', label: t('Selected agents'), hint: t('Only the agents you tick are told about it. Others read “not available to you, ask the lead”.') }
  ]
  const q = query.trim().toLocaleLowerCase(locale())
  const shown = projects.map((p) => ({ ...p, rows: p.rows.filter((r) => !q || `${r.name} ${p.label}`.toLocaleLowerCase(locale()).includes(q)) })).filter((p) => p.rows.length)
  return (
    <div className="machine-section machine-usage">
      <div className="machine-section-title">{t('Who can use it')}</div>
      <div className="usage-modes" role="radiogroup" aria-label={t('Who can use it')}>
        {modes.map((x) => (
          <label key={x.id} className={clsx('usage-mode', mode === x.id && 'on')}>
            <input type="radio" name={`usage-${m.id}`} checked={mode === x.id} disabled={!setUsage} onChange={() => choose(x.id)} />{x.label}
          </label>
        ))}
      </div>
      <p className="setting-hint machine-advisory">{modes.find((x) => x.id === mode)!.hint} {t('This is a rule Drover’s agents follow, not a lock: anything running under your user account can still reach the machine.')}</p>
      {mode === 'agents' && (
        <div className="usage-agents">
          <label className="usage-search"><Search size={13} /><input value={query} placeholder={t('Search agents')} aria-label={t('Search agents')} onChange={(e) => setQuery(e.target.value)} /></label>
          {!projects.length && !unnamed && <span className="setting-hint">{t('No agents are open in herdr yet.')}</span>}
          {projects.length > 0 && !shown.length && <span className="setting-hint">{t('No results. Try another search.')}</span>}
          {shown.map((p) => (
            <div key={p.cwd} className="usage-project" role="group" aria-label={p.label}>
              <div className="usage-project-name" title={p.cwd}>{p.label}</div>
              {p.rows.map((r) => {
                const on = chosen.some((c) => same(c, r)), last = on && !picking && chosen.length === 1
                return (
                  <button key={key(r)} type="button" className={clsx('usage-agent', on && 'on')} role="checkbox" aria-checked={on} disabled={last || !setUsage}
                    title={last ? t('Keep at least one agent, or choose another option above.') : undefined} onClick={() => toggle(r)}>
                    <span className="usage-check">{on && <Check size={11} strokeWidth={3} />}</span>
                    <AgentAvatar kind={r.kind} size={18} />
                    <span className="usage-agent-name">{r.name}</span>
                    {!r.running && <span className="usage-agent-off">{t('not running now')}</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {unnamed > 0 && <span className="setting-hint">{tp({ one: '{n} agent has no name in herdr, so it cannot be picked. Name it to add it here.', other: '{n} agents have no name in herdr, so they cannot be picked. Name them to add them here.' }, unnamed)}</span>}
        </div>
      )}
      {picking && (
        <div className="machine-actions">
          <span className="setting-hint">{picking.length ? tp({ one: '{n} agent selected', other: '{n} agents selected' }, picking.length) : t('Pick at least one agent.')}</span>
          <button type="button" className="btn btn-sm" onClick={() => setPicking(null)}>{t('Cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picking.length} onClick={() => void save({ mode: 'agents', agents: picking }).then((ok) => { if (ok) setPicking(null) })}>{t('Save')}</button>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}
