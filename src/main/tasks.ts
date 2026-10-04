// The team's task board: <project>/.drover/tasks.json.
//
// The orchestrator keeps it up to date (its instructions explain the format),
// the user can add tasks and change statuses from the board, and Drover shows
// it per project. Agents write the file however their tools do (often by
// replacing it), so it is polled rather than watched, and read leniently.
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { BoardTask, TaskBoard, TaskStatus } from '@shared/types'

export const BOARD_FILE = '.drover/tasks.json'
const POLL_MS = 1500

const STATUS_WORDS: Record<string, TaskStatus> = {
  todo: 'todo',
  to_do: 'todo',
  pending: 'todo',
  open: 'todo',
  new: 'todo',
  queued: 'todo',
  backlog: 'todo',
  planned: 'todo',
  not_started: 'todo',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  doing: 'in_progress',
  active: 'in_progress',
  working: 'in_progress',
  started: 'in_progress',
  wip: 'in_progress',
  assigned: 'in_progress',
  review: 'review',
  in_review: 'review',
  reviewing: 'review',
  testing: 'review',
  verify: 'review',
  verifying: 'review',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  closed: 'done',
  resolved: 'done',
  blocked: 'blocked',
  stuck: 'blocked',
  waiting: 'blocked',
  failed: 'blocked',
  error: 'blocked'
}

export function normalizeStatus(value: unknown): TaskStatus {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return STATUS_WORDS[key] ?? 'todo'
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Strip accents from Latin letters (é → e) but keep Cyrillic ones like й intact.
    .replace(/[^\u0400-\u04ff]/g, (c) => c.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .replace(/[^a-z0-9а-яй]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

type RawTask = Record<string, unknown>

/** JSON, or JSON with comments and trailing commas (what agents sometimes write). */
function parseLenient(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const relaxed = text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(relaxed)
  }
}

function rawList(data: unknown): RawTask[] {
  if (Array.isArray(data)) return data as RawTask[]
  const tasks = (data as { tasks?: unknown } | null)?.tasks
  if (Array.isArray(tasks)) return tasks as RawTask[]
  throw new Error('the file has no "tasks" list')
}

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '')

function toTask(raw: RawTask, index: number): BoardTask | null {
  if (!raw || typeof raw !== 'object') return null
  const title = text(raw.title) || text(raw.name) || text(raw.task) || text(raw.summary)
  if (!title) return null
  const assignee = (text(raw.assignee) || text(raw.agent) || text(raw.owner)).replace(/^@/, '')
  const notes = text(raw.notes) || text(raw.note) || text(raw.comment) || text(raw.result)
  return {
    id: text(raw.id) || slug(title) || `task-${index + 1}`,
    title,
    status: normalizeStatus(raw.status ?? raw.state),
    assignee: assignee || undefined,
    notes: notes || undefined
  }
}

/** Tasks from the board file; ids are made unique. Throws when the file is not a board. */
export function parseBoard(content: string): BoardTask[] {
  const seen = new Set<string>()
  const out: BoardTask[] = []
  rawList(parseLenient(content)).forEach((raw, i) => {
    const t = toTask(raw, i)
    if (!t) return
    let id = t.id
    for (let n = 2; seen.has(id); n++) id = `${t.id}-${n}`
    seen.add(id)
    out.push({ ...t, id })
  })
  return out
}

/** The repo's shared git dir: .git itself, or for a worktree the main repo's (from its .git file). */
async function gitCommonDir(cwd: string): Promise<string | null> {
  const dotGit = join(cwd, '.git')
  let st
  try {
    st = await stat(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  try {
    const gitdir = (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!gitdir) return null
    const dir = resolve(cwd, gitdir)
    const common = (await readFile(join(dir, 'commondir'), 'utf8').catch(() => '')).trim()
    return common ? resolve(dir, common) : dir
  } catch {
    return null
  }
}

/** Keeps .drover/ out of the user's commits without touching their .gitignore. */
export async function ignoreInGit(cwd: string): Promise<void> {
  const gitDir = await gitCommonDir(cwd)
  if (!gitDir) return
  const exclude = join(gitDir, 'info', 'exclude')
  let current = ''
  try {
    current = await readFile(exclude, 'utf8')
  } catch {
    /* no exclude file yet */
  }
  if (/^\/?\.drover\/?\s*$/m.test(current)) return
  await mkdir(join(gitDir, 'info'), { recursive: true })
  await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Drover task board\n.drover/\n`)
}

async function writeBoard(cwd: string, data: unknown) {
  await mkdir(join(cwd, '.drover'), { recursive: true })
  const file = join(cwd, BOARD_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n')
  await rename(tmp, file)
}

/** Reads the raw board for an edit; a missing file is an empty board, a broken one is an error. */
async function readRaw(cwd: string): Promise<{ data: { tasks: RawTask[] } & Record<string, unknown> }> {
  let content: string
  try {
    content = await readFile(join(cwd, BOARD_FILE), 'utf8')
  } catch {
    return { data: { tasks: [] } }
  }
  const parsed = parseLenient(content)
  if (Array.isArray(parsed)) return { data: { tasks: parsed as RawTask[] } }
  rawList(parsed)
  return { data: parsed as { tasks: RawTask[] } }
}

export async function ensureBoard(cwd: string): Promise<void> {
  try {
    await stat(join(cwd, BOARD_FILE))
  } catch {
    await writeBoard(cwd, { tasks: [] })
  }
  await ignoreInGit(cwd)
}

export async function addTask(cwd: string, title: string, assignee?: string): Promise<BoardTask> {
  const { data } = await readRaw(cwd)
  const ids = new Set(parseBoard(JSON.stringify(data)).map((t) => t.id))
  const base = slug(title) || 'task'
  let id = base
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`
  const raw: RawTask = { id, title: title.trim(), status: 'todo', assignee: assignee || '', notes: '' }
  data.tasks.push(raw)
  await writeBoard(cwd, data)
  await ignoreInGit(cwd)
  return toTask(raw, data.tasks.length - 1)!
}

/** Changes one task in place, keeping whatever other fields the orchestrator stores. */
export async function updateTask(cwd: string, id: string, patch: Partial<Pick<BoardTask, 'status' | 'assignee' | 'title' | 'notes'>>): Promise<void> {
  const { data } = await readRaw(cwd)
  const tasks = parseBoard(JSON.stringify(data))
  const index = tasks.findIndex((t) => t.id === id)
  if (index < 0) throw new Error('task not found')
  // parseBoard skips entries without a title: map back to the raw entry.
  let seen = -1
  const rawIndex = data.tasks.findIndex((raw, i) => (toTask(raw, i) ? ++seen === index : false))
  const raw = data.tasks[rawIndex]
  if (!raw.id) raw.id = id
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) raw[k] = v
  await writeBoard(cwd, data)
}

export async function removeTask(cwd: string, id: string): Promise<void> {
  const { data } = await readRaw(cwd)
  let seen = -1
  const tasks = parseBoard(JSON.stringify(data))
  const index = tasks.findIndex((t) => t.id === id)
  if (index < 0) return
  data.tasks = data.tasks.filter((raw, i) => !(toTask(raw, i) && ++seen === index))
  await writeBoard(cwd, data)
}

interface Watched {
  refs: number
  mtime: number
  size: number
  board: TaskBoard
  since: Map<string, { status: TaskStatus; at: number }>
}

/** Boards of the projects on screen, polled and pushed to the window on change. */
export class TaskBoards {
  private watched = new Map<string, Watched>()
  private timer: NodeJS.Timeout | null = null

  constructor(private send: (board: TaskBoard) => void) {}

  static valid(cwd: unknown): cwd is string {
    return typeof cwd === 'string' && isAbsolute(cwd) && !cwd.includes('\0')
  }

  async watch(cwd: string, retain = true): Promise<TaskBoard> {
    let w = this.watched.get(cwd)
    if (w) { if (retain) w.refs++ }
    else {
      w = { refs: 1, mtime: -1, size: -1, board: { cwd, exists: false, tasks: [] }, since: new Map() }
      this.watched.set(cwd, w)
    }
    await this.check(cwd, w, true)
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS)
      // Polling alone must never keep the process alive.
      this.timer.unref?.()
    }
    return w.board
  }

  unwatch(cwd: string) {
    const w = this.watched.get(cwd)
    if (!w) return
    if (--w.refs > 0) return
    this.watched.delete(cwd)
    if (!this.watched.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Re-reads a board right away (after Drover itself wrote it). */
  async refresh(cwd: string) {
    const w = this.watched.get(cwd)
    if (w) await this.check(cwd, w, true)
  }

  private async poll() {
    for (const [cwd, w] of this.watched) await this.check(cwd, w, false)
  }

  private async check(cwd: string, w: Watched, force: boolean) {
    let mtime = 0
    let size = 0
    try {
      const st = await stat(join(cwd, BOARD_FILE))
      mtime = st.mtimeMs
      size = st.size
    } catch {
      if (w.board.exists || force) {
        w.mtime = w.size = 0
        w.board = { cwd, exists: false, tasks: [] }
        this.send(w.board)
      }
      return
    }
    if (!force && mtime === w.mtime && size === w.size) return
    w.mtime = mtime
    w.size = size
    let tasks: BoardTask[]
    let error: string | undefined
    try {
      tasks = parseBoard(await readFile(join(cwd, BOARD_FILE), 'utf8'))
    } catch (e) {
      // Mid-write or broken by hand: keep showing the last good copy.
      tasks = w.board.tasks
      error = (e as Error).message
    }
    const now = Date.now()
    for (const t of tasks) {
      const prev = w.since.get(t.id)
      // First sight of a board: the file's time is the best guess (never later than now).
      if (!prev || prev.status !== t.status) w.since.set(t.id, { status: t.status, at: prev || w.board.exists ? now : Math.min(mtime, now) })
      t.since = w.since.get(t.id)!.at
    }
    w.board = { cwd, exists: true, tasks, error }
    this.send(w.board)
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.watched.clear()
  }
}
