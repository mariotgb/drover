import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { CircleAlert, Crown, ListChecks, MoreHorizontal, Plus, Users, X } from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import type { BoardTask, TaskBoard, TaskStatus, TranscriptItem } from '@shared/types'
import { api, humanizeError } from '../api'
import { t } from '../i18n'
import { basename, formatDuration, statusLabel, type Thread, type WorkspaceGroup } from '../model'
import { BOARD_FILE } from '../roles'
import { applyTranscript, closeBoard, select, toast, useStore, watchBoard } from '../store'
import { openMenuAt, type MenuItem } from './Menu'
import { AgentAvatar, IconButton, Spinner, StatusDot } from './primitives'

/** A project's task board, followed while the caller is on screen. */
export function useBoard(cwd: string | null): TaskBoard | null {
  const board = useStore((s) => (cwd ? s.boards[cwd] ?? null : null))
  useEffect(() => (cwd ? watchBoard(cwd) : undefined), [cwd])
  return board
}

export function isLead(th: Thread): boolean {
  return /orchestr|lead|boss|manager|coordinator|оркестр|тимлид/i.test(th.agent?.name ?? th.name)
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const COLUMNS: { statuses: TaskStatus[]; title: () => string }[] = [
  { statuses: ['todo'], title: () => t('To do') },
  { statuses: ['blocked', 'in_progress'], title: () => t('In progress') },
  { statuses: ['review'], title: () => t('Review') },
  { statuses: ['done'], title: () => t('Done') }
]

function statusName(s: TaskStatus): string {
  switch (s) {
    case 'todo':
      return t('To do')
    case 'in_progress':
      return t('In progress')
    case 'review':
      return t('Review')
    case 'done':
      return t('Done')
    case 'blocked':
      return t('Blocked')
  }
}

/** What an agent is on: its latest request and its own plan, from its transcript. */
function activity(items: TranscriptItem[] | undefined): { ask: string | null; plan: { done: number; total: number; current?: string } | null } {
  let ask: string | null = null
  let plan: { done: number; total: number; current?: string } | null = null
  for (let i = (items?.length ?? 0) - 1; i >= 0 && (!ask || !plan); i--) {
    const it = items![i]
    if (!ask && it.kind === 'user' && !it.command) {
      const line = it.text
        .replace(/<selected_element[\s\S]*?<\/selected_element>/g, '')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean)
      if (line) ask = line.length > 160 ? line.slice(0, 157) + '…' : line
    }
    if (!plan && it.kind === 'tool' && it.todos?.length) {
      plan = {
        done: it.todos.filter((x) => x.status === 'completed').length,
        total: it.todos.length,
        current: it.todos.find((x) => x.status === 'in_progress')?.text
      }
    }
  }
  return { ask, plan }
}

/** Keeps the transcripts of the project's agents loaded while the board is open. */
function useTranscripts(agents: Thread[]) {
  const ids = agents.filter((a) => agentKindDef(a.kind)?.transcript).map((a) => a.paneId)
  const key = ids.join(',')
  useEffect(() => {
    let alive = true
    for (const id of ids) {
      void api.transcriptSubscribe(id).then((u) => {
        if (alive) applyTranscript(u)
      })
    }
    return () => {
      alive = false
      for (const id of ids) api.transcriptUnsubscribe(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

async function tell(th: Thread, text: string): Promise<boolean> {
  const r = await api.sendPrompt({ paneId: th.paneId, target: th.agent?.name || th.paneId, agentKind: th.kind, text, imagePaths: [], isShell: false })
  if (!r.ok) toast('error', `${th.name}: ${humanizeError(r.code, r.error)}`)
  return r.ok
}

export function TaskBoardView({ group }: { group: WorkspaceGroup }) {
  const cwd = group.cwd
  const board = useBoard(cwd)
  const agents = useMemo(() => group.threads.filter((th) => !!th.kind), [group.threads])
  const lead = agents.find(isLead) ?? null
  const transcripts = useStore((s) => s.transcripts)
  const workingSince = useStore((s) => s.workingSince)
  const now = useNow(20_000)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [adding, setAdding] = useState(false)
  useTranscripts(agents)

  const byName = (name?: string) => (name ? agents.find((a) => a.agent?.name === name || a.name === name) ?? null : null)
  const tasks = board?.tasks ?? []
  const active = tasks.filter((x) => x.status === 'in_progress' || x.status === 'review' || x.status === 'blocked').length
  const done = tasks.filter((x) => x.status === 'done').length

  const add = async () => {
    const text = title.trim()
    if (!text || !cwd || adding) return
    setAdding(true)
    try {
      const r = await api.addTask(cwd, text, assignee || undefined)
      if (!r.ok || !r.result) {
        toast('error', t('Could not add the task: {error}', { error: r.error ?? '' }))
        return
      }
      setTitle('')
      const target = assignee ? byName(assignee) : lead
      if (target && target === lead) {
        if (await tell(target, t('New task from the user — it is on the board as “{id}”: {title}. Plan it, hand it out and keep the board updated.', { id: r.result.id, title: text }))) {
          toast('success', t('Added and sent to {agent}', { agent: target.name }))
        }
      } else if (target) {
        if (await tell(target, t('New task (on the board in {file} as “{id}”): {title}. When you finish, set its status there to done.', { file: BOARD_FILE, id: r.result.id, title: text }))) {
          toast('success', t('Added and sent to {agent}', { agent: target.name }))
        }
      } else {
        toast('info', t('The task is on the board. Start an orchestrator or give it to an agent.'))
      }
    } finally {
      setAdding(false)
    }
  }

  const setStatus = async (task: BoardTask, status: TaskStatus) => {
    if (!cwd) return
    const r = await api.updateTask(cwd, task.id, { status })
    if (!r.ok) toast('error', t('Could not update the task: {error}', { error: r.error ?? '' }))
  }

  const taskMenu = (task: BoardTask): MenuItem[] => [
    { header: t('Move to') },
    ...(['todo', 'in_progress', 'review', 'done', 'blocked'] as TaskStatus[])
      .filter((s) => s !== task.status)
      .map((s) => ({ label: statusName(s), onClick: () => void setStatus(task, s) })),
    'separator',
    {
      label: t('Delete'),
      danger: true,
      onClick: () => {
        if (cwd) void api.removeTask(cwd, task.id)
      }
    }
  ]

  return (
    <div className="board">
      <header className="board-head drag">
        <div className="board-title no-drag">
          <ListChecks size={17} />
          <h1>{t('Tasks')}</h1>
          <span className="board-project">{group.workspace.label || basename(cwd)}</span>
          {tasks.length > 0 && <span className="board-count">{t('{active} in progress · {done}/{total} done', { active, done, total: tasks.length })}</span>}
        </div>
        <div className="board-actions no-drag">
          {!lead && (
            <button type="button" className="btn btn-sm" onClick={() => useStore.setState({ dialog: { type: 'team', workspaceId: group.workspace.workspace_id } })}>
              <Users size={13} /> {t('Start team…')}
            </button>
          )}
          <IconButton title={t('Close')} onClick={() => closeBoard()}>
            <X size={16} />
          </IconButton>
        </div>
      </header>

      <div className="board-body">
        {!cwd ? (
          <div className="board-empty">{t('This project has no folder, so it has no task board.')}</div>
        ) : (
          <>
            <div className="board-add">
              <input
                className="input"
                value={title}
                placeholder={t('New task…')}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
              />
              <select className="input select" value={assignee} onChange={(e) => setAssignee(e.target.value)} title={t('Who gets it')}>
                <option value="">{lead ? t('Orchestrator decides') : t('Nobody yet')}</option>
                {agents
                  .filter((a) => a !== lead && a.agent?.name)
                  .map((a) => (
                    <option key={a.paneId} value={a.agent!.name!}>
                      {a.name}
                    </option>
                  ))}
              </select>
              <button type="button" className="btn btn-primary" disabled={!title.trim() || adding} onClick={() => void add()}>
                {adding ? <Spinner size={13} /> : <Plus size={14} />} {t('Add')}
              </button>
            </div>

            {board?.error && (
              <div className="board-warn">
                <CircleAlert size={14} /> {t('The task file can’t be read right now (an agent may be editing it). Showing the last good version.')}
              </div>
            )}

            {agents.length > 0 && (
              <section className="board-agents">
                <div className="board-section-title">{t('Agents now')}</div>
                <div className="board-agent-list">
                  {agents.map((a) => {
                    const { ask, plan } = activity(transcripts[a.paneId]?.items)
                    const since = workingSince[a.paneId]
                    return (
                      <button key={a.paneId} type="button" className={clsx('board-agent', `st-${a.status}`)} onClick={() => select(a.paneId)}>
                        <div className="board-agent-head">
                          <AgentAvatar kind={a.kind} size={18} />
                          <span className="board-agent-name">
                            {a === lead && <Crown size={11} className="crown" />}
                            {a.name}
                          </span>
                          <StatusDot status={a.status} size={7} />
                          <span className="board-agent-status">
                            {statusLabel(a.status)}
                            {a.status === 'working' && since ? ` · ${formatDuration(now - since)}` : ''}
                          </span>
                        </div>
                        <div className={clsx('board-agent-ask', !ask && 'dim')}>{ask ?? t('No requests yet')}</div>
                        {plan && (
                          <div className="board-agent-plan">
                            <span className="board-plan-bar">
                              <span style={{ width: `${(plan.done / Math.max(1, plan.total)) * 100}%` }} />
                            </span>
                            {plan.done}/{plan.total}
                            {plan.current ? ` · ${plan.current}` : ''}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>
            )}

            <section className="board-columns">
              {COLUMNS.map((col) => {
                const items = tasks.filter((x) => col.statuses.includes(x.status))
                return (
                  <div key={col.statuses.join()} className="board-column">
                    <div className="board-column-head">
                      {col.title()} <span className="board-column-count">{items.length}</span>
                    </div>
                    {items.map((task) => {
                      const th = byName(task.assignee)
                      return (
                        <div
                          key={task.id}
                          role="button"
                          tabIndex={0}
                          className={clsx('task-card', task.status === 'blocked' && 'blocked', th && 'linked')}
                          onClick={() => th && select(th.paneId)}
                        >
                          <div className="task-card-top">
                            <div className="task-title">{task.title}</div>
                            <button
                              type="button"
                              className="task-more"
                              title={t('More')}
                              onClick={(e) => {
                                e.stopPropagation()
                                openMenuAt(e.currentTarget, taskMenu(task))
                              }}
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </div>
                          {task.notes && <div className="task-notes">{task.notes}</div>}
                          <div className="task-meta">
                            {task.assignee ? (
                              <span className="task-assignee">
                                <AgentAvatar kind={th?.kind ?? null} size={15} />
                                {th?.name ?? task.assignee}
                                {th && <StatusDot status={th.status} size={6} />}
                              </span>
                            ) : (
                              <span className="task-assignee dim">{t('Unassigned')}</span>
                            )}
                            {task.status === 'blocked' && <span className="pill pill-blocked">{t('Blocked')}</span>}
                            {task.since && task.status !== 'done' && task.status !== 'todo' && now - task.since >= 60_000 && (
                              <span className="task-since">{formatDuration(now - task.since)}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </section>

            {tasks.length === 0 && (
              <div className="board-empty">
                {lead
                  ? t('No tasks yet. Add one above: the orchestrator splits it up, hands it out and keeps this board up to date.')
                  : t('No tasks yet. Start a team with an orchestrator — it keeps this board up to date — or add tasks yourself and give them to agents.')}
              </div>
            )}
            <div className="board-foot">{t('The board lives in {file} in the project folder. It is not committed to git.', { file: BOARD_FILE })}</div>
          </>
        )}
      </div>
    </div>
  )
}
