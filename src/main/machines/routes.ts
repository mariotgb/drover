import type { Machine, MachineRoute, MachineRouteKind } from '@shared/machines'
import { publicAddress, validHost, validPort } from './store'
import { MachinesFailure } from './ssh'

export function machineRoutes(machine: Machine): MachineRoute[] {
  if (machine.routes) return machine.routes
  const routes: MachineRoute[] = []
  if (machine.host) routes.push({ kind: publicAddress(machine.host) ? 'internet' : 'lan', host: machine.host, port: machine.port ?? 22, user: machine.user, address: `${machine.host}:${machine.port ?? 22}`, state: 'unknown' })
  if (machine.kind === 'bridged' && (machine.bridgeMachineId || !machine.host)) routes.push({ kind: 'bridge', port: machine.bridgePort, bridgeMachineId: machine.bridgeMachineId, user: machine.user, state: 'setup' })
  machine.routes = routes
  return routes
}
export function orderedRoutes(machine: Machine): MachineRoute[] {
  const rank: Record<MachineRouteKind, number> = { lan: 0, internet: 1, bridge: 2 }
  return machineRoutes(machine).sort((a, b) => rank[a.kind] - rank[b.kind])
}
export function validateRoute(route: MachineRoute): void {
  if (!route || !['lan', 'internet', 'bridge'].includes(route.kind) || !['ok', 'down', 'checking', 'setup', 'unknown'].includes(route.state)) throw new MachinesFailure('invalid_route', 'Choose a valid connection route.')
  if (route.kind !== 'bridge') { validHost(route.host); validPort(route.port) }
  else if (route.port !== undefined) validPort(route.port)
  if (route.user !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(route.user)) throw new MachinesFailure('invalid_user', 'Enter a valid SSH login.')
  if (route.bridgeMachineId !== undefined && !/^[a-f0-9-]{36}$/.test(route.bridgeMachineId)) throw new MachinesFailure('invalid_route', 'Choose a saved bridge.')
}
