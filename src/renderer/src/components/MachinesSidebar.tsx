import { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, FolderClosed, Plus, Server } from 'lucide-react'
import { AGENT_KINDS } from '@shared/agents'
import { t } from '../i18n'
import { errorText } from '../api'
import { toast, useStore } from '../store'
import { openMenuAt, type MenuItem } from './Menu'
import { AgentAvatar, IconButton, StatusDot } from './primitives'
import { MachineDot } from './MachinesSettings'
import { herdrAgentCount, herdrMachinesApi, useHerdrMachines, type HerdrMachine, type HerdrMachineAgent } from '../herdrMachines'
import { machineErrorText, pendingConnect, pendingConnectLabel, useMachinesState, type Machine } from '../machines'

const START_KINDS = ['claude', 'codex', 'gemini', 'opencode']

/** Sidebar: herdr machines with their projects and agents, below the local projects. */
export function MachinesSidebar() {
  const machines = useHerdrMachines()
  const drover = useMachinesState()
  if (!machines.length) return null
  return (
    <div className="mside">
      <div className="sidebar-section-head"><span>{t('Machines')}</span></div>
      {machines.map((m) => <MachineSection key={m.id} machine={m} drover={drover?.machines.find((x) => x.id === m.droverMachineId) ?? null} />)}
    </div>
  )
}

function startMenu(m: HerdrMachine, cwd?: string): MenuItem[] {
  const api = herdrMachinesApi()
  const start = (agent: string) => void api?.startHerdrAgent?.({ machineId: m.id, cwd, agent })
    .then((r) => api.openHerdrAgent?.(m.id, r.paneId))
    .catch((e) => toast('error', errorText(e)))
  return [
    { header: t('New agent on {machine}', { machine: m.label }) },
    ...AGENT_KINDS.filter((k) => START_KINDS.includes(k.kind)).map((k) => ({ label: k.label, icon: <AgentAvatar kind={k.kind} size={16} />, onClick: () => start(k.kind) }))
  ]
}

function MachineSection({ machine: m, drover }: { machine: HerdrMachine; drover: Machine | null }) {
  // Imported from herdr but not connected in Drover yet: show whether it answers, never "offline".
  // When herdr itself reaches the machine, its agents work and herdr's own status wins.
  const pending = drover && m.status.state !== 'online' ? pendingConnect(drover.status) : null
  const [open, setOpen] = useState(m.status.state === 'online' || !!pending)
  const online = m.status.state === 'online'
  const agents = herdrAgentCount(m)
  const meta = pending ? pendingConnectLabel(pending)
    : online ? (m.status.latencyMs !== undefined ? t('{n} ms', { n: m.status.latencyMs }) : t('Online'))
    : m.status.state === 'checking' ? t('Checking…') : m.status.state === 'disabled' || m.enabled === false ? t('Turned off') : m.status.state === 'unknown' ? t('Not checked yet') : t('Offline')
  const connect = () => drover && useStore.setState({ dialog: { type: 'settings', tab: 'machines', connectMachine: drover.id } })
  return (
    <section className={clsx('mside-machine', !online && !pending && 'is-offline', pending && `is-${pending}`)}>
      <div className="mside-head" role="button" tabIndex={0} aria-expanded={open}
        title={[m.target, m.status.error ? machineErrorText(m.status.error, { name: m.label }) : ''].filter(Boolean).join(' · ')}
        onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } }}>
        <ChevronRight size={12} className={clsx('mside-chev', open && 'open')} />
        <MachineDot machine={pending && drover ? drover : { status: { ...m.status, state: m.status.state === 'disabled' ? 'unknown' : m.status.state } }} />
        <Server size={13} className="mside-icon" />
        <span className="mside-label">{m.label}</span>
        {!open && agents > 0 && <span className="mside-count">{agents}</span>}
        <span className="mside-meta">{meta}</span>
        <div className="mside-tools" onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" title={t('New agent here')} disabled={!online} onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, startMenu(m))}>
            <Plus size={13} />
          </IconButton>
        </div>
      </div>
      {open && (
        <div className="mside-body">
          {pending && <div className="mside-note mside-connect">
            <span>{pending === 'reachable' ? t('{name} answers, but Drover is not connected to it yet.', { name: m.label })
              : pending === 'unreachable' ? t('Drover cannot reach {name} right now. Check that it is turned on and on the network, then connect it.', { name: m.label })
              : t('Checking whether {name} answers…', { name: m.label })}</span>
            {pending !== 'checking' && <button type="button" className={clsx('btn btn-sm', pending === 'reachable' && 'btn-primary')} onClick={connect}>{t('Connect machine')}</button>}
          </div>}
          {!online && !pending && <div className="mside-note">{m.status.state === 'disabled' || m.enabled === false
            ? t('{name} is turned off. Turn it on in Settings › Machines to see its agents here.', { name: m.label })
            : m.status.error ? machineErrorText(m.status.error, { name: m.label }) : t('{name} is offline. Its agents show up here when it is back.', { name: m.label })}</div>}
          {online && !m.workspaces.length && (
            <button type="button" className="mside-empty" onClick={(e) => openMenuAt(e.currentTarget, startMenu(m))}>
              <Plus size={12} />{t('No agents on {name} yet. Start one', { name: m.label })}
            </button>
          )}
          {m.workspaces.map((w) => (
            <div key={w.id} className="mside-ws">
              <div className="mside-ws-head" title={w.cwd}>
                <FolderClosed size={12} />
                <span>{w.label}</span>
                {online && <IconButton size="sm" title={t('New agent here')} onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, startMenu(m, w.cwd))}><Plus size={12} /></IconButton>}
              </div>
              {w.agents.map((a) => <MachineAgentRow key={a.paneId} machine={m} agent={a} />)}
              {!w.agents.length && <div className="ws-empty">{t('No agents')}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function MachineAgentRow({ machine: m, agent: a }: { machine: HerdrMachine; agent: HerdrMachineAgent }) {
  const open = () => void herdrMachinesApi()?.openHerdrAgent?.(m.id, a.paneId).catch((e) => toast('error', errorText(e)))
  const attention = a.status === 'blocked' || a.status === 'done'
  return (
    <div role="button" tabIndex={0} className={clsx('thread nested mside-agent', attention && 'attention', `st-${a.status}`)}
      onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
      <AgentAvatar kind={a.agent} size={18} />
      <div className="thread-text">
        <div className="thread-name">
          <span className="name">{a.name || AGENT_KINDS.find((k) => k.kind === a.agent)?.label || a.agent}</span>
          {a.status === 'blocked' && <span className="pill pill-blocked">{t('input')}</span>}
        </div>
        {a.title && <div className="thread-sub">{a.title}</div>}
      </div>
      <div className="thread-status">{a.status !== 'idle' && a.status !== 'unknown' && <StatusDot status={a.status} size={8} />}</div>
    </div>
  )
}
