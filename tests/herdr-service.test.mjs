import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'drover-herdr-service-'))
await build({ stdin: { contents: "export * from './src/main/herdr/service'; export * from './src/shared/types'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'service.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const { HerdrService, HerdrApiError } = createRequire(import.meta.url)(join(root, 'service.cjs'))
rmSync(root, { recursive: true, force: true })

function fixture(t) {
  const service = new HerdrService({ logDir: '/fixture', autoStartServer: () => false })
  const subscriptions = [], calls = []
  const snapshot = { panes: [{ pane_id: 'w1:p1' }], agents: [], workspaces: [], tabs: [], layouts: [] }
  service.client = {
    async request(method) {
      calls.push(method)
      return method === 'ping' ? { version: '0.9.4' } : { snapshot }
    },
    subscribe(filters, handlers) {
      const handle = { filters, handlers, closed: false, close() { this.closed = true; handlers.onClose?.() } }
      subscriptions.push(handle)
      return handle
    }
  }
  t.after(() => service.stop())
  return { service, subscriptions, calls, snapshot }
}

test('one transient snapshot failure cannot become a 2.5 second reconnect loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { service, subscriptions } = fixture(t)
  const states = []; service.on('connection', c => states.push(c.status))
  await service.connect(0, false)
  const original = service.client.request
  service.client.request = async method => {
    if (method === 'session.snapshot') throw new HerdrApiError('server_not_running', 'one-off failure')
    return original(method)
  }
  await service.refresh()
  service.client.request = original
  // Events or a poll can recover before the reconnect timer. That pending
  // reconnect replaces a live stream; closing it must not trigger another.
  await service.refresh()
  await service.connect(0, false)
  assert.deepEqual(states, ['connected', 'disconnected', 'connected', 'connected'])
  assert.equal(subscriptions[0].closed, true)
  assert.equal(service.reconnectTimer, null)
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(2600); await service.refresh() }
  assert.equal(states.filter(s => s === 'disconnected').length, 1)
  assert.equal(service.lifecycleSub.closed, false)
})

test('retired lifecycle and status callbacks cannot affect replacement streams', async t => {
  const { service, subscriptions, snapshot } = fixture(t)
  await service.connect(0, false)
  const [oldLifecycle, oldStatus] = subscriptions
  await service.connect(0, false)
  const lifecycle = service.lifecycleSub
  oldLifecycle.handlers.onClose()
  assert.equal(service.lifecycleSub, lifecycle)
  assert.equal(service.connection.status, 'connected')
  service.syncStatusSubscription({ ...snapshot, panes: [{ pane_id: 'w1:p2' }] })
  const status = service.statusSub
  oldStatus.handlers.onClose()
  assert.equal(service.statusSub, status)
  assert.equal(service.statusPaneKey, 'w1:p2')
  // A real close still schedules recovery.
  lifecycle.close()
  assert.equal(service.connection.status, 'disconnected')
  assert.ok(service.reconnectTimer)
})

test('launch observation read RPCs never schedule another snapshot capture', async t => {
  const { service } = fixture(t)
  await service.request('pane.process_info', { pane_id: 'w1:p1' })
  await service.request('agent.get', { target: 'w1:p1' })
  assert.equal(service.refreshTimer, null)
  await service.request('pane.rename', { pane_id: 'w1:p1', label: 'new' })
  assert.ok(service.refreshTimer)
})
