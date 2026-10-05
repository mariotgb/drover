import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'

export interface WatchdogTarget {
  session: string
  socketPath: string
  herdrPath: string
  env: NodeJS.ProcessEnv
  generation: number
}

/** Only the latest Drover attached to a session may stop it after a crash. */
export class ServerWatchdog {
  private active: { file: string; token: string; child: ChildProcess; target: WatchdogTarget } | null = null

  constructor(
    private logDir: string,
    private record: (event: string, details: Record<string, unknown>) => void,
    private workerPath = join(__dirname, 'serverWatchdogWorker.js'),
    private parentPid = process.pid
  ) {}

  update(enabled: boolean, target: WatchdogTarget | null): void {
    if (!enabled || !target) { this.disarm(); return }
    const prev = this.active?.target
    if (prev?.session === target.session && prev.socketPath === target.socketPath && prev.generation === target.generation) return
    this.disarm()
    const file = join(dirname(target.socketPath), 'drover-watchdog.json')
    const token = randomUUID()
    let out: number | undefined
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${this.parentPid}.tmp`
      writeFileSync(temporary, JSON.stringify({ token, parentPid: this.parentPid, session: target.session }), { mode: 0o600 })
      renameSync(temporary, file)
      mkdirSync(this.logDir, { recursive: true })
      out = openSync(join(this.logDir, 'herdr-watchdog.log'), 'a', 0o600)
      const child = spawn(process.execPath, [this.workerPath, JSON.stringify({ file, token, parentPid: this.parentPid, herdrPath: target.herdrPath, session: target.session })], {
        env: { ...target.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
        detached: true,
        stdio: ['pipe', out, out]
      })
      this.active = { file, token, child, target }
      child.stdin?.on('error', () => { /* watcher exited */ })
      // Keep the parent-lifetime pipe open without keeping Electron alive.
      ;(child.stdin as Socket | null)?.unref()
      child.unref()
      child.once('error', (error) => {
        this.record('herdr-watchdog-error', { session: target.session, error: error.message })
        if (this.active?.child === child) this.disarm()
      })
      child.once('exit', (code, signal) => {
        if (this.active?.child === child) {
          this.record('herdr-watchdog-exit', { session: target.session, code, signal })
          this.disarm()
        }
      })
      this.record('herdr-watchdog-armed', { session: target.session, parentPid: this.parentPid, watchdogPid: child.pid })
    } catch (error) {
      this.removeOwnedFile(file, token)
      this.record('herdr-watchdog-error', { session: target.session, error: String(error) })
    } finally {
      if (out !== undefined) closeSync(out)
    }
  }

  disarm(): void {
    const active = this.active
    if (!active) return
    this.active = null
    // Invalidate ownership BEFORE EOF/SIGTERM, so normal quits cannot stop herdr.
    this.removeOwnedFile(active.file, active.token)
    active.child.stdin?.end()
    active.child.kill('SIGTERM')
    this.record('herdr-watchdog-disarmed', { session: active.target.session, watchdogPid: active.child.pid })
  }

  private removeOwnedFile(file: string, token: string): void {
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file, { force: true }) }
    catch { /* already disarmed or replaced by another Drover */ }
  }
}
