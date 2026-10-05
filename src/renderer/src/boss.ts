import type { BossDelivery, BossProject } from '@shared/boss'

/** Blocked agents need the user's answer; they are never selected by default. */
export function defaultBossProjects(projects: readonly BossProject[]): Set<string> {
  return new Set(projects.filter(p => p.enabled && p.lead?.status !== 'blocked').map(p => p.key))
}

/** Delivery events can arrive before the broadcast IPC response. */
export function mergeBossDeliveries(current: readonly BossDelivery[], updates: readonly BossDelivery[]): BossDelivery[] {
  const next = new Map(current.map(d => [d.id, d]))
  for (const d of updates) {
    const previous = next.get(d.id)
    if (previous && previous.status !== 'queued' && d.status === 'queued') continue
    next.set(d.id, d)
  }
  return [...next.values()]
}
