import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const bundled = mkdtempSync(join(tmpdir(), 'drover-delta-loss-tests-'))
await build({ entryPoints: [resolve('src/renderer/src/remote-api.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundled, 'test.cjs'))
rmSync(bundled, { recursive: true })
const update = (revision, reset, ids, stream = 's') => ({ paneId: 'w1:p1', stream, revision, reset, meta: null, items: ids.map(id => ({ id, kind: 'user', text: id })) })
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

async function startResume(api, socket) {
  const first = api.transcriptSubscribe('w1:p1')
  socket.reply('transcriptSubscribe', update(1, true, ['a'])); await first
  const unsubscribe = api.transcriptUnsubscribe('w1:p1')
  socket.reply('transcriptUnsubscribe', null); await unsubscribe
  const resumed = api.transcriptSubscribe('w1:p1')
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1', { stream: 's', revision: 1 }])
  return { resumed }
}
const transcriptEvent = (socket, revision, ids) => socket.receive({ t: 'event', channel: 'transcript:update', args: [update(revision, false, ids)] })
const retrySubscribe = fire => fire(delay => delay >= 1500 && delay < 2000)

test('resume failure holds subsequent events until a full snapshot, preserving order and overlapping upserts', async t => {
  const { api, socket, fire } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const { resumed } = await startResume(api, socket)
  transcriptEvent(socket, 2, ['b'])
  socket.reply('transcriptSubscribe', { code: 'busy', message: 'Busy' }, false)
  await resumed; await settle()
  transcriptEvent(socket, 3, ['c'])
  assert.equal(events.length, 0, 'events cannot advance an untrusted revision')
  await retrySubscribe(fire)
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1'], 'retry must request a full snapshot')
  transcriptEvent(socket, 4, ['c', 'd'])
  socket.reply('transcriptSubscribe', update(3, true, ['a', 'b', 'c']))
  await settle()
  assert.deepEqual(events.at(-1).items.map(i => i.id), ['a', 'b', 'c', 'd'])
  assert.equal(events.at(-1).revision, 4)
  assert.deepEqual((await api.transcriptSubscribe('w1:p1')).items.map(i => i.id), ['a', 'b', 'c', 'd'])
})

test('repeated resume errors keep the buffer across retries, including RPC timeout', async t => {
  const { api, socket, fire } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const { resumed } = await startResume(api, socket)
  transcriptEvent(socket, 2, ['b'])
  socket.reply('transcriptSubscribe', { code: 'busy', message: 'Busy' }, false)
  await resumed; await settle()
  transcriptEvent(socket, 3, ['c'])
  await retrySubscribe(fire)
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1'])
  await fire(delay => delay > 10_000)
  transcriptEvent(socket, 4, ['d'])
  assert.equal(events.length, 0)
  await retrySubscribe(fire)
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1'])
  socket.reply('transcriptSubscribe', update(1, true, ['a']))
  await settle()
  assert.deepEqual(events.at(-1).items.map(i => i.id), ['a', 'b', 'c', 'd'])
  assert.equal(events.at(-1).revision, 4)
})

test('disconnect during resume invalidates its cursor and ignores the obsolete socket response', async t => {
  const { api, socket, Socket, fire } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const { resumed } = await startResume(api, socket)
  transcriptEvent(socket, 2, ['b'])
  socket.close(); await resumed
  await fire(delay => delay < 1000)
  const fresh = Socket.all.at(-1); fresh.open()
  assert.deepEqual(fresh.sent.find(c => c.method === 'transcriptSubscribe').args, ['w1:p1'])
  fresh.reply('init', { connection: { session: 'test', status: 'connected' }, snapshot: null })
  fresh.reply('setSelectedPane', null)
  socket.reply('transcriptSubscribe', update(99, true, ['stale']))
  transcriptEvent(socket, 100, ['obsolete'])
  transcriptEvent(fresh, 4, ['d'])
  fresh.reply('transcriptSubscribe', update(3, true, ['a', 'b', 'c']))
  await settle()
  assert.deepEqual(events.at(-1).items.map(i => i.id), ['a', 'b', 'c', 'd'])
  assert.equal(events.at(-1).revision, 4)
})

test('recovery rejects an errored snapshot and an unexpected delta without draining the buffer', async t => {
  const { api, socket, fire } = client(t), events = []
  api.on.transcript(u => events.push(u))
  const { resumed } = await startResume(api, socket)
  socket.reply('transcriptSubscribe', { code: 'busy', message: 'Busy' }, false)
  await resumed; await settle()
  transcriptEvent(socket, 2, ['b'])
  await retrySubscribe(fire)
  socket.reply('transcriptSubscribe', { ...update(2, true, []), error: 'not_found' })
  await settle()
  transcriptEvent(socket, 3, ['c'])
  await retrySubscribe(fire)
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1'])
  socket.reply('transcriptSubscribe', { ...update(3, false, ['c']), baseRevision: 2 })
  await settle()
  transcriptEvent(socket, 4, ['d'])
  assert.equal(events.length, 0)
  await retrySubscribe(fire)
  assert.deepEqual(socket.sent.at(-1).args, ['w1:p1'])
  socket.reply('transcriptSubscribe', update(1, true, ['a']))
  await settle()
  assert.deepEqual(events.at(-1).items.map(i => i.id), ['a', 'b', 'c', 'd'])
  assert.equal(events.at(-1).revision, 4)
})
