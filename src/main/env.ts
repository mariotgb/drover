import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, delimiter } from 'node:path'

// Apps launched from Finder/Dock get a minimal launchd environment (PATH is
// /usr/bin:/bin:...). herdr, claude and codex usually live in user-managed
// locations, and the herdr server passes its environment on to every pane.
// Resolve the user's login shell environment; explicit reconnect refreshes it.

let resolved: Promise<NodeJS.ProcessEnv> | null = null
let probeLog: ((event: string, details: Record<string, unknown>) => void) | undefined
export function setEnvProbeLogger(logger: typeof probeLog): void { probeLog = logger }

/** Always dropped: Electron internals and herdr pane context. */
const ALWAYS_DROP = [
  'ELECTRON_',
  'HERDR_ENV',
  'HERDR_PANE',
  'HERDR_TAB',
  'HERDR_WORKSPACE',
  'HERDR_SOCKET',
  'HERDR_PLUGIN',
  'npm_'
]

const ALWAYS_DROP_EXACT = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/**
 * Dropped only when falling back to this process's own environment, which may
 * have been inherited from another agent host (for example a Claude Code
 * session). Leaking those markers into herdr panes breaks the agents there:
 * Claude Code disables transcript saving when it sees CLAUDE_CODE_CHILD_SESSION.
 */
const FALLBACK_DROP = [
  'CLAUDE',
  'MCP_',
  'CODEX_THREAD',
  'ITERM_',
  'TERM_SESSION',
  'TERM_PROGRAM',
  'GHOSTTY_',
  'KITTY_',
  'WEZTERM_',
  'TMUX',
  'VSCODE_',
  '__CF',
  'XPC_',
  'INIT_CWD',
  'NODE_OPTIONS'
]

const EXTRA_PATHS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  join(homedir(), 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin'
]

function drop(env: NodeJS.ProcessEnv, prefixes: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || ALWAYS_DROP_EXACT.has(k)) continue
    if (prefixes.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}

function finalize(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  const parts = (out.PATH ?? '').split(delimiter).filter(Boolean)
  for (const p of EXTRA_PATHS) {
    if (!parts.includes(p) && existsSync(p)) parts.push(p)
  }
  for (const p of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!parts.includes(p)) parts.push(p)
  }
  out.PATH = parts.join(delimiter)
  if (!out.HOME) out.HOME = homedir()
  if (!out.USER) out.USER = userInfo().username
  if (!out.LANG || !/utf-?8/i.test(out.LANG)) out.LANG = 'en_US.UTF-8'
  if (!out.TERM || out.TERM === 'dumb') out.TERM = 'xterm-256color'
  return out
}

export function fallbackEnv(): NodeJS.ProcessEnv {
  return finalize(drop(drop(process.env, ALWAYS_DROP), FALLBACK_DROP))
}

function resolveFromShell(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
  const mark = `__DROVER_ENV_${Date.now()}__`
  const exe = process.execPath.replace(/'/g, "'\\''")
  const script = `'${exe}' -e 'process.stdout.write("${mark}"+JSON.stringify(process.env)+"${mark}")'`
  return new Promise((resolve) => {
    let stdout = ''
    let done = false
    const finish = (env: NodeJS.ProcessEnv | null) => {
      if (done) return
      done = true
      resolve(env ? finalize(drop(env, ALWAYS_DROP)) : fallbackEnv())
    }
    try {
      const child = spawn(shell, ['-ilc', script], {
        env: {
          HOME: homedir(),
          USER: userInfo().username,
          LOGNAME: userInfo().username,
          SHELL: shell,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1'
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true
      })
      probeLog?.('env-probe-start', { pid: child.pid, parentPid: process.pid, shell, executable: process.execPath, detached: true })
      const timer = setTimeout(() => {
        probeLog?.('env-probe-timeout', { pid: child.pid, parentPid: process.pid, signal: 'SIGKILL' })
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish(null)
      }, 10000)
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('close', (code, signal) => {
        probeLog?.('env-probe-exit', { pid: child.pid, parentPid: process.pid, code, signal })
        clearTimeout(timer)
        const start = stdout.indexOf(mark)
        const end = stdout.lastIndexOf(mark)
        if (start >= 0 && end > start) {
          try {
            finish(JSON.parse(stdout.slice(start + mark.length, end)) as NodeJS.ProcessEnv)
            return
          } catch {
            /* fall through */
          }
        }
        finish(null)
      })
    } catch {
      finish(null)
    }
  })
}

export function loginEnv(refresh = false): Promise<NodeJS.ProcessEnv> {
  if (refresh) resolved = null
  if (!resolved) resolved = resolveFromShell()
  return resolved
}

export function which(bin: string, env: NodeJS.ProcessEnv): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}
