import { OFFICE_LIMITS, type OfficeAnimation, type OfficeUIEvent, type OfficeState } from '@shared/office'
import type { Point } from './layout'
export type CarrierKind = 'prompt' | 'user_prompt' | 'prompt_attempt' | 'board'
export interface FlyingEnvelope { id: string; from: string; to: string; kind: CarrierKind; count: number; ts: number; startedAt: number; duration: number }
export const flightDuration = (distance: number) => Math.max(800, Math.min(1800, 600 + 2.2 * distance))
export function arcPoint(a: Point, b: Point, t: number, lift = 40): Point {
  const distance = Math.hypot(b.x - a.x, b.y - a.y), cx = (a.x + b.x) / 2, cy = Math.min(a.y, b.y) - lift * 0.6 - distance * 0.1
  return { x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t * t * b.y }
}
export function carrierPhase(a: FlyingEnvelope, now: number) {
  const age = now - a.startedAt, flight = a.duration
  if (a.kind === 'board') return { phase: age < flight ? 'flight' : 'pin', progress: Math.min(1, age / flight) }
  if (age < 280) return { phase: 'throw', progress: age / 280 }
  const progress = Math.min(1, (age - 280) / flight)
  if (a.kind === 'prompt_attempt' && progress >= 0.7) {
    const fall = age - 280 - flight * 0.7
    return { phase: fall < 500 ? 'fall' : 'crumple', progress: Math.min(1, fall / 500) }
  }
  return { phase: progress < 1 ? 'flight' : 'catch', progress }
}
/** Confirmed flights come only from animations; history never confirms a prompt. */
export class EnvelopeQueue {
  active: FlyingEnvelope[] = []
  notes = new Map<string, { at: number; user: boolean }>()
  celebrations = new Map<string, number>()
  flashes = new Map<string, number>()
  private pending: Omit<FlyingEnvelope, 'startedAt'>[] = []
  private seen = new Set<string>()
  private events = new Set<string>()
  private lastPair = new Map<string, number>()
  private pair(a: { from: string; to: string; kind: CarrierKind }) { return JSON.stringify([a.from, a.to, a.kind]) }
  clear() { this.active = []; this.pending = []; this.lastPair.clear(); this.seen.clear(); this.events.clear(); this.notes.clear(); this.celebrations.clear(); this.flashes.clear() }
  baseline(events: OfficeUIEvent[]) { for (const e of events) this.events.add(e.id) }
  ingest(animations: OfficeAnimation[], now: number, enabled: boolean, distance: (from: string, to: string) => number = () => 0, reduced = false) {
    for (const a of animations) {
      if (this.seen.has(a.id)) continue
      this.seen.add(a.id)
      if (!['prompt', 'user_prompt'].includes(a.kind)) continue
      this.enqueue({ ...a, duration: flightDuration(distance(a.from, a.to)) }, now, enabled, reduced)
      this.advance(now)
    }
    this.bound(); this.advance(now)
  }
  ingestEvents(state: OfficeState, now: number, enabled: boolean, distance: (from: string, to: string) => number, reduced = false) {
    for (const e of state.recentEvents) {
      if (this.events.has(e.id)) continue
      this.events.add(e.id)
      if (!enabled || now - e.ts > OFFICE_LIMITS.animationTtlMs || e.ts > now + 1000) continue
      if (e.kind === 'input_observed') continue
      if (e.from && e.to) this.flashes.set(JSON.stringify([e.from, e.to]), now)
      if (e.kind === 'agent_status') continue // Status transitions are checked against consecutive live snapshots.
      if (e.kind === 'prompt_attempt' && e.from && e.to) this.enqueue({ id: e.id, from: e.from, to: e.to, kind: 'prompt_attempt', count: 1, ts: e.ts, duration: flightDuration(distance(e.from, e.to)) }, now, enabled, reduced)
      if (['task_created', 'task_assigned', 'task_status'].includes(e.kind) && e.from) {
        const agent = state.agents.find(a => a.id === e.from) ?? state.agents.find(a => a.id === e.to)
        if (agent) this.enqueue({ id: e.id, from: agent.id, to: agent.departmentId, kind: 'board', count: 1, ts: e.ts, duration: Math.max(600, Math.min(900, 600 + distance(agent.id, agent.departmentId))) }, now, enabled, reduced)
      }
    }
    this.bound(); this.advance(now)
  }
  private enqueue(a: Omit<FlyingEnvelope, 'startedAt'>, now: number, enabled: boolean, reduced: boolean) {
    if (!enabled || now - a.ts > OFFICE_LIMITS.animationTtlMs || a.ts > now + 1000) return
    if (reduced) { if (a.kind === 'prompt' || a.kind === 'user_prompt') this.notes.set(a.to, { at: now, user: a.kind === 'user_prompt' }); this.flashes.set(a.to, now); return }
    const pair = this.pair(a), existing = [...this.active, ...this.pending].find(p => this.pair(p) === pair && Math.abs(a.ts - p.ts) < OFFICE_LIMITS.pairAnimationMs)
    if (existing) existing.count += a.count
    else if (this.pending.length < OFFICE_LIMITS.maxAnimationQueue) this.pending.push({ ...a })
  }
  private bound() { for (const set of [this.seen, this.events]) while (set.size > OFFICE_LIMITS.maxEvents * 2) set.delete(set.values().next().value!) }
  advance(now: number) {
    this.active = this.active.filter(a => {
      const age = now - a.startedAt
      if ((a.kind === 'prompt' || a.kind === 'user_prompt') && age >= 280 + a.duration && (this.notes.get(a.to)?.at ?? -Infinity) < a.startedAt + 280 + a.duration) this.notes.set(a.to, { at: a.startedAt + 280 + a.duration, user: a.kind === 'user_prompt' })
      return age < (a.kind === 'prompt_attempt' ? 280 + a.duration * 0.7 + 3500 : a.kind === 'board' ? a.duration + 200 : 280 + a.duration + 300)
    })
    this.pending = this.pending.filter(a => now - a.ts <= OFFICE_LIMITS.animationTtlMs)
    for (let i = 0; i < this.pending.length && this.active.length < OFFICE_LIMITS.maxAnimations;) {
      const a = this.pending[i], pair = this.pair(a)
      if (now - (this.lastPair.get(pair) ?? -Infinity) < OFFICE_LIMITS.pairAnimationMs) { i++; continue }
      this.pending.splice(i, 1); this.lastPair.set(pair, now); this.active.push({ ...a, startedAt: now })
    }
    for (const [pair, at] of this.lastPair) if (now - at > OFFICE_LIMITS.historyMs) this.lastPair.delete(pair)
    for (const [id, at] of this.celebrations) if (now - at > 900) this.celebrations.delete(id)
    for (const [id, at] of this.flashes) if (now - at > 400) this.flashes.delete(id)
  }
  pruneNotes(state: OfficeState, now: number) { for (const [id, note] of this.notes) if (now - note.at > 600_000 || !state.agents.some(a => a.id === id && a.status === 'working')) this.notes.delete(id) }
  discardMotion() { this.active = []; this.pending = []; this.celebrations.clear(); this.flashes.clear() }
}
export function decayedWeight(weight: number, sampledAt: number, now: number) { return weight * Math.exp(-Math.max(0, now - sampledAt) / OFFICE_LIMITS.decayMs) }

/** Unique integer pixels along the same quadratic used by the moving carriers. */
export function rasterArc(a: Point, b: Point, lift = 22): Point[] {
  const steps = Math.ceil(Math.max(1, Math.hypot(b.x - a.x, b.y - a.y) + lift) * 3), pixels: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const p = arcPoint(a, b, i / steps, lift), x = Math.round(p.x), y = Math.round(p.y), last = pixels.at(-1)
    if (!last || last.x !== x || last.y !== y) pixels.push({ x, y })
  }
  return pixels
}
