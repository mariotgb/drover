import type { OfficeNodeId } from '@shared/office'
import type { BoardTask, TaskBoard } from '@shared/types'
import { parseBoard } from '../../tasks'
import type { OfficeAnalyzeContext, OfficeEventCandidate } from './types'

export interface OfficeBoardContext extends Pick<OfficeAnalyzeContext, 'session' | 'observedAt' | 'resolveAgent'> {
  departmentId: OfficeNodeId
  /** Present only for a confirmed UI board write. External author remains unknown. */
  author?: OfficeNodeId | null
}
export type OfficeBoardEventCandidate = Omit<OfficeEventCandidate, 'commandIndex'> & { taskId: string }
export interface OfficeBoardObservation {
  snapshot: readonly BoardTask[] | null
  events: OfficeBoardEventCandidate[]
  error?: string
}

/** Caller retains previous on an error; null previous establishes a quiet baseline. */
export function diffTaskBoard(previous: TaskBoard | readonly BoardTask[] | null, next: TaskBoard | readonly BoardTask[], context: OfficeBoardContext): OfficeBoardEventCandidate[] {
  if (previous === null) return []
  const tasks = Array.isArray(next) ? next as readonly BoardTask[] : (next as TaskBoard).tasks
  if (!Array.isArray(next) && (next as TaskBoard).error) return []
  const before = Array.isArray(previous) ? previous as readonly BoardTask[] : (previous as TaskBoard).tasks
  const old = new Map(before.map((task) => [task.id, task]))
  const duplicate = new Set<string>()
  const seen = new Set<string>()
  for (const task of before) { if (seen.has(task.id)) duplicate.add(task.id); seen.add(task.id) }
  seen.clear()
  for (const task of tasks) { if (seen.has(task.id)) duplicate.add(task.id); seen.add(task.id) }
  const events: OfficeBoardEventCandidate[] = []
  for (const task of tasks) {
    if (!task.id || duplicate.has(task.id)) continue
    const prev = old.get(task.id)
    const from = context.author ?? context.departmentId
    const to = task.assignee ? context.resolveAgent(context.session, task.assignee)?.id ?? null : null
    const emit = (kind: OfficeBoardEventCandidate['kind'], summary: string, endpoint: OfficeNodeId | null) =>
      events.push({ from, to: endpoint, kind, ts: context.observedAt, summary, taskId: task.id, confidence: 'confirmed' })
    if (!prev) emit('task_created', 'Новая задача', null)
    if (task.assignee !== prev?.assignee && (prev || task.assignee)) emit('task_assigned', 'Задача назначена', to)
    if (prev && task.status !== prev.status) emit('task_status', 'Статус задачи изменён', to)
  }
  return events
}

export function analyzeTaskBoard(previous: readonly BoardTask[] | null, board: TaskBoard, context: OfficeBoardContext): OfficeBoardObservation {
  if (board.error) return { snapshot: previous, events: [], error: 'Некорректная доска задач' }
  return { snapshot: board.tasks, events: diffTaskBoard(previous, board.tasks, context) }
}

/** Pure JSON entry point for fixtures. Production can reuse TaskBoards' accepted data. */
export function analyzeTaskBoardJson(previous: readonly BoardTask[] | null, content: string, context: OfficeBoardContext): OfficeBoardObservation {
  try {
    const next = parseBoard(content)
    return { snapshot: next, events: diffTaskBoard(previous, next, context) }
  } catch { return { snapshot: previous, events: [], error: 'Некорректная доска задач' } }
}
