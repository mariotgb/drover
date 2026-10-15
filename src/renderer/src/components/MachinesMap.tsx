import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Cable, House, Monitor, Server, Smartphone } from 'lucide-react'
import { t } from '../i18n'
import { isTurnedOff, pendingConnect, pendingConnectLabel } from '../machines'
import { activeRoute, hasRoute, routeName, routesOf, purposeOf, type RouteKind } from '../machineRoutes'
import type { Machine, MachinesApi, MachinesState } from '../machines'
import type { MachinePhone } from '@shared/machines'
import { DeviceIcon, deviceKind, deviceKindName } from '../devices'

const W = 1000
const KEY = 'drover.machines.map'

type Tone = 'ok' | 'warn' | 'bad' | 'off'
interface Node { id: string; x: number; y: number; icon: ReactNode; name: string; sub: string; tone: Tone; kind: 'me' | 'bridge' | 'phone' | 'machine' | 'ghost'; machineId?: string; title?: string }
interface Edge { from: string; to: string; route: RouteKind | 'standby' | 'down'; label?: string }

const toneOf = (m: Machine): Tone => { if (isTurnedOff(m)) return 'off'; const pending = pendingConnect(m.status); return pending ? (pending === 'reachable' ? 'warn' : 'off') : stateTone(m) }
const stateTone = (m: Machine): Tone => m.status.state === 'online' ? 'ok' : m.status.state === 'offline' ? 'bad' : m.status.state === 'unknown' ? 'off' : 'warn'

function usePhones(api: MachinesApi): MachinePhone[] {
  const [phones, setPhones] = useState<MachinePhone[]>([])
  useEffect(() => {
    const load = (api as Partial<Pick<MachinesApi, 'phones'>>).phones
    if (!load) return
    let live = true
    load.call(api).then((p) => { if (live) setPhones(p) }, () => undefined)
    return () => { live = false }
  }, [api])
  return phones
}

/** Map open/closed: remembered per viewer; by default it folds away once every machine works. */
export function useMapOpen(state: MachinesState): [boolean, (open: boolean) => void] {
  const allWell = state.machines.length > 0 && state.machines.every((m) => m.status.state === 'online')
  const [saved, setSaved] = useState<boolean | null>(() => { try { const v = localStorage.getItem(KEY); return v === null ? null : v === '1' } catch { return null } })
  const set = (open: boolean) => { setSaved(open); try { localStorage.setItem(KEY, open ? '1' : '0') } catch { /* private window */ } }
  return [saved ?? !allWell, set]
}

/** This computer, the bridge, phones and every machine, joined by the route in use right now. */
export function MachinesMap({ api, state, onOpen }: { api: MachinesApi; state: MachinesState; onOpen: (id: string) => void }) {
  const phones = usePhones(api)
  const bridge = state.machines.find((m) => m.id === state.bridgeMachineId) ?? null
  const others = state.machines.filter((m) => m.id !== bridge?.id)
  // Machines that use the bridge sit in the right column, the rest in a lower middle column,
  // so lines from the bridge never cross another machine.
  const viaBridge = others.filter((m) => !!bridge && (hasRoute(m, 'bridge') || activeRoute(m) === 'bridge'))
  const direct = others.filter((m) => !viaBridge.includes(m))
  const nodes: Node[] = []
  const edges: Edge[] = []
  const top = phones.length ? 56 + phones.length * 100 + 20 : 150
  const directTop = Math.max(top + 40, 200)
  const H = Math.max(280, top + viaBridge.length * 96 + 30, directTop + direct.length * 96 - 10)
  nodes.push({ id: 'me', x: 110, y: H / 2, icon: <Monitor size={20} />, name: t('This computer'), sub: '', tone: 'ok', kind: 'me' })
  if (bridge) {
    nodes.push({ id: bridge.id, x: 440, y: 64, icon: <Cable size={20} />, name: bridge.name, sub: t('bridge'), tone: toneOf(bridge), kind: 'bridge', machineId: bridge.id })
    edges.push({ from: 'me', to: bridge.id, route: 'bridge', label: t('Via bridge') })
  }
  phones.forEach((p, i) => {
    const id = `phone:${p.id}`
    const kind = deviceKind(p)
    nodes.push({ id, x: 880, y: 56 + i * 100, icon: <DeviceIcon kind={kind} />, name: p.name || deviceKindName(kind), sub: p.online ? t('online') : t('offline'), title: `${deviceKindName(kind)} · ${p.name || deviceKindName(kind)}`, tone: p.online ? 'ok' : 'off', kind: 'phone' })
    if (bridge) edges.push({ from: bridge.id, to: id, route: 'bridge' })
  })
  const place = (m: Machine): [number, number] => {
    const right = viaBridge.indexOf(m)
    if (right >= 0) return [880, top + right * 96]
    return [610, directTop + direct.indexOf(m) * 96]
  }
  others.forEach((m) => {
    const [x, y] = place(m)
    const pending = pendingConnect(m.status)
    const active = pending ? null : activeRoute(m)
    const first = routesOf(m)[0]?.kind
    const off = isTurnedOff(m)
    const sub = off ? [purposeOf(m), t('Turned off')].filter(Boolean).join(' · ') : pending ? [purposeOf(m), pendingConnectLabel(pending)].filter(Boolean).join(' · ') : purposeOf(m) || (active ? routeName(active) : t('not answering'))
    nodes.push({ id: m.id, x, y, icon: first === 'internet' ? <Server size={20} /> : <House size={20} />, name: m.name, sub, tone: toneOf(m), kind: 'machine', machineId: m.id })
    if (pending || off) edges.push({ from: 'me', to: m.id, route: 'standby' })
    else if (active === 'bridge' && bridge) edges.push({ from: bridge.id, to: m.id, route: 'bridge' })
    else if (active) edges.push({ from: 'me', to: m.id, route: active })
    // Not connected yet (listed, e.g. from herdr) is not broken: a quiet line until the user connects it.
    else edges.push({ from: 'me', to: m.id, route: m.status.error?.code === 'key_not_installed' ? 'standby' : 'down' })
    // A bridge route kept in reserve shows as a quiet dotted line.
    if (bridge && active !== 'bridge' && hasRoute(m, 'bridge')) edges.push({ from: bridge.id, to: m.id, route: 'standby' })
  })
  const at = (id: string) => nodes.find((n) => n.id === id)!
  return (
    <div className="mmap" style={{ height: H }}>
      <svg className="mmap-lines" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {edges.map((e, i) => { const a = at(e.from), b = at(e.to); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`mmap-line r-${e.route}`} vectorEffect="non-scaling-stroke" /> })}
      </svg>
      {nodes.map((n) => {
        const body = <>
          <span className="mmap-disc">{n.icon}{n.kind !== 'me' && <span className={clsx('mmap-st', `t-${n.tone}`)} />}</span>
          <span className="mmap-name">{n.name}</span>
          {n.sub && <span className="mmap-sub">{n.sub}</span>}
        </>
        const style = { left: `${(n.x / W) * 100}%`, top: n.y }
        return n.machineId
          ? <button key={n.id} type="button" className={clsx('mmap-node', `k-${n.kind}`)} style={style} onClick={() => onOpen(n.machineId!)} title={t('Open {name}', { name: n.name })}>{body}</button>
          : <div key={n.id} className={clsx('mmap-node', `k-${n.kind}`)} style={style} title={n.title}>{body}</div>
      })}
    </div>
  )
}

export function MapLegend() {
  return (
    <div className="mmap-legend" aria-hidden>
      <span className="r-lan"><i />{t('Home network')}</span>
      <span className="r-internet"><i />{t('Internet')}</span>
      <span className="r-bridge"><i />{t('Via bridge')}</span>
      <span className="r-standby"><i />{t('Backup route')}</span>
    </div>
  )
}

/** First run: only this computer, with dashed places for what can join it. */
export function EmptyMachinesMap() {
  const H = 275
  const ghost = (id: string, x: number, y: number, icon: ReactNode, name: string) => (
    <div key={id} className="mmap-node k-ghost" style={{ left: `${(x / W) * 100}%`, top: y }}><span className="mmap-disc">{icon}</span><span className="mmap-name">{name}</span></div>
  )
  return (
    <div className="mmap" style={{ height: H }}>
      <svg className="mmap-lines" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {[[230, 70], [770, 70], [500, 205]].map(([x, y], i) => <line key={i} x1={500} y1={120} x2={x} y2={y} className="mmap-line r-ghost" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="mmap-node k-me" style={{ left: '50%', top: 120 }}><span className="mmap-disc"><Monitor size={20} /></span><span className="mmap-name">{t('This computer')}</span></div>
      {ghost('home', 230, 70, <House size={20} />, t('Home computer'))}
      {ghost('server', 770, 70, <Server size={20} />, t('Your server'))}
      {ghost('phone', 500, 205, <Smartphone size={20} />, t('Your devices'))}
    </div>
  )
}
