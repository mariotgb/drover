import { OFFICE_LIMITS, type OfficeAnimation } from '@shared/office'
export interface FlyingEnvelope extends OfficeAnimation { startedAt: number }
/** Consume only collector-confirmed animations; recentEvents is never an animation source. */
export class EnvelopeQueue {
  active: FlyingEnvelope[] = []
  private pending: OfficeAnimation[] = []
  private seen = new Set<string>()
  private lastPair = new Map<string, number>()
  private pair(a: OfficeAnimation) { return JSON.stringify([a.from, a.to]) }
  clear() { this.active = []; this.pending = []; this.lastPair.clear(); this.seen.clear() }
  ingest(animations: OfficeAnimation[], now: number, enabled: boolean) {
    for (const a of animations) {
      if (this.seen.has(a.id)) continue
      this.seen.add(a.id)
      if (!enabled || !['prompt', 'user_prompt'].includes(a.kind) || now - a.ts > OFFICE_LIMITS.animationTtlMs || a.ts > now + 1000) continue
      const existing = this.pending.find(p => this.pair(p) === this.pair(a))
      if (existing) existing.count += a.count
      else if (this.pending.length < OFFICE_LIMITS.maxAnimationQueue) this.pending.push({ ...a })
    }
    // Bound dedup memory as well as visual queues. Collector remains authoritative for reconnect dedup.
    while (this.seen.size > OFFICE_LIMITS.maxEvents * 2) this.seen.delete(this.seen.values().next().value!)
    this.advance(now)
  }
  advance(now: number) {
    this.active = this.active.filter(a => now - a.startedAt < 1400)
    this.pending = this.pending.filter(a => now - a.ts <= OFFICE_LIMITS.animationTtlMs)
    for (let i = 0; i < this.pending.length && this.active.length < OFFICE_LIMITS.maxAnimations;) {
      const a = this.pending[i], pair = this.pair(a)
      if (now - (this.lastPair.get(pair) ?? -Infinity) < OFFICE_LIMITS.pairAnimationMs) { i++; continue }
      this.pending.splice(i, 1)
      this.lastPair.set(pair, now)
      this.active.push({ ...a, startedAt: now })
    }
    for (const [pair, at] of this.lastPair) if (now - at > OFFICE_LIMITS.historyMs) this.lastPair.delete(pair)
  }
  discardMotion() { this.active = []; this.pending = [] }
}
export function decayedWeight(weight: number, sampledAt: number, now: number) {
  return weight * Math.exp(-Math.max(0, now - sampledAt) / OFFICE_LIMITS.decayMs)
}
