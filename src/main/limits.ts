import { EventEmitter } from 'node:events'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LimitsState, LimitWindow, ProviderLimits } from '@shared/types'
import { defaultPaths, readClaudeStatusLimits } from './claudeStatusline'
import { codexHome } from './transcripts/locate'

// Plan usage limits, read from local files only — no network, no credentials.
//
// Codex writes its rate-limit snapshot (`rate_limits` on token_count events)
// into every session rollout, so the freshest rollout holds the account's
// current usage.
//
// Claude Code passes the limits it receives with every reply to its status
// line; when the user enables our status-line bridge (see claudeStatusline.ts)
// those snapshots land in ~/.drover/claude-status/.

const REFRESH_MS = 20_000

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function ls(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function newestRollouts(root: string, max = 8): Promise<string[]> {
  const files: { path: string; mtime: number }[] = []
  const years = (await ls(root)).filter((y) => /^\d{4}$/.test(y)).sort().reverse()
  let dayDirs = 0
  outer: for (const y of years) {
    const months = (await ls(join(root, y))).filter((m) => /^\d{2}$/.test(m)).sort().reverse()
    for (const m of months) {
      const days = (await ls(join(root, y, m))).filter((d) => /^\d{2}$/.test(d)).sort().reverse()
      for (const d of days) {
        const dir = join(root, y, m, d)
        for (const f of await ls(dir)) {
          if (!f.endsWith('.jsonl')) continue
          try {
            const st = await stat(join(dir, f))
            files.push({ path: join(dir, f), mtime: st.mtimeMs })
          } catch {
            /* ignore */
          }
        }
        if (++dayDirs >= 3) break outer
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((f) => f.path)
}

async function tail(path: string, bytes = 1024 * 1024): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const st = await fh.stat()
    const start = Math.max(0, st.size - bytes)
    const buf = Buffer.alloc(st.size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

function windowLabel(mins: number | undefined, fallback: string): string {
  if (!mins) return fallback
  if (mins <= 300) return '5-hour'
  if (mins >= 10080 && mins < 10080 * 2) return 'Weekly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  return `${Math.round(mins / 60)}-hour`
}

function prettyPlan(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined
  const known: Record<string, string> = { prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' }
  return known[p.toLowerCase()] ?? p.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function codexLimitsFromLine(o: Json): ProviderLimits | null {
  const p = o?.payload
  const rl = p?.rate_limits
  if (o?.type !== 'event_msg' || p?.type !== 'token_count' || !rl || typeof rl !== 'object') return null
  const observedAt = Date.parse(o.timestamp) || Date.now()
  const windows: LimitWindow[] = []
  for (const [key, w] of [
    ['Primary', rl.primary],
    ['Secondary', rl.secondary]
  ] as const) {
    if (!w || typeof w.used_percent !== 'number') continue
    const mins = typeof w.window_minutes === 'number' ? w.window_minutes : undefined
    const resetsAt =
      typeof w.resets_at === 'number'
        ? w.resets_at * 1000
        : typeof w.resets_in_seconds === 'number'
          ? observedAt + w.resets_in_seconds * 1000
          : undefined
    windows.push({ label: windowLabel(mins, key), usedPercent: w.used_percent, windowMinutes: mins, resetsAt })
  }
  if (!windows.length) return null
  windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
  return {
    provider: 'codex',
    windows,
    plan: prettyPlan(rl.plan_type),
    observedAt,
    reached: !!rl.rate_limit_reached_type
  }
}

async function readCodexLimits(env: NodeJS.ProcessEnv): Promise<ProviderLimits | null> {
  const files = await newestRollouts(join(codexHome(env), 'sessions'))
  let best: ProviderLimits | null = null
  for (const f of files) {
    let text: string
    try {
      text = await tail(f)
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"rate_limits"') || !line.includes('token_count')) continue
      try {
        const lim = codexLimitsFromLine(JSON.parse(line))
        if (lim) {
          if (!best || lim.observedAt > best.observedAt) best = lim
          break
        }
      } catch {
        /* partial first line */
      }
    }
  }
  return best
}

/** Plan name from Claude Code's local account file (no credentials involved). */
async function claudePlanLabel(): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8'))
    const tier: string | undefined = cfg?.oauthAccount?.organizationRateLimitTier ?? cfg?.oauthAccount?.userRateLimitTier
    const m = tier?.match(/claude_(max|pro|team|enterprise)(?:_(\d+)x)?/i)
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)}${m[2] ? ` ${m[2]}x` : ''}`
  } catch {
    /* ignore */
  }
  return undefined
}

export class LimitsService extends EventEmitter<{ limits: [LimitsState] }> {
  state: LimitsState = { claude: null, codex: null }
  private timer: NodeJS.Timeout | null = null
  private lastJson = ''

  constructor(
    private opts: {
      env: () => Promise<NodeJS.ProcessEnv>
      enabled: () => boolean
    }
  ) {
    super()
  }

  start() {
    this.stop()
    if (!this.opts.enabled()) {
      this.state = { claude: null, codex: null }
      this.publish()
      return
    }
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private publish() {
    const json = JSON.stringify(this.state)
    if (json === this.lastJson) return
    this.lastJson = json
    this.emit('limits', this.state)
  }

  async refresh() {
    if (!this.opts.enabled()) return
    await Promise.all([this.refreshCodex(), this.refreshClaude()])
  }

  async refreshCodex() {
    try {
      const lim = await readCodexLimits(await this.opts.env())
      if (lim) {
        this.state = { ...this.state, codex: lim }
        this.publish()
      }
    } catch {
      /* ignore */
    }
  }

  async refreshClaude() {
    try {
      const env = await this.opts.env()
      const lim = await readClaudeStatusLimits(defaultPaths(env), await claudePlanLabel())
      this.state = { ...this.state, claude: lim }
      this.publish()
    } catch {
      /* ignore */
    }
  }
}
