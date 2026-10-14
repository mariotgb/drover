import { randomUUID, createHash } from 'node:crypto'
import { readFile, lstat, readlink, open, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AgentLaunch } from '@shared/agentRestart'
import { HerdrApiError, type AgentInfo, type HerdrSnapshot } from '@shared/types'
import { codexIsolatedArgs } from './codexLaunch'
import { acceptsResumeArgv, resumeArgs, supportsResumeArgv, sanitizeLaunchArgs, type Kind } from './agentLaunchArgs'
import { HerdrClient } from './herdr/client'

interface SessionRef { agent: Kind; source: string; kind: string; value: string }
interface RestoreEntry { paneId: string; cwd: string; name: string | null; ref: SessionRef; args: string[]; identity: string }
interface RestoreQueue { version: 1; entries: Record<string, RestoreEntry[]> }
interface SavedPane { cwd: string; agent_name?: string; managed_agent_kind?: string; agent_session?: SessionRef; agent_resume?: { agent: string; source: string; argv: string[] }; launch_argv?: string[]; drover_restore?: string }
interface SavedSession { version: number; workspaces: { id?: string; public_pane_numbers?: Record<string, number>; tabs: { panes: Record<string, SavedPane> }[] }[] }
export interface LaunchRepository {
  get(paneId: string, session?: string): AgentLaunch | undefined
  record(agent: AgentInfo, args: string[]): Promise<void>
}
export interface RestoreGuard { assertStopped(): Promise<void>; serialized?: boolean }
/** Follow bounded relative/absolute links, including a dangling final target. */
export async function restoreWriteTarget(file: string): Promise<string> {
  let target = resolve(file)
  for (let i = 0; i < 16; i++) {
    let meta
    try { meta = await lstat(target) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return target; throw e }
    if (!meta.isSymbolicLink()) return target
    target = resolve(dirname(target), await readlink(target))
  }
  throw new HerdrApiError('restore_symlink_loop', 'Session persistence has too many symbolic links')
}
/** Queue durability must complete before native session IDs are suppressed. */
export async function writeRestoreJson(file: string, data: unknown, beforeRename?: () => Promise<void>): Promise<void> {
  const target = await restoreWriteTarget(file), parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const temp = join(parent, `.drover-restore-${randomUUID()}.tmp`)
  try {
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await beforeRename?.()
    await rename(temp, target)
    const dir = await open(parent, 'r')
    try { await dir.sync() } finally { await dir.close() }
  } finally { await unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }) }
}
// Electron's per-user-data single-instance lock owns cross-process exclusion.
// This mutex serializes migration/start and capture merges within one process,
// leaves no crash artifacts, and releases even if an action rejects.
const restoreMutexes = new Map<string, Promise<void>>()
export async function withRestoreMutex<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(file), previous = restoreMutexes.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => held)
  restoreMutexes.set(key, queued)
  await previous
  try { return await action() }
  finally { release(); if (restoreMutexes.get(key) === queued) restoreMutexes.delete(key) }
}
function paneIdentity(pane: SavedPane): string {
  return createHash('sha256').update(JSON.stringify([pane.cwd, pane.managed_agent_kind ?? null, pane.agent_name ?? null, pane.launch_argv ?? null])).digest('hex')
}
const alphabet = '123456789ABCDEFGHJKMNPQRSTVWXYZ0'
function publicNumber(n: number): string {
  let out = ''
  while (n > 0) { out = alphabet[(n - 1) % 32] + out; n = Math.floor((n - 1) / 32) }
  return out || '0'
}

/** Herdr's native restore discards launch options through 0.9.4. Prefer its
 * reported resume command; only unsupported commands need a local shell restore. */
export class AgentRestore {
  private queueFile: string
  private queue: RestoreQueue = { version: 1, entries: {} }
  private reports = new Map<string, string>()
  private attempts = new Map<string, number>()
  private prepared = new Map<string, string>()
  private targets: { paneId: string; kind: string; sessionId: string }[] = []
  restoreTargets() { return this.targets.map(target => ({ ...target })) }
  constructor(private repository: LaunchRepository, userData: string) {
    this.queueFile = join(userData, 'agent-restores.json')
  }
  async loadQueue(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.queueFile, 'utf8')) as RestoreQueue
      if (data.version !== 1 || !data.entries || typeof data.entries !== 'object') throw new Error('Invalid agent restore queue')
      for (const entries of Object.values(data.entries)) {
        if (!Array.isArray(entries) || entries.some(e => !e || typeof e.paneId !== 'string' || typeof e.cwd !== 'string' ||
          !['claude', 'codex'].includes(e.ref?.agent) || e.ref.kind !== 'id' || typeof e.ref.value !== 'string' ||
          !Array.isArray(e.args) || e.args.some(a => typeof a !== 'string'))) throw new Error('Invalid agent restore queue')
      }
      let changed = false
      const entries: RestoreQueue['entries'] = {}
      for (const [session, items] of Object.entries(data.entries)) {
        entries[session] = items.flatMap(e => {
          const clean = sanitizeLaunchArgs(e.ref.agent, e.args)
          if (clean.unavailable || !/^[a-f0-9]{64}$/.test(e.identity ?? '') || e.ref.source !== `herdr:${e.ref.agent}`) { changed = true; return [] }
          const item: RestoreEntry = { paneId: e.paneId, cwd: e.cwd, name: e.name ?? null, ref: { agent: e.ref.agent, source: e.ref.source, kind: 'id', value: e.ref.value }, args: resumeArgs(e.ref.agent, e.args, e.ref.value), identity: e.identity }
          if (JSON.stringify(e) !== JSON.stringify(item)) changed = true
          return [item]
        })
      }
      this.queue = { version: 1, entries }
      if (changed) await writeRestoreJson(this.queueFile, this.queue)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  /** Called only after ping proved this server stopped, before Drover spawns it.
   * Queue first, then suppress bare native resumes; a crash cannot lose the IDs. */
  async prepare(session: string, sessionDir: string, version: string | null, noDaemon = false, current: () => boolean = () => true, guard?: RestoreGuard): Promise<void> {
    const file = join(sessionDir, 'session.json')
    if (!guard?.serialized) return withRestoreMutex(file, () => this.prepare(session, sessionDir, version, noDaemon, current, { serialized: true,
      assertStopped: guard?.assertStopped ?? (async () => {
        try { await new HerdrClient(join(sessionDir, 'herdr.sock')).request('ping', {}, 1000) }
        catch (e) { if (e instanceof HerdrApiError && e.code === 'server_not_running') return; throw e }
        throw new HerdrApiError('restore_server_running', 'The herdr server started during restore preparation')
      }) }))
    await this.loadQueue()
    if (!current()) return
    this.prepared.clear()
    this.targets = []
    await guard.assertStopped()
    this.reports.clear(); this.attempts.clear()
    const target = await restoreWriteTarget(file)
    let original: string, metadata: Awaited<ReturnType<typeof lstat>>
    let saved: SavedSession
    try { metadata = await lstat(target); original = await readFile(target, 'utf8'); saved = JSON.parse(original) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!current()) return
    if (saved.version !== 3 || !Array.isArray(saved.workspaces)) return
    const fallback = new Map((this.queue.entries[session] ?? []).map(e => [e.paneId, e]))
    let changed = false
    const seen = new Set<string>()
    for (const workspace of saved.workspaces) for (const tab of workspace.tabs) for (const [raw, pane] of Object.entries(tab.panes)) {
      const number = workspace.public_pane_numbers?.[raw]
      if (!workspace.id || !Number.isSafeInteger(number) || number! < 1) continue // Never guess an old/migrated pane ID.
      const paneId = `${workspace.id}:p${publicNumber(number!)}`
      const ref = pane.agent_session
      const old = fallback.get(paneId)
      if (!ref) {
        if (old && (old.cwd !== pane.cwd || pane.drover_restore !== old.identity || paneIdentity(pane) !== old.identity || pane.agent_resume)) fallback.delete(paneId)
        continue
      }
      fallback.delete(paneId)
      if (!['claude', 'codex'].includes(ref.agent) || ref.kind !== 'id' || ref.source !== `herdr:${ref.agent}` || !ref.value) continue
      const identity = `${ref.agent}:${ref.value}`
      if (seen.has(identity)) { delete pane.agent_session; delete pane.agent_resume; changed = true; continue }
      seen.add(identity)
      this.targets.push({ paneId, kind: ref.agent, sessionId: ref.value })
      const launch = this.repository.get(paneId, session)
      const matching = launch?.kind === ref.agent && (launch.sessionId === ref.value || !launch.sessionId &&
        !!launch.cwd && launch.cwd === pane.cwd && !!launch.name && launch.name === pane.agent_name) && (!launch.cwd || launch.cwd === pane.cwd)
      if (pane.managed_agent_kind && pane.managed_agent_kind !== ref.agent) continue
      // A custom command must pass the same privacy boundary before reuse.
      if (!matching && pane.agent_resume?.agent === ref.agent && pane.agent_resume.source === ref.source &&
        pane.agent_resume.argv[0] === ref.agent && acceptsResumeArgv(pane.agent_resume.argv) &&
        !sanitizeLaunchArgs(ref.agent, pane.agent_resume.argv.slice(1)).unavailable) {
        pane.agent_resume.argv = [ref.agent, ...resumeArgs(ref.agent, pane.agent_resume.argv.slice(1), ref.value)]
        changed = true; continue
      }
      const original = matching ? launch.args : []
      const unsafe = matching ? launch.restoreUnavailable || sanitizeLaunchArgs(ref.agent, original).unavailable
        : !!pane.agent_resume && sanitizeLaunchArgs(ref.agent, pane.agent_resume.argv.slice(1)).unavailable
      if (unsafe) {
        // No bogus replacement for private launch configuration, including a bare native resume.
        delete pane.agent_session; delete pane.agent_resume; delete pane.drover_restore
        changed = true; continue
      }
      const resumed = resumeArgs(ref.agent, original, ref.value, matching ? launch.choice : {})
      const args = ref.agent === 'codex' ? codexIsolatedArgs(resumed, noDaemon) : resumed
      const argv = [ref.agent, ...args]
      if (supportsResumeArgv(version) && acceptsResumeArgv(argv)) {
        pane.agent_resume = { source: ref.source, agent: ref.agent, argv }
        delete pane.drover_restore
      } else {
        pane.drover_restore = paneIdentity(pane)
        fallback.set(paneId, { paneId, cwd: pane.cwd, name: pane.agent_name ?? null, ref, args, identity: pane.drover_restore })
        delete pane.agent_session
        delete pane.agent_resume
      }
      changed = true
    }
    // Entries must still name a saved pane; deleted panes must never be revived.
    const panes = new Set(saved.workspaces.flatMap(w => w.tabs.flatMap(t => Object.keys(t.panes).map(raw =>
      w.id && w.public_pane_numbers?.[raw] ? `${w.id}:p${publicNumber(w.public_pane_numbers[raw])}` : ''))))
    this.queue.entries[session] = [...fallback.values()].filter(e => panes.has(e.paneId))
    for (const entry of this.queue.entries[session]) if (!this.targets.some(t => t.paneId === entry.paneId)) this.targets.push({ paneId: entry.paneId, kind: entry.ref.agent, sessionId: entry.ref.value })
    if (!current()) return
    await writeRestoreJson(this.queueFile, this.queue)
    if (!current()) return
    if (changed) await writeRestoreJson(target, saved, async () => {
      if (!current()) throw new HerdrApiError('session_changed', 'The herdr session changed before migration')
      await guard.assertStopped()
      const now = await lstat(target)
      if (await restoreWriteTarget(file) !== target || now.dev !== metadata.dev || now.ino !== metadata.ino || now.mtimeMs !== metadata.mtimeMs || now.ctimeMs !== metadata.ctimeMs || await readFile(target, 'utf8') !== original)
        throw new HerdrApiError('restore_session_changed', 'Session persistence changed during restore preparation; retry')
    })
    // Herdr's first cold-shell save drops unknown fields, names and launch
    // metadata. Keep only identities validated by this serialized preparation for
    // the immediate restore on our verified server; never authorize from cwd.
    for (const entry of this.queue.entries[session]) this.prepared.set(entry.paneId, entry.identity)
  }
  /** Report only the session, under its existing official source. Never inject
   * a state report, prompt or keystroke, including into busy/blocked agents. */
  async report(agent: AgentInfo, args: string[], choice: AgentLaunch['choice'], version: string | undefined, client: HerdrClient, observedSeq: number): Promise<void> {
    const ref = agent.agent_session
    if (!ref || ref.agent !== agent.agent || ref.kind !== 'id' || ref.source !== `herdr:${agent.agent}` || !supportsResumeArgv(version)) return
    if (sanitizeLaunchArgs(agent.agent as Kind, args).unavailable) return
    const argv = [agent.agent, ...resumeArgs(agent.agent as Kind, args, ref.value, choice)]
    if (!acceptsResumeArgv(argv)) return
    const key = `${client.socketPath}:${agent.pane_id}:${agent.terminal_id}`, value = JSON.stringify(argv)
    if (this.reports.get(key) === value) return
    if (await this.persistedResume(agent.pane_id) === value) { this.reports.set(key, value); return }
    // Herdr debounces saves for five seconds. Do not keep postponing that save
    // by re-reporting an unchanged command on every snapshot poll.
    if (Date.now() - (this.attempts.get(key) ?? 0) < 6000) return
    this.attempts.set(key, Date.now())
    await client.request('pane.report_agent_session', { pane_id: agent.pane_id, source: ref.source, agent: agent.agent,
      agent_session_id: ref.value, resume_argv: argv, seq: observedSeq }, 5000)
    // A raced hook report can make this request a no-op. The next observation
    // retries with a current timestamp in the official hooks' nanosecond unit.
    const stored = await this.persistedResume(agent.pane_id)
    if (stored === value) this.reports.set(key, value)
  }
  private sessionDir: string | null = null
  setSessionDir(dir: string | null): void { this.sessionDir = dir; this.reports.clear(); this.attempts.clear(); this.prepared.clear() }
  async invalidate(snapshot: HerdrSnapshot, session: string): Promise<void> {
    const entries = this.queue.entries[session]
    if (!entries?.length) return
    const valid = entries.filter(e => {
      const pane = snapshot.panes.find(p => p.pane_id === e.paneId)
      const agent = snapshot.agents.find(a => a.pane_id === e.paneId)
      return !!pane && pane.cwd === e.cwd && (!pane.agent || pane.agent === e.ref.agent && (agent?.name ?? null) === e.name && (!pane.agent_session || pane.agent_session.value === e.ref.value))
    })
    if (valid.length !== entries.length) { this.queue.entries[session] = valid; await writeRestoreJson(this.queueFile, this.queue) }
  }
  private async matchesSuppression(entry: RestoreEntry): Promise<boolean> {
    if (!this.sessionDir) return false
    try {
      const saved: SavedSession = JSON.parse(await readFile(join(this.sessionDir, 'session.json'), 'utf8'))
      for (const w of saved.workspaces) for (const t of w.tabs) for (const [raw, pane] of Object.entries(t.panes))
        if (`${w.id}:p${publicNumber(w.public_pane_numbers?.[raw] ?? 0)}` === entry.paneId)
          return !pane.agent_session && !pane.agent_resume && (pane.drover_restore === entry.identity && paneIdentity(pane) === entry.identity ||
            this.prepared.get(entry.paneId) === entry.identity && pane.cwd === entry.cwd && !pane.drover_restore && !pane.managed_agent_kind && !pane.agent_name && !pane.launch_argv)
    } catch { /* Missing/changed persistence is not authorization to revive. */ }
    return false
  }
  private async persistedResume(paneId: string): Promise<string | null> {
    if (!this.sessionDir) return null
    try {
      const saved: SavedSession = JSON.parse(await readFile(join(this.sessionDir, 'session.json'), 'utf8'))
      for (const w of saved.workspaces) for (const t of w.tabs) for (const [raw, p] of Object.entries(t.panes)) {
        if (`${w.id}:p${publicNumber(w.public_pane_numbers?.[raw] ?? 0)}` === paneId) return JSON.stringify(p.agent_resume?.argv) ?? null
      }
    } catch { /* Herdr's asynchronous session save has not completed yet. */ }
    return null
  }
  /** Runs only on a Drover-started server, before connected is published. */
  async restore(session: string, client: HerdrClient, current: () => boolean,
    start: (entry: RestoreEntry) => Promise<void>): Promise<void> {
    const entries = this.queue.entries[session] ?? []
    for (const entry of [...entries]) {
      try {
        if (!current()) return
        if (!await this.matchesSuppression(entry)) { entries.splice(entries.indexOf(entry), 1); await writeRestoreJson(this.queueFile, this.queue); continue }
        const { snapshot } = await client.request<{ snapshot: HerdrSnapshot }>('session.snapshot')
        const pane = snapshot.panes.find(p => p.pane_id === entry.paneId)
        if (!pane || pane.cwd !== entry.cwd) continue
        // Never revive a queued conversation over a different/current occupant.
        if (pane.agent) {
          this.prepared.delete(entry.paneId)
          entries.splice(entries.indexOf(entry), 1); await writeRestoreJson(this.queueFile, this.queue)
          continue
        }
        const deadline = Date.now() + 10000
        let shellPid: number | null = null
        while (current()) {
          const { process_info: info } = await client.request<{ process_info: { shell_pid?: number; foreground_processes?: { pid: number }[] } }>('pane.process_info', { pane_id: entry.paneId })
          if (info.shell_pid && info.foreground_processes?.length && info.foreground_processes.every(p => p.pid === info.shell_pid)) { shellPid = info.shell_pid; break }
          if (Date.now() >= deadline) break
          await new Promise(r => setTimeout(r, 150))
        }
        if (!current() || !shellPid) continue
        const { snapshot: latest } = await client.request<{ snapshot: HerdrSnapshot }>('session.snapshot')
        const target = latest.panes.find(p => p.pane_id === entry.paneId)
        if (!current() || target?.terminal_id !== pane.terminal_id || target.cwd !== entry.cwd || target.agent || !await this.matchesSuppression(entry)) continue
        await start(entry) // Herdr agent.start atomically verifies the shell again.
        if (!current()) throw new HerdrApiError('session_changed', 'The herdr session changed during restore')
        const { agent } = await client.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
        if (!current() || agent.agent !== entry.ref.agent || agent.terminal_id !== pane.terminal_id) continue
        // Old Codex integrations may not report resumed IDs with extra launch args.
        await client.request('pane.report_agent_session', { pane_id: entry.paneId, source: entry.ref.source,
          agent: entry.ref.agent, agent_session_id: entry.ref.value })
        const launched = this.repository.get(entry.paneId, session)
        await this.repository.record({ ...agent, agent_session: entry.ref }, launched?.terminalId === agent.terminal_id ? launched.args : entry.args)
        if (!entry.name) await client.request('agent.rename', { target: entry.paneId, name: null })
        entries.splice(entries.indexOf(entry), 1)
        this.prepared.delete(entry.paneId)
        await writeRestoreJson(this.queueFile, this.queue)
      } catch (error) {
        if (!current()) return
        console.warn('[agent-restore] resume failed:', error instanceof HerdrApiError ? error.code : 'error')
      }
    }
  }
}
