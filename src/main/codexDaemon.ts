import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, HerdrSessionInfo, HerdrSnapshot } from '@shared/types'
import type { CodexDaemonAgent, CodexDaemonPlanChangedResult, CodexDaemonRestartPlan } from '@shared/codexIntegration'
import type { HerdrService } from './herdr/service'
import { HerdrClient } from './herdr/client'
import { defaultSocketPath } from './herdr/cli'
import { runCodex, type CodexCommandResult } from './codexLaunch'

interface DaemonInfo { running: boolean; identity: string; paneId: string | null; socketPath: string | null }
interface Inventory { agents: CodexDaemonAgent[]; fingerprint: string; daemon: DaemonInfo; supported: boolean; complete: boolean }
interface Runtime {
  run?: (args: string[]) => Promise<CodexCommandResult>
  daemonContext?: () => Promise<{ identity: string; paneId: string | null; socketPath: string | null }>
  snapshots?: () => Promise<{ session: string; snapshot: HerdrSnapshot }[]>
}

/** Extract only these two diagnostic values; never expose the rest of ps's environment. */
export function daemonHerdrContext(command: string): { paneId: string | null; socketPath: string | null } {
  return { paneId: command.match(/(?:^|\s)HERDR_PANE_ID=([^\s]*)/)?.[1] || null,
    socketPath: command.match(/(?:^|\s)HERDR_SOCKET_PATH=([^\s]*)/)?.[1] || null }
}

export class CodexDaemon {
  private pending: { plan: CodexDaemonRestartPlan; fingerprint: string } | null = null
  constructor(private service: HerdrService, private runtime: Runtime = {}) {}
  private run(args: string[]): Promise<CodexCommandResult> {
    if (this.runtime.run) return this.runtime.run(args)
    const env = Object.fromEntries(Object.entries(this.service.env).filter(([key]) => !key.startsWith('HERDR_') && key !== 'CODEX_THREAD_ID'))
    return runCodex(env, args, 30000)
  }
  private async context(): Promise<{ identity: string; paneId: string | null; socketPath: string | null }> {
    if (this.runtime.daemonContext) return this.runtime.daemonContext()
    const home = this.service.env.CODEX_HOME || join(homedir(), '.codex')
    const file = await readFile(join(home, 'app-server-daemon', 'daemon.pid'), 'utf8').catch(() => '')
    let pid = '', startedAt = ''
    try {
      const state = JSON.parse(file)
      pid = String(typeof state === 'number' ? state : state.pid ?? '')
      startedAt = typeof state.processStartTime === 'string' ? state.processStartTime : ''
    } catch { pid = file.trim() }
    if (!/^[1-9]\d{0,9}$/.test(pid)) return { identity: '', paneId: null, socketPath: null }
    return new Promise(resolve => execFile('/bin/ps', ['eww', '-p', pid, '-o', 'command='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      if (error || !/codex\s+app-server\b/.test(output)) return resolve({ identity: '', paneId: null, socketPath: null })
      resolve({ identity: `${pid}:${startedAt}`, ...daemonHerdrContext(String(output)) })
    }))
  }
  async info(): Promise<DaemonInfo> {
    const result = await this.run(['app-server', 'daemon', 'version'])
    let running = false
    try { running = result.code === 0 && JSON.parse(result.stdout).status === 'running' } catch { /* unavailable */ }
    return { running, ...await this.context() }
  }
  private async snapshots(): Promise<{ session: string; snapshot: HerdrSnapshot }[]> {
    if (this.runtime.snapshots) return this.runtime.snapshots()
    if (this.service.connection.status !== 'connected' || !this.service.snapshot) throw new Error('Connect to herdr before restarting Codex')
    const listing = await this.service.cli(['session', 'list', '--json'], 10000)
    const data = JSON.parse(listing.stdout)
    if (listing.code !== 0 || !Array.isArray(data.sessions) || data.sessions.some((session: HerdrSessionInfo) => !session || typeof session.name !== 'string' || typeof session.running !== 'boolean')) throw new Error('Could not list running herdr sessions')
    const sessions: HerdrSessionInfo[] = data.sessions
    const running = sessions.filter(session => session.running)
    const results = await Promise.all(running.map(async session => {
      const client = new HerdrClient(session.socket_path || defaultSocketPath(session.name, this.service.env))
      const result = await client.request<{ snapshot: HerdrSnapshot }>('session.snapshot', {}, 5000)
      return { session: session.name, snapshot: result.snapshot }
    }))
    if (!results.some(result => result.session === this.service.sessionName)) {
      const snapshot = (await this.service.request<{ snapshot: HerdrSnapshot }>('session.snapshot')).snapshot
      results.push({ session: this.service.sessionName, snapshot })
    }
    return results
  }
  private async inventory(): Promise<Inventory> {
    const [daemon, supported] = await Promise.all([this.info(), this.service.codexLaunch.supportsNoDaemon()])
    let snapshots: { session: string; snapshot: HerdrSnapshot }[] = [], complete = true
    try { snapshots = await this.snapshots() } catch { complete = false }
    const occupants: (AgentInfo & { session: string })[] = snapshots.flatMap(({ session, snapshot }) => snapshot.agents.filter(agent => agent.agent === 'codex').map(agent => ({ ...agent, session })))
    occupants.sort((a, b) => a.session.localeCompare(b.session) || a.pane_id.localeCompare(b.pane_id))
    const agents = occupants.map(agent => ({ session: agent.session, paneId: agent.pane_id,
      name: agent.name || agent.pane_id, status: agent.agent_status, hasSession: !!agent.agent_session }))
    const fingerprint = JSON.stringify([daemon.identity, occupants.map(agent => [agent.session, agent.pane_id, agent.terminal_id, agent.agent_session, agent.name])])
    return { agents, fingerprint, daemon, supported, complete }
  }
  async plan(): Promise<CodexDaemonRestartPlan> {
    return this.createPlan(await this.inventory())
  }
  private createPlan(inventory: Inventory): CodexDaemonRestartPlan {
    const canRestart = inventory.supported && inventory.complete && inventory.daemon.running && !!inventory.daemon.identity
    const plan: CodexDaemonRestartPlan = { token: randomUUID(), expiresAt: Date.now() + 60_000,
      agents: inventory.agents, busy: inventory.agents.some(agent => ['working', 'blocked', 'unknown'].includes(agent.status)),
      daemonRunning: inventory.daemon.running, canRestart, otherClientsMayBeAffected: true,
      ...(!canRestart ? { reason: !inventory.complete ? 'Could not inspect all running herdr sessions' : !inventory.daemon.running ? 'The shared Codex service is not running' : 'Cannot safely identify a supported Codex service' } : {}) }
    this.pending = { plan, fingerprint: inventory.fingerprint }
    return plan
  }
  async execute(token: string): Promise<(CodexCommandResult & { outcome: 'completed' }) | CodexDaemonPlanChangedResult> {
    const pending = this.pending
    this.pending = null
    if (!pending || pending.plan.token !== token || pending.plan.expiresAt < Date.now() || !pending.plan.canRestart) throw new Error('Review a fresh Codex restart plan first')
    const current = await this.inventory()
    if (!current.complete || !current.supported || !current.daemon.running || current.fingerprint !== pending.fingerprint) {
      return { outcome: 'plan_changed', plan: this.createPlan(current) }
    }
    if (pending.plan.expiresAt <= Date.now()) throw new Error('Review a fresh Codex restart plan first')
    // The one explicit mutation, reachable only through confirmed desktop IPC.
    return { ...await this.run(['app-server', 'daemon', 'restart']), outcome: 'completed' }
  }
}
