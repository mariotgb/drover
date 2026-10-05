import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'drover-boss-session-'))
await build({ entryPoints: ['src/renderer/src/boss-session.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'session.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const { switchBossSession } = createRequire(import.meta.url)(join(dir, 'session.cjs'))
rmSync(dir, { recursive: true, force: true })
function fixture() {
  let state = { settings: { session: 'current' }, connection: { session: 'current', status: 'connected' }, snapshot: { id: 'current' } }
  const listeners = new Set(), calls = []
  const store = { getState: () => state, setState: patch => { state = { ...state, ...patch }; for (const l of listeners) l(state) }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
  let initSnapshot = { id: 'owner' }
  const api = {
    setSettings: async patch => { calls.push(['settings', patch]); return { ...state.settings, ...patch } },
    init: async () => { calls.push(['init', state.connection.session]); return { ...state, snapshot: initSnapshot } },
    bossRoster: async () => { calls.push(['roster', state.connection.session]); return { session: 'owner', needsSessionSwitch: false, boss: { paneId: 'owner:p1' } } }
  }
  return { store, api, calls, listeners, setInit: snapshot => { initSnapshot = snapshot } }
}

test('confirmed boss session switch waits for owner connection/init before reading the owner roster', async () => {
  const f = fixture(), pending = switchBossSession('owner', f.api, f.store)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(f.calls, [['settings', { session: 'owner' }]])
  f.store.setState({ connection: { status: 'connected', session: 'owner' } })
  assert.equal((await pending).session, 'owner')
  assert.deepEqual(f.calls, [['settings', { session: 'owner' }], ['init', 'owner'], ['roster', 'owner']])
  assert.equal(f.store.getState().selectedPaneId, null)
  assert.equal(f.listeners.size, 0)
})

test('connected ping without the first snapshot cannot proceed to opening the boss', async () => {
  const f = fixture(); f.setInit(null)
  const pending = switchBossSession('owner', f.api, f.store)
  await new Promise(r => setImmediate(r))
  f.store.setState({ connection: { status: 'connected', session: 'owner' } })
  await new Promise(r => setImmediate(r))
  assert.equal(f.calls.filter(([call]) => call === 'roster').length, 0)
  const snapshot = { id: 'owner' }; f.setInit(snapshot); f.store.setState({ snapshot })
  await pending
  assert.equal(f.calls.filter(([call]) => call === 'init').length, 2)
  assert.equal(f.listeners.size, 0)
})

test('a failed settings write, another session switch, timeout or changed boss owner never proceeds to open', async () => {
  const failed = fixture(); failed.api.setSettings = async () => { throw new Error('disk failed') }
  await assert.rejects(switchBossSession('owner', failed.api, failed.store), /disk failed/)
  assert.equal(failed.store.getState().settings.session, 'current')
  const changed = fixture(), pending = switchBossSession('owner', changed.api, changed.store)
  await new Promise(r => setImmediate(r)); changed.store.setState({ settings: { session: 'another' } })
  await assert.rejects(pending, /cancelled/); assert.equal(changed.listeners.size, 0)
  const expired = fixture()
  await assert.rejects(switchBossSession('owner', expired.api, expired.store, 5), /Could not connect/)
  assert.equal(expired.listeners.size, 0)
  const moved = fixture(); moved.store.setState({ connection: { status: 'connected', session: 'owner' } })
  moved.api.bossRoster = async () => ({ session: 'another-owner', needsSessionSwitch: true })
  await assert.rejects(switchBossSession('owner', moved.api, moved.store), /boss session changed/)
})

test('a newer session choice while setSettings is pending cancels before a stale response writes to the store', async () => {
  const f = fixture()
  let reply
  f.api.setSettings = () => new Promise(resolve => { reply = resolve })
  const pending = switchBossSession('owner', f.api, f.store)
  const newer = { session: 'another', language: 'es' }
  f.store.setState({ settings: newer, connection: { session: 'another', status: 'connected' } })
  await assert.rejects(pending, /Session switch was cancelled/)
  reply({ session: 'owner', language: 'en' })
  await new Promise(r => setImmediate(r))
  assert.equal(f.store.getState().settings, newer)
  assert.equal(f.store.getState().connection.session, 'another')
  assert.deepEqual(f.calls, [], 'no init, roster or open after cancellation')
  assert.equal(f.listeners.size, 0)
})

test('the expected owner settings echo is accepted without overwriting newer fields with an older response', async () => {
  const f = fixture()
  let reply
  f.api.setSettings = () => new Promise(resolve => { reply = resolve })
  const pending = switchBossSession('owner', f.api, f.store)
  const latest = { session: 'owner', language: 'es' }
  f.store.setState({ settings: latest, connection: { session: 'owner', status: 'connected' } })
  reply({ session: 'owner', language: 'en' })
  await pending
  assert.equal(f.store.getState().settings, latest)
  assert.equal(f.listeners.size, 0)
})
