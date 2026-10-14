import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'drover-question-tests-'))
await build({ stdin: { contents: "export * from './src/main/agentQuestions'; export * from './src/main/actions'; export * from './src/main/remote/rpc'; export * from './src/main/remote/push'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'questions.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(root, 'questions.cjs'))
rmSync(root, { recursive: true, force: true })
const incompatible = 'Background server has incompatible feature settings\n\n› 1. Restart with these settings\n  2. Keep current settings\nPress Enter to select · Esc to cancel'
const hooks = 'Do you trust the hooks configured in this project?\n› 1. Yes, trust these hooks\n  2. No, disable hooks\nPress Enter to confirm'
const approval = 'Would you like to run the following command?\n$ test-command\n› 1. Yes, proceed\n  2. No, cancel\nEsc to cancel'

function fixture(t, text = incompatible) {
  let now = 0, screen = text
  const calls = [], attention = [], changes = []
  const agent = { pane_id: 'w1:p1', terminal_id: 'term', workspace_id: 'w1', tab_id: 'w1:t1', revision: 1, agent: 'codex', name: 'drover-test', agent_status: 'idle', interactive_ready: true, agent_session: { agent: 'codex', kind: 'id', value: 'session' } }
  const snapshot = { panes: [agent], agents: [agent], workspaces: [], tabs: [], layouts: [] }
  const service = { sessionName: 'isolated', connectionGeneration: 1, connection: { status: 'connected' }, snapshot, scheduleRefresh() {}, client: { async request(method, params) {
    calls.push([method, params])
    if (method === 'session.snapshot') return { snapshot }
    if (method === 'agent.get') return { agent }
    if (method === 'pane.read') return { read: { text: screen, revision: agent.revision } }
    return {}
  } } }
  const questions = new m.AgentQuestions(service, () => now)
  questions.on('attention', change => attention.push(change)); questions.on('changed', () => changes.push(1))
  t.after(() => questions.stop())
  return { questions, service, calls, agent, snapshot, attention, changes, time(value) { now = value }, screen(value) { screen = value }, question() { return questions.decorate(snapshot).agents[0].agent_question }, click(choiceId = '1') { return questions.answer({ paneId: agent.pane_id, questionId: this.question().id, choiceId }) } }
}

test('known Codex/Claude blockers and generic choice menus expose question and exact keys', () => {
  for (const text of [incompatible, hooks, approval]) {
    const dialog = m.blockingDialog(text, 'codex')
    assert.equal(dialog.kind, 'codex')
    assert.deepEqual(dialog.choices[0].keys, ['1'])
  }
  for (const text of ['Do you trust this folder?\n1. Yes, I trust this folder\n2. No\nEnter to confirm', 'Resume this conversation?\n1. Resume\n2. Cancel\nEsc to cancel', 'Do you want to proceed?\n1. Yes\n2. No\nPress Enter to select']) assert.equal(m.blockingDialog(text, 'claude').kind, 'claude')
  assert.equal(m.blockingDialog('Choose an option\n1. Continue\n2. Cancel\nEnter to select', 'gemini').kind, 'generic')
  assert.deepEqual(m.blockingDialog('Do you trust these hooks? [y/n]', 'codex').choices.map(c => c.keys), [['y'], ['n']])
  for (const text of ['1. First step\n2. Second step', 'The docs say press enter.\n1. First topic\n2. Second topic\n' + 'ordinary output\n'.repeat(8), 'Worked on hooks configuration.\n› ready for input']) assert.equal(m.blockingDialog(text, 'codex'), null)
})

test('moving screens cost no reads; stationary screens are rate limited and notify once', async t => {
  const f = fixture(t)
  await f.questions.poll(); assert.equal(f.calls.length, 0)
  f.time(6000); await f.questions.poll()
  assert.equal(f.question().kind, 'codex'); assert.equal(f.questions.decorate(f.snapshot).agents[0].agent_status, 'blocked')
  assert.equal(f.attention.length, 1)
  assert.ok(f.calls.every(([method]) => method === 'pane.read'))
  f.time(10000); await f.questions.poll(); assert.equal(f.calls.length, 1)
  f.time(22000); await f.questions.poll(); assert.equal(f.attention.length, 1)
  const id = f.question().id
  f.agent.revision++; f.time(24000); await f.questions.poll(); assert.equal(f.question(), undefined)
  f.time(30000); await f.questions.poll(); assert.notEqual(f.question().id, id); assert.equal(f.attention.length, 1)
  f.agent.revision++; f.screen('› Ask a question'); await f.questions.poll()
  assert.equal(f.question(), undefined)
})

test('click sends exactly the selected key, once, and never replays on another click', async t => {
  const f = fixture(t); await f.questions.poll(); f.time(6000); await f.questions.poll()
  const id = f.question().id
  const results = await Promise.all([f.click('2'), f.click('2')])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.deepEqual(f.calls.filter(([method]) => method === 'agent.send_keys').map(([, params]) => params.keys), [['2']])
  assert.equal((await f.questions.answer({ paneId: 'w1:p1', questionId: id, choiceId: '2' })).code, 'question_gone')
})

test('changed text, pane occupant, session, or arbitrary choice refuses all input', async t => {
  for (const change of ['screen', 'occupant', 'session', 'choice']) {
    const f = fixture(t); await f.questions.poll(); f.time(6000); await f.questions.poll()
    const req = { paneId: 'w1:p1', questionId: f.question().id, choiceId: '1' }
    if (change === 'screen') f.screen(hooks)
    if (change === 'occupant') f.agent.agent_session.value = 'replacement'
    if (change === 'session') f.service.connectionGeneration++
    if (change === 'choice') req.choiceId = 'ctrl+c'
    assert.equal((await f.questions.answer(req)).ok, false)
    assert.ok(!f.calls.some(([method]) => method === 'agent.send_keys'))
  }
})

test('a question click refuses revision changes before the click, at agent.get, and at the final screen read', async t => {
  for (const change of ['before-click', 'agent-get', 'final-read', 'reverified']) {
    const f = fixture(t); await f.questions.poll(); f.time(6000); await f.questions.poll()
    const req = { paneId: 'w1:p1', questionId: f.question().id, choiceId: '1' }
    const request = f.service.client.request.bind(f.service.client)
    let reads = 0
    f.service.client.request = async (method, params) => {
      if (method === 'agent.get' && change === 'agent-get') { f.agent.revision++; f.screen(hooks) }
      if (method === 'pane.read' && ++reads === 2 && change === 'final-read') { f.agent.revision++; f.screen(hooks) }
      return request(method, params)
    }
    // Even the same dialog text at a new revision invalidates the displayed ID.
    if (change === 'before-click' || change === 'reverified') f.agent.revision++
    if (change === 'reverified') { await f.questions.poll(); f.time(12000); await f.questions.poll() }
    assert.equal((await f.questions.answer(req)).code, 'question_changed', change)
    assert.ok(!f.calls.some(([method]) => method === 'agent.send_keys'), change)
  }
})

test('restore dialog preserves real status and recovers after an answer', async t => {
  const f = fixture(t)
  f.questions.beginRestore([{ paneId: 'w1:p1', kind: 'codex', sessionId: 'session' }])
  assert.equal(f.questions.decorate(f.snapshot).agents[0].agent_status, 'idle')
  await f.questions.poll(); f.time(6000); await f.questions.poll(); assert.ok(f.question())
  f.time(60000); await f.questions.poll()
  const blocked = f.questions.decorate(f.snapshot).agents[0]
  assert.equal(blocked.restore_state, undefined); assert.equal(blocked.agent_status, 'blocked'); assert.equal(blocked.restore_error, undefined)
  await f.click(); f.screen('› Ask Codex'); f.agent.revision++; f.time(61000); await f.questions.poll()
  assert.equal(f.questions.decorate(f.snapshot).agents[0].agent_status, 'idle')
})

test('large Claude restore stays starting past 60 seconds and clears immediately on real working status; chat remains usable', async t => {
  const f = fixture(t, 'Starting…')
  f.agent.agent = 'claude'; f.agent.agent_session.agent = 'claude'
  f.agent.agent_status = 'unknown'; f.agent.interactive_ready = false
  f.questions.beginRestore([{ paneId: 'w1:p1', kind: 'claude', sessionId: 'session' }])
  await f.questions.poll(); f.time(61000); await f.questions.poll()
  let pane = f.questions.decorate(f.snapshot).agents[0]
  assert.equal(pane.restore_state, 'starting'); assert.equal(pane.restore_error, undefined)
  f.time(301000); await f.questions.poll()
  assert.equal(f.questions.decorate(f.snapshot).agents[0].restore_state, 'starting', 'a detected agent is still loading, not failed')
  f.agent.agent_status = 'working'
  f.service.client.request = async method => { if (method === 'pane.read') throw new Error('offline read'); return { snapshot: f.snapshot } }
  pane = f.questions.decorate(f.snapshot).agents[0]
  assert.equal(pane.restore_state, undefined); assert.equal(pane.restore_error, undefined); assert.equal(pane.agent_status, 'working')
  const calls = []
  const result = await m.sendPrompt({ request: async (method, args) => { calls.push([method,args]); return {} } }, {paneId:'w1:p1',text:'synthetic message',imagePaths:[],agentKind:pane.agent})
  assert.equal(result.ok, true); assert.ok(calls.some(([method]) => method === 'agent.prompt'))
})

test('failed restore clears for every real status or interactive-ready, without polling', async t => {
  for (const status of ['working','idle','done','blocked','unknown']) {
    const f = fixture(t, '$ '); f.agent.agent = null; f.snapshot.agents = []
    f.questions.beginRestore([{ paneId: 'w1:p1', kind: 'codex', sessionId: 'session' }])
    await f.questions.poll(); f.time(300000); await f.questions.poll()
    assert.equal(f.questions.decorate(f.snapshot).panes[0].restore_state, 'failed')
    f.agent.agent = 'codex'; f.agent.agent_status = status; f.agent.interactive_ready = status === 'unknown'
    f.snapshot.agents = [f.agent]
    const pane = f.questions.decorate(f.snapshot).panes[0]
    assert.equal(pane.restore_state, undefined); assert.equal(pane.restore_error, undefined); assert.equal(pane.agent_status, status)
  }
})

test('unknown restored agent exits to shell -> explicit error; a never-detected kind gets five minutes', async t => {
  const f = fixture(t, 'Starting…'); f.agent.agent_status = 'unknown'; f.agent.interactive_ready = false
  await f.questions.poll(); f.time(60000); await f.questions.poll()
  assert.equal(f.questions.decorate(f.snapshot).agents[0].restore_state, 'starting')
  f.agent.agent = null; f.snapshot.agents = []; f.time(61000); await f.questions.poll()
  const failed = f.questions.decorate(f.snapshot).panes[0]
  assert.equal(failed.restore_state, 'failed'); assert.equal(failed.restore_error.code, 'restore_exited')
  const shell = fixture(t, '$ '); shell.agent.agent = null; shell.snapshot.agents = []
  shell.questions.beginRestore([{ paneId: 'w1:p1', kind: 'codex', sessionId: 'session' }])
  await shell.questions.poll(); shell.time(60000); await shell.questions.poll()
  assert.equal(shell.questions.decorate(shell.snapshot).panes[0].restore_state, 'starting')
  shell.time(300000); await shell.questions.poll()
  assert.equal(shell.questions.decorate(shell.snapshot).panes[0].restore_error.code, 'restore_timeout')
})

test('late native session hook retains the restore deadline and replacement discards it', async t => {
  const f = fixture(t, 'Starting…'); f.agent.interactive_ready = false; f.agent.agent_status = 'unknown'; f.agent.agent_session = undefined
  f.questions.beginRestore([{ paneId: 'w1:p1', kind: 'codex', sessionId: 'session' }])
  await f.questions.poll(); f.agent.agent_session = { kind: 'id', value: 'session' }; f.time(60000); await f.questions.poll()
  assert.equal(f.questions.decorate(f.snapshot).agents[0].restore_state, 'starting')
  f.agent.terminal_id = 'replacement'; f.time(62000); await f.questions.poll()
  assert.equal(f.questions.decorate(f.snapshot).agents[0].restore_state, undefined)
})

test('phone RPC validates opaque question/choice IDs and rejects raw keys', async t => {
  const f = fixture(t); await f.questions.poll(); f.time(6000); await f.questions.poll()
  const handlers = new m.RpcHandlers(); handlers.register('agent:answer-question', (_, req) => f.questions.answer(req))
  const connection = new m.RemoteRpcConnection('phone')
  const call = req => ({ t: 'call', id: '1', method: 'answerAgentQuestion', args: [req] })
  const req = { paneId: 'w1:p1', questionId: f.question().id, choiceId: '1' }
  assert.equal((await m.dispatchRemoteRpc(handlers, connection, call({ ...req, keys: ['ctrl+c'] }))).error.code, 'invalid_args')
  assert.equal((await m.dispatchRemoteRpc(handlers, connection, call(req))).value.ok, true)
  assert.match(readFileSync('src/main/index.ts', 'utf8'), /handle\('agent:answer-question'/)
})

test('desktop/phone attention includes the detected question; strict readiness rejects fake idle', async t => {
  const f = fixture(t); await f.questions.poll(); f.time(6000); await f.questions.poll()
  assert.equal(m.pushPayload(f.attention[0], f.snapshot, 'isolated').body, f.question().question)
  const svc = { request: f.service.client.request }
  assert.equal(await m.waitUntilInteractive(svc, 'w1:p1', 0, 1, true), 'blocked')
  f.screen('Starting…'); f.agent.interactive_ready = false
  assert.equal(await m.waitUntilInteractive(svc, 'w1:p1', 0, 1, true), 'pending')
})


test('closed restoring pane emits an exit error and never leaves a pending ghost', async t => {
  const f = fixture(t, 'Starting…'); f.agent.agent_status = 'unknown'; f.agent.interactive_ready = false
  await f.questions.poll()
  const empty = { ...f.snapshot, panes: [], agents: [] }
  const request = f.service.client.request.bind(f.service.client)
  f.service.client.request = async (method, params) => method === 'session.snapshot' ? {snapshot:empty} : request(method,params)
  await f.questions.poll()
  assert.equal(f.attention.at(-1).pane.restore_error.code,'restore_exited')
  assert.equal(f.questions.decorate(empty).agents.length,0)
})

test('strict restore readiness accepts a working agent without waiting for it to become idle', async t => {
  const f = fixture(t, 'Processing synthetic conversation'); f.agent.agent_status = 'working'; f.agent.interactive_ready = false
  assert.equal(await m.waitUntilInteractive({request:f.service.client.request},'w1:p1',0,1,true),'ready')
})
