import { OFFICE_LIMITS, type OfficeState, type OfficeUpdate } from '@shared/office'
import { sameOfficeView } from './view-state'

function upsert<T extends { id: string }>(previous: T[], changed: T[], removed: string[]): T[] {
  if (!changed.length && !removed.length) return previous
  const changes = new Map(changed.map(row => [row.id, row])), gone = new Set(removed)
  const next: T[] = []
  for (const row of previous) {
    if (gone.has(row.id)) { changes.delete(row.id); continue }
    const replacement = changes.get(row.id)
    next.push(replacement && !sameOfficeView(row, replacement) ? replacement : row)
    changes.delete(row.id)
  }
  for (const row of changes.values()) if (!gone.has(row.id)) next.push(row)
  return next.length === previous.length && next.every((row, i) => row === previous[i]) ? previous : next
}

/** Null requests a fresh baseline; never guess past a missing delta. */
export function reconcileOffice(previous: OfficeState | null, update: OfficeUpdate): OfficeState | null {
  if (update.state) {
    const next = { ...update.state, version: update.state.version ?? 0 }
    if (previous?.session === next.session && previous.generation === next.generation) {
      for (const key of ['departments', 'seats', 'agents', 'externalNodes', 'links', 'recentEvents', 'statusCounts'] as const) {
        if (sameOfficeView(previous[key], next[key])) Object.assign(next, { [key]: previous[key] })
      }
    }
    return next
  }
  const d = update.delta
  if (!previous || d.session !== previous.session || d.generation !== previous.generation || d.baseVersion !== (previous.version ?? 0) || d.version <= d.baseVersion) return null
  let recentEvents = upsert(previous.recentEvents, d.events, d.removedEvents)
  if (recentEvents !== previous.recentEvents) recentEvents = recentEvents.toSorted((a, b) => a.ts - b.ts).slice(-OFFICE_LIMITS.maxEvents)
  return {
    ...previous, version: d.version,
    agents: upsert(previous.agents, d.agents, d.removedAgents),
    links: upsert(previous.links, d.links, d.removedLinks), recentEvents,
    departments: d.departments ?? previous.departments, seats: d.seats ?? previous.seats,
    externalNodes: d.externalNodes ?? previous.externalNodes, statusCounts: d.statusCounts ?? previous.statusCounts
  }
}
