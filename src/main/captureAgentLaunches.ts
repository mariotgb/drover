/** One-shot Node entry. No Electron import, window, hooks, reports, or startup. */
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentLaunch } from '@shared/agentRestart'
import { supportsModels } from '@shared/models'
import { type AgentInfo } from '@shared/types'
import { nativeProcess } from './agentRestart'
import { bypassFlags, sanitizeAgentLaunch } from './agentLaunchArgs'
import { withRestoreMutex, writeRestoreJson } from './agentRestore'
import { HerdrClient } from './herdr/client'
import { defaultSocketPath, findHerdr, runHerdr } from './herdr/cli'

interface CaptureOptions { all: boolean; session?: string; userData: string; herdr?: string }
export function captureOptions(argv: string[]): CaptureOptions {
  let all = false, session: string | undefined, userData = '', herdr: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (seen.has(flag)) throw new Error('usage')
    seen.add(flag)
    if (flag === '--all-sessions') { all = true; continue }
    if (!['--session', '--user-data', '--herdr'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('usage')
    const value = argv[++i]
    if (/[\p{Cc}]/u.test(value)) throw new Error('usage')
    if (flag === '--session') session = value
    else if (flag === '--user-data') userData = value
    else herdr = value
  }
  if (!userData || all === !!session || session && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session)) throw new Error('usage')
  return { all, session, userData, herdr }
}
export async function captureAgentLaunches(options: CaptureOptions, env: NodeJS.ProcessEnv = process.env): Promise<{ code: string; sessions: number; captured: number; skipped: number; unavailable: number; errors: number }> {
  const counts = { code: 'captured', sessions: 0, captured: 0, skipped: 0, unavailable: 0, errors: 0 }
  let sessions: { name: string; socket_path: string }[]
  if (options.all) {
    const herdr = options.herdr ?? findHerdr(env)
    if (!herdr) return { ...counts, code: 'herdr_not_found', errors: 1 }
    const result = await runHerdr(herdr, ['session', 'list', '--json'], env, 15000)
    if (result.code) return { ...counts, code: 'session_list_failed', errors: 1 }
    try {
      const data = JSON.parse(result.stdout)
      if (!Array.isArray(data.sessions)) throw new Error('invalid')
      sessions = data.sessions.filter((s: { running?: boolean }) => s.running).map((s: { name: string; socket_path: string }) => {
        if (typeof s.name !== 'string' || typeof s.socket_path !== 'string') throw new Error('invalid')
        return { name: s.name, socket_path: s.socket_path }
      })
    } catch { return { ...counts, code: 'session_list_invalid', errors: 1 } }
  } else sessions = [{ name: options.session!, socket_path: defaultSocketPath(options.session!, env) }]
  const captured: Record<string, AgentLaunch> = {}
  for (const session of sessions) {
    const client = new HerdrClient(session.socket_path)
    counts.sessions++
    try {
      const { agents } = await client.request<{ agents: AgentInfo[] }>('agent.list', {}, 5000)
      for (const candidate of agents) {
        if (!supportsModels(candidate.agent) || candidate.launch_pending) { counts.skipped++; continue }
        try {
          const { process_info } = await client.request<{ process_info: Parameters<typeof nativeProcess>[1] }>('pane.process_info', { pane_id: candidate.pane_id }, 5000)
          const process = nativeProcess(candidate.agent, process_info)
          if (!process) { counts.skipped++; continue }
          const { agent } = await client.request<{ agent: AgentInfo }>('agent.get', { target: candidate.pane_id }, 5000)
          if (agent.agent !== candidate.agent || agent.terminal_id !== candidate.terminal_id || agent.name !== candidate.name ||
            agent.agent_session?.value !== candidate.agent_session?.value) { counts.skipped++; continue }
          const args = process.args
          const launch = sanitizeAgentLaunch({ kind: candidate.agent, terminalId: agent.terminal_id, name: agent.name ?? null,
            cwd: agent.cwd, sessionId: agent.agent_session?.kind === 'id' ? agent.agent_session.value : null, processId: process.pid, args,
            bypass: args.some(a => bypassFlags.has(a) || a === '--permission-mode=bypassPermissions') || args.some((a, i) => a === '--permission-mode' && args[i + 1] === 'bypassPermissions') })
          captured[`${session.name}:${agent.pane_id}`] = launch
          counts.captured++
          if (launch.restoreUnavailable) counts.unavailable++
        } catch { counts.errors++ }
      }
    } catch { counts.errors++ }
  }
  const file = join(options.userData, 'agent-launches.json')
  try {
    await withRestoreMutex(file, async () => {
      const merged: Record<string, AgentLaunch> = {}
      try {
        const legacy = JSON.parse(await readFile(file, 'utf8'))
        for (const [key, value] of Object.entries(legacy)) {
          const launch = value as AgentLaunch
          if (launch && supportsModels(launch.kind) && typeof launch.terminalId === 'string' && typeof launch.bypass === 'boolean' &&
            Array.isArray(launch.args) && launch.args.every(a => typeof a === 'string')) merged[key] = sanitizeAgentLaunch(launch)
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      await writeRestoreJson(file, { ...merged, ...captured })
    })
  } catch { counts.errors++; counts.code = 'capture_write_failed'; return counts }
  counts.code = counts.errors ? 'capture_partial' : 'captured'
  return counts
}
export async function captureMain(argv: string[]): Promise<number> {
  try {
    const result = await captureAgentLaunches(captureOptions(argv))
    process.stdout.write(JSON.stringify(result) + '\n')
    return result.errors ? 1 : 0
  } catch {
    process.stdout.write(JSON.stringify({ code: 'capture_usage', errors: 1 }) + '\n')
    return 2
  }
}
if (typeof import.meta.url === 'string' && process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  void captureMain(process.argv.slice(2)).then(code => { process.exitCode = code })
}
