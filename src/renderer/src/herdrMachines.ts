// herdr 0.9.4 saved SSH machines ("herdr machines"): their status, projects and agents, shown in the sidebar
// and merged into Settings > Machines. Desktop only.
// Local copy of the backend contract until it lands in @shared/machines; every method is optional so an
// older backend simply shows no herdr machines.

import { useEffect, useState } from 'react'
import { machinesApi, type MachineError } from './machines'

export type HerdrAgentStatus = 'working' | 'blocked' | 'idle' | 'done' | 'unknown'
export interface HerdrMachineAgent { paneId: string; name?: string; agent: string; status: HerdrAgentStatus; title?: string }
export interface HerdrMachineWorkspace { id: string; label: string; cwd?: string; agents: HerdrMachineAgent[] }
export interface HerdrMachine {
  id: string
  label: string
  /** SSH target as herdr stores it, e.g. user@host:port. */
  target: string
  host: string
  status: { state: 'online' | 'offline' | 'checking' | 'unknown' | 'disabled'; latencyMs?: number; checkedAt?: number; error?: MachineError }
  /** Turned off in herdr: listed, but not contacted. */
  enabled?: boolean
  /** herdr session on that machine. */
  session?: string
  herdrVersion?: string
  /** How this computer reaches it: straight over SSH, or through the bridge. */
  route: 'direct' | 'bridge'
  /** The same host in Drover's own Machines, for one merged row. */
  droverMachineId?: string
  workspaces: HerdrMachineWorkspace[]
}
export interface HerdrMachinesApi {
  herdrMachines?(): Promise<HerdrMachine[]>
  onHerdrMachines?(cb: (machines: HerdrMachine[]) => void): () => void
  startHerdrAgent?(options: { machineId: string; cwd?: string; agent: string; name?: string; args?: string[] }): Promise<{ paneId: string }>
  openHerdrAgent?(machineId: string, paneId: string): Promise<void>
}

export function herdrMachinesApi(): HerdrMachinesApi | null {
  return machinesApi() as HerdrMachinesApi | null
}

/** Live list of herdr machines; empty when the backend has none (or does not support them). */
export function useHerdrMachines(): HerdrMachine[] {
  const [list, setList] = useState<HerdrMachine[]>([])
  useEffect(() => {
    const api = herdrMachinesApi()
    if (!api?.herdrMachines) return
    let live = true
    api.herdrMachines().then((m) => { if (live) setList(m) }, () => undefined)
    const off = api.onHerdrMachines?.((m) => { if (live) setList(m) })
    return () => { live = false; off?.() }
  }, [])
  return list
}

export function herdrAgentCount(m: HerdrMachine): number {
  return m.workspaces.reduce((n, w) => n + w.agents.length, 0)
}
