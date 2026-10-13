import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const bundle = mkdtempSync(join(tmpdir(), 'drover-cleanup-bundle-'))
await build({ entryPoints: ['src/main/machines/cleanup.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: join(bundle, 'cleanup.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const { BridgeCleanupQueue } = createRequire(import.meta.url)(join(bundle, 'cleanup.cjs'))
rmSync(bundle, { recursive: true, force: true })
const algorithm = Buffer.from('ssh-ed25519'), size = Buffer.alloc(4); size.writeUInt32BE(algorithm.length)
const key = 'ssh-ed25519 ' + Buffer.concat([size, algorithm, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString('base64')
const old = { id: 'old-bridge', kind: 'direct' }

function fixture(t) {
  const userData = mkdtempSync(join(tmpdir(), 'drover-cleanup-test-')), calls = []
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  let active = 'new-bridge', now = 1_000_000, exists = true, removeFails = false, revokeFails = false, reactivate = false
  const deps = { userData, activeBridgeId: () => active, bridge: id => id === old.id && exists ? old : null, now: () => now,
    removeTargets: async (...args) => { calls.push(['remove', ...args]); if (removeFails) throw Error('PRIVATE ERROR'); if (reactivate) active = old.id },
    revokeInstallers: async (...args) => { calls.push(['revoke', ...args]); if (revokeFails) throw Error('PRIVATE ERROR') } }
  return { calls, deps, queue: new BridgeCleanupQueue(deps), get now() { return now }, set now(value) { now = value }, set active(value) { active = value }, set exists(value) { exists = value }, set removeFails(value) { removeFails = value }, set revokeFails(value) { revokeFails = value }, set reactivate(value) { reactivate = value } }
}

test('failed old cleanup is private, survives restart, obeys backoff and completes both phases', async t => {
  const f = fixture(t)
  f.removeFails = true
  await f.queue.enqueue(old.id, ['target-a'], key + ' drover-agents')
  assert.equal(statSync(f.queue.file).mode & 0o777, 0o600)
  await f.queue.runOnce()
  const state = f.queue.cleanupState(old.id)
  assert.equal(state.state, 'pending'); assert.equal(state.attempts, 1); assert.equal(state.nextAttemptAt, f.now + 30_000)
  assert.equal(state.error.code, 'bridge_cleanup_pending')
  assert.ok(!readFileSync(f.queue.file, 'utf8').includes('PRIVATE ERROR'))
  const restarted = new BridgeCleanupQueue(f.deps)
  await restarted.load()
  assert.deepEqual(restarted.cleanupState(old.id), state)
  await restarted.runOnce()
  assert.equal(f.calls.length, 1)
  f.now = state.nextAttemptAt; f.removeFails = false
  await restarted.runOnce()
  assert.deepEqual(f.calls.map(c => c[0]), ['remove', 'remove', 'revoke'])
  assert.deepEqual(f.calls[1].slice(1), [old, ['target-a'], key])
  assert.equal(restarted.cleanupState(old.id), undefined)
  assert.deepEqual(JSON.parse(readFileSync(restarted.file, 'utf8')).jobs, [])
})

test('successful tunnel phase persists while installer revocation retries with capped backoff', async t => {
  const f = fixture(t); f.revokeFails = true
  await f.queue.enqueue(old.id, ['target-a'], key)
  await f.queue.runOnce()
  assert.equal(JSON.parse(readFileSync(f.queue.file, 'utf8')).jobs[0].targetsRemoved, true)
  const restarted = new BridgeCleanupQueue(f.deps)
  await restarted.load()
  for (let i = 0; i < 12; i++) {
    f.now = restarted.cleanupState(old.id).nextAttemptAt
    await restarted.runOnce()
    assert.ok(restarted.cleanupState(old.id).nextAttemptAt - f.now <= 7_200_000)
  }
  assert.equal(restarted.cleanupState(old.id).nextAttemptAt - f.now, 7_200_000)
  assert.equal(f.calls.filter(c => c[0] === 'remove').length, 1)
  f.revokeFails = false; f.now = restarted.cleanupState(old.id).nextAttemptAt
  await restarted.runOnce()
  assert.equal(restarted.cleanupState(old.id), undefined)
})

test('active bridge is blocked before every remote mutation, including reactivation during an await', async t => {
  const f = fixture(t)
  await f.queue.enqueue(old.id, ['target-a'], key)
  f.active = old.id
  await f.queue.runOnce()
  assert.equal(f.calls.length, 0)
  assert.equal(f.queue.cleanupState(old.id).state, 'blocked')
  assert.equal(f.queue.cleanupState(old.id).error.code, 'bridge_cleanup_active')
  f.active = 'new-bridge'; f.reactivate = true
  await f.queue.runOnce()
  assert.deepEqual(f.calls.map(c => c[0]), ['remove'])
  assert.equal(f.queue.cleanupState(old.id).state, 'blocked')
  // A restart must also keep the partial job blocked while the bridge is active.
  const restarted = new BridgeCleanupQueue(f.deps); await restarted.load(); await restarted.runOnce()
  assert.equal(f.calls.length, 1)
  f.active = 'new-bridge'; await restarted.runOnce()
  assert.deepEqual(f.calls.map(c => c[0]), ['remove', 'revoke'])
})

test('missing bridge stays pending until confirmed retirement cancels it; offline full removals survive', async t => {
  const f = fixture(t)
  const removalFile = join(f.deps.userData, 'machines.json')
  const original = JSON.stringify({ credentialRemovals: { 'offline-target': { agentsPublicKeys: [key], managementPublicKey: key, bridgeMachineId: old.id } } })
  writeFileSync(removalFile, original)
  await f.queue.enqueue(old.id, ['offline-target'], key)
  f.exists = false
  await f.queue.runOnce()
  assert.equal(f.calls.length, 0)
  assert.equal(f.queue.cleanupState(old.id).error.code, 'bridge_cleanup_missing')
  const restarted = new BridgeCleanupQueue(f.deps); await restarted.load()
  assert.equal(restarted.cleanupState(old.id).state, 'blocked')
  await restarted.cancel(old.id)
  assert.equal(restarted.cleanupState(old.id), undefined)
  assert.equal(readFileSync(removalFile, 'utf8'), original)
})

test('concurrent checks do not duplicate cleanup; a fresh switch resets progress and merges targets', async t => {
  const f = fixture(t); f.revokeFails = true
  await f.queue.enqueue(old.id, ['target-a'], key)
  await Promise.all([f.queue.runOnce(), f.queue.runOnce()])
  assert.deepEqual(f.calls.map(c => c[0]), ['remove', 'revoke'])
  assert.ok(f.queue.cleanupState(old.id).nextAttemptAt > f.now)
  await f.queue.enqueue(old.id, ['target-a'], key)
  assert.equal(f.queue.cleanupState(old.id).nextAttemptAt, f.now)
  assert.equal(JSON.parse(readFileSync(f.queue.file, 'utf8')).jobs[0].targetsRemoved, false)
  await f.queue.enqueue(old.id, ['target-b'], key)
  f.revokeFails = false; await f.queue.runOnce()
  assert.deepEqual(f.calls.at(-2)[2], ['target-a', 'target-b'])
  assert.equal(f.queue.cleanupState(old.id), undefined)
})

test('fresh switch replaces the stale jump public key instead of queuing a key restoration', async t => {
  const f = fixture(t); f.revokeFails = true
  const newKey = 'ssh-ed25519 ' + Buffer.concat([size, algorithm, Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 8)]).toString('base64')
  assert.notEqual(newKey, key)
  await f.queue.enqueue(old.id, ['target-a'], key)
  await f.queue.runOnce()
  await f.queue.enqueue(old.id, ['target-b'], newKey)
  assert.equal(JSON.parse(readFileSync(f.queue.file, 'utf8')).jobs.length, 1)
  f.revokeFails = false; await f.queue.runOnce()
  assert.equal(f.calls.at(-2)[3], newKey)
  assert.deepEqual(f.calls.at(-2)[2], ['target-a', 'target-b'])
})

test('damaged queue fails closed without dropping revocations', async t => {
  const f = fixture(t)
  await f.queue.enqueue(old.id, ['target-a'], key)
  const data = JSON.parse(readFileSync(f.queue.file, 'utf8')); data.jobs[0].targetIds = ['bad\noption']
  writeFileSync(f.queue.file, JSON.stringify(data))
  const restarted = new BridgeCleanupQueue(f.deps)
  await assert.rejects(restarted.runOnce(), { code: 'store_invalid' })
  assert.equal(f.calls.length, 0)
  assert.equal(JSON.parse(readFileSync(f.queue.file, 'utf8')).jobs.length, 1)
})
