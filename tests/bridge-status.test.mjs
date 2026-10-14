import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

// Bridge card status (Settings > Machines): amber "Web access only" only while web access really works.
const dir = mkdtempSync(join(tmpdir(), 'drover-bridge-status-'))
const out = join(dir, 'machines.cjs')
await build({ entryPoints: [resolve('src/renderer/src/machines.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
globalThis.window ??= {}
const { bridgeStatus } = createRequire(import.meta.url)(out)
rmSync(dir, { recursive: true, force: true })

const homes = { total: 0, online: 0 }
const conn = (extra = {}) => ({ source: 'existing', users: ['bridge-mac', 'jump'], publicUrl: 'https://203-0-113-5.sslip.io', macTunnel: 'running', forwards: [], ...extra })
const bridge = (extra = {}) => ({
  id: 'b', name: 'bridge', kind: 'direct', alias: 'drover-bridge', host: '203.0.113.5', user: 'root', publicIp: true, permissions: { mode: 'full', projects: [] },
  status: { state: 'online', latencyMs: 9 }, bridgeSetup: { state: 'failed' }, bridgeConnection: conn(), ...extra
})

test('adopted bridge that answers, with a web address and a running tunnel, is amber Web access only', () => {
  const s = bridgeStatus(bridge(), homes)
  assert.equal(s.tone, 'phone')
  assert.equal(s.label, 'Web access only')
  assert.match(s.text, /gives web access to Drover from any device/)
})

test('a stopped or missing computer tunnel is red with that reason, not Web access only', () => {
  const stopped = bridgeStatus(bridge({ bridgeConnection: conn({ macTunnel: 'stopped' }) }), homes)
  assert.equal(stopped.tone, 'bad')
  assert.match(stopped.text, /tunnel to the bridge is stopped/)
  const missing = bridgeStatus(bridge({ bridgeConnection: conn({ macTunnel: 'missing' }) }), homes)
  assert.equal(missing.tone, 'bad')
  assert.match(missing.text, /tunnel to the bridge is not set up/)
})

test('a missing web address is red with that reason', () => {
  const s = bridgeStatus(bridge({ bridgeConnection: conn({ publicUrl: undefined }) }), homes)
  assert.equal(s.tone, 'bad')
  assert.match(s.text, /Web access is not set up on the bridge/)
})

test('a bridgeSetup error is shown, never masked by Web access only', () => {
  const s = bridgeStatus(bridge({ bridgeSetup: { state: 'failed', error: { code: 'bridge_firewall_missing' } } }), homes)
  assert.equal(s.tone, 'bad')
  assert.match(s.text, /firewall is not set up/)
})

test('a status error or an unreachable bridge is red with the real reason', () => {
  const timeout = bridgeStatus(bridge({ status: { state: 'offline', error: { code: 'timeout' } } }), homes)
  assert.equal(timeout.tone, 'bad')
  assert.match(timeout.text, /did not answer in time/)
  const down = bridgeStatus(bridge({ status: { state: 'offline' } }), homes)
  assert.equal(down.tone, 'bad')
  assert.match(down.text, /not reachable/)
})

test('an upgraded ready bridge is Working; an upgraded one not set up yet says so', () => {
  const ready = bridgeStatus(bridge({ bridgeSetup: { state: 'ready' }, bridgeConnection: conn({ managed: true }) }), { total: 2, online: 1 })
  assert.equal(ready.tone, 'ok')
  assert.match(ready.text, /1 of 2 home machines connected/)
  const unset = bridgeStatus(bridge({ bridgeConnection: conn({ managed: true }) }), homes)
  assert.equal(unset.tone, 'bad')
  assert.match(unset.text, /answers, but it is not set up for home machines yet/)
})

test('setup in progress is a neutral wait state', () => {
  const s = bridgeStatus(bridge({ bridgeSetup: { state: 'running', step: 'users' } }), homes)
  assert.equal(s.tone, 'wait')
  assert.equal(s.label, 'Setting up')
})
