import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

async function ls(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function findClaudeTranscript(env: NodeJS.ProcessEnv, sessionId: string, cwd?: string | null): Promise<string | null> {
  const projects = join(claudeHome(env), 'projects')
  if (cwd) {
    const direct = join(projects, claudeProjectSlug(cwd), `${sessionId}.jsonl`)
    if (existsSync(direct)) return direct
  }
  for (const d of await ls(projects)) {
    const p = join(projects, d, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

/** UUIDv7 ids embed their creation time; Codex rollouts are filed by local date. */
function uuidV7Time(id: string): number | null {
  const hex = id.replace(/-/g, '').slice(0, 12)
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null
  const ms = parseInt(hex, 16)
  return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null
}

function dayDir(root: string, t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}

async function codexDayDirsDesc(root: string): Promise<string[]> {
  const out: string[] = []
  const years = (await ls(root)).filter((y) => /^\d{4}$/.test(y)).sort().reverse()
  for (const y of years) {
    const months = (await ls(join(root, y))).filter((m) => /^\d{2}$/.test(m)).sort().reverse()
    for (const m of months) {
      const days = (await ls(join(root, y, m))).filter((x) => /^\d{2}$/.test(x)).sort().reverse()
      for (const d of days) out.push(join(root, y, m, d))
    }
  }
  return out
}

export async function findCodexRollout(env: NodeJS.ProcessEnv, sessionId: string): Promise<string | null> {
  const root = join(codexHome(env), 'sessions')
  const suffix = `-${sessionId}.jsonl`
  const t = uuidV7Time(sessionId)
  if (t) {
    for (const off of [0, -864e5, 864e5]) {
      const dir = dayDir(root, t + off)
      const hit = (await ls(dir)).find((f) => f.endsWith(suffix))
      if (hit) return join(dir, hit)
    }
  }
  for (const dir of await codexDayDirsDesc(root)) {
    const hit = (await ls(dir)).find((f) => f.endsWith(suffix))
    if (hit) return join(dir, hit)
  }
  const archived = join(codexHome(env), 'archived_sessions')
  const hit = (await ls(archived)).find((f) => f.endsWith(suffix))
  return hit ? join(archived, hit) : null
}

export function processStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null)
      const t = Date.parse(String(stdout).trim().replace(/\s+/g, ' '))
      resolve(Number.isNaN(t) ? null : t)
    })
  })
}

async function firstLine(path: string, max = 256 * 1024): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await fh.read(buf, 0, max, 0)
    const s = buf.subarray(0, bytesRead).toString('utf8')
    const nl = s.indexOf('\n')
    return nl >= 0 ? s.slice(0, nl) : s
  } finally {
    await fh.close()
  }
}

function rolloutTime(name: string): number | null {
  const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

function rolloutId(name: string): string | null {
  const m = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return m ? m[1] : null
}

export interface Guess {
  path: string
  sessionId: string
}

/**
 * For Codex panes whose session id herdr never learned: the earliest rollout
 * for the same cwd created after the agent process started, skipping
 * sessions that belong to other panes.
 */
export async function guessCodexRollout(
  env: NodeJS.ProcessEnv,
  cwds: string[],
  startMs: number,
  claimed: Set<string>
): Promise<Guess | null> {
  const root = join(codexHome(env), 'sessions')
  const now = Date.now()
  const dirs = new Set<string>()
  for (let t = startMs - 864e5; t <= now + 864e5; t += 864e5) dirs.add(dayDir(root, t))
  const candidates: { path: string; id: string; t: number }[] = []
  for (const dir of dirs) {
    for (const f of await ls(dir)) {
      const t = rolloutTime(f)
      const id = rolloutId(f)
      if (t === null || !id || claimed.has(id)) continue
      if (t < startMs - 5000) continue
      candidates.push({ path: join(dir, f), id, t })
    }
  }
  candidates.sort((a, b) => a.t - b.t)
  for (const c of candidates) {
    try {
      const meta = JSON.parse(await firstLine(c.path))
      const cwd = meta?.payload?.cwd
      if (typeof cwd === 'string' && cwds.includes(cwd)) return { path: c.path, sessionId: c.id }
    } catch {
      /* skip unreadable */
    }
  }
  return null
}

export async function guessClaudeTranscript(
  env: NodeJS.ProcessEnv,
  cwds: string[],
  startMs: number,
  claimed: Set<string>
): Promise<Guess | null> {
  const projects = join(claudeHome(env), 'projects')
  const candidates: { path: string; id: string; t: number }[] = []
  for (const cwd of cwds) {
    const dir = join(projects, claudeProjectSlug(cwd))
    for (const f of await ls(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const id = f.slice(0, -'.jsonl'.length)
      if (claimed.has(id)) continue
      try {
        const st = await stat(join(dir, f))
        const t = st.birthtimeMs || st.ctimeMs
        if (t >= startMs - 5000) candidates.push({ path: join(dir, f), id, t })
      } catch {
        /* ignore */
      }
    }
  }
  candidates.sort((a, b) => a.t - b.t)
  return candidates.length ? { path: candidates[0].path, sessionId: candidates[0].id } : null
}
