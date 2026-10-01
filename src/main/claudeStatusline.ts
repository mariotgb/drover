import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeStatuslineState, LimitWindow, ProviderLimits } from '@shared/types'

// Claude Code limits without tokens or network.
//
// Claude Code already receives the plan usage limits with every model reply
// and passes them to its status-line command as `rate_limits` (an official,
// documented Claude Code feature). With the user's consent we register a tiny
// shell script as that status line. It saves the JSON Claude Code hands it into
// ~/.drover/claude-status/ and prints a short "5h 42% · wk 6%" line.
// The app only reads those files. Nothing here talks to the network or reads
// credentials.

export interface StatuslinePaths {
  /** Claude Code config dir (~/.claude or $CLAUDE_CONFIG_DIR). */
  claudeDir: string
  /** Drover data dir (~/.drover). */
  dataDir: string
}

export function defaultPaths(env: NodeJS.ProcessEnv): StatuslinePaths {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    dataDir: join(homedir(), '.drover')
  }
}

const scriptPath = (p: StatuslinePaths) => join(p.dataDir, 'claude-statusline.sh')
const statusDir = (p: StatuslinePaths) => join(p.dataDir, 'claude-status')
const prevPath = (p: StatuslinePaths) => join(p.dataDir, 'claude-statusline-prev.json')
const settingsPath = (p: StatuslinePaths) => join(p.claudeDir, 'settings.json')

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function scriptContent(p: StatuslinePaths, prevCommand: string | null): string {
  return `#!/bin/sh
# Installed by Drover. Saves what Claude Code passes to its status line
# (including plan usage limits) so Drover can show them.
# Local only: no network, no credentials. Remove it in Drover settings.
input=$(cat)
dir=${shQuote(statusDir(p))}
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
[ -n "$sid" ] || sid=unknown
mkdir -p "$dir" 2>/dev/null
tmp="$dir/.$sid.$$"
printf '%s' "$input" > "$tmp" 2>/dev/null && mv -f "$tmp" "$dir/$sid.json" 2>/dev/null
prev=${shQuote(prevCommand ?? '')}
if [ -n "$prev" ]; then
  printf '%s' "$input" | sh -c "$prev"
  exit $?
fi
five=$(printf '%s' "$input" | sed -n 's/.*"five_hour" *: *{[^}]*"used_percentage" *: *\\([0-9][0-9.]*\\).*/\\1/p')
week=$(printf '%s' "$input" | sed -n 's/.*"seven_day" *: *{[^}]*"used_percentage" *: *\\([0-9][0-9.]*\\).*/\\1/p')
out=""
[ -n "$five" ] && out="5h \${five%%.*}%"
[ -n "$week" ] && out="\${out:+$out · }wk \${week%%.*}%"
printf '%s\\n' "$out"
`
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function readSettings(p: StatuslinePaths): Promise<Json> {
  let raw: string
  try {
    raw = await readFile(settingsPath(p), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed as Json
}

async function writeSettings(p: StatuslinePaths, data: Json): Promise<void> {
  await mkdir(p.claudeDir, { recursive: true })
  const file = settingsPath(p)
  const tmp = `${file}.drover-tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
  await rename(tmp, file)
}

function isOurs(p: StatuslinePaths, statusLine: unknown): boolean {
  const cmd = (statusLine as Json | null)?.command
  return typeof cmd === 'string' && cmd.includes(scriptPath(p))
}

export async function statuslineState(p: StatuslinePaths): Promise<ClaudeStatuslineState> {
  let installed = false
  let other: string | null = null
  let error: string | undefined
  try {
    const s = await readSettings(p)
    installed = isOurs(p, s.statusLine)
    if (!installed && s.statusLine && typeof s.statusLine.command === 'string') other = s.statusLine.command
  } catch (e) {
    error = `Could not read ${settingsPath(p)}: ${(e as Error).message}`
  }
  let lastUpdate: number | null = null
  try {
    for (const f of await readdir(statusDir(p))) {
      if (!f.endsWith('.json')) continue
      const st = await stat(join(statusDir(p), f))
      if (!lastUpdate || st.mtimeMs > lastUpdate) lastUpdate = st.mtimeMs
    }
  } catch {
    /* no data yet */
  }
  return { installed, otherCommand: other, lastUpdate, settingsFile: settingsPath(p), error }
}

export async function installStatusline(p: StatuslinePaths): Promise<void> {
  const settings = await readSettings(p)
  if (isOurs(p, settings.statusLine)) return
  await mkdir(p.dataDir, { recursive: true })
  // Keep whatever status line the user had: it keeps working, chained behind ours.
  const previous = settings.statusLine ?? null
  await writeFile(prevPath(p), JSON.stringify({ statusLine: previous }, null, 2))
  try {
    const raw = await readFile(settingsPath(p), 'utf8')
    await writeFile(`${settingsPath(p)}.drover-backup`, raw)
  } catch {
    /* no settings file yet */
  }
  const prevCommand = previous && typeof previous.command === 'string' ? previous.command : null
  await writeFile(scriptPath(p), scriptContent(p, prevCommand))
  await chmod(scriptPath(p), 0o755)
  settings.statusLine = { type: 'command', command: shQuote(scriptPath(p)), padding: 0 }
  await writeSettings(p, settings)
}

export async function uninstallStatusline(p: StatuslinePaths): Promise<void> {
  const settings = await readSettings(p)
  if (isOurs(p, settings.statusLine)) {
    let previous: unknown = null
    try {
      previous = (JSON.parse(await readFile(prevPath(p), 'utf8')) as Json).statusLine ?? null
    } catch {
      /* nothing to restore */
    }
    if (previous) settings.statusLine = previous
    else delete settings.statusLine
    await writeSettings(p, settings)
  }
  await rm(scriptPath(p), { force: true })
  await rm(prevPath(p), { force: true })
  await rm(statusDir(p), { recursive: true, force: true })
}

function windowFrom(label: string, mins: number, w: Json | undefined): LimitWindow | null {
  if (!w || typeof w.used_percentage !== 'number') return null
  return {
    label,
    usedPercent: w.used_percentage,
    windowMinutes: mins,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined
  }
}

/** Newer window wins; within the same window, usage only grows. */
function fresher(a: LimitWindow | null, b: LimitWindow | null): LimitWindow | null {
  if (!a) return b
  if (!b) return a
  const ra = a.resetsAt ?? 0
  const rb = b.resetsAt ?? 0
  if (ra !== rb) return rb > ra ? b : a
  return b.usedPercent > a.usedPercent ? b : a
}

/**
 * Merges the snapshots of every Claude Code session. Limits are per account,
 * so the freshest window across sessions is the current one.
 */
export async function readClaudeStatusLimits(p: StatuslinePaths, plan?: string): Promise<ProviderLimits | null> {
  let files: string[]
  try {
    files = (await readdir(statusDir(p))).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  let five: LimitWindow | null = null
  let week: LimitWindow | null = null
  let observedAt = 0
  const now = Date.now()
  for (const f of files) {
    const file = join(statusDir(p), f)
    try {
      const st = await stat(file)
      if (now - st.mtimeMs > 14 * 864e5) {
        await rm(file, { force: true })
        continue
      }
      const rl = (JSON.parse(await readFile(file, 'utf8')) as Json)?.rate_limits as Json | undefined
      if (!rl) continue
      const f5 = windowFrom('5-hour', 300, rl.five_hour)
      const f7 = windowFrom('Weekly', 10080, rl.seven_day)
      const n5 = fresher(five, f5)
      const n7 = fresher(week, f7)
      if ((f5 && n5 === f5) || (f7 && n7 === f7)) observedAt = Math.max(observedAt, st.mtimeMs)
      five = n5
      week = n7
    } catch {
      /* partial or foreign file */
    }
  }
  const windows = [five, week].filter((w): w is LimitWindow => !!w)
  if (!windows.length) return null
  return {
    provider: 'claude',
    windows,
    plan,
    observedAt: observedAt || now,
    reached: windows.some((w) => w.usedPercent >= 100 && (!w.resetsAt || w.resetsAt > now))
  }
}
