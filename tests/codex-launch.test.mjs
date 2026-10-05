import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const bundle = mkdtempSync(join(tmpdir(), 'drover-codex-test-'))
await build({ stdin: { contents: `export * from './src/main/codexLaunch'; export * from './src/main/codexDaemon'; export * from './src/main/herdr/service'`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })

test('new Codex launch and resume bypass shared daemon only when supported, without mutating caller args', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-codex-fake-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\n[ "$1" = "--help" ] && printf "Usage: codex --no-daemon\\n"\n', { mode: 0o700 })
  const service = new m.HerdrService({ logDir: dir, autoStartServer: () => false })
  t.after(() => service.stop())
  service.env = { PATH: dir }
  const requests = []
  service.client = { async request(method, params) { if (method === 'agent.start') requests.push([method, params]); return {} } }
  const original = ['-m', 'gpt-6.1-sol', 'resume', 'native-session']
  await service.request('agent.start', { pane_id: 'w1:p1', kind: 'codex', args: original })
  assert.deepEqual(requests[0][1].args, ['--no-daemon', ...original])
  assert.deepEqual(original, ['-m', 'gpt-6.1-sol', 'resume', 'native-session'])
  await service.request('agent.start', { pane_id: 'w1:p2', kind: 'claude', args: ['--model', 'opus'] })
  assert.deepEqual(requests[1][1].args, ['--model', 'opus'])
  assert.deepEqual(m.codexIsolatedArgs(['--no-daemon', 'resume', 'x'], true), ['--no-daemon', 'resume', 'x'])
  assert.deepEqual(m.codexIsolatedArgs(original, false), original)
  writeFileSync(join(dir, 'codex'), '#!/bin/sh\nprintf "Usage: old codex\\n"\n', { mode: 0o700 })
  service.codexLaunch.reset()
  await service.request('agent.start', { pane_id: 'w1:p3', kind: 'codex', args: [] })
  assert.deepEqual(requests[2][1].args, [])
})

function daemonFixture(extra = {}) {
  const agents = [{ pane_id: 'w1:p1', terminal_id: 'term1', name: 'worker', agent: 'codex', agent_status: 'working', agent_session: null }]
  const snapshot = { agents, panes: agents, tabs: [], workspaces: [], layouts: [] }
  const calls = []
  const service = { codexLaunch: { supportsNoDaemon: async () => true } }
  let running = true
  const daemon = new m.CodexDaemon(service, {
    run: async args => {
      calls.push(args)
      if (args.at(-1) === 'stop') running = false
      if (args.at(-1) === 'start') running = true
      return { code: 0, stdout: JSON.stringify({ status: running ? 'running' : 'stopped' }), stderr: '' }
    },
    probe: async () => ({ code: 0, stdout: 'Accepts new sessions', stderr: '' }),
    wait: async () => {},
    daemonContext: async () => ({ identity: running ? '123' : '', paneId: 'stale:p1', socketPath: '/test.sock' }),
    snapshots: async () => [{ session: 'isolated', snapshot }], ...extra
  })
  return { daemon, calls, snapshot, service }
}

test('daemon plan is read-only, includes interruption list and wait recommendation; explicit confirmed execute is single use', async () => {
  const f = daemonFixture()
  const plan = await f.daemon.plan()
  assert.equal(plan.canRestart, true)
  assert.equal(plan.busy, true)
  assert.equal(plan.otherClientsMayBeAffected, true)
  assert.deepEqual(plan.agents, [{ session: 'isolated', paneId: 'w1:p1', name: 'worker', status: 'working', hasSession: false }])
  assert.ok(f.calls.every(args => !args.includes('restart')))
  await f.daemon.execute(plan.token)
  assert.deepEqual(f.calls.slice(-4).map(args => args.at(-1)), ['stop', 'version', 'start', 'version'])
  assert.equal(f.calls.some(args => args.includes('restart')), false)
  await assert.rejects(f.daemon.execute(plan.token), /fresh/)
})

test('daemon status changes do not invalidate a confirmed restart plan', async () => {
  const f = daemonFixture()
  for (const status of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    const plan = await f.daemon.plan()
    f.snapshot.agents[0].agent_status = status
    assert.equal((await f.daemon.execute(plan.token)).outcome, 'completed')
  }
  assert.equal(f.calls.filter(args => args.includes('start')).length, 5)
})

test('daemon identity and agent membership changes return a fresh plan requiring another confirmation', async () => {
  const changes = [
    f => { f.snapshot.agents.push({ ...f.snapshot.agents[0], pane_id: 'w1:p2', terminal_id: 'term2', name: 'new-worker' }) },
    f => { f.snapshot.agents.pop() },
    ...['pane_id', 'terminal_id', 'agent_session', 'name'].map(field => f => { f.snapshot.agents[0][field] = 'replacement' })
  ]
  for (const change of changes) {
    const f = daemonFixture()
    const plan = await f.daemon.plan()
    change(f)
    const result = await f.daemon.execute(plan.token)
    assert.equal(result.outcome, 'plan_changed')
    assert.notEqual(result.plan.token, plan.token)
    assert.deepEqual(result.plan.agents.map(agent => agent.name), f.snapshot.agents.map(agent => agent.name))
    assert.equal(f.calls.some(args => args.includes('restart')), false)
    assert.equal((await f.daemon.execute(result.plan.token)).outcome, 'completed')
    assert.equal(f.calls.filter(args => args.includes('start')).length, 1)
  }
  for (const field of ['identity', 'session']) {
    let identity = '123', session = 'isolated'
    const f = daemonFixture({
      daemonContext: async () => ({ identity: f.calls.at(-1)?.at(-1) === 'version' && f.calls.at(-2)?.at(-1) === 'stop' ? '' : identity, paneId: 'stale:p1', socketPath: '/test.sock' }),
      snapshots: async () => [{ session, snapshot: f.snapshot }]
    })
    const plan = await f.daemon.plan()
    if (field === 'identity') identity = '456'
    else session = 'replacement'
    const result = await f.daemon.execute(plan.token)
    assert.equal(result.outcome, 'plan_changed')
    assert.equal(f.calls.some(args => args.includes('restart')), false)
    assert.equal((await f.daemon.execute(result.plan.token)).outcome, 'completed')
  }
})

test('daemon execute returns an unavailable fresh plan when inventory becomes incomplete or the service stops', async () => {
  for (const change of ['inventory', 'running', 'supported']) {
    let changed = false
    const f = daemonFixture({
      run: async args => { f.calls.push(args); return { code: 0, stdout: JSON.stringify({ status: changed && change === 'running' ? 'stopped' : 'running' }), stderr: '' } },
      snapshots: async () => {
        if (changed && change === 'inventory') throw new Error('socket unavailable')
        return [{ session: 'isolated', snapshot: f.snapshot }]
      }
    })
    f.service.codexLaunch.supportsNoDaemon = async () => !(changed && change === 'supported')
    const plan = await f.daemon.plan()
    changed = true
    const result = await f.daemon.execute(plan.token)
    assert.equal(result.outcome, 'plan_changed')
    assert.equal(result.plan.canRestart, false)
    assert.equal(f.calls.some(args => args.includes('restart')), false)
  }
})

test('daemon execute rejects expired/invalid tokens and unavailable plans', async () => {
  const f = daemonFixture()
  const second = await f.daemon.plan()
  await assert.rejects(f.daemon.execute('arbitrary-token'), /fresh/)
  await assert.rejects(f.daemon.execute(second.token), /fresh/)
  const expired = await f.daemon.plan()
  expired.expiresAt = Date.now() - 1
  await assert.rejects(f.daemon.execute(expired.token), /fresh/)
  const incomplete = daemonFixture({ snapshots: async () => { throw new Error('socket unavailable') } })
  const plan = await incomplete.daemon.plan()
  assert.equal(plan.canRestart, false)
  await assert.rejects(incomplete.daemon.execute(plan.token), /fresh/)
  assert.ok(f.calls.every(args => !args.includes('restart')))
})

test('daemon environment diagnostic returns only HERDR pane and socket, excluding credentials', () => {
  assert.deepEqual(m.daemonHerdrContext('/bin/codex app-server SECRET=hidden HERDR_PANE_ID=w8:p4 HERDR_SOCKET_PATH=/tmp/herdr.sock API_KEY=hidden'),
    { paneId: 'w8:p4', socketPath: '/tmp/herdr.sock' })
})

test('refresh drops stale success/error/finally without disturbing a new connection refresh', async t => {
  for (const failure of [false, true]) {
    const service = new m.HerdrService({ logDir: '/tmp', autoStartServer: () => false })
    t.after(() => service.stop())
    let releaseOld, releaseNew
    service.client = { request: () => new Promise((resolve, reject) => { releaseOld = failure ? reject : resolve }) }
    const old = service.refresh()
    service.stop()
    service.session = 'new'
    service.snapshot = { fixture: 'new', panes: [], agents: [] }
    service.connection = { status: 'connecting', session: 'new' }
    service.client = { request: () => new Promise(resolve => { releaseNew = resolve }), subscribe: () => ({ close() {} }) }
    const fresh = service.refresh()
    releaseOld(failure ? new Error('old socket failed') : { snapshot: { fixture: 'old' } })
    await old
    assert.equal(service.snapshot.fixture, 'new')
    assert.equal(service.connection.status, 'connecting')
    assert.notEqual(service.refreshing, null)
    releaseNew({ snapshot: { fixture: 'fresh', panes: [], agents: [] } })
    await fresh
    assert.equal(service.snapshot.fixture, 'fresh')
    assert.equal(service.connection.status, 'connected')
    assert.equal(service.refreshing, null)
  }
})

test('daemon execute checks expiry again after asynchronous inventory revalidation', async () => {
  const original = Date.now
  let clock = 100000, advance = false
  Date.now = () => clock
  try {
    const f = daemonFixture({ snapshots: async () => {
      if (advance) clock += 61000
      return [{ session: 'isolated', snapshot: { agents: [], panes: [] } }]
    } })
    const plan = await f.daemon.plan()
    advance = true
    await assert.rejects(f.daemon.execute(plan.token), /fresh/)
    assert.equal(f.calls.some(args => args.includes('restart')), false)
  } finally { Date.now = original }
})

test('daemon waits for the old process to stop, then checks a new session; draining never counts as success', async () => {
  for (const scenario of ['delayed-stop', 'stop-fails', 'never-stops', 'start-fails', 'not-running', 'draining', 'version-unavailable']) {
    const calls = []; let phase = 'old', polls = 0, probes = 0
    const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr })
    const f = daemonFixture({
      run: async args => {
        const command = args.at(-1); calls.push(command)
        if (command === 'stop') { if (scenario === 'stop-fails') return result(1, '', 'stop rejected'); phase = 'stopping'; return result(0) }
        if (command === 'start') { phase = 'new'; return scenario === 'start-fails' ? result(1, '', 'start rejected') : result(0) }
        if (phase === 'stopping') {
          polls++
          if (scenario === 'never-stops') return result(0, '{"status":"running"}')
          if (scenario === 'version-unavailable') return result(1, '', 'permission denied')
          if (scenario === 'delayed-stop' && polls === 1) return result(0, '{"status":"running"}')
          phase = 'stopped'
          return result(1, '', 'failed to connect to socket: No such file or directory')
        }
        return result(0, JSON.stringify({ status: phase === 'new' && scenario === 'not-running' ? 'stopped' : 'running' }))
      },
      daemonContext: async () => ({ identity: phase === 'stopped' ? '' : '123', paneId: null, socketPath: null }),
      probe: async () => { probes++; return scenario === 'draining' ? result(1, '', 'Server is draining; retry after reconnecting') : result(0, 'accepts sessions') }
    })
    const plan = await f.daemon.plan(), executed = await f.daemon.execute(plan.token)
    assert.equal(executed.code === 0, scenario === 'delayed-stop', scenario)
    assert.equal(calls.includes('restart'), false)
    if (['stop-fails', 'never-stops', 'version-unavailable'].includes(scenario)) assert.equal(calls.includes('start'), false)
    if (scenario !== 'delayed-stop') assert.match(executed.stderr, /Codex service|Codex.*shutdown/)
    assert.equal(probes, ['delayed-stop', 'draining'].includes(scenario) ? 1 : 0)
    if (scenario === 'draining') assert.match(executed.stderr, /draining/)
  }
})

test('daemon probe uses an ephemeral session without turns, removes inherited HERDR context, and rejects draining', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-daemon-probe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}
const readline = require('node:readline');
if (process.argv.slice(2).join(' ') !== 'app-server proxy') process.exit(2);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (Object.keys(process.env).some(k => k.startsWith('HERDR_')) || process.env.CODEX_THREAD_ID) return send({id:request.id,error:{message:'inherited context'}});
 if (request.method === 'initialize') send({id:request.id,result:{}});
 else if (request.method === 'thread/start') {
  if (!request.params.ephemeral || request.params.sandbox !== 'readOnly') process.exit(3);
  send(process.env.TEST_DRAINING ? {id:request.id,error:{message:'Server is draining; retry after reconnecting'}} : {id:request.id,result:{thread:{id:'test',ephemeral:true}}});
 } else if (request.method === 'thread/unsubscribe') send({id:request.id,result:{}});
 else if (request.method !== 'initialized') process.exit(4);
});
`, { mode: 0o700 })
  const env = { PATH: dir, HERDR_PANE_ID: 'old', HERDR_SOCKET_PATH: 'old.sock', HERDR_EXTRA: 'old', CODEX_THREAD_ID: 'old' }
  assert.equal((await m.probeCodexDaemon(env)).code, 0)
  assert.match((await m.probeCodexDaemon({ ...env, TEST_DRAINING: '1' })).stderr, /draining/)
  assert.deepEqual(m.daemonEnvironment(env), { PATH: dir })
})
