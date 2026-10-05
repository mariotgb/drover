import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

interface RunState { pid: number; version: string; startedAt: string; clean: boolean; reason?: string }

/** Synchronous breadcrumbs survive abrupt termination; SIGKILL itself cannot be caught. */
export class LifecycleJournal {
  readonly previousCrash: RunState | null
  private file: string
  private marker: string
  private state: RunState
  private timer: NodeJS.Timeout | null = null
  private fatal = false
  constructor(userData: string, version: string, pid = process.pid) {
    const dir = join(userData, 'logs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'lifecycle.log')
    this.marker = join(dir, 'lifecycle-state.json')
    let previous: RunState | null = null
    try {
      const value = JSON.parse(readFileSync(this.marker, 'utf8'))
      if (value && typeof value.pid === 'number' && typeof value.startedAt === 'string' && value.clean === false) previous = value
    } catch { /* first launch or incomplete marker */ }
    this.previousCrash = previous
    this.state = { pid, version, startedAt: new Date().toISOString(), clean: false }
    this.save()
    this.record('start', { version })
    if (previous) this.record('previous-abnormal-exit', { previous })
  }
  record(event: string, details: Record<string, unknown> = {}): void {
    try { appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), pid: this.state.pid, event, ...details }) + '\n', { mode: 0o600 }) }
    catch (error) { console.warn('[lifecycle] unable to write log:', String(error)) }
  }
  private save(): void {
    const temporary = `${this.marker}.${this.state.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state) + '\n', { mode: 0o600 })
    renameSync(temporary, this.marker)
  }
  abnormal(reason: string): void {
    this.fatal = true
    this.state.reason = reason
    this.record('abnormal-exit', { reason })
    try { this.save() } catch { /* retain previous dirty marker */ }
  }
  get canStopServer(): boolean { return !this.fatal }
  finish(code: number, reason: string): void {
    this.stopMonitor()
    this.state.clean = code === 0 && !this.fatal
    if (!this.fatal) this.state.reason = reason
    this.record(this.state.clean ? 'normal-exit' : 'abnormal-exit', { code, reason: this.state.reason })
    try { this.save() } catch (error) { console.warn('[lifecycle] unable to save exit:', String(error)) }
  }
  monitor(): void {
    if (this.timer) return
    let expected = performance.now() + 1000
    this.timer = setInterval(() => {
      const now = performance.now(), delayMs = Math.round(now - expected)
      if (delayMs > 2000) this.record('event-loop-delay', { delayMs })
      expected = now + 1000
    }, 1000)
    this.timer.unref()
  }
  stopMonitor(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}

/** Never stop a session which this instance has not actually connected to. */
export function mayStopServer(ownsLock: boolean, attachedSession: string | null, session: string, normal: boolean): boolean {
  return ownsLock && normal && attachedSession === session
}
