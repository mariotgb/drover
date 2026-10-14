import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { t } from '../i18n'
import { errorText } from '../api'
import { useModel } from '../store'
import type { MachinesApi } from '../machines'

const ROLES = ['lead', 'orchestrator', 'devops'] as const
const roleLabel = (r: string) => r === 'lead' ? t('Project lead') : r === 'orchestrator' ? t('Orchestrator') : r === 'devops' ? 'DevOps' : r

/** Per project: which agent roles may ask to change machines. Drover still asks the user every time. */
export function MachinesRolesBlock({ api }: { api: MachinesApi }) {
  const groups = useModel((m) => m.groups)
  const projects = useMemo(() => {
    const seen = new Map<string, string>()
    for (const g of groups) if (g.cwd && !seen.has(g.cwd)) seen.set(g.cwd, g.workspace.label || g.cwd.split('/').pop() || g.cwd)
    return [...seen]
  }, [groups])
  const [policies, setPolicies] = useState<Record<string, string[]>>({})
  const [error, setError] = useState('')
  const load = (api as Partial<Pick<MachinesApi, 'projectMachinePolicy'>>).projectMachinePolicy
  useEffect(() => {
    if (!load) return
    let live = true
    for (const [cwd] of projects) load.call(api, cwd).then((p) => { if (live) setPolicies((all) => ({ ...all, [cwd]: p.configureRoles })) }, () => undefined)
    return () => { live = false }
  }, [api, projects.map(([c]) => c).join('\n')])
  if (!load || !projects.length) return null
  const toggle = (cwd: string, role: string) => {
    const now = policies[cwd] ?? [...ROLES]
    const next = now.includes(role) ? now.filter((r) => r !== role) : [...now, role]
    setPolicies((all) => ({ ...all, [cwd]: next }))
    setError('')
    api.setProjectMachinePolicy(cwd, { configureRoles: next }).catch((e) => { setError(errorText(e)); setPolicies((all) => ({ ...all, [cwd]: now })) })
  }
  return (
    <div className="setting-block machines-block">
      <div className="setting-block-head big"><span>{t('Agents that may change machines')}</span></div>
      <p className="setting-hint">{t('An agent with one of these roles may ask to add, change or remove a machine. Drover asks you every time; nothing changes without your yes.')}</p>
      <div className="roles-table">
        {projects.map(([cwd, label]) => (
          <div key={cwd} className="roles-row">
            <span className="roles-project" title={cwd}>{label}</span>
            <span className="roles-chips">
              {ROLES.map((r) => {
                const on = (policies[cwd] ?? ROLES).includes(r)
                return <button key={r} type="button" className={clsx('machine-project', on && 'on')} aria-pressed={on} onClick={() => toggle(cwd, r)}>{on && <Check size={12} />}{roleLabel(r)}</button>
              })}
            </span>
          </div>
        ))}
      </div>
      <p className="setting-hint">{t('Other agents can work on machines but not change them. The role is checked at the moment of the request.')}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}
