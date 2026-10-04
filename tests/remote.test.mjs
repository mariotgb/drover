import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'

const bundled = mkdtempSync(join(tmpdir(), 'drover-remote-tests-'))
await build({
  stdin: { contents: `
    export * from './src/shared/remote'
    export * from './src/main/remote/rpc'
    export * from './src/main/remote/security'
    export * from './src/main/remote/store'
    export * from './src/main/remote/auth'
    export * from './src/main/remote/server'
    export * from './src/main/remote/push'
    export { SettingsStore } from './src/main/settings'
  `, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'remote.cjs'),
  alias: { '@shared': resolve('src/shared') }, logLevel: 'silent'
})
const m = createRequire(import.meta.url)(join(bundled, 'remote.cjs'))
rmSync(bundled, { recursive: true })
const call = (method, args = [], id = '1') => ({ t: 'call', id, method, args })

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-remote-case-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function device(store, credentialId = 'credential', rpID = 'localhost') {
  return store.addDevice({ name: 'Test phone', rpID, userID: 'user', credential: { id: credentialId, publicKey: 'AA', counter: 0 } })
}

test('remote allowlist covers preload methods and never includes native/management methods', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const api = preload.slice(preload.indexOf('const api = {'), preload.indexOf('\n  on: {'))
  const methods = [...api.matchAll(/^  (\w+):/gm)].map((match) => match[1])
  for (const method of methods) assert.ok(Object.hasOwn(m.REMOTE_METHOD_CHANNELS, method) || m.REMOTE_LOCAL_ONLY_METHODS.includes(method), method)
  for (const method of m.REMOTE_LOCAL_ONLY_METHODS) assert.equal(Object.hasOwn(m.REMOTE_METHOD_CHANNELS, method), false, method)
})

test('RPC uses the same registered handler; awaits async values and preserves errors', async () => {
  const handlers = new m.RpcHandlers()
  const contexts = []
  handlers.register('herdr:request', async (ctx, method, args) => { contexts.push(ctx); return { method, args } })
  const local = await handlers.invoke('herdr:request', {}, ['pane.focus', { pane_id: 'w1:p1' }])
  const remote = await m.dispatchRemoteRpc(handlers, new m.RemoteRpcConnection('a'), call('request', ['pane.focus', { pane_id: 'w1:p1' }]))
  assert.deepEqual(remote, { t: 'result', id: '1', ok: true, value: local })
  assert.equal(contexts.length, 2)
  assert.equal(contexts[1].remote.id, 'a')
  handlers.register('app:init', () => { throw new m.RemoteFailure('specific_error', 'detail') })
  assert.deepEqual((await m.dispatchRemoteRpc(handlers, new m.RemoteRpcConnection('b'), call('init'))).error, { code: 'specific_error', message: 'detail' })
})

test('RPC denies native methods, IPC channel names and prototype methods', async () => {
  const handlers = new m.RpcHandlers()
  const c = new m.RemoteRpcConnection('a')
  for (const method of [...m.REMOTE_LOCAL_ONLY_METHODS, 'shell:open-external', '__proto__', 'toString', 'unknown']) {
    const result = await m.dispatchRemoteRpc(handlers, c, call(method))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'not_available_remotely', method)
  }
  for (const invalid of [null, {}, { ...call('init'), args: null }, { ...call('init'), id: '' }]) {
    assert.equal((await m.dispatchRemoteRpc(handlers, c, invalid)).error.code, 'invalid_call')
  }
})

test('RPC cannot change remote settings via the regular settings method', async () => {
  const handlers = new m.RpcHandlers()
  let calls = 0
  handlers.register('settings:set', () => ++calls)
  const c = new m.RemoteRpcConnection('a')
  for (const patch of [{ remoteEnabled: true }, { remotePort: 8000 }, { remotePublicUrl: 'https://evil.test' }]) {
    assert.equal((await m.dispatchRemoteRpc(handlers, c, call('setSettings', [patch]))).error.code, 'not_available_remotely')
  }
  assert.equal(calls, 0)
  assert.equal((await m.dispatchRemoteRpc(handlers, c, call('setSettings', [{ chatFontSize: 16 }]))).ok, true)
})

test('terminal IDs are scoped to each WS and writes require an owned subscription', async () => {
  const handlers = new m.RpcHandlers()
  const seen = []
  for (const channel of ['term:open', 'term:input', 'term:close']) handlers.register(channel, (_ctx, ...args) => { seen.push([channel, ...args]); return { ok: true } })
  const a = new m.RemoteRpcConnection('a'), b = new m.RemoteRpcConnection('b')
  assert.equal((await m.dispatchRemoteRpc(handlers, b, call('termInput', ['same', 'secret']))).error.code, 'not_subscribed')
  await m.dispatchRemoteRpc(handlers, a, call('termOpen', ['same', 'w1:p1', 80, 24]))
  await m.dispatchRemoteRpc(handlers, b, call('termOpen', ['same', 'w1:p1', 80, 24]))
  await m.dispatchRemoteRpc(handlers, a, call('termInput', ['same', 'hello']))
  assert.deepEqual(seen.map((entry) => entry[1]), ['remote:a:same', 'remote:b:same', 'remote:a:same'])
  m.releaseRemoteRpc(handlers, a)
  assert.equal(seen.at(-1)[1], 'remote:a:same')
  assert.equal(b.terminals.size, 1)
  assert.equal((await m.dispatchRemoteRpc(handlers, a, call('termOpen', ['new', 'w1:p1', 80, 24]))).error.code, 'unauthorized')
})

test('disconnect during async subscribe releases its reference exactly once', async () => {
  const handlers = new m.RpcHandlers()
  let finish, refs = 1
  handlers.register('transcript:subscribe', () => { refs++; return new Promise((r) => { finish = r }) })
  handlers.register('transcript:unsubscribe', () => { refs-- })
  const c = new m.RemoteRpcConnection('a')
  const pending = m.dispatchRemoteRpc(handlers, c, call('transcriptSubscribe', ['w1:p1']))
  m.releaseRemoteRpc(handlers, c)
  finish({})
  await pending
  assert.equal(refs, 1, 'desktop reference retained')
})

test('pair codes are one-time, expire at ten minutes, and a new code replaces the previous one', () => {
  let now = 1000
  const codes = new m.PairingCodes(() => now)
  const first = codes.create()
  assert.equal(first.expiresAt, now + 600_000)
  const hash = codes.check(first.code)
  codes.consume(hash)
  assert.throws(() => codes.check(first.code), { code: 'invalid_pairing_code' })
  assert.throws(() => codes.consume(hash), { code: 'invalid_pairing_code' })
  const second = codes.create()
  now = second.expiresAt
  assert.throws(() => codes.check(second.code), { code: 'invalid_pairing_code' })
  const third = codes.create()
  codes.create()
  assert.throws(() => codes.check(third.code), { code: 'invalid_pairing_code' })
})

test('WebAuthn challenges cannot be replayed and expire after five minutes', () => {
  let now = 1
  const c = new m.Challenges(() => now)
  const id = c.add({ challenge: 'test' })
  assert.equal(c.take(id).challenge, 'test')
  assert.throws(() => c.take(id), { code: 'invalid_challenge' })
  const second = c.add({})
  now += 300_000
  assert.throws(() => c.take(second), { code: 'invalid_challenge' })
})

test('sessions persist hashes only, use 0600, expire at thirty days and revoke with the device', (t) => {
  const path = join(temp(t), 'remote-auth.json')
  let now = 1000
  const store = new m.RemoteAuthStore(path, () => now)
  const d = device(store)
  const { token, expiresAt } = store.issueSession(d.id, 'http://localhost:7780')
  assert.equal(expiresAt, now + 30 * 86400_000)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const disk = readFileSync(path, 'utf8')
  assert.equal(disk.includes(token), false)
  assert.ok(disk.includes(m.hashSecret(token)))
  assert.equal(store.session(token, 'http://localhost:7780').device.id, d.id)
  assert.equal(store.session(token, 'https://other.test'), undefined)
  assert.equal(store.session('bad', 'http://localhost:7780'), undefined)
  assert.equal(new m.RemoteAuthStore(path, () => now).session(token, 'http://localhost:7780').device.id, d.id)
  now = expiresAt
  assert.equal(store.session(token, 'http://localhost:7780'), undefined)
  now = 2000
  const fresh = store.issueSession(d.id, 'http://localhost:7780').token
  store.revoke(d.id)
  assert.equal(store.session(fresh, 'http://localhost:7780'), undefined)
  assert.deepEqual(store.devices(), [])
})

test('cookie flags and parsing reject duplicated session cookies', () => {
  assert.match(m.sessionCookie('x', true), /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/)
  assert.doesNotMatch(m.sessionCookie('x', false), /Secure/)
  assert.match(m.sessionCookie('', true, true), /Max-Age=0/)
  assert.equal(m.sessionToken('foo=a; drover_session=abc'), 'abc')
  assert.equal(m.sessionToken('drover_session=a; drover_session=b'), undefined)
})

test('concurrent login cannot roll a credential counter back to zero', (t) => {
  const store = new m.RemoteAuthStore(join(temp(t), 'auth.json'))
  const d = device(store)
  store.updateCredential(d.id, 1)
  for (const counter of [0, 1]) assert.throws(() => store.updateCredential(d.id, counter), { code: 'invalid_authentication' })
  assert.equal(store.credential('credential', 'localhost').credential.counter, 1)
  store.updateCredential(d.id, 2)
})

test('device revocation during WebAuthn verification cannot issue a session', async (t) => {
  const store = new m.RemoteAuthStore(join(temp(t), 'auth.json'))
  const d = device(store)
  let finish
  const auth = new m.RemoteAuth(store, () => m.DEFAULT_REMOTE_SETTINGS, {
    generateAuthenticationOptions: async () => ({ challenge: 'c' }),
    verifyAuthenticationResponse: () => new Promise((resolveResult) => { finish = resolveResult })
  })
  const options = await auth.post(m.REMOTE_AUTH_ROUTES.loginOptions, {}, 'http://localhost:7780')
  const pending = auth.post(m.REMOTE_AUTH_ROUTES.loginVerify, { challengeId: options.body.challengeId, response: { id: 'credential', response: {} } }, 'http://localhost:7780')
  store.revoke(d.id)
  finish({ verified: true, authenticationInfo: { newCounter: 1 } })
  await assert.rejects(pending, { code: 'unauthorized' })
  assert.deepEqual(JSON.parse(readFileSync(join(store.file), 'utf8')).sessions, [])
})

test('Origin must exactly match the public origin or the local configured port', () => {
  const settings = { ...m.DEFAULT_REMOTE_SETTINGS, remotePublicUrl: 'https://1-2-3-4.sslip.io' }
  assert.equal(m.remoteIdentity(settings).rpID, '1-2-3-4.sslip.io')
  for (const origin of ['https://1-2-3-4.sslip.io', 'http://localhost:7780']) assert.equal(m.allowedOrigin(origin, settings), true)
  for (const origin of [undefined, 'null', 'http://127.0.0.1:7780', 'http://localhost:7781', 'https://1-2-3-4.sslip.io.evil.test', 'https://1-2-3-4.sslip.io/']) {
    assert.equal(m.allowedOrigin(origin, settings), false, String(origin))
  }
  for (const remotePublicUrl of ['http://public.test', 'https://user:pass@public.test', 'https://public.test/path', 'https://127.0.0.1', 'https://public.test/?a=1']) {
    assert.throws(() => m.remoteIdentity({ ...settings, remotePublicUrl }), { code: 'invalid_settings' })
  }
})

test('remote access is disabled in a new profile; legacy settings gain defaults', (t) => {
  const dir = temp(t)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ chatFontSize: 17 }))
  const store = m.SettingsStore.at(dir)
  assert.equal(store.get().remoteEnabled, false)
  assert.equal(store.get().remotePort, 7780)
  assert.equal(store.get().remotePublicUrl, '')
  assert.equal(store.get().chatFontSize, 17)
})

test('login/pair attempts are rate limited and recover after the window', () => {
  let now = 1
  const limiter = new m.AttemptLimiter(() => now)
  for (let i = 0; i < 30; i++) limiter.check('127.0.0.1')
  assert.throws(() => limiter.check('127.0.0.1'), { code: 'rate_limited', status: 429 })
  now += 60_000
  assert.doesNotThrow(() => limiter.check('127.0.0.1'))
})

test('successful registration consumes code only once, even with two verified challenges', async (t) => {
  const store = new m.RemoteAuthStore(join(temp(t), 'auth.json'))
  let serial = 0
  const verifier = {
    generateRegistrationOptions: async () => ({ challenge: `c${++serial}` }),
    verifyRegistrationResponse: async (options) => {
      assert.equal(options.requireUserVerification, true)
      assert.equal(options.expectedOrigin, 'http://localhost:7780')
      return { verified: true, registrationInfo: { credential: { id: `id-${options.expectedChallenge}`, publicKey: new Uint8Array([1, 2]), counter: 0 } } }
    }
  }
  const auth = new m.RemoteAuth(store, () => m.DEFAULT_REMOTE_SETTINGS, verifier)
  const code = auth.codes.create().code
  const one = await auth.post(m.REMOTE_AUTH_ROUTES.registerOptions, { code }, 'http://localhost:7780')
  const two = await auth.post(m.REMOTE_AUTH_ROUTES.registerOptions, { code }, 'http://localhost:7780')
  const results = await Promise.allSettled([one, two].map((r) => auth.post(m.REMOTE_AUTH_ROUTES.registerVerify, { challengeId: r.body.challengeId, response: {} }, 'http://localhost:7780')))
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(store.devices().length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'invalid_pairing_code')
  assert.ok(results.find((r) => r.status === 'fulfilled').value.cookie.includes('HttpOnly'))
})

test('failed WebAuthn verification cannot create a device/session or consume a pairing code', async (t) => {
  const store = new m.RemoteAuthStore(join(temp(t), 'auth.json'))
  const auth = new m.RemoteAuth(store, () => m.DEFAULT_REMOTE_SETTINGS, {
    generateRegistrationOptions: async () => ({ challenge: 'c' }),
    verifyRegistrationResponse: async () => { throw new Error('signature mismatch') }
  })
  const code = auth.codes.create().code
  const options = await auth.post(m.REMOTE_AUTH_ROUTES.registerOptions, { code }, 'http://localhost:7780')
  await assert.rejects(auth.post(m.REMOTE_AUTH_ROUTES.registerVerify, { challengeId: options.body.challengeId, response: {} }, 'http://localhost:7780'), { code: 'invalid_authentication', status: 403 })
  assert.deepEqual(store.devices(), [])
  assert.doesNotThrow(() => auth.codes.check(code))
})

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
function websocket(port, token, origin = `http://localhost:${port}`) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: `localhost:${port}`, ...(origin ? { Origin: origin } : {}), ...(token ? { Cookie: `drover_session=${token}` } : {}) } })
}
async function rejectedUpgrade(port, token, origin) {
  const ws = websocket(port, token, origin)
  ws.on('error', () => {})
  return new Promise((resolveResult, reject) => {
    ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolveResult(res.statusCode) })
    ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected successful upgrade')) })
  })
}

test('HTTP/WS enforce sessions, Origin and isolated terminal events; device revocation closes WS', async (t) => {
  const dir = temp(t), port = await freePort(), origin = `http://localhost:${port}`
  const web = join(dir, 'web')
  mkdirSync(join(web, 'auth/assets'), { recursive: true })
  mkdirSync(join(web, 'assets'))
  writeFileSync(join(web, 'index.html'), '<html>app</html>')
  writeFileSync(join(web, 'auth/index.html'), '<html>login</html>')
  writeFileSync(join(web, 'auth/assets/login.js'), 'auth')
  writeFileSync(join(web, 'assets/app.js'), 'private app')
  writeFileSync(join(dir, 'secret.json'), 'secret')
  symlinkSync(join(dir, 'secret.json'), join(web, 'assets/leak.json'))
  const store = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
  const d = device(store)
  const token = store.issueSession(d.id, origin).token
  const handlers = new m.RpcHandlers()
  handlers.register('app:init', () => ({ greeting: 'hello' }))
  handlers.register('term:open', () => ({ ok: true }))
  handlers.register('term:close', () => {})
  let settings = { ...m.DEFAULT_REMOTE_SETTINGS, remoteEnabled: true, remotePort: port }
  const server = new m.RemoteServer({ webRoot: web, userData: dir, attachmentsDir: join(dir, 'attachments'), handlers, settings: () => settings, saveSettings: (s) => { settings = s }, statusChanged: () => {} })
  handlers.register('push:key', () => server.pushPublicKey())
  handlers.register('push:status', (ctx) => server.pushStatus(ctx.remote?.deviceId))
  handlers.register('push:subscribe', (ctx, subscription) => server.savePushSubscription(ctx.remote?.deviceId, subscription))
  handlers.register('push:unsubscribe', (ctx, endpoint) => server.deletePushSubscription(ctx.remote?.deviceId, endpoint))
  handlers.register('push:preferences', (ctx, patch) => server.setPushPreferences(ctx.remote?.deviceId, patch))
  t.after(() => server.stop())
  await server.sync()
  assert.equal(server.status().running, true)
  assert.equal(server.server.address().address, '127.0.0.1')
  const request = (path, options = {}, auth = false) => new Promise((done, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { Host: `localhost:${port}`, ...(auth ? { Cookie: `drover_session=${token}` } : {}), ...options.headers }
    }, (res) => {
      const chunks = []
      res.on('data', (data) => chunks.push(data))
      res.on('end', () => done({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
  assert.equal((await request('/')).status, 302)
  assert.equal((await request('/login')).status, 200)
  assert.equal((await request('/pair?code=foo')).status, 200)
  assert.equal((await request('/auth/assets/login.js')).status, 200)
  assert.equal((await request('/assets/app.js')).status, 401)
  assert.equal((await request('/assets/app.js', {}, true)).status, 200)
  assert.equal((await request('/push/key')).status, 401)
  const publicKey = await (await request('/push/key', {}, true)).json()
  assert.equal(typeof publicKey, 'string')
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65)
  assert.equal((await request('/push/subscribe', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  assert.equal((await request('/push/preferences', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' }, true)).status, 403)
  assert.equal((await request('/push/preferences', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"finished":false}' }, true)).status, 200)
  assert.equal((await (await request('/push/status', {}, true)).json()).preferences.finished, false)
  assert.equal((await request('/assets/leak.json', {}, true)).status, 404)
  assert.deepEqual(await (await request('/auth/session')).json(), { authenticated: false })
  assert.equal((await (await request('/auth/session', {}, true)).json()).authenticated, true)
  assert.equal((await request('/auth/login/options', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
  assert.equal(await rejectedUpgrade(port, undefined, origin), 401)
  assert.equal(await rejectedUpgrade(port, token, 'https://evil.test'), 403)
  assert.equal(await rejectedUpgrade(port, token, ''), 403)
  const a = websocket(port, token), b = websocket(port, token)
  await Promise.all([once(a, 'open'), once(b, 'open')])
  t.after(() => { a.terminate(); b.terminate() })
  const received = [], otherReceived = []
  a.on('message', (data) => received.push(JSON.parse(data.toString())))
  b.on('message', (data) => otherReceived.push(JSON.parse(data.toString())))
  const waitFor = async (condition) => {
    const deadline = Date.now() + 3000
    while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.ok(condition(), 'WS result received')
  }
  a.send(JSON.stringify(call('init')))
  await waitFor(() => received.some((r) => r.id === '1'))
  assert.deepEqual(received.find((r) => r.id === '1').value, { greeting: 'hello' })
  a.send(JSON.stringify(call('pushStatus', [], 'push')))
  await waitFor(() => received.some((r) => r.id === 'push'))
  assert.equal(received.find((r) => r.id === 'push').value.preferences.finished, false, 'WS is bound to the cookie device')
  a.send(JSON.stringify(call('termOpen', ['terminal', 'w1:p1', 80, 24], '2')))
  await waitFor(() => received.some((r) => r.id === '2'))
  const subscribed = [...server.clients].find((c) => c.rpc.terminals.size)
  const internalId = subscribed.rpc.terminals.get('terminal')
  server.broadcast('term:frames', [internalId, [{ data: new Uint8Array([65, 66]) }]])
  await waitFor(() => received.some((r) => r.channel === 'term:frames'))
  assert.deepEqual(received.find((r) => r.channel === 'term:frames').args, ['terminal', [{ data: [65, 66] }]])
  assert.equal(otherReceived.some((r) => r.channel === 'term:frames'), false)
  const closeA = once(a, 'close'), closeB = once(b, 'close')
  server.revoke(d.id)
  assert.equal((await closeA)[0], 4001)
  assert.equal((await closeB)[0], 4001)
  assert.equal((await request('/assets/app.js', {}, true)).status, 401)
  await server.configure({ remoteEnabled: false })
  assert.equal(server.status().running, false)
})
