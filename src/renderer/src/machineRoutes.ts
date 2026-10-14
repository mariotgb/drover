// 0.8.4: one machine type with several routes (home network, internet, bridge), chosen automatically.
// Machines saved before routes existed have no routes[]; they are derived from kind/host/bridge.

import { t } from './i18n'
import type { Machine } from './machines'
import type { MachineRoute, MachineRouteKind } from '@shared/machines'

export type RouteKind = MachineRouteKind
export type RouteInfo = MachineRoute
type RouteState = MachineRoute['state']

const fields = (m: Machine) => m

export const ROUTE_ORDER: RouteKind[] = ['lan', 'internet', 'bridge']

/** The machine's routes in try order: the backend's list, else what its setup implies. */
export function routesOf(m: Machine): RouteInfo[] {
  const own = fields(m).routes
  if (own?.length) return own
  const state: RouteState = m.status.state === 'online' ? 'ok' : m.status.state === 'checking' ? 'checking' : m.status.state === 'unknown' ? 'unknown' : m.status.state === 'waiting' ? 'setup' : 'down'
  const latencyMs = m.status.latencyMs
  if (m.kind === 'direct') return [{ kind: m.publicIp ? 'internet' : 'lan', address: m.host, state, latencyMs }]
  if (m.bridgeMachineId) return [{ kind: 'bridge', state, latencyMs }]
  return [{ kind: 'lan', address: m.host, state, latencyMs }]
}

/** The route Drover uses right now, if any works. */
export function activeRoute(m: Machine): RouteKind | null {
  const f = fields(m)
  if (f.activeRoute) return f.activeRoute
  return routesOf(m).find((r) => r.state === 'ok')?.kind ?? null
}

export function isFallback(m: Machine): boolean {
  const f = fields(m)
  if (f.fallback !== undefined) return f.fallback
  const routes = routesOf(m), active = activeRoute(m)
  return !!active && routes[0]?.kind !== active
}

export function hasRoute(m: Machine, kind: RouteKind): boolean {
  return routesOf(m).some((r) => r.kind === kind)
}

export function purposeOf(m: Machine): string {
  return fields(m).purpose?.trim() ?? ''
}

export function routeName(kind: RouteKind): string {
  return kind === 'lan' ? t('Home network') : kind === 'internet' ? t('Internet') : t('Via bridge')
}

/** Short chip text: "Now: home network" for the active route, otherwise its state. */
export function routeChip(r: RouteInfo, active: boolean): string {
  if (active) return r.kind === 'lan' ? t('Now: home network') : r.kind === 'internet' ? t('Now: internet') : t('Now: via bridge')
  if (r.state === 'setup') return t('{route} — waiting for setup', { route: routeName(r.kind) })
  if (r.state === 'down') return t('{route} — not answering', { route: routeName(r.kind) })
  return routeName(r.kind)
}
