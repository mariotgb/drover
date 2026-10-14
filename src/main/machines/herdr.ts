import { join } from 'node:path'
import type { HerdrMachineWorkspace, HerdrSavedMachine, HerdrSavedMachineStatus, StartHerdrAgentRequest } from '@shared/machines'
import type { AgentInfo, HerdrSnapshot } from '@shared/types'
import { AGENT_KINDS, AGENT_NAME_RE, toAgentName } from '@shared/agents'
import { findHerdr, type CliResult } from '../herdr/cli'
import { nativeProcess } from '../agentRestart'
import { bypassFlags, sanitizeAgentLaunch, launchChoice } from '../agentLaunchArgs'
import { writeRestoreJson } from '../agentRestore'
import { MachinesFailure, privateWrite, quote, runCommand, type CommandRunner } from './ssh'
import { validHost, validPort } from './store'

export function parseHerdrTarget(target: string): { host: string; port: number; user?: string } {
  if (typeof target !== 'string' || target.length > 512 || /[\s\0]/.test(target)) throw new MachinesFailure('invalid_target', 'Invalid saved SSH target.')
  const match = target.match(/^(?:ssh:\/\/)?(?:([a-zA-Z_][a-zA-Z0-9_.-]*)@)?(\[[0-9a-fA-F:]+\]|[^:@/]+)(?::([0-9]+))?\/?$/)
  if (!match) throw new MachinesFailure('invalid_target', 'Invalid saved SSH target.')
  const host = match[2].replace(/^\[|\]$/g, ''), port = match[3] ? Number(match[3]) : 22
  validHost(host); validPort(port)
  return { host, port, ...(match[1] ? { user: match[1] } : {}) }
}
function json(result: CliResult): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout || result.stderr) } catch { /* sanitized below */ }
  if (result.code !== 0) {
    const code = (parsed as { error?: { code?: string } })?.error?.code
    throw new MachinesFailure(code && /^[a-z][a-z0-9_]*$/.test(code) ? code : 'herdr_unavailable', 'Herdr could not complete this machine operation. Check its SSH connection in herdr; no password or host-key prompt is opened by Drover.')
  }
  if (parsed === undefined) throw new MachinesFailure('invalid_response', 'Herdr returned invalid machine metadata.')
  return parsed
}
export interface HerdrRegistryOptions {
  root: string; userData: string; configPath: string; env(): NodeJS.ProcessEnv
  binary?(): string | null; run?: CommandRunner
}
/** All background calls are list/status/snapshot/process-info. Registry writes
 * are separate methods, invoked only by confirmed desktop operations. */
export class HerdrMachineRegistry {
  private runner: CommandRunner
  private prepared = false
  constructor(private options: HerdrRegistryOptions) { this.runner = options.run ?? runCommand }
  private async env(): Promise<NodeJS.ProcessEnv> {
    const folder = join(this.options.root, 'herdr-bin')
    if (!this.prepared) {
      // Herdr invokes OpenSSH itself; this shim adds the managed config and
      // prevents any SSH authentication/host-check dialog in background calls.
      // Herdr supplies its own -F, which would override ours. Discard that
      // option before the destination, preserving transport flags and the
      // remote command byte-for-byte (including any -F inside that command).
      await privateWrite(join(folder, 'ssh'), `#!/bin/bash
args=()
while (( $# )); do
  case "$1" in
    -F) (( $# >= 2 )) || exit 64; shift 2 ;;
    -F?*) shift ;;
    -[BbcDEeIiJLlmOopQRSWw]) (( $# >= 2 )) || exit 64; args+=("$1" "$2"); shift 2 ;;
    --) args+=("$@"); break ;;
    -*) args+=("$1"); shift ;;
    *) args+=("$@"); break ;;
  esac
done
exec /usr/bin/ssh -F ${quote(this.options.configPath)} -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 "\${args[@]}"
`, 0o700)
      this.prepared = true
    }
    return { ...this.options.env(), PATH: folder + ':' + (this.options.env().PATH ?? ''), HERDR_CONTROLLER_ID: 'drover', SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '/usr/bin/false' }
  }
  async cli(args: string[], timeoutMs = 15_000): Promise<CliResult> {
    const binary = this.options.binary?.() ?? findHerdr(this.options.env())
    if (!binary) throw new MachinesFailure('herdr_unavailable', 'Install herdr 0.9.4 or newer to use saved machines.')
    return this.runner(binary, args, { env: await this.env(), timeoutMs })
  }
  async remoteTerminalCommand(profile: HerdrSavedMachine): Promise<string> {
    const env = await this.env()
    return `env PATH=${quote(env.PATH ?? '')} ${quote(this.options.binary?.() ?? 'herdr')} --remote ${quote(profile.target)} --session ${quote(profile.session)}`
  }
  private async command<T>(args: string[], timeout?: number): Promise<T> { return json(await this.cli(args, timeout)) as T }
  async list(): Promise<HerdrSavedMachine[]> {
    const rows = await this.command<HerdrSavedMachine[]>(['machine', 'list', '--json'])
    if (!Array.isArray(rows) || rows.length > 1000 || rows.some(m => !m || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.id) || typeof m.label !== 'string' || typeof m.target !== 'string' || typeof m.session !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.session) || typeof m.enabled !== 'boolean')) throw new MachinesFailure('invalid_response', 'Invalid herdr saved-machine list.')
    return rows.map(m => ({ ...m, ...parseHerdrTarget(m.target) }))
  }
  async statuses(ids?: string[]): Promise<HerdrSavedMachineStatus[]> {
    const rows = ids ? (await Promise.all(ids.map(id => this.command<HerdrSavedMachineStatus[]>(['machine', 'status', id, '--json'], 30_000)))).flat() : await this.command<HerdrSavedMachineStatus[]>(['machine', 'status', '--json'], 30_000)
    if (!Array.isArray(rows) || rows.some(m => !m || typeof m.id !== 'string' || typeof m.status !== 'string')) throw new MachinesFailure('invalid_response', 'Invalid herdr machine status.')
    return rows
  }
  async snapshot(id: string): Promise<HerdrSnapshot> {
    const value = await this.command<{ result?: { snapshot?: HerdrSnapshot }; snapshot?: HerdrSnapshot }>(['--machine', id, 'api', 'snapshot'])
    const snapshot = value.result?.snapshot ?? value.snapshot ?? (value as unknown as HerdrSnapshot)
    if (!snapshot || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.panes)) throw new MachinesFailure('invalid_response', 'Invalid remote herdr snapshot.')
    return snapshot
  }
  async add(target: string, label: string, session = 'default'): Promise<HerdrSavedMachine> {
    const result = await this.cli(['machine', 'add', target, '--label', label, '--remote-session', session], 60_000)
    if (result.code) json(result)
    const profile = (await this.list()).find(m => m.target === target && m.session === session)
    if (!profile) throw new MachinesFailure('herdr_sync_failed', 'Herdr did not retain the machine. Check its installation in a terminal.')
    return profile
  }
  async update(action: 'remove' | 'enable' | 'disable', id: string): Promise<void> {
    const result = await this.cli(['machine', action, id])
    if (result.code) json(result)
  }
  async rename(id: string, label: string): Promise<void> {
    const result = await this.cli(['machine', 'rename', id, '--label', label])
    if (result.code) json(result)
  }
  async start(profile: HerdrSavedMachine, req: StartHerdrAgentRequest): Promise<{ paneId: string }> {
    if (!AGENT_KINDS.some(a => a.kind === req.agent) || req.cwd !== undefined && (typeof req.cwd !== 'string' || /[\r\n\0]/.test(req.cwd) || req.cwd.length > 8192) || req.args !== undefined && (!Array.isArray(req.args) || req.args.length > 100 || req.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 8192))) throw new MachinesFailure('invalid_agent', 'Choose a supported agent and valid launch options.')
    const snapshot = await this.snapshot(profile.id)
    const names = new Set(snapshot.agents.map(a => a.name)), base = toAgentName(req.name || req.agent)
    if (!base || req.name && !AGENT_NAME_RE.test(req.name)) throw new MachinesFailure('invalid_name', 'Use a valid herdr agent name.')
    let name = base, suffix = 2
    while (names.has(name)) name = base.slice(0, 25) + '-' + suffix++
    const created = await this.command<{ result?: { root_pane?: { pane_id: string } } }>(['--machine', profile.id, 'workspace', 'create', ...(req.cwd ? ['--cwd', req.cwd] : []), '--label', name, '--no-focus'])
    const paneId = created.result?.root_pane?.pane_id
    if (!paneId) throw new MachinesFailure('pane_creation_failed', 'Herdr did not return a remote shell pane.')
    const args = req.args ?? []
    await this.command(['--machine', profile.id, 'agent', 'start', name, '--kind', req.agent, '--pane', paneId, '--timeout', '120000', ...(args.length ? ['--', ...args] : [])], 130_000)
    // Capture the exact requested flags, using the same sanitizer as local
    // agents. Remote paths/instructions are never interpreted on the Mac.
    const next = await this.snapshot(profile.id)
    const agent = next.agents.find(a => a.pane_id === paneId)
    if (agent) await this.capture(profile, agent, args)
    return { paneId }
  }
  private launches = new Map<string, ReturnType<typeof sanitizeAgentLaunch>>()
  private save = Promise.resolve()
  async capture(profile: HerdrSavedMachine, agent: AgentInfo, requested?: string[]): Promise<void> {
    if (!['claude', 'codex'].includes(agent.agent)) return
    let args = requested
    if (!args) {
      const result = await this.command<{ result?: { process_info?: Parameters<typeof nativeProcess>[1] } }>(['--machine', profile.id, 'pane', 'process-info', '--pane', agent.pane_id])
      args = result.result?.process_info ? nativeProcess(agent.agent as 'claude' | 'codex', result.result.process_info)?.args : undefined
    }
    if (!args) return
    const launch = sanitizeAgentLaunch({ kind: agent.agent as 'claude' | 'codex', args, terminalId: agent.terminal_id, sessionId: agent.agent_session?.kind === 'id' ? agent.agent_session.value : null, name: agent.name, cwd: agent.cwd, bypass: args.some(a => bypassFlags.has(a)) || args.some((a, i) => a === '--permission-mode=bypassPermissions' || a === '--permission-mode' && args[i + 1] === 'bypassPermissions'), ...launchChoice(agent.agent as 'claude' | 'codex', args) })
    const key = profile.id + ':' + profile.session + ':' + agent.pane_id
    if (JSON.stringify(this.launches.get(key)) === JSON.stringify(launch)) return
    this.launches.set(key, launch)
    const data = Object.fromEntries(this.launches)
    this.save = this.save.catch(() => {}).then(() => writeRestoreJson(join(this.options.userData, 'herdr-agent-launches.json'), data))
    await this.save
  }
  workspaces(snapshot: HerdrSnapshot): HerdrMachineWorkspace[] {
    return snapshot.workspaces.map(w => ({ id: w.workspace_id, label: w.label, cwd: snapshot.panes.find(p => p.workspace_id === w.workspace_id)?.cwd ?? undefined, agents: snapshot.agents.filter(a => a.workspace_id === w.workspace_id).map(a => ({ paneId: a.pane_id, name: a.name ?? undefined, agent: a.agent, status: a.agent_status ?? 'unknown', title: a.terminal_title_stripped ?? a.title ?? undefined })) }))
  }
}
