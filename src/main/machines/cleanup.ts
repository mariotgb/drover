import { join } from 'node:path'
import type { BridgeCleanupState, Machine, MachineError } from '@shared/machines'
import { fingerprint, MachinesFailure, privateRead, privateWrite } from './ssh'

export type { BridgeCleanupState } from '@shared/machines'
export interface BridgeCleanupDeps {
  userData: string
  activeBridgeId: () => string | null
  /** Missing rows stay blocked until explicit cancellation after retirement. */
  bridge: (id: string) => Machine | null
  removeTargets: (bridge: Machine, targetIds: string[], agentsPublicKey: string) => Promise<void>
  revokeInstallers: (bridge: Machine) => Promise<void>
  now?: () => number
}
interface CleanupJob {
  bridgeId: string
  targetIds: string[]
  agentsPublicKey: string
  targetsRemoved: boolean
  attempts: number
  nextAttemptAt: number
  error?: MachineError
}
const RETRY_BASE = 30_000
const RETRY_MAX = 2 * 60 * 60 * 1000
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const failure = (code: string, detail: string): MachineError => ({ code, detail })
const ACTIVE = failure('bridge_cleanup_active', 'Cleanup is paused while this bridge is selected.')
const MISSING = failure('bridge_cleanup_missing', 'The old bridge record is missing. Confirm retirement before clearing cleanup.')
const FAILED = failure('bridge_cleanup_pending', 'Old bridge credential cleanup failed and will be retried.')

/** One queue for obsolete bridge tunnels/capabilities, never target credential
 * removals. The service calls runOnce in its serial lane on startup and checks.
 * Queue operations also serialize internally so cancellation cannot race a run.
 */
export class BridgeCleanupQueue {
  readonly file: string
  private jobs: CleanupJob[] = []
  private loaded: Promise<void> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private running = new Set<string>()
  constructor(private deps: BridgeCleanupDeps) { this.file = join(deps.userData, 'bridge-cleanup.json') }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  async load(): Promise<void> {
    return this.loaded ??= (async () => {
      const raw = await privateRead(this.file)
      if (raw === null) return
      try {
        const data = JSON.parse(raw)
        if (data.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > 1000) throw Error('Invalid queue')
        const seen = new Set<string>()
        for (const job of data.jobs) {
          if (!id(job.bridgeId) || !Array.isArray(job.targetIds) || job.targetIds.length > 1000 || !job.targetIds.every(id) || typeof job.agentsPublicKey !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(job.agentsPublicKey) || typeof job.targetsRemoved !== 'boolean' || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Number.isFinite(job.nextAttemptAt) || job.nextAttemptAt < 0) throw Error('Invalid job')
          fingerprint(job.agentsPublicKey)
          const key = job.bridgeId
          if (seen.has(key)) throw Error('Duplicate job')
          seen.add(key)
        }
        // Never surface arbitrary persisted error text in status or logs.
        this.jobs = data.jobs.map((job: CleanupJob) => ({ bridgeId: job.bridgeId, targetIds: [...new Set(job.targetIds)], agentsPublicKey: job.agentsPublicKey, targetsRemoved: job.targetsRemoved, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt, ...(job.error ? { error: FAILED } : {}) }))
      } catch { throw new MachinesFailure('store_invalid', 'The bridge cleanup queue is damaged. Restore its backup before changing bridge access.') }
    })().catch(error => { this.loaded = null; throw error })
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { await this.load(); return action() })
    this.tail = result.catch(() => undefined)
    return result
  }
  private async save(jobs = this.jobs): Promise<void> {
    await privateWrite(this.file, JSON.stringify({ version: 1, jobs }, null, 2) + '\n')
    this.jobs = jobs
  }
  enqueue(bridgeId: string, targetIds: string[], agentsPublicKey: string): Promise<void> {
    return this.serial(async () => {
      const fields = agentsPublicKey.trim().split(/\s+/), key = fields.slice(0, 2).join(' ')
      if (!id(bridgeId) || !Array.isArray(targetIds) || targetIds.length > 1000 || !targetIds.every(id) || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(key)) throw new MachinesFailure('invalid_cleanup', 'Invalid bridge cleanup request.')
      fingerprint(key)
      const jobs = structuredClone(this.jobs), job = jobs.find(j => j.bridgeId === bridgeId)
      if (job) {
        job.targetIds = [...new Set([...job.targetIds, ...targetIds])]
        if (job.targetIds.length > 1000) throw new MachinesFailure('invalid_cleanup', 'Too many bridge cleanup targets.')
        // Enqueue means a NEW switch, not a retry. A bridge may have been
        // reselected and its grants recreated since this job's previous phase.
        job.agentsPublicKey = key
        job.targetsRemoved = false
        job.attempts = 0
        job.nextAttemptAt = this.now()
        delete job.error
      } else {
        if (jobs.length >= 1000) throw new MachinesFailure('invalid_cleanup', 'Too many pending bridge cleanups.')
        jobs.push({ bridgeId, targetIds: [...new Set(targetIds)], agentsPublicKey: key, targetsRemoved: false, attempts: 0, nextAttemptAt: this.now() })
      }
      await this.save(jobs)
    })
  }
  cleanupState(bridgeId: string): BridgeCleanupState | undefined {
    const jobs = this.jobs.filter(j => j.bridgeId === bridgeId)
    if (!jobs.length) return undefined
    const blocked = this.deps.activeBridgeId() === bridgeId ? ACTIVE : !this.deps.bridge(bridgeId) ? MISSING : undefined
    const error = blocked ?? jobs.find(j => j.error)?.error
    return { state: blocked ? 'blocked' : this.running.has(bridgeId) ? 'running' : 'pending', attempts: Math.max(...jobs.map(j => j.attempts)), nextAttemptAt: Math.min(...jobs.map(j => j.nextAttemptAt)), ...(error ? { error: { ...error } } : {}) }
  }
  private bridgeFor(job: CleanupJob): Machine | null {
    // Check immediately before EACH remote mutation, including after awaits.
    if (this.deps.activeBridgeId() === job.bridgeId) return null
    const bridge = this.deps.bridge(job.bridgeId)
    return bridge?.id === job.bridgeId && bridge.kind === 'direct' ? bridge : null
  }
  runOnce(): Promise<void> {
    return this.serial(async () => {
      for (const job of [...this.jobs]) {
        if (job.nextAttemptAt > this.now() || !this.bridgeFor(job)) continue
        this.running.add(job.bridgeId)
        try {
          if (!job.targetsRemoved) {
            const bridge = this.bridgeFor(job)
            if (!bridge) continue
            try { await this.deps.removeTargets(bridge, [...job.targetIds], job.agentsPublicKey) }
            catch { await this.retry(job); continue }
            job.targetsRemoved = true
            await this.save()
          }
          const bridge = this.bridgeFor(job)
          if (!bridge) continue
          try { await this.deps.revokeInstallers(bridge) }
          catch { await this.retry(job); continue }
          await this.save(this.jobs.filter(j => j !== job))
        } finally { this.running.delete(job.bridgeId) }
      }
    })
  }
  private async retry(job: CleanupJob): Promise<void> {
    job.attempts = Math.min(job.attempts + 1, Number.MAX_SAFE_INTEGER)
    job.nextAttemptAt = this.now() + Math.min(RETRY_MAX, RETRY_BASE * 2 ** Math.min(job.attempts - 1, 8))
    job.error = FAILED
    await this.save()
  }
  /** Call only AFTER successful remote retirement, before removing its row.
   * This does not finish or erase any offline target credential removal.
   */
  cancel(bridgeId: string): Promise<void> {
    return this.serial(async () => {
      if (this.jobs.some(j => j.bridgeId === bridgeId)) await this.save(this.jobs.filter(j => j.bridgeId !== bridgeId))
    })
  }
}
