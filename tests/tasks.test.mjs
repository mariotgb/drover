import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from './_bundle.mjs'

const m = await load()
const project = () => mkdtempSync(join(tmpdir(), 'drover-board-'))
const board = (dir) => JSON.parse(readFileSync(join(dir, m.BOARD_FILE), 'utf8'))

test('the board file is read the way agents tend to write it', () => {
  const tasks = m.parseBoard(`{
    // written by the orchestrator
    "tasks": [
      { "id": "api", "title": "Auth API", "assignee": "@backend", "status": "In Progress", "notes": "JWT" },
      { "name": "Login form", "agent": "frontend", "state": "completed" },
      { "title": "Login form", "status": "pending" },
      { "status": "done" },
    ]
  }`)
  assert.deepEqual(tasks, [
    { id: 'api', title: 'Auth API', status: 'in_progress', assignee: 'backend', notes: 'JWT' },
    { id: 'login-form', title: 'Login form', status: 'done', assignee: 'frontend', notes: undefined },
    { id: 'login-form-2', title: 'Login form', status: 'todo', assignee: undefined, notes: undefined }
  ])
  assert.equal(m.parseBoard('[{"title":"x","status":"WIP"}]')[0].status, 'in_progress')
  assert.deepEqual(['blocked', 'stuck', 'in-review', 'nonsense'].map(m.normalizeStatus), ['blocked', 'blocked', 'review', 'todo'])
  assert.throws(() => m.parseBoard('{"items": []}'))
  assert.throws(() => m.parseBoard('{"tasks": [ {"title": '))
})

test('edits keep the orchestrator’s own fields and the git repo stays clean', async () => {
  const dir = project()
  mkdirSync(join(dir, '.git', 'info'), { recursive: true })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '# local excludes\n*.swp')
  await m.ensureBoard(dir)
  await m.ensureBoard(dir)
  assert.deepEqual(board(dir), { tasks: [] })
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), '# local excludes\n*.swp\n# Drover task board\n.drover/\n')

  writeFileSync(join(dir, m.BOARD_FILE), JSON.stringify({ project: 'shop', tasks: [{ id: 'api', title: 'Auth API', status: 'todo', priority: 1 }] }))
  assert.equal((await m.addTask(dir, 'Тёмная тема', '')).id, 'темная-тема')
  await m.removeTask(dir, 'темная-тема')
  assert.equal((await m.addTask(dir, 'Создай файл café', '')).id, 'создай-файл-cafe')
  await m.removeTask(dir, 'создай-файл-cafe')
  const added = await m.addTask(dir, 'Форма входа', 'frontend')
  assert.deepEqual(added, { id: 'форма-входа', title: 'Форма входа', status: 'todo', assignee: 'frontend', notes: undefined })
  await m.updateTask(dir, 'api', { status: 'done', notes: 'merged' })
  assert.deepEqual(board(dir), {
    project: 'shop',
    tasks: [
      { id: 'api', title: 'Auth API', status: 'done', priority: 1, notes: 'merged' },
      { id: 'форма-входа', title: 'Форма входа', status: 'todo', assignee: 'frontend', notes: '' }
    ]
  })
  await m.removeTask(dir, 'api')
  assert.deepEqual(board(dir).tasks.map((t) => t.id), ['форма-входа'])
  await assert.rejects(m.updateTask(dir, 'missing', { status: 'done' }))
  writeFileSync(join(dir, m.BOARD_FILE), '{ broken')
  await assert.rejects(m.addTask(dir, 'x'), 'a broken board is not overwritten')
  assert.equal(readFileSync(join(dir, m.BOARD_FILE), 'utf8'), '{ broken')
})

test('in a git worktree the board is excluded in the main repository', async () => {
  const main = project()
  mkdirSync(join(main, '.git', 'worktrees', 'feat'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feat', 'commondir'), '../..\n')
  const wt = project()
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feat')}\n`)
  await m.ensureBoard(wt)
  assert.equal(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8'), '# Drover task board\n.drover/\n')
})

test('boards on screen follow the file and keep the last good copy while it is broken', async () => {
  const dir = project()
  const sent = []
  const boards = new m.TaskBoards((b) => sent.push(b))
  try {
  assert.equal((await boards.watch(dir)).exists, false)
  mkdirSync(join(dir, '.drover'))
  writeFileSync(join(dir, m.BOARD_FILE), '{"tasks":[{"id":"a","title":"A","status":"todo"}]}')
  await boards.refresh(dir)
  const first = sent.at(-1)
  assert.deepEqual([first.exists, first.tasks.map((t) => t.status)], [true, ['todo']])
  writeFileSync(join(dir, m.BOARD_FILE), '{"tasks":[{"id":"a","title":"A","status":"in_progress"}]}')
  await boards.refresh(dir)
  const moved = sent.at(-1).tasks[0]
  assert.equal(moved.status, 'in_progress')
  assert.ok(moved.since >= first.tasks[0].since)
  writeFileSync(join(dir, m.BOARD_FILE), '{"tasks":[')
  await boards.refresh(dir)
  assert.equal(sent.at(-1).tasks[0].status, 'in_progress')
  assert.ok(sent.at(-1).error)
  boards.unwatch(dir)
  } finally {
    boards.dispose()
  }
})
