import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

const bundleDir = mkdtempSync(join(tmpdir(), 'drover-boss-bundle-'))
await build({ stdin: { contents: `
  export * from './src/shared/boss'
  export * from './src/main/boss/service'
  export * from './src/main/boss/store'
  export * from './src/main/boss/hq'
  export * from './src/main/boss/protocol'
  export { sendPrompt } from './src/main/actions'
  export { OfficeCollector } from './src/main/office/collector'
  export { HerdrApiError } from './src/shared/types'
  export * from './src/shared/remote'
  export * from './src/main/remote/rpc'
  export { buildModel } from './src/renderer/src/model'
  export { projectLead } from './src/renderer/src/leads'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundleDir, 'boss.cjs'),
  alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundleDir, 'boss.cjs'))
rmSync(bundleDir, { recursive: true, force: true })

function snapshot() {
  const snap = { version: 'test', protocol: 1, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] }
  const add = (workspace, number, cwd, names) => {
    snap.workspaces.push({ workspace_id: workspace, label: workspace, number })
    const tab = `${workspace}:t1`
    snap.tabs.push({ workspace_id: workspace, tab_id: tab, number: 1, label: '1' })
    const layout = { workspace_id: workspace, tab_id: tab, panes: [] }
    names.forEach((name, i) => {
      const pane = { workspace_id: workspace, tab_id: tab, pane_id: `${workspace}:p${i + 1}`, terminal_id: `terminal:${workspace}:${i}`,
        cwd, foreground_cwd: '/ignored/foreground', agent_status: 'idle', agent: name ? 'codex' : null }
      snap.panes.push(pane)
      if (name) snap.agents.push({ ...pane, name, agent_session: { source: 'test', agent: 'codex', kind: 'native', value: `session:${pane.pane_id}` }, interactive_ready: true })
      layout.panes.push({ pane_id: pane.pane_id, rect: { x: i * 10, y: 0 } })
    })
    snap.layouts.push(layout)
  }
  add('w2', 2, '/project/a', ['chosen', 'orchestrator'])
  add('w1', 1, '/project/a', [null, 'worker'])
  add('w3', 3, '/project/b', ['тимлид', 'frontend'])
  add('w4', 4, '/project/c', [null])
  return snap
}

test('project roster groups workspaces, ignores shells/foreground cwd, and uses sidebar workspace/tab/layout order', () => {
  const snap = snapshot()
  snap.panes.reverse(); snap.agents.reverse(); snap.tabs.reverse()
  const roster = m.projectLeadRoster(snap, {})
  assert.deepEqual(roster.map(p => p.key), ['/project/a', '/project/b', '/project/c'])
  assert.deepEqual(roster[0].workspaceIds, ['w1', 'w2'])
  assert.equal(roster[0].lead.name, 'orchestrator')
  assert.equal(roster[1].lead.name, 'тимлид')
  assert.equal(roster[2].lead, null)
  const manual = m.projectLeadRoster(snap, { '/project/a': 'chosen' })
  assert.equal(manual[0].lead.name, 'chosen')
  assert.equal(m.projectLeadRoster(snap, { '/project/a': 'gone' })[0].lead.name, 'orchestrator')
  snap.agents.find(a => a.name === 'orchestrator').name = 'other'
  assert.equal(m.projectLeadRoster(snap, {})[0].lead.name, 'worker')
  assert.deepEqual(m.projectLeadRoster(null, {}), [])
})

test('all lead name rules, explicit choice, fallback and project exclusions share the renderer selector', () => {
  for (const name of ['orchestrator', 'team-lead', 'boss', 'manager', 'coordinator', 'оркестр', 'тимлид']) {
    assert.equal(m.isLeadName(name), true, name)
    assert.equal(m.selectProjectLead(['first', name], undefined, a => a), name)
  }
  assert.equal(m.selectProjectLead(['first', 'boss', 'chosen'], 'chosen', a => a), 'chosen')
  assert.equal(m.selectProjectLead([], undefined, a => a), null)
  const snap = snapshot(), choices = { '/project/a': 'chosen' }
  for (const group of m.buildModel(snap).groups) {
    const shared = m.projectLeadRoster({ ...snap, workspaces: [group.workspace] }, choices)[0]
    assert.equal(shared.lead?.paneId ?? null, m.projectLead(group, choices)?.paneId ?? null)
  }
  const roster = m.projectLeadRoster(snap, choices, ['/project/a', '/gone'])
  assert.equal(roster[0].enabled, false); assert.equal(roster[0].lead.name, 'chosen')
  assert.equal(roster[1].enabled, true)
  snap.panes.filter(p => p.workspace_id === 'w4').forEach(p => { p.cwd = null })
  assert.equal(m.projectLeadRoster(snap, {})[2].key, 'workspace:w4')
  assert.equal(m.projectLeadRoster(snap, {}, [], '/project/a').length, 2)
})

async function fixture(t, runtime = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drover-boss-case-'))
  const calls = [], events = [], accepted = [], choices = {}
  const svc = { sessionName: 'synthetic', snapshot: snapshot(), async request(method, params) {
    calls.push([method, params])
    if (method === 'agent.get') return { agent: structuredClone(this.snapshot.agents.find(a => a.pane_id === params.target)) }
    if (method === 'agent.prompt') return { type: 'agent_prompted', agent: structuredClone(this.snapshot.agents.find(a => a.pane_id === params.target)) }
    if (method === 'workspace.create') {
      const workspace = { workspace_id: 'hq', label: params.label, number: 5 }
      const tab = { workspace_id: 'hq', tab_id: 'hq:t1', number: 1, label: '1' }
      const pane = { pane_id: 'hq:p1', workspace_id: 'hq', tab_id: tab.tab_id, terminal_id: 'hq-terminal', cwd: params.cwd, agent: null, agent_status: 'idle' }
      this.snapshot.workspaces.push(workspace); this.snapshot.tabs.push(tab); this.snapshot.panes.push(pane)
      return { workspace, tab, root_pane: pane }
    }
    if (method === 'agent.start') {
      const pane = this.snapshot.panes.find(p => p.pane_id === params.pane_id)
      Object.assign(pane, { agent: params.kind })
      this.snapshot.agents.push({ ...pane, name: params.name, agent_session: { source: 'test', agent: params.kind, kind: 'native', value: 'hq-session' }, interactive_ready: true })
      return {}
    }
    return {}
  } }
  const store = m.BossSettingsStore.at(root, root)
  const boss = new m.BossService(svc, store, () => choices, d => events.push(d), (...args) => accepted.push(args),
    { instructions: 'TEST HQ INSTRUCTIONS', version: '0.7.1', executable: process.execPath, kindInstalled: () => true, ...runtime })
  t.after(async () => { boss.dispose(); await boss.refresh(); rmSync(root, { recursive: true, force: true }) })
  await boss.settings()
  const setStatus = (name, status, extra = {}) => {
    const agent = svc.snapshot.agents.find(a => a.name === name)
    Object.assign(agent, { agent_status: status }, extra)
    Object.assign(svc.snapshot.panes.find(p => p.pane_id === agent.pane_id), { agent_status: status })
  }
  return { boss, svc, calls, events, accepted, choices, root, setStatus }
}

test('private settings and roster are atomic 0600, refreshed on live changes and reloaded', async t => {
  const f = await fixture(t)
  let roster = await f.boss.roster()
  const file = join(roster.hqFolder, 'roster.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  f.choices['/project/a'] = 'chosen'
  f.boss.onChange(); await f.boss.refresh()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].lead.name, 'chosen')
  f.setStatus('chosen', 'blocked'); await f.boss.refresh()
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].lead.status, 'blocked')
  await f.boss.setSettings({ excludedProjects: ['/project/a'] })
  const reloaded = m.BossSettingsStore.at(f.root, f.root); await reloaded.load()
  assert.deepEqual(reloaded.get().excludedProjects, ['/project/a'])
  assert.equal((await stat(join(f.root, 'boss-settings.json'))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(roster.hqFolder), ['.drover', 'AGENTS.md', 'bin', 'roster.json'])
  await assert.rejects(f.boss.setSettings({ hqFolder: 'relative' }))
  await assert.rejects(f.boss.setSettings({ excludedProjects: [5] }))
})

test('broadcast reports each project, skips excluded/blocked/no lead, and uses only agent.prompt receipts', async t => {
  const f = await fixture(t)
  f.setStatus('orchestrator', 'blocked')
  const res = await f.boss.broadcast({ text: 'PRIVATE_ASSIGNMENT' })
  assert.deepEqual(res.map(d => d.status), ['blocked', 'delivered', 'no_lead'])
  assert.deepEqual(f.calls.filter(c => c[0] === 'agent.prompt').map(c => c[1].target), ['w3:p1'])
  assert.deepEqual(f.accepted, [['w3:p1', 'PRIVATE_ASSIGNMENT']])
  await f.boss.setSettings({ excludedProjects: ['/project/b'] })
  assert.deepEqual((await f.boss.broadcast({ text: 'second' })).map(d => d.projectKey), ['/project/a', '/project/c'])
  assert.equal((await f.boss.broadcast({ text: 'second', projectKeys: ['/project/b', '/project/b'] }))[0].status, 'excluded')
  await assert.rejects(f.boss.broadcast({ text: 'x', projectKeys: ['/unknown'] }))
  await assert.rejects(f.boss.broadcast({ text: '  ' }))
})

test('working and startup agents queue; only the same ready agent receives FIFO assignments, with delivery events', async t => {
  const f = await fixture(t)
  f.setStatus('orchestrator', 'working')
  f.setStatus('тимлид', 'idle', { interactive_ready: false, launch_pending: true })
  const deliveries = await f.boss.broadcast({ text: 'queued' })
  assert.deepEqual(deliveries.map(d => d.status), ['queued', 'queued', 'no_lead'])
  assert.equal(f.calls.some(c => c[0] === 'agent.prompt'), false)
  f.setStatus('orchestrator', 'idle')
  f.setStatus('тимлид', 'done', { interactive_ready: true, launch_pending: false })
  f.boss.onChange()
  for (let i = 0; i < 100 && f.events.length < 2; i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(f.events.map(d => d.id), deliveries.slice(0, 2).map(d => d.id))
  assert.ok(f.events.every(d => d.status === 'delivered'))
  assert.equal(f.accepted.length, 2)
})

test('queued requests cancel on blocked, changed lead, exclusion, agent replacement or session switch', async t => {
  for (const change of ['blocked', 'lead', 'excluded', 'replacement', 'session']) {
    const f = await fixture(t)
    f.setStatus('orchestrator', 'working')
    const [delivery] = await f.boss.broadcast({ text: 'queued', projectKeys: ['/project/a'] })
    assert.equal(delivery.status, 'queued')
    if (change === 'blocked') f.setStatus('orchestrator', 'blocked')
    if (change === 'lead') f.choices['/project/a'] = 'chosen'
    if (change === 'excluded') await f.boss.setSettings({ excludedProjects: ['/project/a'] })
    if (change === 'replacement') f.svc.snapshot.agents.find(a => a.name === 'orchestrator').terminal_id = 'replacement'
    if (change === 'session') f.svc.sessionName = 'other'
    f.boss.onChange()
    for (let i = 0; i < 100 && !f.events.length; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(f.events.length, 1, change)
    assert.equal(f.events[0].status, change === 'blocked' ? 'blocked' : change === 'excluded' ? 'excluded' : 'error', change)
    assert.equal(f.calls.some(c => c[0] === 'agent.prompt'), false, change)
  }
})

test('fresh probe prevents blocked/stale sends, and a disappearing agent never falls back to raw terminal input', async t => {
  for (const code of ['agent_blocked', 'agent_not_found', 'failure']) {
    const f = await fixture(t), original = f.svc.request.bind(f.svc)
    f.svc.request = async (method, params) => { if (method === 'agent.prompt') throw new m.HerdrApiError(code, 'failed'); return original(method, params) }
    const [delivery] = await f.boss.broadcast({ text: 'private', projectKeys: ['/project/a'] })
    assert.equal(delivery.status, code === 'agent_blocked' ? 'blocked' : 'error')
    assert.equal(f.accepted.length, 0)
    assert.equal(f.calls.some(c => c[0].startsWith('pane.send')), false)
  }
  const f = await fixture(t)
  f.svc.request = async method => {
    assert.equal(method, 'agent.get')
    return { agent: { ...f.svc.snapshot.agents.find(a => a.name === 'orchestrator'), agent_status: 'blocked' } }
  }
  assert.equal((await f.boss.broadcast({ text: 'x', projectKeys: ['/project/a'] }))[0].status, 'blocked')
})

test('revalidates session and exclusions after a slow readiness probe', async t => {
  for (const change of ['session', 'excluded']) {
    const f = await fixture(t), original = f.svc.request.bind(f.svc)
    f.svc.request = async (method, params) => {
      const result = await original(method, params)
      if (method === 'agent.get') {
        if (change === 'session') f.svc.sessionName = 'other'
        else await f.boss.setSettings({ excludedProjects: ['/project/a'] })
      }
      return result
    }
    const [delivery] = await f.boss.broadcast({ text: 'private', projectKeys: ['/project/a'] })
    assert.equal(delivery.status, change === 'excluded' ? 'excluded' : 'error')
    assert.equal(f.calls.some(c => c[0] === 'agent.prompt'), false)
  }
})

test('opening HQ creates board/roster before role prompt, and reopens without duplicate agents or role prompts', async t => {
  const f = await fixture(t), original = f.svc.request.bind(f.svc)
  f.svc.request = async (method, params) => {
    if (method === 'agent.start') {
      const settings = await f.boss.settings()
      assert.ok(JSON.parse(await readFile(join(settings.hqFolder, 'roster.json'), 'utf8')).projects.length)
      assert.deepEqual(JSON.parse(await readFile(join(settings.hqFolder, '.drover/tasks.json'), 'utf8')).tasks, [])
    }
    return original(method, params)
  }
  const req = { kind: 'codex', prompt: 'ROLE_ONLY_NO_ASSIGNMENT' }
  const [opened, parallel] = await Promise.all([f.boss.open(req), f.boss.open(req)])
  assert.equal(opened.ok, true); assert.equal(parallel.paneId, opened.paneId)
  assert.equal(f.calls.filter(c => c[0] === 'workspace.create').length, 1)
  assert.equal(f.calls.filter(c => c[0] === 'agent.start').length, 1)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, 1)
  assert.equal(f.calls.find(c => c[0] === 'agent.prompt')[1].text, req.prompt)
  assert.equal(f.boss.isBoss(opened.paneId), true)
  assert.equal((await f.boss.open(req)).existing, true)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, 1)
  assert.equal((await f.boss.roster()).projects.length, 3)
  await assert.rejects(f.boss.open({ kind: 'not-a-supported-agent', prompt: 'x' }))
})

test('phone sees HQ and sends ordinary chat to the boss, while boss management IPC stays local-only', async t => {
  const f = await fixture(t)
  const hq = await f.boss.open({ kind: 'claude', prompt: 'role' })
  f.svc.snapshot.focused_workspace_id = hq.workspaceId
  f.svc.snapshot.focused_pane_id = hq.paneId
  const handlers = new m.RpcHandlers(), connection = new m.RemoteRpcConnection('test')
  handlers.register('app:init', () => ({ snapshot: f.svc.snapshot }))
  handlers.register('agent:send', (_ctx, req) => m.sendPrompt(f.svc, req))
  const init = await m.dispatchRemoteRpc(handlers, connection, { t: 'call', id: '1', method: 'init', args: [] })
  assert.equal(init.value.snapshot.workspaces.some(w => w.workspace_id === hq.workspaceId), true)
  assert.equal(init.value.snapshot.agents.some(a => a.name === 'drover-boss'), true)
  const sent = await m.dispatchRemoteRpc(handlers, connection, { t: 'call', id: '2', method: 'sendPrompt', args: [{ paneId: hq.paneId, target: hq.paneId, agentKind: 'claude', text: 'Hello boss from the phone', imagePaths: [], isShell: false }] })
  assert.equal(sent.value.ok, true)
  assert.equal(f.calls.at(-1)[0], 'agent.prompt'); assert.equal(f.calls.at(-1)[1].target, hq.paneId)
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.doesNotMatch(main, /boss\.remoteSnapshot|boss\.remoteArgsBlocked/)
  for (const method of ['bossRoster', 'bossSettings', 'setBossSettings', 'openBoss', 'broadcastBoss']) {
    assert.ok(m.REMOTE_LOCAL_ONLY_METHODS.includes(method))
    const result = await m.dispatchRemoteRpc(handlers, connection, { t: 'call', id: '1', method, args: [] })
    assert.equal(result.error.code, 'not_available_remotely')
  }
})

test('every known installed kind can be a boss with native launch args; unknown/uninstalled kinds and malformed args cannot start', async t => {
  const f = await fixture(t)
  const args = ['--model', 'chosen-model', '--effort', 'high']
  const opened = await f.boss.open({ kind: 'gemini', prompt: 'Read AGENTS.md and wait', args })
  assert.equal(opened.ok, true)
  assert.deepEqual(f.calls.find(c => c[0] === 'agent.start')[1].args, args)
  assert.equal(f.calls.find(c => c[0] === 'agent.start')[1].kind, 'gemini')
  assert.ok((await readFile(join(opened.folder, 'GEMINI.md'), 'utf8')).includes('TEST HQ INSTRUCTIONS'))
  assert.equal((await f.boss.roster()).boss.name, 'drover-boss')
  await assert.rejects(f.boss.open({ kind: 'codex', prompt: 'x', args: [5] }))
  const missing = await fixture(t, { kindInstalled: () => false })
  await assert.rejects(missing.boss.open({ kind: 'codex', prompt: 'x' }), /not installed/)
  assert.equal(missing.calls.length, 0)
})

test('HQ updates its versioned block while preserving user content outside and edits inside the block', () => {
  const original = 'USER RULE BEFORE\n\n'
  const first = m.mergeHqInstructions(original, 'OLD INSTRUCTIONS', '0.7.1') + '\nUSER RULE AFTER\n'
  const next = m.mergeHqInstructions(first, 'NEW INSTRUCTIONS', '0.7.2')
  assert.ok(next.startsWith(original)); assert.ok(next.includes('USER RULE AFTER'))
  assert.ok(next.includes('NEW INSTRUCTIONS')); assert.ok(!next.includes('OLD INSTRUCTIONS'))
  const edited = first.replace('OLD INSTRUCTIONS', 'USER CUSTOM INSTRUCTIONS')
  const retained = m.mergeHqInstructions(edited, 'NEW INSTRUCTIONS', '0.7.2')
  assert.ok(retained.includes('USER CUSTOM INSTRUCTIONS')); assert.ok(retained.includes('NEW INSTRUCTIONS'))
  assert.equal(m.mergeHqInstructions(retained, 'NEW INSTRUCTIONS', '0.7.2'), retained)
})

async function helper(f, args, env = {}) {
  const settings = await f.boss.settings()
  const { stdout } = await execute(join(settings.hqFolder, 'bin', 'boss'), args, { env: { ...process.env, HERDR_PANE_ID: 'hq:p1', HERDR_SESSION: 'synthetic', ...env }, timeout: 5000 })
  return JSON.parse(stdout)
}

test('boss helper uses live registry, emits primary absolute reply protocol, records expectations without text and resumes IDs without resending', async t => {
  // Production uses Electron's embedded Node rather than requiring Node in PATH.
  const f = await fixture(t, { executable: createRequire(import.meta.url)('electron') })
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const before = f.calls.filter(c => c[0] === 'agent.prompt').length
  const sent = await helper(f, ['send', 'a', 'PRIVATE_BOSS_TASK', '--id', 'request-1'])
  assert.equal(sent.id, 'request-1'); assert.equal(sent.projects[0].status, 'delivered'); assert.equal(sent.projects[0].awaitingReply, true)
  const prompt = f.calls.filter(c => c[0] === 'agent.prompt').at(-1)[1].text
  assert.ok(prompt.startsWith('[Поручение от Главного босса · request-1]'))
  assert.ok(prompt.includes(join((await f.boss.settings()).hqFolder, 'bin', 'boss')))
  assert.ok(prompt.indexOf(' reply ') < prompt.indexOf('herdr agent prompt'))
  assert.equal(f.accepted.at(-1)[2], 'hq:p1')
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, before + 1)
  assert.equal((await helper(f, ['send', 'a', 'PRIVATE_BOSS_TASK', '--id', 'request-1'])).id, sent.id)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, before + 1)
  await assert.rejects(helper(f, ['send', 'a', 'DIFFERENT_TEXT', '--id', 'request-1']))
  const folder = (await f.boss.settings()).hqFolder
  const ledgerFile = join(folder, '.drover', 'boss-requests.json')
  assert.ok(!(await readFile(ledgerFile, 'utf8')).includes('PRIVATE_BOSS_TASK'))
  assert.equal((await stat(ledgerFile)).mode & 0o777, 0o600)
  assert.equal((await stat(join(folder, 'bin', 'boss'))).mode & 0o777, 0o700)
  assert.equal((await helper(f, ['roster'])).boss.paneId, 'hq:p1')
})

test('helper queues busy leads and excludes disabled projects; fresh probes prevent blocked delivery', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  f.setStatus('orchestrator', 'working'); f.setStatus('тимлид', 'blocked')
  const sent = await helper(f, ['send', 'all', 'work'])
  assert.deepEqual(sent.projects.map(p => p.status), ['queued', 'blocked', 'no_lead'])
  await f.boss.setSettings({ excludedProjects: ['/project/b'] })
  assert.equal((await helper(f, ['send', '/project/b', 'work'])).projects[0].status, 'excluded')
})

async function fakeHerdr(f) {
  const file = join(f.root, 'fake-herdr')
  const agentsFile = join(f.root, 'fake-agents.json'), callsFile = join(f.root, 'fake-cli-calls.jsonl')
  await writeFile(file, `#!${process.execPath}\nconst fs=require('node:fs');const argv=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(argv)+'\\n');const agents=JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)},'utf8'));const agent=agents.find(a=>a.pane_id===argv[4]);if(!agent)process.exit(1);console.log(JSON.stringify({id:argv[3]==='prompt'?'cli:agent:prompt':'cli:agent:get',result:{type:argv[3]==='prompt'?'agent_prompted':'agent',agent}}))\n`, { mode: 0o700 })
  f.svc.herdrPath = file
  return { agentsFile, callsFile, async update() { await writeFile(agentsFile, JSON.stringify(f.svc.snapshot.agents)) } }
}

test('absolute offline reply delivers from another cwd but next launch only reports it unconfirmed without closing the wait', async t => {
  const replies = [], f = await fixture(t)
  f.svc.snapshot.agents.find(a => a.name === 'orchestrator').agent = 'opencode'
  f.svc.snapshot.panes.find(p => p.pane_id === 'w2:p2').agent = 'opencode'
  const fake = await fakeHerdr(f)
  await f.boss.open({ kind: 'gemini', prompt: 'role' })
  await fake.update()
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'offline-1'])
  const folder = (await f.boss.settings()).hqFolder
  f.boss.dispose()
  const { stdout } = await execute(join(folder, 'bin', 'boss'), ['reply', '/project/a', 'offline-1', 'PRIVATE_REPLY'], {
    cwd: '/tmp', env: { ...process.env, HERDR_PANE_ID: sent.projects[0].lead.paneId, HERDR_SESSION: 'synthetic' }, timeout: 5000 })
  assert.equal(JSON.parse(stdout).status, 'delivered'); assert.equal(JSON.parse(stdout).confirmed, false)
  const directory = join(folder, '.drover', 'boss-receipts'), files = await readdir(directory)
  assert.equal(files.length, 1)
  assert.ok(!(await readFile(join(directory, files[0]), 'utf8')).includes('PRIVATE_REPLY'))
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600)
  const boss = new m.BossService(f.svc, m.BossSettingsStore.at(f.root, f.root), () => f.choices, () => {}, () => {},
    { instructions: 'UPDATED TEMPLATE', version: '0.7.2', executable: process.execPath, replyAccepted: (...args) => replies.push(args) })
  t.after(() => boss.dispose())
  await boss.roster()
  const ledger = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
  assert.equal(ledger.requests[0].projects[0].awaitingReply, true)
  assert.ok(ledger.requests[0].projects[0].replyUnconfirmed)
  assert.equal(replies.length, 0)
  assert.deepEqual(await readdir(directory), [])
  assert.ok((await readFile(fake.callsFile, 'utf8')).includes('[Ответ /project/a · offline-1] PRIVATE_REPLY'))
})

test('open Drover picks up an any-kind reply immediately and emits only confirmed lead-to-boss office metadata', async t => {
  let office
  const updates = [], f = await fixture(t, { replyAccepted: (from, to, id, ts) => office.agentPrompt(office.endpoint(from), office.endpoint(to), undefined, id, ts) })
  const fake = await fakeHerdr(f)
  f.svc.snapshot.agents.find(a => a.name === 'orchestrator').agent = 'opencode'
  f.svc.snapshot.panes.find(p => p.pane_id === 'w2:p2').agent = 'opencode'
  await f.boss.open({ kind: 'gemini', prompt: 'role' }); await fake.update()
  office = new m.OfficeCollector({ session: () => 'synthetic', snapshot: () => f.svc.snapshot,
    settings: () => ({ roles: [], projectLeads: {} }), isBoss: pane => f.boss.isBoss(pane),
    subscribe: async paneId => ({ paneId, reset: true, items: [], meta: null }), unsubscribe: () => {},
    watchBoard: async cwd => ({ cwd, exists: true, tasks: [] }), unwatchBoard: () => {} }, u => updates.push(u))
  t.after(() => office.dispose()); office.init()
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'live-reply'])
  await helper(f, ['reply', '/project/a', sent.id, 'PRIVATE_RESULT'], { HERDR_PANE_ID: 'w2:p2', HERDR_SESSION: 'synthetic' })
  await f.boss.roster()
  office.flush()
  const event = office.getState().recentEvents.find(e => e.kind === 'prompt')
  assert.ok(event); assert.equal(event.from, office.endpoint('w2:p2')); assert.equal(event.to, office.endpoint('hq:p1'))
  assert.ok(!JSON.stringify(updates).includes('PRIVATE_RESULT'))
  const ledger = JSON.parse(await readFile(join((await f.boss.settings()).hqFolder, '.drover', 'boss-requests.json'), 'utf8'))
  assert.equal(ledger.requests[0].projects[0].awaitingReply, false)
})

test('handwritten purported CLI/main receipts A/B/A cannot confirm replies or emit office events', async t => {
  const replies = [], f = await fixture(t, { replyAccepted: (...args) => replies.push(args) })
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'receipt-check'])
  const folder = (await f.boss.settings()).hqFolder, directory = join(folder, '.drover', 'boss-receipts')
  const metadata = { version: 1, type: 'boss_reply', confirmation: 'main', ts: Date.now(), assignmentId: sent.id, projectKey: '/project/a', session: 'synthetic',
    fromPaneId: 'w2:p2', fromName: 'orchestrator', toPaneId: 'hq:p1', fromTerminalId: 'terminal:w2:1', toTerminalId: 'hq-terminal',
    fromSessionId: 'session:w2:p2', toSessionId: 'hq-session',
    receipt: { id: 'cli:agent:prompt', result: { type: 'agent_prompted', agent: { pane_id: 'hq:p1', name: 'drover-boss' } } } }
  const prompts = f.calls.filter(c => c[0] === 'agent.prompt').length
  for (const id of ['forged-A', 'forged-B', 'forged-A']) {
    await m.writeBossJson(join(directory, '111.json'), { ...metadata, id })
    await f.boss.roster()
    const ledger = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
    assert.equal(ledger.requests[0].projects[0].awaitingReply, true)
    assert.equal(ledger.requests[0].projects[0].repliedAt, undefined)
    assert.equal(ledger.requests[0].projects[0].replyUnconfirmed.receiptId, id)
    assert.deepEqual(ledger.acceptedReceiptIds, [])
  }
  assert.equal(replies.length, 0)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, prompts)
})

test('all accepted receipt IDs deduplicate A/B/A and survive restart; files never re-emit acceptance', async t => {
  const replies = [], f = await fixture(t, { replyAccepted: (...args) => replies.push(args) })
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'dedup'])
  const receipts = []
  for (const text of ['progress', 'complete']) {
    const result = await helper(f, ['reply', '/project/a', sent.id, text], { HERDR_PANE_ID: 'w2:p2' })
    assert.equal(result.confirmed, true)
    receipts.push(result.receiptId)
  }
  assert.equal(replies.length, 2)
  const folder = (await f.boss.settings()).hqFolder
  const ledgerFile = join(folder, '.drover', 'boss-requests.json')
  assert.deepEqual(JSON.parse(await readFile(ledgerFile, 'utf8')).acceptedReceiptIds, receipts)
  for (const id of [receipts[0], receipts[1], receipts[0]]) {
    await m.writeBossJson(join(folder, '.drover', 'boss-receipts', '111.json'), { id })
    await f.boss.roster()
  }
  assert.equal(replies.length, 2)
  f.boss.dispose()
  const restarted = new m.BossService(f.svc, m.BossSettingsStore.at(f.root, f.root), () => f.choices, () => {}, () => {},
    { executable: process.execPath, replyAccepted: (...args) => replies.push(args) })
  t.after(() => restarted.dispose())
  await m.writeBossJson(join(folder, '.drover', 'boss-receipts', '222.json'), { id: receipts[0] })
  await restarted.roster()
  assert.equal(replies.length, 2)
  assert.deepEqual(JSON.parse(await readFile(ledgerFile, 'utf8')).acceptedReceiptIds, receipts)
})

test('ordinary leads cannot send as boss, even with the shared socket token; changed live boss incarnation is refused', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const prompts = f.calls.filter(c => c[0] === 'agent.prompt').length
  await assert.rejects(helper(f, ['send', '/project/a', 'spoofed'], { HERDR_PANE_ID: 'w2:p2' }), /Unauthorized HQ sender/)
  await assert.rejects(helper(f, ['send', '/project/a', 'spoofed'], { HERDR_PANE_ID: '', HERDR_SESSION: 'synthetic' }), /Unauthorized HQ sender/)
  await assert.rejects(helper(f, ['send', '/project/a', 'spoofed'], { HERDR_SESSION: 'different' }), /Unauthorized HQ sender/)
  const original = f.svc.request.bind(f.svc)
  f.svc.request = async (method, params) => {
    const result = await original(method, params)
    if (method === 'agent.get' && params.target === 'hq:p1') result.agent.agent_session.value = 'replaced'
    return result
  }
  await assert.rejects(helper(f, ['send', '/project/a', 'spoofed']), /incarnation has changed/)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, prompts)
})

test('reply rejects unassigned/stale incarnations and blocked boss; fallback reports remain unconfirmed', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'reply-1'])
  const prompts = f.calls.filter(c => c[0] === 'agent.prompt').length
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'private'], { HERDR_PANE_ID: 'w3:p1' }), /Unauthorized HQ sender/)
  const lead = f.svc.snapshot.agents.find(a => a.name === 'orchestrator')
  const originalSession = lead.agent_session.value
  lead.agent_session.value = 'replacement'
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'private'], { HERDR_PANE_ID: 'w2:p2' }), /incarnation has changed/)
  lead.agent_session.value = originalSession
  const bossAgent = f.svc.snapshot.agents.find(a => a.name === 'drover-boss')
  bossAgent.terminal_id = 'replacement-terminal'
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'private'], { HERDR_PANE_ID: 'w2:p2' }), /incarnation has changed/)
  bossAgent.terminal_id = 'hq-terminal'
  f.setStatus('drover-boss', 'blocked')
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'private'], { HERDR_PANE_ID: 'w2:p2' }), /blocked or not ready/)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, prompts)
  f.boss.observeConfirmedReply('w3:p1', 'hq:p1', '[Ответ /project/a · reply-1] wrong sender')
  f.boss.observeConfirmedReply('w2:p2', 'w3:p1', '[Ответ /project/a · reply-1] wrong target')
  const file = join((await f.boss.settings()).hqFolder, '.drover', 'boss-requests.json')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).requests[0].projects[0].replyUnconfirmed, undefined)
  f.boss.observeConfirmedReply('w2:p2', 'hq:p1', '[Ответ /project/a · reply-1] result')
  await new Promise(r => setTimeout(r, 20))
  const project = JSON.parse(await readFile(file, 'utf8')).requests[0].projects[0]
  assert.equal(project.awaitingReply, true)
  assert.ok(project.replyUnconfirmed)
})

test('online delivery errors cannot confirm replies and never fall back to an offline CLI send', async t => {
  const replies = [], f = await fixture(t, { replyAccepted: (...args) => replies.push(args) }), fake = await fakeHerdr(f)
  await f.boss.open({ kind: 'codex', prompt: 'role' }); await fake.update()
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'failed-reply'])
  const original = f.svc.request.bind(f.svc)
  f.svc.request = async (method, params) => { if (method === 'agent.prompt') throw new m.HerdrApiError('agent_blocked', 'blocked'); return original(method, params) }
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'PRIVATE'], { HERDR_PANE_ID: 'w2:p2' }), /blocked/)
  assert.equal(replies.length, 0)
  await assert.rejects(readFile(fake.callsFile, 'utf8'), { code: 'ENOENT' })
  const folder = (await f.boss.settings()).hqFolder
  const ledger = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
  assert.equal(ledger.requests[0].projects[0].awaitingReply, true)
  assert.deepEqual(ledger.acceptedReceiptIds, [])
})

test('more than 1000 rejected/completed requests rotate while active waits and archived ID idempotency survive', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const active = await helper(f, ['send', '/project/a', 'active task', '--id', 'active'])
  f.setStatus('тимлид', 'blocked')
  const folder = (await f.boss.settings()).hqFolder
  const send = (id, project = '/project/b', text = 'skipped') => f.boss.helperRequest({ method: 'send', project, text, id, paneId: 'hq:p1', session: 'synthetic' })
  for (let i = 0; i < 1005; i++) {
    const result = await send(`blocked-${i}`)
    assert.equal(result.projects[0].status, 'blocked')
  }
  const ledger = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
  assert.ok(ledger.requests.length <= 101)
  assert.equal(ledger.requests.find(r => r.id === active.id).projects[0].awaitingReply, true)
  assert.ok((await readdir(join(folder, '.drover', 'boss-archive'))).length >= 905)
  const before = f.calls.filter(c => c[0] === 'agent.prompt').length
  assert.equal((await send('blocked-0')).id, 'blocked-0')
  await assert.rejects(send('blocked-0', '/project/b', 'different'), /different request/)
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, before)
  const reply = await helper(f, ['reply', '/project/a', active.id, 'done'], { HERDR_PANE_ID: 'w2:p2' })
  assert.equal(reply.confirmed, true)
  assert.equal((await send('new-active', '/project/a', 'new task')).projects[0].awaitingReply, true)
})

test('1000 active waits limit only active sends; rejected attempts and expired waits do not exhaust HQ', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const first = await helper(f, ['send', '/project/a', 'pending', '--id', 'pending-0'])
  const folder = (await f.boss.settings()).hqFolder
  const requests = f.boss.assignments.get(folder)
  for (let i = 1; i < 1000; i++) requests.push({ ...structuredClone(first), id: `pending-${i}` })
  const send = (id, project) => f.boss.helperRequest({ method: 'send', project, text: 'task', id, paneId: 'hq:p1', session: 'synthetic' })
  await assert.rejects(send('excess-active', '/project/a'), /1000 active assignments/)
  f.setStatus('тимлид', 'blocked')
  assert.equal((await send('blocked-at-cap', '/project/b')).projects[0].status, 'blocked')
  requests.find(r => r.id === 'pending-1').createdAt = Date.now() - 31 * 24 * 60 * 60_000
  assert.equal((await send('replacement-active', '/project/a')).projects[0].awaitingReply, true)
  assert.equal(requests.some(r => r.id === 'pending-1'), false)
  const archive = await f.boss.archivedAssignment(folder, 'pending-1')
  assert.equal(archive.projects[0].code, 'reply_expired')
  assert.equal(archive.projects[0].awaitingReply, false)
})

test('bounded recent receipt index archives old IDs instead of permanently blocking new replies', async t => {
  const replies = [], f = await fixture(t, { replyAccepted: (...args) => replies.push(args) })
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'receipt-rotation'])
  const folder = (await f.boss.settings()).hqFolder
  const accepted = f.boss.acceptedReceipts.get(folder)
  for (let i = 0; i < 10000; i++) accepted.add(`old-receipt-${i}`)
  const result = await helper(f, ['reply', '/project/a', sent.id, 'done'], { HERDR_PANE_ID: 'w2:p2' })
  assert.equal(result.confirmed, true)
  assert.equal(accepted.size, 10000)
  assert.equal(accepted.has('old-receipt-0'), false)
  assert.equal(await f.boss.receiptAccepted(folder, 'old-receipt-0'), true)
  await m.writeBossJson(join(folder, '.drover', 'boss-receipts', '111.json'), { id: 'old-receipt-0' })
  await f.boss.roster()
  assert.equal(replies.length, 1)
  assert.equal((await stat(f.boss.receiptArchivePath(folder, 'old-receipt-0'))).mode & 0o777, 0o600)
})

test('a changed boss in the actual prompt acknowledgement cannot close an expectation', async t => {
  const replies = [], f = await fixture(t, { replyAccepted: (...args) => replies.push(args) })
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'ack-incarnation'])
  const original = f.svc.request.bind(f.svc)
  f.svc.request = async (method, params) => {
    const result = await original(method, params)
    if (method === 'agent.prompt') result.agent.agent_session.value = 'replaced-after-probe'
    return result
  }
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'done'], { HERDR_PANE_ID: 'w2:p2' }), /did not confirm reply delivery/)
  const folder = (await f.boss.settings()).hqFolder
  const ledger = JSON.parse(await readFile(join(folder, '.drover', 'boss-requests.json'), 'utf8'))
  assert.equal(ledger.requests[0].projects[0].awaitingReply, true)
  assert.deepEqual(ledger.acceptedReceiptIds, [])
  assert.equal(replies.length, 0)
})

test('offline helper refuses a replaced lead incarnation and cannot create even an unconfirmed delivery', async t => {
  const f = await fixture(t), fake = await fakeHerdr(f)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  const sent = await helper(f, ['send', '/project/a', 'task', '--id', 'offline-stale'])
  f.svc.snapshot.agents.find(a => a.name === 'orchestrator').agent_session.value = 'replacement'
  await fake.update()
  f.boss.dispose()
  await assert.rejects(helper(f, ['reply', '/project/a', sent.id, 'private'], { HERDR_PANE_ID: 'w2:p2' }), /assigned lead has changed/)
  assert.ok(!(await readFile(fake.callsFile, 'utf8')).includes('"prompt"'))
})

test('queued assignments are bound to the boss incarnation and cannot be sent after its replacement', async t => {
  const f = await fixture(t)
  await f.boss.open({ kind: 'codex', prompt: 'role' })
  f.setStatus('orchestrator', 'working')
  const sent = await helper(f, ['send', '/project/a', 'queued task', '--id', 'stale-boss-queue'])
  assert.equal(sent.projects[0].status, 'queued')
  const prompts = f.calls.filter(c => c[0] === 'agent.prompt').length
  f.svc.snapshot.agents.find(a => a.name === 'drover-boss').agent_session.value = 'replacement'
  f.setStatus('orchestrator', 'idle')
  await f.boss.drain()
  assert.equal(f.events.at(-1).status, 'error')
  assert.equal(f.events.at(-1).code, 'boss_changed')
  assert.equal(f.calls.filter(c => c[0] === 'agent.prompt').length, prompts)
})
