import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, HerdrSessionInfo, HerdrSnapshot } from '@shared/types'
import type { CodexDaemonAgent, CodexDaemonPlanChangedResult, CodexDaemonRestartPlan } from '@shared/codexIntegration'
import type { HerdrService } from './herdr/service'
import { HerdrClient } from './herdr/client'
import { defaultSocketPath } from './herdr/cli'
import { runCodex, type CodexCommandResult } from './codexLaunch'
import { which } from './env'

interface DaemonInfo { running: boolean; identity: string; paneId: string | null; socketPath: string | null }
interface Inventory { agents: CodexDaemonAgent[]; fingerprint: string; daemon: DaemonInfo; supported: boolean; complete: boolean }
interface Runtime {
  run?: (args: string[]) => Promise<CodexCommandResult>
  probe?: () => Promise<CodexCommandResult>
  wait?: (ms: number) => Promise<void>
  daemonContext?: () => Promise<{ identity: string; paneId: string | null; socketPath: string | null }>
  snapshots?: () => Promise<{ session: string; snapshot: HerdrSnapshot }[]>
}

export function daemonEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('HERDR_') && key !== 'CODEX_THREAD_ID'))
}

/** Use the existing daemon only. An ephemeral thread runs no turn and leaves no saved chat. */
export function probeCodexDaemon(env: NodeJS.ProcessEnv): Promise<CodexCommandResult> {
  const binary = which('codex', env)
  if (!binary) return Promise.resolve({ code: 127, stdout: '', stderr: 'Codex CLI is not installed' })
  return new Promise(resolve => {
    const child = spawn(binary, ['app-server', 'proxy'], { env: daemonEnvironment(env), stdio: 'pipe' })
    let buffer = '', stderr = '', settled = false
    const finish = (code: number, message: string) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      child.stdin.destroy(); child.kill()
      resolve({ code, stdout: code === 0 ? message : '', stderr: code === 0 ? '' : message })
    }
    const timer = setTimeout(() => finish(1, 'Codex did not accept a new session within 10 seconds.'), 10000)
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
    child.on('error', error => finish(1, error.message))
    child.stdin.on('error', error => finish(1, error.message))
    child.on('close', () => finish(1, stderr.trim() || 'Codex closed the connection before accepting a new session.'))
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 2 * 1024 * 1024) return finish(1, 'Codex returned an oversized session check response.')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let response
        try { response = JSON.parse(line) } catch { continue }
        if (![1, 2, 3].includes(response.id)) continue
        if (response.error) return finish(1, response.error.message || 'Codex rejected the new session check.')
        if (!response.result) return finish(1, 'Codex returned an invalid session check response.')
        if (response.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'thread/start', params: { ephemeral: true, approvalPolicy: 'never', sandbox: 'readOnly', config: { mcp_servers: {} } } })
        } else if (response.id === 2) {
          if (!response.result.thread?.id || response.result.thread.ephemeral !== true) return finish(1, 'Codex did not confirm a temporary session.')
          send({ id: 3, method: 'thread/unsubscribe', params: { threadId: response.result.thread.id } })
        } else finish(0, 'Codex service accepts new sessions.')
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'drover_daemon_check', version: '1' }, capabilities: { experimentalApi: true } } })
  })
}

/** Extract only these two diagnostic values; never expose the rest of ps's environment. */
export function daemonHerdrContext(command: string): { paneId: string | null; socketPath: string | null } {
  return { paneId: command.match(/(?:^|\s)HERDR_PANE_ID=([^\s]*)/)?.[1] || null,
    socketPath: command.match(/(?:^|\s)HERDR_SOCKET_PATH=([^\s]*)/)?.[1] || null }
}

export class CodexDaemon {
  private pending: { plan: CodexDaemonRestartPlan; fingerprint: string } | null = null
  lastStartedAt = 0
  constructor(private service: HerdrService, private runtime: Runtime = {}) {}
  private run(args: string[], timeout = 30000): Promise<CodexCommandResult> {
    if (this.runtime.run) return this.runtime.run(args)
    return runCodex(daemonEnvironment(this.service.env), args, timeout)
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
    // restart can leave the old process draining. Confirm its shutdown before start.
    const failure = (message: string, result?: CodexCommandResult) => ({ outcome: 'completed' as const, code: result?.code || 1,
      stdout: '', stderr: [message, result?.stderr || result?.stdout].filter(Boolean).join('\n') })
    const stopped = await this.run(['app-server', 'daemon', 'stop'])
    if (stopped.code !== 0) return failure('Could not stop the Codex service. It has not been started again.', stopped)
    let confirmed = false
    const deadline = Date.now() + 10000
    for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
      const result = await this.run(['app-server', 'daemon', 'version'], 5000)
      let status: string | undefined
      try { if (result.code === 0) status = JSON.parse(result.stdout).status } catch { /* retry */ }
      // Current CLI returns a connection error, rather than JSON, when stopped.
      const unavailable = result.code !== 0 && /failed to connect[\s\S]*(?:No such file or directory|Connection refused)/i.test(result.stderr)
      if ((status === 'stopped' || status === 'not_running' || unavailable) && !(await this.context()).identity) { confirmed = true; break }
      await (this.runtime.wait?.(250) ?? new Promise(resolve => setTimeout(resolve, 250)))
    }
    if (!confirmed) return failure('Codex service shutdown could not be confirmed. Start was cancelled; check the service and try again.')
    const started = await this.run(['app-server', 'daemon', 'start'])
    if (started.code !== 0) return failure('Codex service stopped, but could not be started again.', started)
    const version = await this.run(['app-server', 'daemon', 'version'])
    let running = false
    try { running = version.code === 0 && JSON.parse(version.stdout).status === 'running' } catch { /* failed */ }
    if (!running) return failure('Codex service start returned, but the service is not running.', version)
    this.lastStartedAt = Date.now()
    const probe = await (this.runtime.probe?.() ?? probeCodexDaemon(this.service.env))
    if (probe.code !== 0) return failure('Codex service is running but cannot accept a new session. Check the service before starting agents.', probe)
    return { ...probe, outcome: 'completed' }
  }
}
