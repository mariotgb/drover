// Phone: read-only machine status. No actions — machines are managed on the Mac.
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { House, Server, TriangleAlert } from 'lucide-react'
import type { MachinesStatus } from '@shared/machines'
import { api } from '../api'
import { t, tp } from '../i18n'
import { useStore } from '../store'
import { ago, machineErrorText, osName, type Machine } from '../machines'
import { MachineDot } from './MachinesSettings'

const POLL_MS = 30_000

// One shared poller for the drawer and Settings; it runs only while something is mounted and the page is visible.
let cache: MachinesStatus | null = null
const subs = new Set<(s: MachinesStatus | null) => void>()
let timer: ReturnType<typeof setInterval> | null = null
async function refresh() {
  if (typeof api.machinesStatus !== 'function' || document.hidden) return
  try { cache = await api.machinesStatus() } catch { return }
  subs.forEach((cb) => cb(cache))
}
const onVisible = () => { if (!document.hidden) void refresh() }
function subscribe(cb: (s: MachinesStatus | null) => void) {
  subs.add(cb)
  if (subs.size === 1) {
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    subs.delete(cb)
    if (subs.size) return
    if (timer) clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisible)
  }
}

export function useMachinesStatus(enabled = true): MachinesStatus | null {
  const [state, setState] = useState(cache)
  useEffect(() => (enabled && typeof api.machinesStatus === 'function' ? subscribe(setState) : undefined), [enabled])
  return enabled ? state : null
}

function viaName(m: Machine, s: MachinesStatus) {
  return s.machines.find((x) => x.id === (m.bridgeMachineId ?? s.bridgeMachineId))?.name
}

/** Settings group: one row per machine. */
export function MobileMachinesGroup() {
  const s = useMachinesStatus()
  if (typeof api.machinesStatus !== 'function' || !s) return null
  return (
    <section className="mw-group">
      <h2>{t('Machines')}</h2>
      <div className="mw-group-list">
        {!s.machines.length && <div className="mw-row"><span className="mw-row-label mw-dim">{t('No machines yet')}</span></div>}
        {s.machines.map((m) => {
          const via = viaName(m, s)
          const offline = m.status.state === 'offline'
          const sub = [m.osLabel || osName(m.os), m.kind === 'bridged' ? (via ? t('Through {bridge}', { bridge: via }) : t('Home network')) : t('Direct')].filter(Boolean).join(' · ')
          return (
            <div key={m.id} className={clsx('mw-row mw-machine', offline && 'is-offline')}>
              <MachineDot machine={m} />
              <span className="mw-machine-icon">{m.kind === 'direct' ? <Server size={16} /> : <House size={16} />}</span>
              <span className="mw-machine-text">
                <strong>{m.name}{m.id === s.bridgeMachineId && <span className="machine-badge">{t('Bridge')}</span>}</strong>
                <span>{sub}</span>
                {offline && m.status.error && <span className="mw-machine-reason">{machineErrorText(m.status.error, m, via)}</span>}
              </span>
              <span className="mw-machine-meta">
                <span>{m.status.state === 'online' && m.status.latencyMs !== undefined ? t('{n} ms', { n: m.status.latencyMs }) : m.status.state === 'offline' ? t('Offline') : m.status.state === 'waiting' ? t('Waiting to connect') : m.status.state === 'checking' ? t('Checking…') : t('Not checked yet')}</span>
                <span>{ago(m.status.checkedAt)}</span>
              </span>
            </div>
          )
        })}
      </div>
      <div className="mw-group-foot">{t('Status only. Add and manage machines in Drover on your computer: Settings → Machines.')}</div>
    </section>
  )
}

/** Drawer line, shown only when at least one machine is offline. */
export function MobileMachinesAlert() {
  const s = useMachinesStatus()
  const offline = s?.machines.filter((m) => m.status.state === 'offline') ?? []
  if (!offline.length) return null
  return (
    <button type="button" className="mw-machines-alert" onClick={() => useStore.setState({ mobileSettings: true, mobileDrawer: false })}>
      <TriangleAlert size={15} />
      <span>{tp({ one: '{n} machine offline: {names}', other: '{n} machines offline: {names}' }, offline.length, { names: offline.map((m) => m.name).join(', ') })}</span>
    </button>
  )
}
