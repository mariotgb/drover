import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { setImmediate as turn } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createServer } from 'node:net'
import { once } from 'node:events'

const bundled = mkdtempSync(join(tmpdir(), 'drover-stability-tests-'))
await build({ stdin: { contents: `
  export * from './src/main/remote/server'
  export * from './src/main/remote/store'
  export * from './src/main/remote/rpc'
  export * from './src/main/remote/queue'
  export * from './src/main/remote/log'
  export * from './src/main/transcripts/manager'
  export * from './src/renderer/src/transcript-state'
  export * from './src/renderer/src/remote-api'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundled, 'test.cjs'))
rmSync(bundled, { recursive: true })
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'drover-stability-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const update = (revision, reset, ids, stream = 's') => ({ paneId: 'w1:p1', stream, revision, reset, meta: null, items: ids.map(id => ({ id, kind: 'user', text: id })) })
const call = (method, args = [], id = method) => ({ t: 'call', id, method, args })
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function client(t) {
  const timers = [], globals = ['WebSocket', 'window', 'document', 'location', 'fetch', 'setTimeout', 'clearTimeout'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)])
  t.after(() => { for (const [k, d] of globals) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k] } })
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static all = []
    readyState = 0; sent = []
    constructor() { Socket.all.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    close() { this.readyState = 3; this.onclose?.() }
    send(data) { this.sent.push(JSON.parse(data)) }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    reply(method, value, ok = true, stateRevision) { const c = this.sent.findLast(c => c.method === method); assert.ok(c, method); this.receive(ok ? { t: 'result', id: c.id, ok, value, stateRevision } : { t: 'result', id: c.id, ok, error: value }) }
  }
  Object.assign(globalThis, { WebSocket: Socket, window: { addEventListener() {} }, document: { documentElement: { classList: { add() {} } } }, location: { protocol: 'https:', host: 'test.invalid', replace() { throw new Error('Unexpected auth redirect') } }, fetch: async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true }) }),
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer }, clearTimeout(timer) { if (timer) timer.cleared = true } })
  const api = m.createRemoteApi(), socket = Socket.all[0]; socket.open()
  const fire = async predicate => { const timer = timers.find(t => !t.cleared && predicate(t.delay)); assert.ok(timer, 'timer exists'); timer.cleared = true; timer.fn(); await settle() }
  return { api, socket, Socket, timers, fire }
}

test('new transcript events survive a late subscribe snapshot; reset clears only a newer conversation', () => {
  let state = m.mergeTranscript(undefined, update(1, true, ['a'])).next
  state = m.mergeTranscript(state, update(3, false, ['b'])).next
  const late = m.mergeTranscript(state, update(2, true, ['a']))
  assert.equal(late.next, state)
  assert.deepEqual(late.newUsers, [])
  assert.deepEqual(state.items.map(i => i.id), ['a', 'b'])
  state = m.mergeTranscript(state, update(4, true, ['new'])).next
  assert.deepEqual(state.items.map(i => i.id), ['new'])
  state = m.mergeTranscript(state, update(1, true, ['after-restart'], 'new-server')).next
  assert.deepEqual(state.items.map(i => i.id), ['after-restart'])
})

test('duplicate browser subscriptions share one RPC and return the latest event state', async t => {
  const { api, socket } = client(t)
  const subscriptions = [api.transcriptSubscribe('w1:p1'), api.transcriptSubscribe('w1:p1'), api.transcriptSubscribe('w1:p1')]
  assert.equal(socket.sent.filter(c => c.method === 'transcriptSubscribe').length, 1)
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(1, true, ['a'])] })
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(3, false, ['b'])] })
  socket.reply('transcriptSubscribe', update(2, true, ['a']))
  for (const u of await Promise.all(subscriptions)) assert.deepEqual(u.items.map(i => i.id), ['a', 'b'])
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(4, false, ['c'])] })
  assert.deepEqual((await api.transcriptSubscribe('w1:p1')).items.map(i => i.id), ['a', 'b', 'c'])
})

test('phone appearance writes omit the desktop-owned custom theme definitions', async t => {
  const { api, socket } = client(t)
  const patch = { appearance: { theme: 'custom-existing', customThemes: [{ id: 'custom-existing' }], glass: 0.8 } }
  const saved = api.setSettings(patch)
  const request = socket.sent.find(c => c.method === 'setSettings')
  assert.deepEqual(request.args, [{ appearance: { theme: 'custom-existing', glass: 0.8 } }])
  assert.equal(patch.appearance.customThemes.length, 1, 'the renderer snapshot stays intact')
  socket.reply('setSettings', { appearance: patch.appearance })
  assert.deepEqual(await saved, { appearance: patch.appearance })
})

test('failed subscribe preserves loaded messages instead of returning an empty reset', async t => {
  const { api, socket } = client(t)
  const subscription = api.transcriptSubscribe('w1:p1')
  socket.reply('transcriptSubscribe', { code: 'busy', message: 'Busy' }, false)
  const u = await subscription
  assert.equal(u.reset, false)
  assert.equal(u.error, 'busy')
  const loaded = m.mergeTranscript(undefined, update(1, true, ['saved'])).next
  assert.deepEqual(m.mergeTranscript(loaded, u).next.items, loaded.items)
})

test('reconnect restores wanted subscriptions, retries a failed restore and never replays a command', async t => {
  const { api, socket, Socket, fire } = client(t)
  const updates = []; api.on.transcript(u => updates.push(u))
  const initial = api.transcriptSubscribe('w1:p1'); socket.reply('transcriptSubscribe', update(1, true, ['a'])); await initial
  const board = api.watchTasks('/fixture'); socket.reply('watchTasks', { cwd: '/fixture', tasks: [] }); await board
  const command = api.sendPrompt('w1:p1', 'DO NOT REPLAY')
  socket.close(); assert.equal((await command).ok, false)
  await api.unwatchTasks('/fixture')
  await fire(delay => delay < 1000)
  const restored = Socket.all.at(-1); restored.open()
  assert.deepEqual(restored.sent.map(c => c.method), ['init', 'transcriptSubscribe', 'setSelectedPane'])
  restored.reply('init', { connection: { session: 'test', status: 'connected' }, snapshot: null })
  restored.reply('setSelectedPane', null)
  restored.reply('transcriptSubscribe', { code: 'busy', message: 'Busy' }, false)
  await settle(); await fire(delay => delay >= 1500 && delay < 2100)
  restored.reply('transcriptSubscribe', update(2, true, ['a', 'b']))
  await settle(); assert.deepEqual(updates.at(-1).items.map(i => i.id), ['a', 'b'])
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(99, true, ['stale'])] }); socket.close()
  assert.equal(m.getRemoteConnection(), 'connected')
  assert.deepEqual(updates.at(-1).items.map(i => i.id), ['a', 'b'])
})

test('init response cannot roll back a newer state event received during initialization', async t => {
  const { api, socket } = client(t)
  const initial = api.init()
  socket.receive({ t: 'event', channel: 'herdr:snapshot', stateRevision: 3, args: [{ panes: ['new'] }] })
  socket.reply('init', { connection: { session: 'test' }, snapshot: { panes: ['old'] } }, true, 2)
  assert.deepEqual((await initial).snapshot.panes, ['new'])
})

test('request deadline includes transport margin, logs timeout and never retries the operation', async t => {
  const { api, socket, timers, fire } = client(t)
  const request = api.request('pane.focus', { pane_id: 'w1:p1' }, 20_000)
  assert.ok(timers.some(t => t.delay === 35_000))
  await fire(delay => delay === 35_000)
  assert.equal((await request).code, 'timeout')
  assert.equal(socket.sent.filter(c => c.t === 'call').length, 1)
  assert.deepEqual(socket.sent.at(-1), { t: 'timeout', id: socket.sent[0].id })
})

test('resource queue lets transcript/read RPC bypass slow work while preserving terminal/subscription order', async () => {
  const q = new m.RemoteRpcQueue(), order = []; let finish
  const slow = q.run(call('setAgentModel'), () => new Promise(r => { finish = r; order.push('slow') }))
  await settle()
  await q.run(call('init'), async () => order.push('init'))
  await q.run(call('transcriptSubscribe', ['w1:p1']), async () => order.push('subscribe'))
  const close = q.run(call('termClose', ['term']), async () => order.push('close'))
  await settle(); assert.deepEqual(order, ['slow', 'init', 'subscribe'])
  finish(); await Promise.all([slow, close]); assert.equal(order.at(-1), 'close')
  let complete
  const sub = q.run(call('transcriptSubscribe', ['w1:p1']), () => new Promise(r => { complete = r }))
  const unsub = q.run(call('transcriptUnsubscribe', ['w1:p1']), async () => order.push('unsubscribe'))
  await q.run(call('transcriptSubscribe', ['w1:p2']), async () => order.push('other-pane'))
  assert.equal(order.at(-1), 'other-pane'); complete(); await Promise.all([sub, unsub]); assert.equal(order.at(-1), 'unsubscribe')
})

test('concurrent manager subscribers await file loading; returned snapshots are immutable in length and versioned', async t => {
  const root = temporary(t), sessions = join(root, 'projects', 'fixture'); mkdirSync(sessions, { recursive: true })
  const file = join(sessions, 'session.jsonl'), line = id => JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: id } }) + '\n'
  writeFileSync(file, line('first'))
  const service = { env: { CLAUDE_CONFIG_DIR: root }, snapshot: { panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: 'session' } }] } }
  const events = [], manager = new m.TranscriptManager(service, u => events.push(u)); t.after(() => manager.dispose())
  const [a, b] = await Promise.all([manager.subscribe('w1:p1'), manager.subscribe('w1:p1')])
  assert.equal(a.items.length, 1); assert.equal(b.items.length, 1); assert.equal(a.revision, b.revision)
  appendFileSync(file, line('second'))
  for (let i = 0; i < 200 && !events.some(u => u.items.some(i => i.text === 'second')); i++) await new Promise(r => setTimeout(r, 10))
  assert.ok(events.at(-1).revision > a.revision)
  assert.equal(a.items.length, 1)
  manager.unsubscribe('w1:p1'); manager.unsubscribe('w1:p1')
  assert.equal(manager.subs.get('w1:p1').refs, 0)
})

test('repeated remote subscribe is idempotent and disconnect releases exactly one retained reference', async () => {
  const handlers = new m.RpcHandlers(), c = new m.RemoteRpcConnection('test'); let refs = 0
  handlers.register('transcript:subscribe', ctx => { if (!ctx.existingSubscription) refs++; return update(1, true, ['a']) })
  handlers.register('transcript:unsubscribe', () => refs--)
  for (let i = 0; i < 3; i++) assert.equal((await m.dispatchRemoteRpc(handlers, c, call('transcriptSubscribe', ['w1:p1']))).ok, true)
  assert.equal(refs, 1); m.releaseRemoteRpc(handlers, c); assert.equal(refs, 0)
})

test('remote log rotates, stays private and excludes unknown method/error/argument text', async t => {
  const root = temporary(t), log = new m.RemoteLog(root, 350, 2)
  for (let i = 0; i < 20; i++) log.write('rpc_error', 'fixture-connection', i % 2 ? 'transcriptSubscribe' : '/pair?code=SECRET COOKIE CHAT', 1008)
  await log.flush()
  const dir = join(root, 'logs'), files = readdirSync(dir)
  assert.deepEqual(files.sort(), ['remote.log', 'remote.log.1', 'remote.log.2'])
  for (const file of files) {
    const path = join(dir, file), data = readFileSync(path, 'utf8'); assert.doesNotMatch(data, /SECRET|COOKIE|CHAT|pair/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    for (const l of data.trim().split('\n')) assert.equal(JSON.parse(l).event, 'rpc_error')
  }
})

test('real WS: slow reads/bursts preserve connection and timeout diagnostics have no request secrets', async t => {
  const root = temporary(t), listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(r => listener.close(r))
  const origin = `http://localhost:${port}`, store = new m.RemoteAuthStore(join(root, 'remote-auth.json'))
  const device = store.addDevice({ name: 'Fixture', rpID: 'localhost', userID: 'fixture', credential: { id: 'fixture', publicKey: 'AA', counter: 0 } }), token = store.issueSession(device.id, origin).token
  const handlers = new m.RpcHandlers(); let release; const releases = []
  handlers.register('roles:discover', () => new Promise(r => { release = r; releases.push(r) }))
  handlers.register('app:init', () => ({ snapshot: null }))
  handlers.register('transcript:subscribe', () => update(1, true, ['SECRET CHAT']))
  handlers.register('transcript:unsubscribe', () => {})
  handlers.register('herdr:request', () => { throw new Error('SECRET ERROR COOKIE') })
  let settings = { remoteEnabled: true, remotePort: port, remotePublicUrl: '' }
  const server = new m.RemoteServer({ userData: root, webRoot: root, attachmentsDir: join(root, 'attachments'), handlers, settings: () => settings, saveSettings: s => { settings = s }, statusChanged() {} })
  t.after(() => server.stop()); await server.sync()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { Host: `localhost:${port}`, Cookie: `drover_session=${token}` } }); t.after(() => ws.terminate()); await once(ws, 'open')
  const responses = []; ws.on('message', d => responses.push(JSON.parse(d)))
  ws.send(JSON.stringify(call('discoverRoles', ['/SECRET'], 'slow')))
  ws.send(JSON.stringify(call('transcriptSubscribe', ['w1:p1'], 'sub')))
  for (let i = 0; i < 48; i++) ws.send(JSON.stringify(call('init', [], String(i))))
  ws.send(JSON.stringify(call('request', ['pane.focus', { pane_id: 'w1:p1' }], 'error')))
  while (!release) await turn()
  for (let i = 0; i < 100 && responses.length < 50; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(responses.filter(r => r.ok).length, 49)
  assert.ok(!responses.some(r => r.id === 'slow'))
  ws.send(JSON.stringify({ t: 'timeout', id: 'slow' }))
  ws.send(JSON.stringify({ t: 'timeout', id: 'slow' }))
  ws.send(JSON.stringify({ t: 'timeout', id: 'SECRET UNTRACKED' }))
  await new Promise(r => setTimeout(r, 30)); release([]); await turn()
  for (let i = 0; i < 129; i++) ws.send(JSON.stringify(call('discoverRoles', ['/fixture'], `overload-${i}`)))
  for (let i = 0; i < 100 && !responses.some(r => r.error?.code === 'busy'); i++) await new Promise(r => setTimeout(r, 10))
  assert.ok(responses.some(r => r.error?.code === 'busy'))
  assert.equal(ws.readyState, WebSocket.OPEN)
  assert.ok([...server.clients][0].rpc.transcripts.has('w1:p1'))
  for (const finish of releases) finish([])
  const closed = once(ws, 'close'); ws.close(); await closed; await server.stop()
  const log = readFileSync(join(root, 'logs/remote.log'), 'utf8')
  assert.doesNotMatch(log, new RegExp(`${token}|SECRET|COOKIE|CHAT`))
  const lines = log.trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.filter(l => l.event === 'rpc_timeout').length, 1)
  assert.ok(lines.some(l => l.event === 'rpc_error'))
  assert.ok(lines.some(l => l.event === 'ws_connect'))
  assert.ok(lines.some(l => l.event === 'ws_disconnect'))
})

test('session changes during transcript lookup cannot attach the previous agent file', async t => {
  const root = temporary(t), project = join(root, 'projects', 'fixture'); mkdirSync(project, { recursive: true })
  for (const id of ['old', 'new']) writeFileSync(join(project, id + '.jsonl'), JSON.stringify({ type: 'user', uuid: id, message: { role: 'user', content: id } }) + '\n')
  const pane = id => ({ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: id } })
  const service = { env: { CLAUDE_CONFIG_DIR: root }, snapshot: { panes: [pane('old')] } }
  const events = [], manager = new m.TranscriptManager(service, u => events.push(u)); t.after(() => manager.dispose())
  const subscribing = manager.subscribe('w1:p1')
  service.snapshot = { panes: [pane('new')] }; manager.onSnapshot(service.snapshot)
  const result = await subscribing
  assert.equal(result.meta.sessionId, 'new')
  assert.deepEqual(result.items.map(i => i.text), ['new'])
  assert.ok(events.every(u => u.meta?.sessionId !== 'old'))
})

test('failed reconnect init is retried and restores settings as well as the current snapshot', async t => {
  const { api, socket, Socket, fire } = client(t)
  const snapshots = [], settings = []; api.on.snapshot(s => snapshots.push(s)); api.on.settings(s => settings.push(s))
  socket.close(); await fire(delay => delay < 1000)
  const restored = Socket.all.at(-1); restored.open()
  restored.reply('init', { code: 'busy', message: 'Busy' }, false); restored.reply('setSelectedPane', null)
  await settle(); await fire(delay => delay === 2000)
  restored.reply('init', { connection: { session: 'test', status: 'connected' }, snapshot: { panes: ['current'] }, settings: { language: 'ru' } })
  await settle(); assert.deepEqual(snapshots.at(-1), { panes: ['current'] }); assert.deepEqual(settings.at(-1), { language: 'ru' })
})

test('delta arriving before the first subscribe snapshot waits for its history base', async t => {
  const { api, socket } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const subscribing = api.transcriptSubscribe('w1:p1')
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(3, false, ['new'])] })
  assert.equal(events.length, 0, 'a delta cannot load an incomplete conversation')
  socket.reply('transcriptSubscribe', update(2, true, ['history']))
  assert.deepEqual((await subscribing).items.map(i => i.id), ['history', 'new'])
})


test('warm switch and reconnect send last cursor; events during resume cannot hide missed items', async t => {
  const { api, socket, Socket, fire } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const first = api.transcriptSubscribe('w1:p1'); socket.reply('transcriptSubscribe', update(1, true, ['a'])); await first
  const unsubscribe = api.transcriptUnsubscribe('w1:p1'); socket.reply('transcriptUnsubscribe', null); await unsubscribe
  const resumed = api.transcriptSubscribe('w1:p1')
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1', { stream: 's', revision: 1 }])
  socket.receive({ t: 'event', channel: 'transcript:update', args: [update(3, false, ['c'])] })
  assert.equal(events.length, 0)
  socket.reply('transcriptSubscribe', { ...update(2, false, ['b']), baseRevision: 1 })
  assert.deepEqual((await resumed).items.map(i => i.id), ['a', 'b', 'c'])
  socket.close(); await fire(delay => delay < 1000)
  const fresh = Socket.all.at(-1); fresh.open()
  assert.deepEqual(fresh.sent.find(c => c.method === 'transcriptSubscribe').args, ['w1:p1', { stream: 's', revision: 3 }])
  fresh.reply('init', { connection: { session: 'test', status: 'connected' }, snapshot: null }); fresh.reply('setSelectedPane', null)
  fresh.reply('transcriptSubscribe', { ...update(4, false, ['d']), baseRevision: 3 })
  await settle(); assert.deepEqual(events.at(-1).items.map(i => i.id), ['a', 'b', 'c', 'd'])
})
