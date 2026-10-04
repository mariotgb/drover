import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import webPush from 'web-push'

const bundled = mkdtempSync(join(tmpdir(), 'drover-push-tests-'))
await build({
  stdin: { contents: `
    export * from './src/main/remote/push'
    export * from './src/main/remote/store'
    export * from './src/main/remote/push-subscription'
    export { DEFAULT_REMOTE_SETTINGS } from './src/shared/remote'
  `, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  outfile: join(bundled, 'push.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent'
})
const m = createRequire(import.meta.url)(join(bundled, 'push.cjs'))
rmSync(bundled, { recursive: true })
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'drover-push-case-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
function subscription(suffix = 'test') {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  return { endpoint: `https://web.push.apple.com/${suffix}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}
function device(store, id = 'test', rpID = 'localhost') {
  return store.addDevice({ name: id, rpID, userID: id, credential: { id, publicKey: 'AA', counter: 0 } })
}
function change(from, to, paneId = 'w1:p1') {
  return { from, to, name: 'worker', pane: { pane_id: paneId, agent: 'codex', workspace_id: 'w1', cwd: '/home/project',
    title: 'PRIVATE CHAT CONTENT', terminal_title_stripped: 'PRIVATE CHAT CONTENT', agent_status: to } }
}
const snapshot = { workspaces: [{ workspace_id: 'w1', label: 'My project' }] }
function setup(t, sender = async () => {}) {
  const dir = temp(t), store = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
  let now = 0, enabled = true
  const push = new m.PushNotifications({ userData: dir, store: () => store, settings: () => m.DEFAULT_REMOTE_SETTINGS, enabled: () => enabled }, sender, () => now)
  return { dir, store, push, time: (n) => { now = n }, enable: (value) => { enabled = value } }
}

test('push trigger matrix: working -> done/idle and any known different state -> blocked', () => {
  const statuses = ['unknown', 'working', 'done', 'idle', 'blocked']
  for (const from of [undefined, ...statuses]) for (const to of statuses) {
    const expected = from === undefined || from === to ? null : to === 'blocked' ? 'blocked' : from === 'working' && ['done', 'idle'].includes(to) ? 'finished' : null
    assert.equal(m.pushTrigger(from, to), expected, `${from} -> ${to}`)
  }
})

test('notification includes only agent name/project/status and safe same-origin click target', () => {
  const payload = m.pushPayload(change('working', 'idle'), snapshot, 'test-session')
  assert.equal(payload.title, 'worker finished')
  assert.equal(payload.body, 'My project')
  assert.equal(payload.data.url, '/?pane=w1%3Ap1')
  assert.equal(payload.data.kind, 'finished')
  assert.ok(!JSON.stringify(payload).includes('PRIVATE CHAT CONTENT'))
  assert.ok(!JSON.stringify(payload).includes('/home/project'))
  assert.equal(m.pushPayload({ ...change('working', 'done'), pane: { ...change('working', 'done').pane, agent: null } }, snapshot, 'test'), null)
})

test('VAPID key pair is generated once, reused on restart, matches and is mode 0600', (t) => {
  const file = join(temp(t), 'remote-vapid.json')
  const first = new m.VapidKeys(file).get(), bytes = readFileSync(file, 'utf8')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  chmodSync(file, 0o644)
  const second = new m.VapidKeys(file).get()
  assert.deepEqual(second, first)
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(first.privateKey, 'base64url'))
  assert.equal(ecdh.getPublicKey().toString('base64url'), first.publicKey)
})

test('subscriptions/preferences persist by device; revoke atomically deletes them and retains other phones', (t) => {
  const { dir, store } = setup(t), one = device(store, 'one'), two = device(store, 'two')
  const sub = subscription()
  assert.equal(store.pushStatus(one.id).subscribed, false)
  store.savePushSubscription(one.id, sub)
  store.savePushSubscription(two.id, subscription('other'))
  store.setPushPreferences(one.id, { finished: false })
  assert.equal(statSync(join(dir, 'remote-auth.json')).mode & 0o777, 0o600)
  const restarted = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
  assert.equal(restarted.pushStatus(one.id).subscriptionCount, 1)
  assert.deepEqual(restarted.pushStatus(one.id).preferences, { finished: false, blocked: true })
  assert.equal(restarted.pushRecipients('localhost').length, 2)
  assert.deepEqual(restarted.pushRecipients('other.example'), [])
  restarted.revoke(one.id)
  assert.equal(restarted.pushRecipients('localhost').length, 1)
  assert.equal(readFileSync(join(dir, 'remote-auth.json'), 'utf8').includes(sub.endpoint), false)
  assert.throws(() => restarted.savePushSubscription(one.id, sub), { code: 'unauthorized' })
})

test('subscription upsert/removal is scoped to a device and cannot steal another phone endpoint', (t) => {
  const { store } = setup(t), a = device(store, 'one'), b = device(store, 'two'), sub = subscription()
  store.savePushSubscription(a.id, sub)
  const refreshed = { ...subscription(), endpoint: sub.endpoint }
  store.savePushSubscription(a.id, refreshed)
  assert.equal(store.pushStatus(a.id).subscriptionCount, 1)
  assert.throws(() => store.savePushSubscription(b.id, sub), { code: 'subscription_in_use' })
  store.removePushSubscription(b.id, sub.endpoint)
  assert.equal(store.pushStatus(a.id).subscriptionCount, 1)
  store.removePushSubscription(a.id, sub.endpoint, sub)
  assert.equal(store.pushStatus(a.id).subscriptionCount, 1, 'stale 410 does not delete refreshed keys')
  store.removePushSubscription(a.id)
  assert.equal(store.pushStatus(a.id).subscribed, false)
})

test('invalid/private push endpoints, invalid keys and non-boolean preferences are rejected', () => {
  const sub = subscription()
  for (const endpoint of ['http://web.push.apple.com/test', 'https://localhost/test', 'https://127.0.0.1/test', 'https://web.push.apple.com.evil.test/x', 'https://web.push.apple.com:444/x', 'https://u:p@web.push.apple.com/test']) {
    assert.throws(() => m.validatePushSubscription({ ...sub, endpoint }), { code: 'invalid_subscription' })
  }
  for (const keys of [{ auth: 'x', p256dh: sub.keys.p256dh }, { auth: sub.keys.auth, p256dh: Buffer.alloc(65).toString('base64url') }]) {
    assert.throws(() => m.validatePushSubscription({ ...sub, keys }), { code: 'invalid_subscription' })
  }
  for (const patch of [{ finished: 1 }, { blocked: null }, { unexpected: false }]) assert.throws(() => m.validatePushPreferences(patch), { code: 'invalid_preferences' })
})

test('expired subscriptions are not sent and invalid expired saves are rejected', (t) => {
  const path = join(temp(t), 'auth.json')
  let now = 10
  const store = new m.RemoteAuthStore(path, () => now), d = device(store)
  const sub = { ...subscription(), expirationTime: 100 }
  store.savePushSubscription(d.id, sub)
  now = 100
  assert.equal(store.pushStatus(d.id).subscribed, false)
  assert.deepEqual(store.pushRecipients('localhost'), [])
  assert.throws(() => store.savePushSubscription(d.id, sub), { code: 'invalid_subscription' })
})

test('no startup spam; debounce is 30 seconds per agent, applies across event kinds and reserves before await', async (t) => {
  const deliveries = [], f = setup(t, async (_sub, payload) => deliveries.push(JSON.parse(payload)))
  const d = device(f.store); f.store.savePushSubscription(d.id, subscription())
  await f.push.statusChanged(change(undefined, 'blocked'), snapshot, 'test')
  assert.equal(deliveries.length, 0)
  await Promise.all([f.push.statusChanged(change('working', 'done'), snapshot, 'test'), f.push.statusChanged(change('working', 'idle'), snapshot, 'test')])
  assert.equal(deliveries.length, 1)
  f.time(29_999); await f.push.statusChanged(change('idle', 'blocked'), snapshot, 'test')
  assert.equal(deliveries.length, 1)
  await f.push.statusChanged(change('idle', 'blocked', 'w1:p2'), snapshot, 'test')
  assert.equal(deliveries.length, 2, 'different agents have independent debounce')
  f.time(30_000); await f.push.statusChanged(change('idle', 'blocked'), snapshot, 'test')
  assert.equal(deliveries.length, 3)
  assert.equal(deliveries.at(-1).data.kind, 'blocked')
})

test('device-specific preferences and disabled remote access prevent sends without consuming debounce', async (t) => {
  const sent = [], f = setup(t, async (sub) => sent.push(sub.endpoint))
  const a = device(f.store, 'a'), b = device(f.store, 'b')
  f.store.savePushSubscription(a.id, subscription('a')); f.store.savePushSubscription(b.id, subscription('b'))
  f.store.setPushPreferences(a.id, { finished: false, blocked: false })
  f.enable(false); await f.push.statusChanged(change('working', 'done'), snapshot, 'test')
  assert.deepEqual(sent, [])
  f.enable(true); await f.push.statusChanged(change('working', 'done'), snapshot, 'test')
  assert.deepEqual(sent, ['https://web.push.apple.com/b'])
})

test('404/410 remove subscriptions; other failures retain them and never log keys/provider bodies', async (t) => {
  const warnings = [], original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  t.after(() => { console.warn = original })
  const f = setup(t, async (sub) => { throw Object.assign(new Error('PRIVATE PROVIDER BODY'), { statusCode: Number(sub.endpoint.split('/').at(-1)) }) })
  const d = device(f.store)
  for (const code of [404, 410, 503]) f.store.savePushSubscription(d.id, subscription(String(code)))
  await f.push.statusChanged(change('working', 'done'), snapshot, 'test')
  assert.equal(f.store.pushStatus(d.id).subscriptionCount, 1)
  assert.equal(f.store.pushRecipients('localhost')[0].subscription.endpoint, 'https://web.push.apple.com/503')
  assert.deepEqual(warnings, ['[web-push] delivery failed 503'])
})

test('revocation before queued delivery prevents further sends', async (t) => {
  let count = 0
  const f = setup(t, async () => { count++; f.store.revoke(d.id) })
  const d = device(f.store)
  for (let i = 0; i < 5; i++) f.store.savePushSubscription(d.id, subscription(String(i)))
  await f.push.statusChanged(change('working', 'done'), snapshot, 'test')
  assert.equal(count, 1)
  assert.deepEqual(f.store.pushRecipients('localhost'), [])
})

test('real web-push builds encrypted aes128gcm payload and VAPID authorization without network access', (t) => {
  const keys = new m.VapidKeys(join(temp(t), 'vapid.json')).get()
  const details = webPush.generateRequestDetails(subscription(), 'PRIVATE PAYLOAD', {
    vapidDetails: { subject: 'https://drover.example', ...keys }, contentEncoding: 'aes128gcm', TTL: 300
  })
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm')
  assert.match(details.headers.Authorization, /^vapid /)
  assert.ok(Buffer.isBuffer(details.body))
  assert.ok(!details.body.includes(Buffer.from('PRIVATE PAYLOAD')))
})
