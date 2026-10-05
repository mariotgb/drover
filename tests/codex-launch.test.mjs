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
  const daemon = new m.CodexDaemon(service, {
    run: async args => { calls.push(args); return { code: 0, stdout: JSON.stringify({ status: 'running' }), stderr: '' } },
    daemonContext: async () => ({ identity: '123', paneId: 'stale:p1', socketPath: '/test.sock' }),
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
  assert.equal(f.calls.filter(args => args.includes('restart')).length, 1)
  await assert.rejects(f.daemon.execute(plan.token), /fresh/)
})

test('daemon status changes do not invalidate a confirmed restart plan', async () => {
  const f = daemonFixture()
  for (const status of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    const plan = await f.daemon.plan()
    f.snapshot.agents[0].agent_status = status
    assert.equal((await f.daemon.execute(plan.token)).outcome, 'completed')
  }
  assert.equal(f.calls.filter(args => args.includes('restart')).length, 5)
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
    assert.equal(f.calls.filter(args => args.includes('restart')).length, 1)
  }
  for (const field of ['identity', 'session']) {
    let identity = '123', session = 'isolated'
    const f = daemonFixture({
      daemonContext: async () => ({ identity, paneId: 'stale:p1', socketPath: '/test.sock' }),
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
