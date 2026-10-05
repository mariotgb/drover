import type { OfficeState, OfficeUIEvent } from '@shared/office'

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(k => equal(left[k], right[k]))
}
export const sameOfficeView = equal
/** This projection has only data consumed by the HUD. Link decay and event
 * timestamps stay in the engine/journal, and never schedule the whole view. */
export function officeViewState(previous: OfficeState | null, incoming: OfficeState): OfficeState {
  const byId = new Map(previous?.agents.map(a => [a.id, a]) ?? [])
  const next: OfficeState = { ...incoming, version: 0, links: [], recentEvents: [], agents: incoming.agents.map(a => {
    const old = byId.get(a.id), row = { ...a, lastStatusAt: 0 }
    return old && equal(old, row) ? old : row
  }) }
  for (const key of ['departments', 'seats', 'agents', 'externalNodes', 'statusCounts'] as const) {
    if (previous && equal(previous[key], next[key])) Object.assign(next, { [key]: previous[key] })
  }
  return previous && equal(previous, next) ? previous : next
}
export class OfficeViewData {
  private state: OfficeState | null = null
  private listeners = new Set<() => void>()
  get = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  update(state: OfficeState) { this.state = state; for (const listener of this.listeners) listener() }
}
export function visibleOfficeEvents(state: OfficeState | null, hall: string | null): OfficeUIEvent[] {
  if (!state) return []
  const ids = new Set(state.agents.filter(a => a.departmentId === hall).map(a => a.id)), events: OfficeUIEvent[] = []
  for (let i = state.recentEvents.length - 1; i >= 0 && events.length < 8; i--) {
    const e = state.recentEvents[i]
    if (!hall || e.from === hall || e.to === hall || ids.has(e.from ?? '') || ids.has(e.to ?? '')) events.push(e)
  }
  return events
}
