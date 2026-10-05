import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const dir = mkdtempSync(join(tmpdir(), 'drover-restart-test-'))
const file = join(dir, 'restart.cjs')
await build({ entryPoints: ['src/main/agentRestart.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: file, alias: { '@shared': join(process.cwd(), 'src/shared') }, logLevel: 'silent' })
const { restartArgs, AgentRestartService } = createRequire(import.meta.url)(file)

test('Claude resumes the same conversation with model/effort and toggles permissions', () => {
  const old = ['old prompt', '--resume', 'old-session', '--model', 'haiku', '--effort=low', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--add-dir', '/extra']
  assert.deepEqual(restartArgs('claude', old, 'same-session', { model: 'opus', effort: 'max' }, true), ['--resume', 'same-session', '--add-dir', '/extra', '--model', 'opus', '--effort', 'max', '--dangerously-skip-permissions'])
  assert.deepEqual(restartArgs('claude', old, 'same-session', {}, false), ['--resume', 'same-session', '--add-dir', '/extra', '--model', 'haiku', '--effort', 'low', '--permission-mode', 'manual'])
})

test('Claude -c is a boolean continue flag and -p never replays a print prompt', () => {
  const permissions = ['--permission-mode', 'manual']
  assert.deepEqual(restartArgs('claude', ['-c','--dangerously-skip-permissions'], 'same', {}, false), ['--resume','same',...permissions])
  assert.deepEqual(restartArgs('claude', ['-c','--model','sonnet'], 'same', {}, false), ['--resume','same','--model','sonnet',...permissions])
  for (const print of ['-p','--print']) assert.deepEqual(restartArgs('claude', [print,'do this again','--model=opus','--effort=max'], 'same', {}, false), ['--resume','same','--model','opus','--effort','max',...permissions])
  assert.deepEqual(restartArgs('claude', ['--continue','--resume=old','--fork-session','--debug','--model=x','--append-system-prompt','system context'], 'same', {}, false), ['--resume','same','--debug','--append-system-prompt','system context','--model','x',...permissions])
})

test('native option arities preserve Codex profile/config and never steal the next flag', () => {
  const permissions = ['--ask-for-approval','on-request','--sandbox','workspace-write']
  assert.deepEqual(restartArgs('codex', ['-p','profile','--model=x','-c','features.foo=true','resume','old','old prompt','--config=model_reasoning_effort="ultra"'], 'same', {}, false), ['resume','same','-p','profile','-c','features.foo=true','-m','x','-c','model_reasoning_effort=ultra',...permissions])
  assert.deepEqual(restartArgs('codex', ['-c','--dangerously-bypass-approvals-and-sandbox','--model','x'], 'same', {}, false), ['resume','same','-m','x',...permissions])
})

test('Codex resume replaces approvals, sandbox and model overrides without replaying a prompt', () => {
  const old = ['resume', 'old', '--last', '--full-auto', '-a', 'never', '-s', 'danger-full-access', '-c', 'approval_policy="never"', '--config=sandbox_mode="danger-full-access"', '-c', 'model_reasoning_effort=low', '-m', 'old-model', '-c', 'features.example=true', '--', 'old prompt']
  const expected = ['resume', 'same', '-c', 'features.example=true', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=ultra']
  assert.deepEqual(restartArgs('codex', old, 'same', { model: 'gpt-6-astra', effort: 'ultra' }, true), [...expected, '--dangerously-bypass-approvals-and-sandbox'])
  assert.deepEqual(restartArgs('codex', old, 'same', { model: 'gpt-6-astra', effort: 'ultra' }, false), [...expected, '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'])
  assert.deepEqual(restartArgs('codex', [], null, {}, true), ['--dangerously-bypass-approvals-and-sandbox'])
})

function fixture(agents, metadata = {}, onRestart) {
  const states = new Map(agents.map(a => [a.pane_id, { interactive_ready: true, terminal_id: `term-${a.pane_id}`, workspace_id: 'w1', agent: 'codex', name: `agent-${a.pane_id}`, agent_status: 'idle', ...a }]))
  const calls = [], presses = new Map(), started = new Set(), readiness = new Map()
  const service = {
    sessionName: 'test', connectionGeneration: 1, client: {}, snapshot: { agents: [...states.values()], panes: [...states.values()] },
    refresh: async () => {}, scheduleRefresh() {},
    async request(method, params) {
      calls.push({ method, params, session: service.sessionName })
      const id = params.target || params.pane_id
      const a = states.get(id)
      if (method === 'agent.get') {
        if (started.has(id)) {
          const n = (readiness.get(id) ?? 0) + 1
          readiness.set(id, n)
          return { agent: { ...a, interactive_ready: n > 1, launch_pending: n <= 1 } }
        }
        return { agent: { ...a } }
      }
      if (method === 'pane.process_info') return { process_info: { shell_pid: 1, foreground_processes: !started.has(id) && (presses.get(id) ?? 0) >= 2 ? [{ pid: 1, name: 'zsh' }] : [{ pid: 2, name: a.agent, argv: [a.agent, '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high'] }] } }
      if (method === 'agent.send_keys') presses.set(id, (presses.get(id) ?? 0) + 1)
      if (method === 'agent.start') { started.add(id); a.agent_status = 'idle'; a.name = params.name }
      return {}
    }
  }
  const userData = mkdtempSync(join(dir, 'profile-'))
  const restart = new AgentRestartService(service, userData, async id => metadata[id] ?? null, onRestart)
  return { restart, service, states, calls, readiness, userData }
}

const ref = value => ({ agent: 'codex', kind: 'id', source: 'herdr:codex', value })

test('batch confirmation lists eligible agents and skips working, blocked, unknown and unsupported', async () => {
  const { restart } = fixture([
    { pane_id: 'p1', agent_session: ref('same') }, { pane_id: 'p2', agent_status: 'working' },
    { pane_id: 'p3', agent_status: 'blocked' }, { pane_id: 'p4', agent_status: 'unknown' },
    { pane_id: 'p5', agent: 'gemini' }
  ])
  const plan = await restart.plan({ workspaceId: 'w1', bypass: true })
  assert.deepEqual(plan.agents.map(a => [a.paneId, a.sessionId]), [['p1', 'same']])
  assert.deepEqual(plan.skipped.map(a => [a.paneId, a.reason]), [['p2', 'agent_busy'], ['p3', 'agent_blocked'], ['p4', 'agent_not_ready']])
})

test('restart keeps pane/name/session/model/effort, waits for interactive_ready, and persists its badge', async () => {
  const remembered = []
  const { restart, calls, readiness, userData, service } = fixture([{ pane_id: 'p1', agent_session: ref('same') }], {}, async (paneId, launch) => {
    assert.ok(readiness.get(paneId) >= 2, 'persistent binding sees only an interactive-ready agent')
    remembered.push({ paneId, launch }); launch.args.push('callback cannot mutate the saved launch')
  })
  const plan = await restart.plan({ paneId: 'p1', bypass: true })
  const results = await restart.execute(plan.token)
  assert.equal(results[0].ok, true, results[0].error)
  const start = calls.find(c => c.method === 'agent.start').params
  assert.equal(start.pane_id, 'p1')
  assert.equal(start.name, 'agent-p1')
  assert.equal(remembered.length, 1); assert.equal(remembered[0].paneId, 'p1')
  assert.equal(remembered[0].launch.sessionId, 'same'); assert.equal(remembered[0].launch.bypass, true)
  assert.deepEqual(start.args, ['resume', 'same', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', '--dangerously-bypass-approvals-and-sandbox'])
  assert.ok(readiness.get('p1') >= 2)
  assert.ok(!calls.some(c => c.method === 'pane.close'))
  assert.equal(restart.decorate(service.snapshot).panes[0].bypass, true)
  const reloaded = new AgentRestartService(service, userData, async () => null)
  assert.equal(reloaded.decorate(service.snapshot).panes[0].bypass, true)
  assert.ok(!JSON.parse(readFileSync(join(userData, 'agent-launches.json'), 'utf8'))['test:p1'].args.includes('callback cannot mutate the saved launch'))
  assert.equal(JSON.parse(readFileSync(join(userData, 'agent-launches.json'), 'utf8'))['test:p1'].bypass, true)
  await assert.rejects(restart.execute(plan.token), /expired/)
})

test('agents that become working or blocked after confirmation are skipped without keys or start', async () => {
  for (const status of ['working', 'blocked']) {
    const { restart, states, calls } = fixture([{ pane_id: 'p1', agent_session: ref('same') }])
    const plan = await restart.plan({ paneId: 'p1', bypass: true })
    states.get('p1').agent_status = status
    const results = await restart.execute(plan.token)
    assert.equal(results[0].code, status === 'working' ? 'agent_busy' : 'agent_blocked')
    assert.ok(!calls.some(c => ['agent.send_keys', 'agent.start'].includes(c.method)))
  }
})

test('exact transcript can supply resume identity, heuristic matching is disclosed as unknown', async () => {
  const { restart } = fixture([{ pane_id: 'p1' }, { pane_id: 'p2' }], {
    p1: { agent: 'codex', located: 'exact', sessionId: 'transcript-session', model: 'gpt-6-sol', effort: 'max' },
    p2: { agent: 'codex', located: 'heuristic', sessionId: 'someone-else' }
  })
  const plan = await restart.plan({ workspaceId: 'w1', bypass: true })
  assert.deepEqual(plan.agents.map(a => a.sessionId), ['transcript-session', null])
})

test('a different session or pane occupant invalidates the reviewed plan', async () => {
  const { restart, states, calls } = fixture([{ pane_id: 'p1', agent_session: ref('before') }])
  const plan = await restart.plan({ paneId: 'p1', bypass: true })
  states.get('p1').agent_session = ref('after')
  assert.equal((await restart.execute(plan.token))[0].code, 'restart_plan_expired')
  assert.ok(!calls.some(c => c.method === 'agent.send_keys'))
})

test('session switch or reconnect between Ctrl+C presses cannot target the new connection', async () => {
  for (const change of ['session', 'client', 'generation']) {
    const { restart, service, calls } = fixture([{ pane_id: 'p1', agent_session: ref('same') }])
    const plan = await restart.plan({ paneId: 'p1', bypass: true })
    const request = service.request.bind(service)
    service.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'agent.send_keys') setTimeout(() => {
        if (change === 'session') service.sessionName = 'new-session'
        else if (change === 'client') service.client = {}
        else service.connectionGeneration++
      }, 50)
      return result
    }
    const result = await restart.execute(plan.token)
    assert.equal(result[0].code, 'restart_session_changed')
    assert.equal(calls.filter(c => c.method === 'agent.send_keys').length, 1)
    assert.ok(!calls.some(c => c.method === 'agent.start'))
    assert.ok(!calls.some(c => c.session === 'new-session'))
  }
})

test('a replacement idle agent or a new PID never receives the second Ctrl+C or old resume', async () => {
  for (const change of ['kind', 'name', 'session', 'pid']) {
    const { restart, service, states, calls } = fixture([{ pane_id: 'p1', agent_session: ref('same') }])
    const plan = await restart.plan({ paneId: 'p1', bypass: true })
    const request = service.request.bind(service)
    let replaced = false
    service.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'agent.send_keys') {
        replaced = true
        if (change === 'kind') states.get('p1').agent = 'claude'
        if (change === 'name') states.get('p1').name = 'other'
        if (change === 'session') states.get('p1').agent_session = ref('other')
      }
      if (method === 'pane.process_info' && replaced && change === 'pid') result.process_info.foreground_processes[0].pid = 99
      return result
    }
    assert.equal((await restart.execute(plan.token))[0].code, 'restart_occupant_changed')
    assert.equal(calls.filter(c => c.method === 'agent.send_keys').length, 1)
    assert.ok(!calls.some(c => c.method === 'agent.start'))
  }
})

test('new launches remember bypass and the remote allowlist cannot invoke restart', async () => {
  const { restart, service } = fixture([{ pane_id: 'p1' }])
  await restart.recordLaunch({ kind: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'] }, 'p1')
  assert.equal(restart.decorate(service.snapshot).panes[0].bypass, true)
  await restart.recordLaunch({ kind: 'codex', args: ['--full-auto'] }, 'p1')
  assert.equal(restart.decorate(service.snapshot).panes[0].bypass, false, 'full-auto keeps a sandbox and is not the dangerous bypass mode')
  const source = readFileSync('src/shared/remote.ts', 'utf8')
  const allowed = source.slice(source.indexOf('export const REMOTE_METHOD_CHANNELS'), source.indexOf('export type RemoteMethod'))
  assert.ok(!allowed.includes('restartAgents'))
  assert.ok(!allowed.includes('planAgentRestart'))
})

test('launch recording discards stale replies without changing either session cache', async () => {
  for (const change of ['session', 'client', 'generation']) {
    const { restart, service, userData } = fixture([{ pane_id: 'w1:p1', agent_session: ref('original') }])
    const req = { kind: 'codex', args: [] }
    await restart.recordLaunch(req, 'w1:p1')
    service.sessionName = 'foreign'
    await restart.recordLaunch({ ...req, args: ['--dangerously-bypass-approvals-and-sandbox'] }, 'w1:p1')
    const file = join(userData, 'agent-launches.json'), before = readFileSync(file, 'utf8')
    service.sessionName = 'test'
    const request = service.request.bind(service)
    let release
    const deferred = new Promise(resolve => { release = resolve })
    service.request = async (method, params) => {
      const reply = await request(method, params)
      await deferred
      return reply
    }
    const recording = restart.recordLaunch({ ...req, args: ['--model', 'old-owner'] }, 'w1:p1')
    if (change === 'session') service.sessionName = 'foreign'
    else if (change === 'client') service.client = {}
    else service.connectionGeneration++
    release()
    await recording
    assert.equal(readFileSync(file, 'utf8'), before, `${change}: neither cache entry may be rewritten`)
    service.sessionName = 'foreign'
    assert.equal(restart.decorate(service.snapshot).panes[0].bypass, true, `${change}: foreign bypass is preserved`)
  }
})

test('a session switch during the persistence hook cannot start the next project agent', async () => {
  const f = fixture([{pane_id:'p1',agent_session:ref('one')},{pane_id:'p2',agent_session:ref('two')}], {}, async () => { f.service.sessionName='foreign'; f.service.connectionGeneration++ })
  const plan=await f.restart.plan({workspaceId:'w1',bypass:true}),results=await f.restart.execute(plan.token)
  assert.equal(results[0].code,'restart_session_changed');assert.equal(results[1].code,'restart_session_changed')
  assert.ok(!f.calls.some(c=>c.method==='agent.start' && c.params.pane_id==='p2'))
})
