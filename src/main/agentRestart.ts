import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { bypassArgs, modelArgs, supportsModels, type ModelChoice } from '@shared/models'
import { HerdrApiError, type AgentInfo, type HerdrSnapshot, type NewAgentRequest, type TranscriptMeta } from '@shared/types'
import type { AgentLaunch, RestartCandidate, RestartPlan, RestartResult, RestartSelection } from '@shared/agentRestart'
import type { HerdrService } from './herdr/service'
import { waitUntilInteractive } from './actions'
import { writeBossJson } from './boss/store'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const bypassFlags = new Set(['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo'])
const permissionFlags = new Set([...bypassFlags, '--full-auto', '--approve-for-me'])
type Kind = 'claude' | 'codex'
type Arity = 0 | 1 | 'optional' | 'many'
const flags = (groups: [Arity, string][]): Map<string, Arity> => new Map(groups.flatMap(([arity, names]) => names.split(' ').map(name => [name, arity] as const)))
const CLAUDE_FLAGS = flags([
  [0, '-c --continue -p --print --fork-session --dangerously-skip-permissions --allow-dangerously-skip-permissions --bare --brief --chrome --no-chrome --ide --disable-slash-commands --strict-mcp-config --safe-mode --restricted --no-session-persistence --verbose --ax-screen-reader'],
  [1, '--model --effort --permission-mode --session-id --settings --setting-sources --append-system-prompt --append-system-prompt-file --system-prompt --system-prompt-file --agent --agents --fallback-model --plugin-dir --plugin-url -n --name --debug-file --output-format --input-format --json-schema --max-budget-usd --permission-prompts --permission-prompt-tool --autocompact'],
  ['optional', '-r --resume -d --debug --from-pr --prompt-suggestions --remote-control'],
  ['many', '--add-dir --mcp-config --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools --betas --file']
])
const CODEX_FLAGS = flags([
  [0, '--last --all --full-auto --yolo --dangerously-bypass-approvals-and-sandbox --approve-for-me --dangerously-bypass-hook-trust --oss --search --no-alt-screen --no-daemon --strict-config --include-non-interactive --worktree'],
  [1, '-c --config -m --model -s --sandbox -a --ask-for-approval --approval-policy -p --profile -C --cd --add-dir --enable --disable --local-provider --remote --remote-auth-token-env'],
  ['many', '-i --image']
])
interface LaunchOption { flag: string; tokens: string[]; value?: string }
/** Native argv has different meanings for -c/-p; never consume a following flag as a value. */
function launchOptions(kind: Kind, args: string[]): LaunchOption[] {
  const table = kind === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS, out: LaunchOption[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (kind === 'codex' && ['resume', 'fork'].includes(arg)) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue }
    if (!arg.startsWith('-')) continue // Launch/session prompts are never replayed.
    const equals = arg.indexOf('='), flag = equals < 0 ? arg : arg.slice(0, equals)
    const arity = table.get(flag), tokens = [arg]
    let value = equals < 0 ? undefined : arg.slice(equals + 1)
    if (equals < 0 && arity !== 0 && arity !== undefined && args[i + 1] && !args[i + 1].startsWith('-')) {
      value = args[++i]; tokens.push(value)
      if (arity === 'many') while (args[i + 1] && !args[i + 1].startsWith('-')) tokens.push(args[++i])
    }
    if (arity === 1 && value === undefined) continue // Do not preserve dangling options.
    out.push({ flag, tokens, value })
  }
  return out
}

/** Keep launch options, replacing conversation, model and permission settings. Never append a prompt. */
export function restartArgs(kind: 'claude' | 'codex', original: string[], sessionId: string | null, choice: ModelChoice, bypass: boolean): string[] {
  const rest: string[] = []
  const replace = kind === 'claude'
    ? new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--model', '--effort', '--permission-mode', '--fork-session', '--from-pr', '-p', '--print', '--output-format', '--input-format', '--allow-dangerously-skip-permissions'])
    : new Set(['--last', '--all', '-m', '--model', '-a', '--ask-for-approval', '--approval-policy', '-s', '--sandbox', '-i', '--image', '--worktree'])
  for (const option of launchOptions(kind, original)) {
    if (permissionFlags.has(option.flag) || replace.has(option.flag)) continue
    if (kind === 'codex' && ['-c', '--config'].includes(option.flag) && /^(model|model_reasoning_effort|approval_policy|sandbox_mode)\s*=/.test(option.value ?? '')) continue
    rest.push(...option.tokens)
  }
  const effectiveChoice = { ...launchChoice(kind, original), ...Object.fromEntries(Object.entries(choice).filter(([, v]) => v)) }
  const permissions = bypass ? bypassArgs(kind, true) : kind === 'claude' ? ['--permission-mode', 'manual'] : ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
  return [...(sessionId ? kind === 'claude' ? ['--resume', sessionId] : ['resume', sessionId] : []), ...rest, ...modelArgs(kind, effectiveChoice), ...permissions]
}

export function launchChoice(kind: Kind, args: string[]): ModelChoice {
  const choice: ModelChoice = {}
  for (const { flag, value } of launchOptions(kind, args)) {
    if (flag === '--model' || kind === 'codex' && flag === '-m') choice.model = value
    else if (kind === 'claude' && flag === '--effort') choice.effort = value
    else if (kind === 'codex' && (flag === '-c' || flag === '--config')) {
      const m = value?.match(/^(model|model_reasoning_effort)\s*=\s*["']?([^"']+)["']?$/)
      if (m) choice[m[1] === 'model' ? 'model' : 'effort'] = m[2]
    }
  }
  return choice
}

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
  constructor(private service: HerdrService, userData: string, private transcript: (paneId: string) => Promise<TranscriptMeta | null>,
    private onRestart?: (paneId: string, launch: AgentLaunch) => Promise<void>) {
    this.file = join(userData, 'agent-launches.json')
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [key, v] of Object.entries(data)) {
        const a = v as AgentLaunch
        if (a && supportsModels(a.kind) && typeof a.terminalId === 'string' && typeof a.bypass === 'boolean' && Array.isArray(a.args) && a.args.every(s => typeof s === 'string')) this.launches[key] = a
      }
    } catch { /* first run or corrupt cache */ }
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
    const data = structuredClone(this.launches)
    const save = this.save.catch(() => {}).then(() => writeBossJson(this.file, data))
    this.save = save
    return save
  }
  async recordLaunch(req: NewAgentRequest, paneId: string) {
    if (!supportsModels(req.kind)) return
    const context = this.context(), key = `${context.session}:${paneId}`
    let agent: AgentInfo
    try { ({ agent } = await this.boundService(context).request<{ agent: AgentInfo }>('agent.get', { target: paneId })) }
    catch (error) { if (!this.currentContext(context)) return; throw error }
    if (agent.agent !== req.kind) return
    this.launches[key] = { kind: req.kind, terminalId: agent.terminal_id, sessionId: agent.agent_session?.kind === 'id' ? agent.agent_session.value : null, args: [...req.args], bypass: req.args.some(a => bypassFlags.has(a)), ...launchChoice(req.kind, req.args) }
    await this.persist()
    this.service.scheduleRefresh()
  }
  async recordChoice(paneId: string, choice: ModelChoice) {
    const saved = this.launches[this.key(paneId)]
    if (saved) { Object.assign(saved, Object.fromEntries(Object.entries(choice).filter(([, v]) => v))); await this.persist() }
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
      const process = info.process_info.foreground_processes?.find(p => p.argv?.some(arg => /^(claude|codex)(?:\.js)?$/.test(basename(arg))))
      const foregroundPid = process?.pid ?? info.process_info.foreground_processes?.find(p => p.pid !== info.process_info.shell_pid)?.pid
      const shellPid = info.process_info.shell_pid
      if (!foregroundPid || !shellPid) { skipped.push({ paneId: a.pane_id, name: a.name || a.agent, reason: 'agent_not_ready' }); continue }
      const argv = process?.argv ?? []
      const executable = argv.findIndex(arg => /^(claude|codex)(?:\.js)?$/.test(basename(arg)))
      const args = executable >= 0 ? argv.slice(executable + 1) : saved?.args ?? []
      const meta = await this.transcript(a.pane_id)
      this.assertContext(context)
      const sessionId = a.agent_session?.kind === 'id' && a.agent_session.agent === a.agent ? a.agent_session.value : meta?.agent === a.agent && meta.located === 'exact' ? meta.sessionId || null : null
      const choice = { ...launchChoice(a.agent, args), ...(saved?.model ? { model: saved.model } : {}), ...(saved?.effort ? { effort: saved.effort } : {}), ...(meta?.model ? { model: meta.model } : {}), ...(meta?.effort ? { effort: meta.effort } : {}) }
      const bypass = executable >= 0 ? args.some(arg => bypassFlags.has(arg) || arg === '--permission-mode=bypassPermissions') || args.some((arg, i) => arg === '--permission-mode' && args[i + 1] === 'bypassPermissions') : saved?.bypass ?? false
      this.launches[this.key(a.pane_id)] = { kind: a.agent, terminalId: a.terminal_id, sessionId, args, bypass, ...choice }
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
    await service.request('agent.start', { name: entry.originalName || `drover-resume-${randomUUID().slice(0, 8)}`, kind: entry.kind, pane_id: entry.paneId, args, timeout_ms: 120000 }, 60000)
    this.launches[this.key(entry.paneId)] = { kind: entry.kind, terminalId: entry.terminalId, sessionId: entry.sessionId, args, bypass, ...entry.choice }
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
