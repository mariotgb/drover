import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexIntegrationInstallResult, CodexIntegrationStatus } from '@shared/codexIntegration'
import type { HerdrService } from './herdr/service'
import { herdrConfigDir } from './herdr/cli'
import type { CodexDaemon } from './codexDaemon'
import type { HerdrSnapshot } from '@shared/types'

export function parseCodexIntegration(output: string): Pick<CodexIntegrationStatus, 'installed' | 'outdated' | 'integrationVersion'> {
  const line = output.split('\n').find(line => /^codex:/i.test(line.trim())) ?? ''
  return { installed: !!line && !/not installed|missing/i.test(line), outdated: /outdated|older|modified/i.test(line),
    integrationVersion: Number(line.match(/\bv(\d+)\b/)?.[1]) || null }
}
export function herdrStartedAt(log: string): number {
  let started = 0
  for (const line of log.split('\n')) if (line.includes('event="app.startup"')) {
    const date = Date.parse(line.split(/\s/)[0])
    if (Number.isFinite(date)) started = date
  }
  return started
}
export function codexReportFailures(log: string, since = 0, livePanes?: ReadonlySet<string>): string[] {
  const result: string[] = []
  const requests = new Map<string, string>()
  const boundary = Math.max(since, herdrStartedAt(log))
  for (const line of log.split('\n')) {
    const id = line.match(/request_id="(herdr:codex:[^"]+)"/)?.[1]
    if (!id || !line.includes('method="pane.report_agent_session"')) continue
    const pane = line.match(/pane_id="?([a-zA-Z0-9]+:p\d+)"?/)?.[1]
    if (pane) requests.set(id, pane)
    if (!line.includes('outcome="error"')) continue
    const date = Date.parse(line.split(/\s/)[0])
    if (boundary && (!Number.isFinite(date) || date <= boundary)) continue
    const target = pane ?? requests.get(id)
    // Old Herdr versions omit pane IDs. Only current-start errors may then be
    // used as a general hook signal, and only while Codex panes are still live.
    if (livePanes && (target ? !livePanes.has(target) : !boundary || !livePanes.size)) continue
    result.push(id)
  }
  return result
}
export function codexReportErrors(log: string, since = 0, livePanes?: ReadonlySet<string>): number {
  return codexReportFailures(log, since, livePanes).length
}

/** Observe every live Codex incarnation, including agents launched outside Drover. */
export class CodexSessionTracker {
  private seen = new Map<string, number>()
  private session = ''
  missing(snapshot: HerdrSnapshot | null, session: string, now = Date.now()): string[] {
    if (this.session !== session) { this.seen.clear(); this.session = session }
    const live = new Set<string>(), missing: string[] = []
    for (const agent of snapshot?.agents ?? []) {
      if (agent.agent !== 'codex') continue
      const identity = JSON.stringify([agent.pane_id, agent.terminal_id, agent.name ?? null])
      live.add(identity)
      if (!this.seen.has(identity)) this.seen.set(identity, now)
      if (!agent.agent_session && now - this.seen.get(identity)! >= 60000) missing.push(identity)
    }
    for (const key of this.seen.keys()) if (!live.has(key)) this.seen.delete(key)
    return missing.sort()
  }
}

/** Read a bounded tail; diagnostics must not load an unbounded server log. */
async function logTail(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat(), start = Math.max(0, size - 8 * 1024 * 1024)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch { return '' }
  finally { await handle?.close() }
}

export class CodexIntegration {
  private installing: Promise<CodexIntegrationInstallResult> | null = null
  private tracker = new CodexSessionTracker()
  private serverStarted = new Map<string, number>()
  constructor(private service: HerdrService, private daemon?: CodexDaemon) {}
  async status(): Promise<CodexIntegrationStatus> {
    const fallback: CodexIntegrationStatus = { status: 'unavailable', installed: false, outdated: false,
      reportErrors: 0, integrationVersion: null, herdrVersion: this.service.connection.version ?? null, message: 'herdr is not connected' }
    if (!this.service.herdrPath) return fallback
    const result = await this.service.cli(['integration', 'status'], 15000)
    if (result.code !== 0) return { ...fallback, message: result.stderr || 'Could not inspect the Codex integration' }
    const integration = parseCodexIntegration(result.stdout)
    const config = herdrConfigDir(this.service.env)
    const logDir = this.service.sessionName === 'default' ? config : join(config, 'sessions', this.service.sessionName)
    const script = join(this.service.env.CODEX_HOME || join(homedir(), '.codex'), 'herdr-agent-state.sh')
    // Reinstallation replaces the hook. Historical errors before that replacement
    // are evidence about the old hook, not proof that the new one has failed.
    const installedAt = await stat(script).then(value => value.mtimeMs).catch(() => 0)
    const [daemon, noDaemonSupported] = await Promise.all([this.daemon?.info(), this.service.codexLaunch.supportsNoDaemon()])
    const log = await logTail(join(logDir, 'herdr-server.log'))
    const started = herdrStartedAt(log)
    if (started) this.serverStarted.set(logDir, started)
    const daemonStarted = Date.parse(daemon?.identity.slice(daemon.identity.indexOf(':') + 1) ?? '') || 0
    const since = Math.max(installedAt, this.serverStarted.get(logDir) ?? 0, this.daemon?.lastStartedAt ?? 0, daemonStarted)
    const live = new Set(this.service.snapshot?.agents.filter(a => a.agent === 'codex').map(a => a.pane_id) ?? [])
    // If the bounded tail no longer contains startup and we have never observed
    // it, do not guess that unattributed old log records describe this server.
    const failures = this.serverStarted.has(logDir) ? codexReportFailures(log, since, live) : []
    const reportErrors = failures.length
    const missing = this.tracker.missing(this.service.snapshot, this.service.sessionName)
    const missingSessions = missing.length
    const staleDaemonContext = !!daemon?.running && !!daemon.paneId &&
      (daemon.socketPath !== this.service.connection.socketPath || !this.service.snapshot?.panes.some(pane => pane.pane_id === daemon.paneId))
    const warning = !integration.installed || integration.outdated || reportErrors > 0 || missingSessions > 0 || staleDaemonContext
    const message = !integration.installed ? 'Codex integration is not installed' : integration.outdated ? 'Codex integration needs reinstallation' :
      reportErrors ? `herdr rejected ${reportErrors} Codex session reports. Reinstall the integration; check herdr/Codex versions and pane context if errors continue.` :
        missingSessions || staleDaemonContext ? 'Codex agents have missing session identities or the shared service inherited a different HERDR_PANE_ID. They may not return after a herdr restart. New Drover launches use --no-daemon when supported.' : 'Codex integration is current'
    return { status: warning ? 'warning' : 'ok', ...integration, reportErrors,
      herdrVersion: this.service.connection.version ?? await this.service.version(), message,
      missingSessions, noDaemonSupported, daemonRunning: daemon?.running ?? false, staleDaemonContext,
      warningKey: JSON.stringify([this.service.sessionName, integration, failures, missing, staleDaemonContext ? daemon : null]) }
  }
  install(): Promise<CodexIntegrationInstallResult> {
    if (this.installing) return this.installing
    this.installing = this.service.cli(['integration', 'install', 'codex'], 60000)
      .then(async result => ({ ...result, status: await this.status() }))
      .finally(() => { this.installing = null })
    return this.installing
  }
}
