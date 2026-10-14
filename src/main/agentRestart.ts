import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { supportsModels, type ModelChoice } from '@shared/models'
import { HerdrApiError, type AgentInfo, type HerdrSnapshot, type NewAgentRequest, type TranscriptMeta } from '@shared/types'
import type { AgentLaunch, RestartCandidate, RestartPlan, RestartResult, RestartSelection } from '@shared/agentRestart'
import type { HerdrService } from './herdr/service'
import { waitUntilInteractive } from './actions'
import { bypassFlags, launchChoice, restartArgs, sanitizeAgentLaunch, sanitizeLaunchArgs, safeLaunchChoice } from './agentLaunchArgs'
import { AgentRestore, writeRestoreJson } from './agentRestore'
import type { RestoreTarget } from './agentQuestions'
export { launchChoice, restartArgs, resumeArgs } from './agentLaunchArgs'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface ProcessInfo {
  shell_pid?: number | null
  foreground_processes?: { pid: number; name: string; argv?: string[] | null; argv0?: string | null }[]
}
interface Prepared extends RestartCandidate { terminalId: string; args: string[]; choice: ModelChoice; originalName: string | null; foregroundPid: number; shellPid: number }
interface Context { session: string; generation: number; client: HerdrService['client'] }
interface Pending { plan: RestartPlan; entries: Prepared[]; expires: number; context: Context }

/** Local-only plans bind confirmation to the exact pane occupant and conversation. */
export class AgentRestartService {
  private launches: Record<string, AgentLaunch> = {}
  private pending = new Map<string, Pending>()
  private busy = new Set<string>()
  private save = Promise.resolve()
  private file: string
  private restoreService: AgentRestore
  private observing: Promise<void> = Promise.resolve()
  constructor(private service: HerdrService, userData: string, private transcript: (paneId: string) => Promise<TranscriptMeta | null>,
    private onRestart?: (paneId: string, launch: AgentLaunch) => Promise<void>, enabled: () => boolean = () => true,
    private onRestore?: (targets: RestoreTarget[]) => void) {
    this.file = join(userData, 'agent-launches.json')
    let scrub = false
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [key, v] of Object.entries(data)) {
        const a = v as AgentLaunch
        if (a && supportsModels(a.kind) && typeof a.terminalId === 'string' && typeof a.bypass === 'boolean' && Array.isArray(a.args) && a.args.every(s => typeof s === 'string')) {
          this.launches[key] = sanitizeAgentLaunch(a)
          if (JSON.stringify(a) !== JSON.stringify(this.launches[key])) scrub = true
        } else scrub = true
      }
    } catch { /* first run or corrupt cache */ }
    if (scrub) void this.persist().catch(() => console.warn('[agent-restore] cache scrub failed: error'))
    this.restoreService = new AgentRestore({ get: (paneId, session) => this.launches[`${session ?? this.service.sessionName}:${paneId}`],
      record: (agent, args) => this.remember(agent, args) }, userData)
    service.agentRestore = {
      prepare: async (session, dir, version, guard) => {
        if (!enabled()) return
        const context = this.context()
        await this.observing
        const noDaemon = await service.codexLaunch.supportsNoDaemon()
        if (!this.currentContext(context)) return
        await this.restoreService.prepare(session, dir, version, noDaemon, () => this.currentContext(context), guard)
        if (this.currentContext(context)) this.onRestore?.(this.restoreService.restoreTargets())
      },
      restore: async (client, current) => {
        if (!enabled()) return
        await this.restoreService.restore(service.sessionName, client, current, async entry => {
          if (!current()) return
          await service.request('agent.start', { pane_id: entry.paneId, kind: entry.ref.agent,
            name: entry.name || `drover-resume-${randomUUID().slice(0, 8)}`, args: entry.args, timeout_ms: 120000 }, 130000)
          const state = await waitUntilInteractive(this.boundService(this.context()), entry.paneId, 300000, 1000, true)
          if (state === 'exited') throw new HerdrApiError('agent_not_ready', 'The resumed agent exited before becoming interactive')
          // Pending and blocked restores remain observed by AgentQuestions.
          // A slow startup must not be retried over an already running agent.
        })
      },
      sessionDir: dir => this.restoreService.setSessionDir(dir),
      observe: snapshot => {
        if (!enabled()) return
        const ctx = this.context()
        this.observing = this.observing.catch(() => {}).then(async () => {
          if (this.currentContext(ctx)) await this.observe(snapshot, ctx)
        }).catch(error => console.warn('[agent-restore] capture failed:', error instanceof HerdrApiError ? error.code : 'error'))
      },
      launched: async (params) => {
        if (!enabled() || !supportsModels(String(params.kind))) return
        await this.recordLaunch({ kind: params.kind as 'claude' | 'codex', args: params.args as string[] } as NewAgentRequest, String(params.pane_id))
      }
    }
  }
  private key(paneId: string) { return `${this.service.sessionName}:${paneId}` }
  private context(): Context { return { session: this.service.sessionName, generation: this.service.connectionGeneration, client: this.service.client } }
  private currentContext(ctx: Context) {
    return ctx.session === this.service.sessionName && ctx.generation === this.service.connectionGeneration && ctx.client === this.service.client
  }
  private assertContext(ctx: Context) {
    if (!this.currentContext(ctx)) throw new HerdrApiError('restart_session_changed', 'The herdr connection changed. Restart cancelled; review the original session before retrying.')
  }
  private boundService(ctx: Context): Pick<HerdrService, 'request'> {
    return { request: async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
      this.assertContext(ctx)
      const result = await this.service.request<T>(method, params, timeoutMs)
      this.assertContext(ctx)
      return result
    } }
  }
  private stored(a: AgentInfo) {
    const saved = this.launches[this.key(a.pane_id)]
    return saved?.terminalId === a.terminal_id && saved.kind === a.agent && (!saved.sessionId || !a.agent_session?.value || saved.sessionId === a.agent_session.value) ? saved : undefined
  }
  private persist() {
    this.launches = Object.fromEntries(Object.entries(this.launches).map(([key, launch]) => [key, sanitizeAgentLaunch(launch)]))
    const data = structuredClone(this.launches)
    const save = this.save.catch(() => {}).then(() => writeRestoreJson(this.file, data))
    this.save = save
    return save
  }
  async recordLaunch(req: NewAgentRequest, paneId: string) {
    if (!supportsModels(req.kind)) return
    const context = this.context()
    let agent: AgentInfo
    try { ({ agent } = await this.boundService(context).request<{ agent: AgentInfo }>('agent.get', { target: paneId })) }
    catch (error) { if (!this.currentContext(context)) return; throw error }
    if (agent.agent !== req.kind) return
    await this.remember(agent, req.args, undefined, true)
    if (!this.currentContext(context)) return
    this.service.scheduleRefresh()
  }
  async recordChoice(paneId: string, choice: ModelChoice) {
    const saved = this.launches[this.key(paneId)]
    if (saved) { const patch = safeLaunchChoice(choice); Object.assign(saved, patch); saved.choice = { ...saved.choice, ...patch }; await this.persist(); this.service.scheduleRefresh() }
  }
  private async remember(agent: AgentInfo, args: string[], processId?: number, fresh = false) {
    if (!supportsModels(agent.agent)) return
    const cached = this.launches[this.key(agent.pane_id)]
    const saved = !fresh && processId !== undefined && cached?.kind === agent.agent && cached.terminalId === agent.terminal_id && processId === cached.processId ? cached : undefined
    this.launches[this.key(agent.pane_id)] = sanitizeAgentLaunch({ kind: agent.agent, terminalId: agent.terminal_id,
      sessionId: agent.agent_session?.kind === 'id' ? agent.agent_session.value : saved?.sessionId ?? null,
      name: agent.name ?? null, cwd: agent.cwd, processId, args: [...args],
      bypass: args.some(a => bypassFlags.has(a) || a === '--permission-mode=bypassPermissions') ||
        args.some((a, i) => a === '--permission-mode' && args[i + 1] === 'bypassPermissions'),
      ...launchChoice(agent.agent, args), ...(saved?.choice ? { choice: saved.choice, ...saved.choice } : {}),
      ...(saved?.restoreUnavailable ? { restoreUnavailable: true } : {}) })
    await this.persist()
  }
  private async observe(snapshot: HerdrSnapshot, ctx: Context) {
    const service = this.boundService(ctx)
    await this.restoreService.invalidate(snapshot, ctx.session)
    for (const candidate of snapshot.agents) {
      if (!supportsModels(candidate.agent) || candidate.launch_pending) continue
      const cached = this.launches[this.key(candidate.pane_id)]
      const saved = cached?.kind === candidate.agent && cached.terminalId === candidate.terminal_id ? cached : undefined
      const { process_info } = await service.request<{ process_info: ProcessInfo }>('pane.process_info', { pane_id: candidate.pane_id })
      const process = nativeProcess(candidate.agent, process_info)
      // Detection can outlive a process for a few frames. A shell or an
      // unrecognized occupant has no launch policy to capture.
      if (!process) continue
      // A restore/explicit launch can leave the cache without a PID. That is
      // not evidence that the next occupant is the same native process.
      const sameProcess = saved?.processId === process.pid
      const args = sameProcess ? saved.args : process.args
      const processId = process.pid
      // Sequence precedes identity observation; a newer official hook wins a race.
      const observedSeq = (Date.now() - 1) * 1_000_000
      let agent: AgentInfo
      try { ({ agent } = await service.request<{ agent: AgentInfo }>('agent.get', { target: candidate.pane_id })) }
      catch (error) {
        if (error instanceof HerdrApiError && ['agent_not_found', 'not_found'].includes(error.code)) continue
        throw error
      }
      if (agent.agent !== candidate.agent || agent.terminal_id !== candidate.terminal_id || !args) continue
      // A /clear changes the native session but keeps the process's launch policy.
      if (!saved || JSON.stringify([saved.args, saved.sessionId, saved.name, saved.cwd, saved.processId]) !==
        JSON.stringify([args, agent.agent_session?.value ?? saved.sessionId, agent.name ?? null, agent.cwd, processId])) await this.remember(agent, args, processId)
      const launch = this.launches[this.key(agent.pane_id)]
      if (ctx.client && !launch.restoreUnavailable) await this.restoreService.report(agent, args, launch.choice, this.service.connection.version, ctx.client, observedSeq)
      this.assertContext(ctx)
    }
  }
  decorate(snapshot: HerdrSnapshot | null): HerdrSnapshot | null {
    if (!snapshot) return null
    const decorate = <T extends HerdrSnapshot['panes'][number]>(a: T): T => {
      const saved = this.launches[this.key(a.pane_id)]
      return saved?.terminalId === a.terminal_id && saved.kind === a.agent && (!saved.sessionId || !a.agent_session?.value || saved.sessionId === a.agent_session.value) ? { ...a, bypass: saved.bypass } : a
    }
    return { ...snapshot, panes: snapshot.panes.map(decorate), agents: snapshot.agents.map(decorate) }
  }
  async plan(selection: RestartSelection): Promise<RestartPlan> {
    if (typeof selection?.bypass !== 'boolean' || !!selection.paneId === !!selection.workspaceId) throw new Error('Choose one agent or project')
    for (const [token, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(token)
    const context = this.context(), service = this.boundService(context)
    await this.service.refresh(); this.assertContext(context)
    const candidates = this.service.snapshot?.agents.filter(a => selection.paneId ? a.pane_id === selection.paneId : a.workspace_id === selection.workspaceId) ?? []
    const entries: Prepared[] = [], skipped: RestartPlan['skipped'] = []
    for (const candidate of candidates) {
      if (!supportsModels(candidate.agent)) continue
      const { agent: a } = await service.request<{ agent: AgentInfo }>('agent.get', { target: candidate.pane_id })
      const reason = a.agent_status === 'working' ? 'agent_busy' : a.agent_status === 'blocked' ? 'agent_blocked' : !['idle', 'done'].includes(a.agent_status) || a.launch_pending ? 'agent_not_ready' : null
      if (reason) { skipped.push({ paneId: a.pane_id, name: a.name || a.agent, reason }); continue }
      if (!supportsModels(a.agent)) continue
      const saved = this.stored(a)
      const info = await service.request<{ process_info: ProcessInfo }>('pane.process_info', { pane_id: a.pane_id })
      const process = nativeProcess(a.agent, info.process_info)
      const foregroundPid = process?.pid ?? info.process_info.foreground_processes?.find(p => p.pid !== info.process_info.shell_pid)?.pid
      const shellPid = info.process_info.shell_pid
      if (!foregroundPid || !shellPid) { skipped.push({ paneId: a.pane_id, name: a.name || a.agent, reason: 'agent_not_ready' }); continue }
      const args = process?.args ?? saved?.args ?? []
      if (saved?.restoreUnavailable || sanitizeLaunchArgs(a.agent, args).unavailable) { skipped.push({ paneId: a.pane_id, name: a.name || a.agent, reason: 'restore_unavailable' }); continue }
      const meta = await this.transcript(a.pane_id)
      this.assertContext(context)
      const sessionId = a.agent_session?.kind === 'id' && a.agent_session.agent === a.agent ? a.agent_session.value : meta?.agent === a.agent && meta.located === 'exact' ? meta.sessionId || null : null
      const choice = { ...launchChoice(a.agent, args), ...(saved?.model ? { model: saved.model } : {}), ...(saved?.effort ? { effort: saved.effort } : {}), ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort } : {}) }
      const bypass = process ? args.some(arg => bypassFlags.has(arg) || arg === '--permission-mode=bypassPermissions') || args.some((arg, i) => arg === '--permission-mode' && args[i + 1] === 'bypassPermissions') : saved?.bypass ?? false
      this.launches[this.key(a.pane_id)] = { kind: a.agent, terminalId: a.terminal_id, sessionId, args, bypass, ...choice, cwd: a.cwd, name: a.name, processId: foregroundPid, choice: saved?.choice }
      if (selection.workspaceId && bypass === selection.bypass) { skipped.push({ paneId: a.pane_id, name: a.name || a.agent, reason: 'already_bypass' }); continue }
      entries.push({ paneId: a.pane_id, name: a.name || a.agent, originalName: a.name ?? null, kind: a.agent, terminalId: a.terminal_id, sessionId, bypass, args, choice, foregroundPid, shellPid })
    }
    await this.persist()
    this.assertContext(context)
    const plan: RestartPlan = { token: randomUUID(), bypass: selection.paneId && entries.length ? !entries[0].bypass : selection.bypass, agents: entries.map(({ paneId, name, kind, sessionId, bypass }) => ({ paneId, name, kind, sessionId, bypass })), skipped }
    this.pending.set(plan.token, { plan, entries, expires: Date.now() + 5 * 60_000, context })
    return plan
  }
  async execute(token: string): Promise<RestartResult[]> {
    const pending = this.pending.get(token)
    this.pending.delete(token)
    if (!pending || pending.expires < Date.now()) throw new HerdrApiError('restart_plan_expired', 'Restart confirmation expired. Review the agents again.')
    this.assertContext(pending.context)
    const results: RestartResult[] = []
    for (const entry of pending.entries) {
      if (this.busy.has(entry.paneId)) { results.push({ paneId: entry.paneId, name: entry.name, ok: false, code: 'agent_busy' }); continue }
      this.busy.add(entry.paneId)
      try { await this.restart(entry, pending.plan.bypass, pending.context); results.push({ paneId: entry.paneId, name: entry.name, ok: true }) }
      catch (e) { results.push({ paneId: entry.paneId, name: entry.name, ok: false, code: e instanceof HerdrApiError ? e.code : 'error', error: e instanceof Error ? e.message : String(e) }) }
      finally { this.busy.delete(entry.paneId) }
    }
    return results
  }
  private async restart(entry: Prepared, bypass: boolean, context: Context) {
    const service = this.boundService(context)
    const { agent } = await service.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
    if (agent.agent_status === 'working') throw new HerdrApiError('agent_busy', 'The agent is busy right now. Try again when it finishes.')
    if (agent.agent_status === 'blocked') throw new HerdrApiError('agent_blocked', 'The agent is waiting for your answer (approval or question). Answer it in the terminal panel first.')
    const ref = agent.agent_session
    const meta = ref?.kind === 'id' ? null : await this.transcript(entry.paneId)
    this.assertContext(context)
    const sessionId = ref?.kind === 'id' ? ref.value : meta?.located === 'exact' && meta.agent === entry.kind ? meta.sessionId || null : null
    if (agent.terminal_id !== entry.terminalId || agent.agent !== entry.kind || (agent.name ?? null) !== entry.originalName || sessionId !== entry.sessionId || !['idle', 'done'].includes(agent.agent_status) || agent.launch_pending) throw new HerdrApiError('restart_plan_expired', 'The agent changed. Review the restart again.')
    // Ctrl+C twice is the agents' graceful exit. Never close the pane or kill herdr.
    for (let press = 0; press < 2; press++) {
      const info = await service.request<{ process_info: ProcessInfo }>('pane.process_info', { pane_id: entry.paneId })
      if (atShell(info.process_info)) break
      const { agent: current } = await service.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
      this.assertOccupant(entry, current, info.process_info)
      if (current.agent_status === 'working' || current.agent_status === 'blocked') throw new HerdrApiError(current.agent_status === 'working' ? 'agent_busy' : 'agent_blocked', 'The agent changed. Review the restart again.')
      await service.request('agent.send_keys', { target: entry.paneId, keys: ['ctrl+c'] })
      await sleep(350)
    }
    const deadline = Date.now() + 12000
    for (;;) {
      const info = await service.request<{ process_info: ProcessInfo }>('pane.process_info', { pane_id: entry.paneId })
      if (atShell(info.process_info) && info.process_info.shell_pid === entry.shellPid) break
      const { agent: current } = await service.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
      this.assertOccupant(entry, current, info.process_info)
      if (Date.now() >= deadline) throw new HerdrApiError('agent_stop_failed', 'The agent did not stop. Check the terminal panel before retrying.')
      await sleep(150)
    }
    const args = restartArgs(entry.kind, entry.args, entry.sessionId, entry.choice, bypass)
    const ensureShell = async () => {
      const info = await service.request<{ process_info: ProcessInfo }>('pane.process_info', { pane_id: entry.paneId })
      if (!atShell(info.process_info) || info.process_info.shell_pid !== entry.shellPid) throw new HerdrApiError('restart_occupant_changed', 'The pane occupant changed. Restart cancelled; no further input was sent.')
    }
    await ensureShell()
    // Detection can retain an exited agent's name for a few frames. Clear only
    // that original binding at its verified shell prompt, then restore the name.
    try {
      const { agent: ended } = await service.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
      if (ended.agent && (ended.agent !== entry.kind || (ended.name ?? null) !== entry.originalName || ended.terminal_id !== entry.terminalId)) throw new HerdrApiError('restart_occupant_changed', 'The pane occupant changed. Restart cancelled; no further input was sent.')
      if (ended.name) { await ensureShell(); await service.request('agent.rename', { target: entry.paneId, name: null }) }
    } catch (e) {
      if (!(e instanceof HerdrApiError) || !['agent_not_found', 'not_found'].includes(e.code)) throw e
    }
    await ensureShell()
    const recordedBeforeStart = this.launches[this.key(entry.paneId)]
    if (entry.sessionId) this.onRestore?.([{ paneId: entry.paneId, kind: entry.kind, sessionId: entry.sessionId }])
    await service.request('agent.start', { name: entry.originalName || `drover-resume-${randomUUID().slice(0, 8)}`, kind: entry.kind, pane_id: entry.paneId, args, timeout_ms: 120000 }, 60000)
    const actual = this.launches[this.key(entry.paneId)]
    const actualArgs = actual !== recordedBeforeStart && actual?.terminalId === entry.terminalId && actual.kind === entry.kind ? actual.args : args
    this.launches[this.key(entry.paneId)] = { kind: entry.kind, terminalId: entry.terminalId, sessionId: entry.sessionId, args: actualArgs, bypass, ...entry.choice, name: entry.originalName, cwd: agent.cwd }
    await this.persist()
    this.assertContext(context)
    const state = await waitUntilInteractive(service, entry.paneId, 30000)
    const { agent: started } = await service.request<{ agent: AgentInfo }>('agent.get', { target: entry.paneId })
    this.service.scheduleRefresh()
    if (state !== 'ready' || !started.interactive_ready || started.agent !== entry.kind) throw new HerdrApiError(state === 'blocked' ? 'agent_blocked' : 'agent_not_ready', 'The agent is still starting. Check the terminal panel before retrying.')
    // Preserve unnamed occupants too: names are attached to the current process.
    if (!entry.originalName) await service.request('agent.rename', { target: entry.paneId, name: null })
    // HQ persistence observes the actual ready launch, after all identity guards.
    const launch = this.launches[this.key(entry.paneId)]
    if (started.agent_session?.kind === 'id' && started.agent_session.agent === entry.kind) {
      launch.sessionId = started.agent_session.value
      await this.persist()
    }
    this.assertContext(context)
    if (this.onRestart) { await this.onRestart(entry.paneId, structuredClone(launch)); this.assertContext(context) }
  }
  private assertOccupant(entry: Prepared, agent: AgentInfo, info: ProcessInfo) {
    const ref = agent.agent_session
    if (agent.terminal_id !== entry.terminalId || agent.agent !== entry.kind || (agent.name ?? null) !== entry.originalName || info.shell_pid !== entry.shellPid || !info.foreground_processes?.some(p => p.pid === entry.foregroundPid) || ref?.kind === 'id' && ref.value !== entry.sessionId) throw new HerdrApiError('restart_occupant_changed', 'The pane occupant changed. Restart cancelled; no further input was sent.')
  }
}

function atShell(info: ProcessInfo): boolean {
  return !!info.shell_pid && !!info.foreground_processes?.length && info.foreground_processes.every(p => p.pid === info.shell_pid)
}

/** Native processes can be an executable, an npm shim, or node plus a package CLI. */
export function nativeProcess(kind: 'claude' | 'codex', info: ProcessInfo): { args: string[]; pid: number } | null {
  for (const process of info.foreground_processes ?? []) {
    const argv = process.argv ?? []
    const index = argv.findIndex((arg, i) => i < 3 &&
      (basename(arg.replaceAll(String.fromCharCode(92), '/')).replace(/\.(?:js|cjs|mjs|exe|cmd)$/i, '') === kind ||
        kind === 'claude' && /(?:^|[/\\])@anthropic-ai[/\\]claude-code[/\\]cli\.js$/.test(arg)))
    if (index >= 0) return { args: argv.slice(index + 1), pid: process.pid }
  }
  return null
}
