import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexIntegrationInstallResult, CodexIntegrationStatus } from '@shared/codexIntegration'
import type { HerdrService } from './herdr/service'
import { herdrConfigDir } from './herdr/cli'
import type { CodexDaemon } from './codexDaemon'

export function parseCodexIntegration(output: string): Pick<CodexIntegrationStatus, 'installed' | 'outdated' | 'integrationVersion'> {
  const line = output.split('\n').find(line => /^codex:/i.test(line.trim())) ?? ''
  return { installed: !!line && !/not installed|missing/i.test(line), outdated: /outdated|older|modified/i.test(line),
    integrationVersion: Number(line.match(/\bv(\d+)\b/)?.[1]) || null }
}
export function codexReportErrors(log: string, since = 0): number {
  return log.split('\n').filter(line => line.includes('method="pane.report_agent_session"') &&
    line.includes('outcome="error"') && /request_id="herdr:codex:/.test(line) &&
    (since === 0 || Date.parse(line.split(/\s/)[0]) > since)).length
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
    const reportErrors = codexReportErrors(await logTail(join(logDir, 'herdr-server.log')), installedAt)
    const missingSessions = this.service.snapshot?.agents.filter(agent => agent.agent === 'codex' && !agent.agent_session).length ?? 0
    const [daemon, noDaemonSupported] = await Promise.all([this.daemon?.info(), this.service.codexLaunch.supportsNoDaemon()])
    const staleDaemonContext = !!daemon?.running && !!daemon.paneId &&
      (daemon.socketPath !== this.service.connection.socketPath || !this.service.snapshot?.panes.some(pane => pane.pane_id === daemon.paneId))
    const warning = !integration.installed || integration.outdated || reportErrors > 0 || missingSessions > 0 || staleDaemonContext
    const message = !integration.installed ? 'Codex integration is not installed' : integration.outdated ? 'Codex integration needs reinstallation' :
      reportErrors ? `herdr rejected ${reportErrors} Codex session reports. Reinstall the integration; check herdr/Codex versions and pane context if errors continue.` :
        missingSessions || staleDaemonContext ? 'Codex agents have missing session identities or the shared service inherited a different HERDR_PANE_ID. They may not return after a herdr restart. New Drover launches use --no-daemon when supported.' : 'Codex integration is current'
    return { status: warning ? 'warning' : 'ok', ...integration, reportErrors,
      herdrVersion: this.service.connection.version ?? await this.service.version(), message,
      missingSessions, noDaemonSupported, daemonRunning: daemon?.running ?? false, staleDaemonContext }
  }
  install(): Promise<CodexIntegrationInstallResult> {
    if (this.installing) return this.installing
    this.installing = this.service.cli(['integration', 'install', 'codex'], 60000)
      .then(async result => ({ ...result, status: await this.status() }))
      .finally(() => { this.installing = null })
    return this.installing
  }
}
