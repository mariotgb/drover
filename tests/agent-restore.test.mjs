import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, lstatSync, statSync, utimesSync } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
const bundle = mkdtempSync(join(tmpdir(), 'drover-restore-test-'))
await build({ stdin: { contents: `export * from './src/main/agentRestore'; export * from './src/main/agentLaunchArgs'; export * from './src/main/agentRestart'; export * from './src/main/herdr/service'; export * from './src/main/captureAgentLaunches'; export * from './src/main/herdr/cli'`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundle, 'test.cjs'))
rmSync(bundle, { recursive: true, force: true })
const codexArgs = ['--no-daemon', '-m', 'openai/gpt-6.1-sol', '--dangerously-bypass-approvals-and-sandbox', '-p', 'office', '--add-dir', '/extra', '--search']
const claudeArgs = ['--model=sonnet', '--effort', 'high', '--permission-mode', 'acceptEdits', '--allow-dangerously-skip-permissions', '--settings', '/config/settings.json', '--mcp-config', '/config/mcp.json']
const ref = (agent, value = `${agent}-session`) => ({ agent, source: `herdr:${agent}`, kind: 'id', value })

test('resume keeps allowlisted native policy and file paths, drops selectors, prompts and unknown config', () => {
  assert.deepEqual(m.resumeArgs('codex', ['fork', 'old-id', ...codexArgs, 'old prompt'], 'new-id'), [...codexArgs, 'resume', 'new-id'])
  assert.deepEqual(m.resumeArgs('codex', [...codexArgs, 'resume', 'old-id', '--last', '--all', '--', 'old prompt'], 'new-id'), [...codexArgs, 'resume', 'new-id'])
  assert.deepEqual(m.resumeArgs('claude', ['old prompt', '-c', '--resume=old-id', '--fork-session', ...claudeArgs], 'new-id'), ['--resume', 'new-id', ...claudeArgs])
  assert.deepEqual(m.resumeArgs('claude', ['--print', 'prompt', '--session-id', 'old', ...claudeArgs], 'new-id'), ['--resume', 'new-id', ...claudeArgs])
  assert.deepEqual(m.resumeArgs('codex', ['-mold', '-cmodel="x"', '-c', 'model_reasoning_effort="low"', '-c', 'approval_policy="never"', '-pwork'], 'same', { model: 'new', effort: 'high' }), ['-pwork', '-m', 'new', '-c', 'model_reasoning_effort=high', 'resume', 'same'])
  assert.deepEqual(m.resumeArgs('codex', ['--new-config-option', 'keep its value', '--no-daemon'], 'same'), ['--no-daemon', 'resume', 'same'])
})

function fixture(t, launches = { 'w1:p1': { kind: 'codex', args: codexArgs, sessionId: 'codex-session' }, 'w1:pA': { kind: 'claude', args: claudeArgs, sessionId: 'claude-session' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-restore-case-')), sessionDir = join(dir, 'session')
  mkdirSync(sessionDir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const panes = { 101: { cwd: dir, agent_name: 'drover-worker', agent_session: ref('codex') }, 102: { cwd: dir, agent_name: 'drover-designer', agent_session: ref('claude') }, 103: { cwd: dir, agent_session: { agent: 'pi', source: 'herdr:pi', kind: 'id', value: 'pi-session' } } }
  const saved = { version: 3, selected: 0, active: 0, workspaces: [{ id: 'w1', identity_cwd: dir, public_pane_numbers: { 101: 1, 102: 10, 103: 11 }, tabs: [{ panes }] }] }
  const file = join(sessionDir, 'session.json')
  writeFileSync(file, JSON.stringify(saved))
  const records = [], repo = { get: id => launches[id], record: async (agent, args) => records.push({ agent, args }) }
  const restore = new m.AgentRestore(repo, dir)
  restore.setSessionDir(sessionDir)
  return { dir, file, sessionDir, saved, panes, restore, records, launches, read: () => JSON.parse(readFileSync(file, 'utf8')) }
}

test('0.9.2+ persisted resume_argv keeps models/permissions for both CLIs; other kinds untouched', async t => {
  const f = fixture(t)
  await f.restore.prepare('isolated', f.sessionDir, '0.9.4', true)
  const p = f.read().workspaces[0].tabs[0].panes
  assert.deepEqual(p[101].agent_resume.argv, ['codex', ...codexArgs, 'resume', 'codex-session'])
  assert.deepEqual(p[102].agent_resume.argv, ['claude', '--resume', 'claude-session', ...claudeArgs])
  assert.deepEqual(p[103], f.panes[103])
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'agent-restores.json'), 'utf8')).entries.isolated.length, 0)
})

test('launch captured before the first native hook matches only its same saved name and cwd', async t => {
  const f = fixture(t)
  const launch = f.launches['w1:p1']
  delete launch.sessionId
  launch.cwd = f.dir; launch.name = 'drover-worker'
  await f.restore.prepare('isolated', f.sessionDir, '0.9.4')
  assert.deepEqual(f.read().workspaces[0].tabs[0].panes[101].agent_resume.argv, ['codex', ...codexArgs, 'resume', 'codex-session'])
  launch.name = 'different-occupant'
  delete f.panes[101].agent_resume
  writeFileSync(f.file, JSON.stringify(f.saved))
  await f.restore.prepare('isolated', f.sessionDir, '0.9.4')
  assert.deepEqual(f.read().workspaces[0].tabs[0].panes[101].agent_resume.argv, ['codex', 'resume', 'codex-session'])
})

test('old herdr and resume_argv limit violations queue full args durably without bare native resume', async t => {
  for (const version of ['0.9.1', '0.9.4']) {
    const f = fixture(t)
    if (version === '0.9.4') {
      f.launches['w1:p1'].args = [...codexArgs, '--add-dir', "/don't"]
      f.launches['w1:pA'].args = [...claudeArgs, '--settings', '/' + 'x'.repeat(8193)]
    }
    await f.restore.prepare('isolated', f.sessionDir, version)
    const saved = f.read().workspaces[0].tabs[0].panes
    assert.equal(saved[101].agent_session, undefined); assert.equal(saved[102].agent_session, undefined)
    assert.ok(saved[103].agent_session)
    const queue = JSON.parse(readFileSync(join(f.dir, 'agent-restores.json'), 'utf8')).entries.isolated
    assert.deepEqual(queue.map(e => e.paneId), ['w1:p1', 'w1:pA'])
    assert.deepEqual(queue[0].args, [...f.launches['w1:p1'].args, 'resume', 'codex-session'])
    // A process crash between queue save and native suppression is retryable.
    const reloaded = new m.AgentRestore({ get: () => undefined, record: async () => {} }, f.dir)
    await reloaded.prepare('isolated', f.sessionDir, version)
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'agent-restores.json'), 'utf8')).entries.isolated.length, 2)
  }
  assert.equal(m.acceptsResumeArgv(['codex', ...Array(64).fill('--search')]), false)
  assert.equal(m.acceptsResumeArgv(['codex', '-c', 'x="a"']), true)
  assert.equal(m.acceptsResumeArgv(['codex', 'bad\nvalue']), false)
  assert.equal(m.supportsResumeArgv('0.9.1'), false); assert.equal(m.supportsResumeArgv('0.9.2'), true)
})

test('queue restores at a verified shell once, never over an occupant or changed cwd/connection', async t => {
  for (const change of ['none', 'occupied', 'cwd', 'context']) {
    const f = fixture(t)
    await f.restore.prepare('isolated', f.sessionDir, '0.9.1')
    const calls = [], started = new Set()
    let current = true
    const client = { request: async (method, params) => {
      calls.push([method, params])
      const pane = { pane_id: 'w1:p1', terminal_id: 'new-term', cwd: change === 'cwd' ? '/elsewhere' : f.dir, agent: change === 'occupied' ? 'claude' : null }
      if (method === 'session.snapshot') return { snapshot: { panes: [pane] } }
      if (method === 'pane.process_info') { if (change === 'context') current = false; return { process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }] } } }
      if (method === 'agent.get') return { agent: { ...pane, agent: 'codex' } }
      return {}
    } }
    await f.restore.restore('isolated', client, () => current, async entry => { started.add(entry.paneId); assert.deepEqual(entry.args, [...codexArgs, 'resume', 'codex-session']) })
    assert.equal(started.size, change === 'none' ? 1 : 0, change)
    if (change === 'none') {
      assert.equal(f.records[0].agent.agent_session.value, 'codex-session')
      await f.restore.restore('isolated', client, () => current, async () => assert.fail('must not repeat'))
    }
    assert.equal(calls.some(([method]) => method === 'agent.send_keys' || method === 'pane.run'), false)
  }
})

test('reports existing native session source with full argv and no state/input commands; retries no-op until persisted', async t => {
  const f = fixture(t), calls = []
  const agent = { pane_id: 'w1:p1', terminal_id: 'term', agent: 'codex', agent_status: 'working', agent_session: ref('codex') }
  const client = { socketPath: '/synthetic.sock', request: async (method, params) => calls.push([method, params]) }
  await f.restore.report(agent, codexArgs, undefined, '0.9.4', client, 123)
  await f.restore.report(agent, codexArgs, undefined, '0.9.4', client, 124)
  assert.equal(calls.length, 1)
  assert.ok(calls.every(([method, params]) => method === 'pane.report_agent_session' && params.source === 'herdr:codex' && !params.state && params.resume_argv.includes('--no-daemon')))
  f.panes[101].agent_resume = { agent: 'codex', source: 'herdr:codex', argv: calls[0][1].resume_argv }
  writeFileSync(f.file, JSON.stringify(f.saved))
  await f.restore.report(agent, codexArgs, undefined, '0.9.4', client, 125)
  await f.restore.report(agent, codexArgs, undefined, '0.9.4', client, 126)
  assert.equal(calls.length, 1)
})

test('snapshot observation captures external CLI launch and the same-process /clear retains args', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-external-launch-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  let agent = { pane_id: 'w1:p1', terminal_id: 'term', name: 'drover-external', cwd: dir, agent: 'codex', agent_status: 'working', agent_session: ref('codex') }
  let pid = 21, argv = ['/tools/codex.exe', ...codexArgs]
  const calls = []
  const service = { sessionName: 'isolated', connectionGeneration: 1, connection: { version: '0.9.1' }, client: {}, scheduleRefresh() {}, request: async (method, params) => {
    calls.push([method, params]); return method === 'agent.get' ? { agent: { ...agent } } : { process_info: { shell_pid: 20, foreground_processes: [{ pid, argv }] } }
  } }
  const restart = new m.AgentRestartService(service, dir, async () => null)
  service.agentRestore.observe({ agents: [agent], panes: [agent] }); await restart.observing
  let saved = JSON.parse(readFileSync(join(dir, 'agent-launches.json'), 'utf8'))['isolated:w1:p1']
  assert.deepEqual(saved.args, codexArgs); assert.equal(saved.processId, 21)
  agent.agent_session = ref('codex', 'clear-session')
  service.agentRestore.observe({ agents: [agent], panes: [agent] }); await restart.observing
  saved = JSON.parse(readFileSync(join(dir, 'agent-launches.json'), 'utf8'))['isolated:w1:p1']
  assert.equal(saved.sessionId, 'clear-session'); assert.deepEqual(saved.args, codexArgs)
  // A new occupant in the same pane must supply its own policy.
  pid = 22; argv = ['codex', '-m', 'different-model']; agent.agent_session = ref('codex', 'replacement')
  service.agentRestore.observe({ agents: [agent], panes: [agent] }); await restart.observing
  saved = JSON.parse(readFileSync(join(dir, 'agent-launches.json'), 'utf8'))['isolated:w1:p1']
  assert.deepEqual(saved.args, ['-m', 'different-model'])
  assert.ok(calls.every(([method]) => ['agent.get', 'pane.process_info'].includes(method)))
})

test('H1 shared sanitizer prevents credentials, inline JSON/env and prompts at every disk/report boundary', async t => {
  const f = fixture(t)
  const privateArgs = [...codexArgs, '-c', 'model_providers.custom.http_headers.Authorization="Bearer FAKE-CREDENTIAL"', '--unknown', 'FAKE-UNKNOWN', 'FAKE-PROMPT']
  const clean = m.sanitizeLaunchArgs('codex', privateArgs)
  assert.equal(clean.unavailable, true)
  assert.deepEqual(clean.args, codexArgs)
  for (const args of [
    ['--settings', '{"env":{"API_KEY":"FAKE-ENV"}}'],
    ['--mcp-config', '{"servers":{"env":{"API_KEY":"FAKE-MCP"}}}'],
    ['--model', 'Bearer FAKE-MODEL'], ['--effort', 'FAKE-EFFORT'], ['--system-prompt', 'FAKE-SYSTEM'],
    ['--unknown=FAKE-UNKNOWN'], ['--config', 'API_KEY=FAKE-CONFIG']
  ]) {
    const sanitized = m.sanitizeLaunchArgs('claude', args)
    assert.equal(sanitized.unavailable, true)
    assert.ok(!JSON.stringify(sanitized).includes('FAKE-'))
  }
  const safe = m.sanitizeLaunchArgs('claude', [...claudeArgs, 'FAKE-POSITIONAL-PROMPT'])
  assert.equal(safe.unavailable, false); assert.deepEqual(safe.args, claudeArgs)
  const calls = []
  await f.restore.report({ agent: 'codex', pane_id: 'w1:p1', terminal_id: 'term', agent_session: ref('codex') }, privateArgs, {}, '0.9.4', { request: async (...args) => calls.push(args) }, 1)
  assert.equal(calls.length, 0, 'unsafe policy cannot be replaced with a bogus report')
  const file = join(f.dir, 'agent-launches.json')
  writeFileSync(file, JSON.stringify({ 'isolated:w1:p1': { kind: 'codex', terminalId: 'term', args: privateArgs, bypass: true, privatePrompt: 'FAKE-EXTRA' } }))
  const service = { sessionName: 'isolated', connectionGeneration: 1, client: {} }
  const restart = new m.AgentRestartService(service, f.dir, async () => null)
  await restart.save
  const scrubbed = readFileSync(file, 'utf8')
  assert.ok(!scrubbed.includes('FAKE-')); assert.ok(JSON.parse(scrubbed)['isolated:w1:p1'].restoreUnavailable)
  f.launches['w1:p1'].args = privateArgs
  await f.restore.prepare('isolated', f.sessionDir, '0.9.1')
  assert.equal(f.read().workspaces[0].tabs[0].panes[101].agent_session, undefined)
  assert.ok(!readFileSync(join(f.dir, 'agent-restores.json'), 'utf8').includes('FAKE-'))
  const queueFile = join(f.dir, 'agent-restores.json')
  writeFileSync(queueFile, JSON.stringify({ version: 1, entries: { isolated: [{ paneId: 'w1:p1', cwd: f.dir, name: 'old', ref: ref('codex'), args: privateArgs, identity: 'a'.repeat(64) }] } }))
  await f.restore.loadQueue()
  assert.deepEqual(JSON.parse(readFileSync(queueFile, 'utf8')).entries.isolated, [])
})

test('H2 migration mutex, last-moment stopped check and file mtime/content comparison', async t => {
  const f = fixture(t)
  let entered, release
  const ready = new Promise(r => { entered = r }), wait = new Promise(r => { release = r })
  const holder = m.withRestoreMutex(f.file, async () => { entered(); await wait })
  await ready
  let prepared = false
  const queued = f.restore.prepare('isolated', f.sessionDir, '0.9.4').then(() => { prepared = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(prepared, false)
  release(); await holder; await queued
  assert.equal(prepared, true)
  for (const change of ['running', 'mtime', 'content', 'symlink']) {
    writeFileSync(f.file, JSON.stringify(f.saved))
    let checks = 0
    const guard = { assertStopped: async () => {
      checks++
      if (checks !== 2) return
      if (change === 'running') throw Object.assign(new Error('running'), { code: 'restore_server_running' })
      if (change === 'mtime') utimesSync(f.file, new Date(), new Date(Date.now() + 2000))
      if (change === 'content') writeFileSync(f.file, JSON.stringify({ ...f.saved, newerServerSave: true }))
      if (change === 'symlink') { const other = join(f.dir, 'other.json'); writeFileSync(other, JSON.stringify({ ...f.saved, newerServerSave: true })); rmSync(f.file); symlinkSync(other, f.file) }
    } }
    await assert.rejects(f.restore.prepare('isolated', f.sessionDir, '0.9.4', false, () => true, guard), e => ['restore_server_running', 'restore_session_changed'].includes(e.code))
    assert.equal(f.read().workspaces[0].tabs[0].panes[101].agent_resume, undefined)
    if (change === 'content' || change === 'symlink') assert.equal(f.read().newerServerSave, true)
    if (change === 'symlink') rmSync(f.file)
  }
})

test('restore mutex leaves no owner file, ignores old crash markers and releases after rejection', async t => {
  const f = fixture(t), old = `${f.file}.drover-lock`
  writeFileSync(old, 'obsolete SIGKILL marker')
  await assert.rejects(m.withRestoreMutex(f.file, async () => { throw new Error('fixture failure') }), /fixture failure/)
  let resumed = false
  await m.withRestoreMutex(f.file, async () => { resumed = true })
  assert.equal(resumed, true); assert.equal(readFileSync(old, 'utf8'), 'obsolete SIGKILL marker')
})

test('normal default binary/session.json path is unchanged; DROVER_USER_DATA profiles have independent paths', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-default-path-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = { env: { PATH: '/fixture/bin', HERDR_CONFIG_PATH: join(dir, 'original-config'), FIXTURE: 'unchanged' }, seen: [], prepared: [] }
  globalThis.__droverPaths = runtime
  t.after(() => delete globalThis.__droverPaths)
  const outfile = join(dir, 'paths.cjs')
  await build({ entryPoints: ['src/main/herdr/service.ts'], bundle: true, platform: 'node', format: 'cjs', outfile, alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'isolated-paths', setup(b) {
    b.onResolve({ filter: /^\.\.\/env$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'env', namespace: 'fake-path' } : undefined)
    b.onResolve({ filter: /^\.\/cli$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'cli', namespace: 'fake-path' } : undefined)
    b.onResolve({ filter: /^\.\/client$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'client', namespace: 'fake-path' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fake-path' }, args => ({ contents: args.path === 'env' ? `exports.loginEnv = async () => globalThis.__droverPaths.env;`
      : args.path === 'cli' ? `const path = require('node:path'); const r = globalThis.__droverPaths; exports.findHerdr = env => { r.seen.push(['binary', env.PATH]); return '/fixture/bin/herdr' }; exports.defaultSocketPath = (session, env) => path.join(env.HERDR_CONFIG_PATH, ...(session === 'default' ? [] : ['sessions', session]), 'herdr.sock'); exports.listSessions = async (binary, env) => { const session_dir = env.HERDR_CONFIG_PATH; r.seen.push(['list', binary, session_dir]); return [{ name: 'default', session_dir, socket_path: path.join(session_dir, 'herdr.sock') }] };`
      : `exports.HerdrClient = class { constructor(socketPath) { this.socketPath = socketPath } async request() { return { version: 'fixture' } } };`, loader: 'js' }))
  } }] })
  const { HerdrService } = createRequire(import.meta.url)(outfile)
  const paths = []
  for (const isolatedHerdrDir of [undefined, join(dir, 'profile-a', 'herdr'), join(dir, 'profile-b', 'herdr')]) {
    const service = new HerdrService({ logDir: dir, autoStartServer: () => false, isolatedHerdrDir })
    service.subscribeLifecycle = () => {}; service.refresh = async () => {}; service.schedulePoll = () => {}
    await service.start('default')
    assert.equal(service.herdrPath, '/fixture/bin/herdr'); assert.equal(service.sessionName, 'default')
    assert.equal(service.env.PATH, runtime.env.PATH); assert.equal(service.env.FIXTURE, 'unchanged')
    paths.push(join(service.sessionDir, 'session.json'))
    assert.equal(service.client.socketPath, join(isolatedHerdrDir ?? runtime.env.HERDR_CONFIG_PATH, 'herdr.sock'))
    if (!isolatedHerdrDir) { assert.equal(service.env, runtime.env); assert.equal(paths[0], join(runtime.env.HERDR_CONFIG_PATH, 'session.json')) }
    service.stop()
  }
  assert.equal(new Set(paths).size, 3)
  const normal = m.defaultSocketPath('default', {})
  assert.equal(normal, join(m.herdrConfigDir({}), 'herdr.sock'))
  assert.equal(join(dirname(normal), 'session.json'), join(m.herdrConfigDir({}), 'session.json'))
  // Electron v44.5.1 uses DIR_USER_DATA for ProcessSingleton; assert our
  // profile override precedes that native lock and all service construction.
  const index = readFileSync('src/main/index.ts', 'utf8')
  assert.ok(index.indexOf("app.setPath('userData', process.env.DROVER_USER_DATA)") < index.indexOf('app.requestSingleInstanceLock()'))
  assert.ok(index.indexOf('app.requestSingleInstanceLock()') < index.indexOf('new HerdrService('))
  assert.match(index, /isolatedHerdrDir: process\.env\.DROVER_USER_DATA \? join\(userData, 'herdr'\) : undefined/)
})

test('H2 starts serialize; guards reject external races and failed spawn; pong PID or start window gates fallback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-startup-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = { mode: 'own', running: false, events: [], calls: 0 }
  globalThis.__droverStartup = runtime
  t.after(() => delete globalThis.__droverStartup)
  const outfile = join(dir, 'startup.cjs')
  await build({ stdin: { contents: `export * from './src/main/herdr/service'; export { HerdrApiError } from './src/shared/types'`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile, alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'fake-start-only', setup(b) {
    b.onResolve({ filter: /^\.\/cli$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'cli', namespace: 'fake-start' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fake-start' }, () => ({ contents: `const { EventEmitter } = require('node:events'); const s = globalThis.__droverStartup;
      exports.herdrVersion = async () => { s.events.push('version'); if (s.mode === 'race') { s.running = true; s.events.push('external'); } return '0.9.4' };
      exports.startServer = () => { s.calls++; s.events.push('spawn'); const c = new EventEmitter(); c.pid = 999999999; c.exitCode = null; c.signalCode = null; setImmediate(() => { if (s.mode === 'failed') c.emit('error', new Error('fake spawn failure')); else { s.running = true; if (s.mode === 'exited') c.exitCode = 1; c.emit('spawn') } }); return c; };`, loader: 'js' }))
  } }] })
  const { HerdrService, HerdrApiError } = createRequire(import.meta.url)(outfile)
  for (const mode of ['race', 'failed', 'own', 'foreign', 'no-pid', 'exited', 'already']) {
    runtime.mode = mode; runtime.running = false; runtime.events = []; runtime.calls = 0
    const service = new HerdrService({ logDir: dir, autoStartServer: () => false })
    service.herdrPath = '/fake/herdr'; service.sessionDir = dir
    service.subscribeLifecycle = () => {}; service.refresh = async () => {}; service.schedulePoll = () => {}
    service.client = { socketPath: join(dir, 'herdr.sock'), request: async () => {
      runtime.events.push('ping')
      if (mode === 'already') runtime.running = true
      if (!runtime.running) throw new HerdrApiError('server_not_running', 'stopped')
      return { version: '0.9.4', ...(mode === 'no-pid' ? {} : { pid: mode === 'foreign' ? 111 : 999999999 }) }
    } }
    service.agentRestore = { prepare: async (_session, _dir, _version, guard) => { runtime.events.push('prepare'); await guard.assertStopped(); runtime.events.push('write'); await guard.assertStopped(); runtime.events.push('rename') }, restore: async () => runtime.events.push('restore') }
    const result = await Promise.all([service.startServerAndWait(), service.startServerAndWait()])
    assert.deepEqual(result, ['race', 'failed'].includes(mode) ? [false, false] : [true, true])
    assert.equal(runtime.calls, ['race', 'already'].includes(mode) ? 0 : 1)
    assert.equal(runtime.events.includes('restore'), ['own', 'no-pid'].includes(mode), mode)
    if (mode === 'race') assert.ok(!runtime.events.includes('prepare'))
    if (mode === 'own') assert.deepEqual(runtime.events.slice(runtime.events.indexOf('write') + 1, runtime.events.indexOf('rename')), ['version', 'ping'])
    service.stop()
  }
})

test('fallback rejects pong outside spawn window and known replacement PID while old child remains alive', async t => {
  const f = fixture(t)
  for (const mode of ['expired', 'replacement', 'known-own', 'no-pid']) {
    const service = new m.HerdrService({ logDir: f.dir, autoStartServer: () => false })
    service.startedHere = true
    service.startedChild = { pid: 101, exitCode: null, signalCode: null }
    service.startDeadline = Date.now() + (mode === 'expired' ? -1 : 15000)
    service.subscribeLifecycle = () => {}; service.refresh = async () => {}; service.schedulePoll = () => {}
    service.client = { request: async () => ({ version: '0.9.4', ...(mode === 'no-pid' ? {} : { pid: mode === 'replacement' ? 202 : 101 }) }) }
    let restored = 0
    service.agentRestore = { restore: async () => { restored++ } }
    await service.connect(service.connectionGeneration, false)
    assert.equal(restored, ['known-own', 'no-pid'].includes(mode) ? 1 : 0, mode)
    service.stop()
  }
  const service = readFileSync('src/main/herdr/service.ts', 'utf8')
  assert.doesNotMatch(service, /createServer|createConnection|unlink|lsof|\/proc\/net\/unix|reserveRestoreSocket|ownsServerSocket/)
  const restore = readFileSync('src/main/agentRestore.ts', 'utf8')
  assert.doesNotMatch(restore, /drover-lock|restoreProcessStart|unlinkSync|lstatSync|\blink\(/)
})

test('M queue identity removes reused kinds, names, custom launch argv and session sources before reviving', async t => {
  for (const change of ['kind', 'name', 'launch', 'source', 'marker']) {
    const f = fixture(t)
    f.panes[101].managed_agent_kind = 'codex'; f.panes[101].launch_argv = ['codex']
    writeFileSync(f.file, JSON.stringify(f.saved))
    await f.restore.prepare('isolated', f.sessionDir, '0.9.1')
    const saved = f.read(), pane = saved.workspaces[0].tabs[0].panes[101]
    if (change === 'kind') pane.managed_agent_kind = 'pi'
    if (change === 'name') pane.agent_name = 'replacement'
    if (change === 'launch') pane.launch_argv = ['pi', '--custom']
    if (change === 'source') pane.agent_resume = { agent: 'pi', source: 'custom:pi', argv: ['pi'] }
    if (change === 'marker') delete pane.drover_restore
    writeFileSync(f.file, JSON.stringify(saved))
    await f.restore.prepare('isolated', f.sessionDir, '0.9.1')
    assert.ok(!JSON.parse(readFileSync(join(f.dir, 'agent-restores.json'), 'utf8')).entries.isolated.some(e => e.paneId === 'w1:p1'), change)
    await f.restore.restore('isolated', { request: async () => ({ snapshot: { panes: [] } }) }, () => true, async () => assert.fail('stale launch'))
  }
})

test('M serialized prepared identity survives first Herdr cold-shell save but rejects later replacement metadata', async t => {
  for (const replaced of [false, true]) {
    const f = fixture(t)
    await f.restore.prepare('isolated', f.sessionDir, '0.9.1')
    const saved = f.read(), pane = saved.workspaces[0].tabs[0].panes[101]
    delete pane.drover_restore; delete pane.agent_name; delete pane.managed_agent_kind; delete pane.launch_argv
    if (replaced) { pane.managed_agent_kind = 'pi'; pane.agent_name = 'new-agent' }
    writeFileSync(f.file, JSON.stringify(saved))
    const live = { pane_id: 'w1:p1', terminal_id: 'new', cwd: f.dir, agent: null }
    let starts = 0
    await f.restore.restore('isolated', { request: async method => method === 'session.snapshot' ? { snapshot: { panes: [live] } }
      : method === 'pane.process_info' ? { process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }] } }
      : method === 'agent.get' ? { agent: { ...live, agent: 'codex' } } : {} }, () => true, async () => { starts++ })
    assert.equal(starts, replaced ? 0 : 1)
  }
})

test('M relative chained session symlink remains intact and resolved target is replaced at 0600', async t => {
  const f = fixture(t), canonical = join(f.dir, 'canonical.json'), intermediate = join(f.sessionDir, 'linked.json')
  writeFileSync(canonical, JSON.stringify(f.saved)); rmSync(f.file)
  symlinkSync('../canonical.json', intermediate); symlinkSync('linked.json', f.file)
  await f.restore.prepare('isolated', f.sessionDir, '0.9.4')
  assert.equal(lstatSync(f.file).isSymbolicLink(), true); assert.equal(lstatSync(intermediate).isSymbolicLink(), true)
  assert.ok(JSON.parse(readFileSync(canonical, 'utf8')).workspaces[0].tabs[0].panes[101].agent_resume)
  assert.equal(statSync(canonical).mode & 0o777, 0o600)
  const dangling = join(f.dir, 'dangling.json'); symlinkSync('missing.json', dangling)
  await m.writeRestoreJson(dangling, { version: 1 })
  assert.equal(lstatSync(dangling).isSymbolicLink(), true); assert.equal(JSON.parse(readFileSync(join(f.dir, 'missing.json'), 'utf8')).version, 1)
})

test('M durable write syncs temp then parent; failed queue durability cannot suppress IDs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'drover-durability-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runtime = { calls: [], fail: false }
  globalThis.__droverRestoreFs = runtime
  t.after(() => delete globalThis.__droverRestoreFs)
  const outfile = join(dir, 'durable.cjs')
  await build({ entryPoints: ['src/main/agentRestore.ts'], bundle: true, platform: 'node', format: 'cjs', outfile, alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'instrument-sync', setup(b) {
    b.onResolve({ filter: /^node:fs\/promises$/ }, args => args.namespace === 'instrument' ? { path: args.path, external: true } : { path: 'fs-promises', namespace: 'instrument' })
    b.onLoad({ filter: /.*/, namespace: 'instrument' }, () => ({ contents: `const fs = require('node:fs/promises'); const state = globalThis.__droverRestoreFs;
      module.exports = { ...fs, open: async (...args) => { const handle = await fs.open(...args); const sync = handle.sync.bind(handle); handle.sync = async () => { state.calls.push(['sync', args[0], args[1]]); if (state.fail && args[1] === 'wx') throw new Error('synthetic-sync-failure'); return sync() }; return handle }, rename: async (...args) => { state.calls.push(['rename', ...args]); return fs.rename(...args) } }`, loader: 'js' }))
  } }] })
  const durable = createRequire(import.meta.url)(outfile)
  await durable.writeRestoreJson(join(dir, 'queue.json'), { version: 1 })
  assert.deepEqual(runtime.calls.map(c => c[0]), ['sync', 'rename', 'sync'])
  assert.equal(runtime.calls[0][2], 'wx'); assert.equal(runtime.calls[2][2], 'r')
  const f = fixture(t)
  const restore = new durable.AgentRestore({ get: id => f.launches[id], record: async () => {} }, f.dir)
  runtime.fail = true
  await assert.rejects(restore.prepare('isolated', f.sessionDir, '0.9.1'), /synthetic-sync-failure/)
  assert.ok(f.read().workspaces[0].tabs[0].panes[101].agent_session)
})

test('one-shot capture merges private 0600 cache using only three read RPCs and fake session CLI', async t => {
  const f = fixture(t), socketPath = join(f.sessionDir, 'herdr.sock'), requests = []
  const agent = { pane_id: 'w1:p1', terminal_id: 'term', agent: 'codex', name: 'drover-fake', cwd: f.dir, agent_session: ref('codex') }
  const server = createServer(socket => {
    socket.on('data', buffer => {
      const req = JSON.parse(String(buffer)); requests.push(req.method)
      const result = req.method === 'agent.list' ? { agents: [agent, { ...agent, agent: 'pi', pane_id: 'w1:p2' }] }
        : req.method === 'agent.get' ? { agent } : { process_info: { shell_pid: 10, foreground_processes: [{ pid: 11, argv: ['codex', ...codexArgs, '-c', 'secret="FAKE-CAPTURE"', 'FAKE-PROMPT'] }] } }
      socket.end(JSON.stringify({ id: req.id, result }) + '\n')
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const fake = join(f.dir, 'fake-herdr')
  writeFileSync(fake, '#!/bin/sh\nif [ "$1 $2 $3" != "session list --json" ]; then exit 9; fi\ncat <<\'JSON\'\n' + JSON.stringify({ sessions: [{ name: 'isolated', socket_path: socketPath, running: true }] }) + '\nJSON\n', { mode: 0o700 })
  const file = join(f.dir, 'agent-launches.json')
  writeFileSync(file, JSON.stringify({ 'foreign:w1:p1': { kind: 'claude', terminalId: 'other', args: [...claudeArgs, 'FAKE-LEGACY-PROMPT'], bypass: false } }))
  const result = await m.captureAgentLaunches({ all: true, userData: f.dir, herdr: fake }, { PATH: '/usr/bin:/bin' })
  assert.deepEqual(result, { code: 'captured', sessions: 1, captured: 1, skipped: 1, unavailable: 1, errors: 0 })
  assert.deepEqual(requests, ['agent.list', 'pane.process_info', 'agent.get'])
  const data = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(data).length, 2); assert.ok(data['isolated:w1:p1'].restoreUnavailable)
  assert.ok(!readFileSync(file, 'utf8').includes('FAKE-')); assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(m.captureOptions(['--session', 'isolated', '--user-data', f.dir]), { all: false, session: 'isolated', userData: f.dir, herdr: undefined })
  assert.throws(() => m.captureOptions(['--all-sessions', '--session', 'isolated', '--user-data', f.dir]))
  // Execute the actual standalone entry with no Electron and no live sessions.
  const entry = join(f.dir, 'capture.mjs')
  await build({ entryPoints: ['src/main/captureAgentLaunches.ts'], bundle: true, platform: 'node', format: 'esm', outfile: entry, alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
  const invoke = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { PATH: '/usr/bin:/bin', HERDR_CONFIG_PATH: f.sessionDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
  })
  for (const selector of [['--all-sessions', '--herdr', fake], ['--session', 'default']]) {
    const cli = await invoke([...selector, '--user-data', f.dir])
    assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.stderr, '')
    assert.equal(JSON.parse(cli.stdout).captured, 1); assert.ok(!cli.stdout.includes('FAKE-')); assert.ok(!cli.stdout.includes(f.dir))
  }
  const invalid = await invoke(['--unknown', 'FAKE-ARGV'])
  assert.equal(invalid.code, 2); assert.equal(invalid.stderr, '')
  assert.deepEqual(JSON.parse(invalid.stdout), { code: 'capture_usage', errors: 1 })
})
