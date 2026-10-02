import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HerdrSessionInfo } from '@shared/types'
import { which } from '../env'

export const CONTROLLER_ID = 'drover'

const COMMON_LOCATIONS = [
  join(homedir(), '.local', 'bin', 'herdr'),
  '/opt/homebrew/bin/herdr',
  '/usr/local/bin/herdr',
  join(homedir(), '.cargo', 'bin', 'herdr'),
  join(homedir(), 'bin', 'herdr')
]

export function findHerdr(env: NodeJS.ProcessEnv): string | null {
  return which('herdr', env) ?? COMMON_LOCATIONS.find((p) => existsSync(p)) ?? null
}

export function herdrConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.HERDR_CONFIG_PATH) {
    const p = env.HERDR_CONFIG_PATH
    return p.endsWith('.toml') ? join(p, '..') : p
  }
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg && xdg.length ? xdg : join(homedir(), '.config'), 'herdr')
}

export function defaultSocketPath(session: string, env: NodeJS.ProcessEnv): string {
  const dir = herdrConfigDir(env)
  return session === 'default' ? join(dir, 'herdr.sock') : join(dir, 'sessions', session, 'herdr.sock')
}

/** What quitting Drover does to the herdr server. */
export function quitPlan(stopOnQuit: boolean, panes: { agent?: string | null; agent_status?: string }[] | undefined): 'keep' | 'stop' | 'ask' {
  if (!stopOnQuit) return 'keep'
  const busy = (panes ?? []).filter((p) => p.agent && (p.agent_status === 'working' || p.agent_status === 'blocked')).length
  return busy ? 'ask' : 'stop'
}

/** Stops the session's server; blocks for a few seconds at most (used while quitting). */
export function stopServerSync(herdrPath: string, session: string, env: NodeJS.ProcessEnv): boolean {
  const r = spawnSync(herdrPath, [...sessionArgs(session), 'server', 'stop'], { env, timeout: 8000, stdio: 'ignore' })
  return r.status === 0
}

export function sessionArgs(session: string): string[] {
  return session && session !== 'default' ? ['--session', session] : []
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export function runHerdr(
  herdrPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60000
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      herdrPath,
      args,
      { env: { ...env, HERDR_CONTROLLER_ID: CONTROLLER_ID }, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

export async function listSessions(herdrPath: string, env: NodeJS.ProcessEnv): Promise<HerdrSessionInfo[]> {
  const res = await runHerdr(herdrPath, ['session', 'list', '--json'], env, 15000)
  try {
    const parsed = JSON.parse(res.stdout) as { sessions?: HerdrSessionInfo[] }
    return parsed.sessions ?? []
  } catch {
    return []
  }
}

export async function herdrVersion(herdrPath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const res = await runHerdr(herdrPath, ['--version'], env, 10000)
  const m = res.stdout.match(/(\d+\.\d+\.\d+[^\s]*)/)
  return m ? m[1] : null
}

/**
 * Starts a detached headless herdr server for the session. It keeps running
 * after the desktop app quits, exactly like a server started by the TUI.
 */
export function startServer(
  herdrPath: string,
  session: string,
  env: NodeJS.ProcessEnv,
  logDir: string
): void {
  mkdirSync(logDir, { recursive: true })
  const out = openSync(join(logDir, `herdr-server-${session}.log`), 'a')
  const child = spawn(herdrPath, [...sessionArgs(session), 'server'], {
    env: { ...env },
    cwd: homedir(),
    detached: true,
    stdio: ['ignore', out, out]
  })
  child.unref()
}
