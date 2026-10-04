import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import ts from 'typescript'

const bundled = mkdtempSync(join(tmpdir(), 'drover-security-tests-'))
await build({ stdin: { contents: `
 export * from './src/main/remote/rpc'
 export * from './src/main/remote/security'
 export * from './src/main/remote/validation'
 export * from './src/main/remote/store'
 export * from './src/main/remote/server'
 export * from './src/shared/remote'
 export { DEFAULT_SETTINGS } from './src/shared/types'
 export { SettingsStore } from './src/main/settings'
 export { logoutRemote } from './src/renderer/src/remote-session'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'security.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const bundleSource = readFileSync(join(bundled, 'security.cjs'))
const require = createRequire(import.meta.url)
const m = require(join(bundled, 'security.cjs'))
rmSync(bundled, { recursive: true })
const call = (method, args = []) => ({ t: 'call', id: 'test', method, args })
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'drover-security-case-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p }
async function fixture(t, extra = {}) {
 const dir = temp(t), p = await port(), origin = `http://localhost:${p}`
 const settings = m.SettingsStore.at(dir); settings.set({ remoteEnabled: true, remotePort: p }); settings.flush()
 const auth = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
 const device = auth.addDevice({ name: 'Owner', rpID: 'localhost', userID: 'test', credential: { id: 'cred', publicKey: 'AA', counter: 0 } })
 const token = auth.issueSession(device.id, origin).token
 const handlers = new m.RpcHandlers(), statuses = [], warnings = []
 const server = new m.RemoteServer({ webRoot: dir, userData: dir, attachmentsDir: join(dir, 'attachments'), handlers, settings: () => settings.get(), saveSettings: s => { settings.set(s); settings.flush() }, statusChanged: s => statuses.push(s), persistenceWarning: (error, poisonSaved) => warnings.push({ error, poisonSaved }), ...extra })
 t.after(() => server.stop())
 t.after(() => rmSync(m.authPoisonPaths(join(dir, 'remote-auth.json'))[1], { force: true }))
 server.devices() // Load before injecting disk failures.
 await server.sync()
 const http = (path, { body = '{}', auth = false, headers = {}, method = 'POST' } = {}) => new Promise((done, reject) => {
  const req = request({ hostname: '127.0.0.1', port: p, path, method, agent: false, headers: { Host: `localhost:${p}`, Origin: origin, 'Content-Type': 'application/json', ...(auth ? { Cookie: `drover_session=${token}` } : {}), ...headers } }, res => {
   const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
  }); req.on('error', reject); req.end(method === 'GET' ? undefined : body)
 })
 return { dir, p, origin, settings, server, token, auth, device, handlers, statuses, warnings, http }
}

test('nested request allowlist denies raw reads/control APIs and validates fields; shell keys require this connection subscription', async () => {
 const handlers = new m.RpcHandlers(), invoked = []
 handlers.register('herdr:request', (_ctx, ...args) => { invoked.push(args); return { ok: true } })
 handlers.register('term:open', () => ({ ok: true })); handlers.register('term:close', () => {})
 const a = new m.RemoteRpcConnection('a'), b = new m.RemoteRpcConnection('b')
 for (const method of ['pane.read', 'pane.process_info', 'pane.list', 'session.snapshot', 'pane.run', 'agent.start', 'server.stop', 'workspace.create', 'toString', '__proto__']) assert.equal((await m.dispatchRemoteRpc(handlers, a, call('request', [method, { pane_id: 'w1:p1' }]))).error.code, 'not_available_remotely')
 for (const params of [{}, { pane_id: null }, { pane_id: 'w1:p1', extra: true }, { pane_id: '../other' }]) assert.equal((await m.dispatchRemoteRpc(handlers, a, call('request', ['pane.focus', params]))).error.code, 'invalid_args')
 assert.equal(invoked.length, 0)
 assert.equal((await m.dispatchRemoteRpc(handlers, a, call('request', ['pane.focus', { pane_id: 'w1:p1' }, null]))).ok, true)
 const keys = call('request', ['pane.send_keys', { pane_id: 'w1:p1', keys: ['ctrl+c'] }])
 assert.equal((await m.dispatchRemoteRpc(handlers, a, keys)).error.code, 'not_subscribed')
 await m.dispatchRemoteRpc(handlers, a, call('termOpen', ['w1:p1#1', 'w1:p1', 80, 24]))
 assert.equal((await m.dispatchRemoteRpc(handlers, b, keys)).error.code, 'not_subscribed')
 assert.equal((await m.dispatchRemoteRpc(handlers, a, keys)).ok, true)
 await m.dispatchRemoteRpc(handlers, a, call('termClose', ['w1:p1#1']))
 assert.equal((await m.dispatchRemoteRpc(handlers, a, keys)).error.code, 'not_subscribed')
 assert.equal((await m.dispatchRemoteRpc(handlers, a, call('request', ['agent.send_keys', { target: 'w1:p1', keys: ['$(shell)'] }]))).error.code, 'invalid_args')
})

test('herdr request allowlist contains exactly the action methods used by the renderer', () => {
 const used = new Set()
 const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [])
 for (const file of files('src/renderer/src')) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
   if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'call' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) used.add(node.arguments[0].text)
   ts.forEachChild(node, visit)
  }
  visit(source)
 }
 assert.deepEqual([...m.REMOTE_HERDR_METHODS].sort(), [...used].sort())
})

test('RPC rejects malformed types/ranges/fields before invoking handlers or changing subscriptions', async () => {
 const h = new m.RpcHandlers(), c = new m.RemoteRpcConnection('a'); let invoked = 0
 for (const channel of new Set(Object.values(m.REMOTE_METHOD_CHANNELS))) h.register(channel, () => { invoked++; return { ok: true } })
 const cases = [
  ['init', [1]], ['setSettings', [{ appearance: null }]], ['setSettings', [{ unknown: true }]], ['setSettings', [{ language: 'xx' }]], ['setSettings', [{ chatFontSize: 999 }]], ['setSettings', [{ syncFocus: 'yes' }]],
  ['setSettings', [{ appearance: { ...m.DEFAULT_SETTINGS.appearance, glass: -1 } }]], ['setSettings', [{ appearance: { ...m.DEFAULT_SETTINGS.appearance, background: null } }]], ['setSettings', [{ appearance: { ...m.DEFAULT_SETTINGS.appearance, customThemes: [null] } }]],
  ['termOpen', ['t', 'w1:p1', -1, 24]], ['termOpen', ['t', 'w1:p1', 80.5, 24]], ['termOpen', ['t', 'w1:p1', 80, 24, true]], ['termInput', ['t', {}]], ['termInputBytes', ['t', '<not base64>']], ['termResize', ['t', Infinity, 20]], ['termScroll', ['t', 'left', -1]],
  ['transcriptSubscribe', [null]], ['watchTasks', [123]], ['watchTasks', ['relative']], ['updateTask', ['/project', 'task', { status: 'broken' }]], ['updateTask', ['/project', 'task', { id: 'other' }]], ['addTask', ['/project', '']],
  ['setAgentModel', ['w1:p1', 'claude', { model: {}, extra: true }]], ['sendPrompt', [{ paneId: 'w1:p1', target: 'w1:p2', agentKind: null, text: 'hello', imagePaths: [], isShell: true }]],
  ['createAgent', [{ workspaceId: 'w1', folder: null, kind: null, name: null, placement: 'bad', args: 'shell' }]], ['setSelectedPane', [{}]], ['setPushPreferences', [{ finished: 'true' }]]
 ]
 for (const [method, args] of cases) assert.equal((await m.dispatchRemoteRpc(h, c, call(method, args))).ok, false, method)
 assert.equal(invoked, 0); assert.equal(c.terminals.size, 0); assert.equal(c.terminalTargets.size, 0); assert.equal(c.tasks.size, 0); assert.equal(c.transcripts.size, 0)
 assert.equal((await m.dispatchRemoteRpc(h, c, call('setSettings', [{ language: 'ru', appearance: m.DEFAULT_SETTINGS.appearance }]))).ok, true)
 assert.equal(invoked, 1)
})

test('invalid setSettings never mutates/saves settings; corrupted persisted fields cannot break startup', t => {
 const dir = temp(t), s = m.SettingsStore.at(dir); s.flush(); const disk = readFileSync(join(dir, 'settings.json'), 'utf8'), previous = s.get()
 for (const patch of [{ appearance: null }, { roles: {} }, { agentArgs: [] }, { showLimits: 'yes' }, { terminalFontSize: NaN }, { appearance: { ...m.DEFAULT_SETTINGS.appearance, background: { kind: 'none' } } }]) assert.throws(() => s.set(patch), { code: 'invalid_args' })
 assert.equal(s.get(), previous); assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), disk)
 writeFileSync(join(dir, 'settings.json'), JSON.stringify({ appearance: null, language: 'xx', chatFontSize: 'wrong', agentModels: null, roles: {} }))
 const restored = m.SettingsStore.at(dir).get(); assert.deepEqual(restored.appearance, m.DEFAULT_SETTINGS.appearance); assert.equal(restored.language, 'system'); assert.deepEqual(restored.agentModels, {}); assert.deepEqual(restored.roles, [])
})

test('failed device revocation closes WS/server, warns on Mac and refuses reopening until restart', async t => {
 const f = await fixture(t), authFile = join(f.dir, 'remote-auth.json'), backup = authFile + '.backup'
 const ws = new WebSocket(`ws://127.0.0.1:${f.p}/ws`, { headers: { Host: `localhost:${f.p}`, Origin: f.origin, Cookie: `drover_session=${f.token}` } }); await once(ws, 'open')
 const closed = once(ws, 'close')
 renameSync(authFile, backup); mkdirSync(authFile)
 await assert.rejects(f.server.revoke(f.device.id)); await closed
 assert.equal(f.server.status().running, false); assert.ok(f.server.status().error); assert.ok(f.statuses.at(-1).error)
 assert.equal(m.SettingsStore.at(f.dir).get().remoteEnabled, false, 'restart must remain disabled')
 await f.server.sync(); assert.equal(f.server.status().running, false)
 await assert.rejects(f.server.configure({ remoteEnabled: true })); assert.equal(f.server.status().running, false)
 assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0].poisonSaved, true)
 assert.match(f.warnings[0].error, /stopped until Drover restarts/)
 rmSync(authFile, { recursive: true }); renameSync(backup, authFile)
 await assert.rejects(f.server.configure({ remoteEnabled: true }), { code: 'remote_restart_required' })
 await f.server.sync(); assert.equal(f.server.status().running, false)
 const settings = m.SettingsStore.at(f.dir)
 const restarted = new m.RemoteServer({ webRoot: f.dir, userData: f.dir, attachmentsDir: join(f.dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings.get(), saveSettings: s => { settings.set(s); settings.flush() }, statusChanged: () => {} })
 t.after(() => restarted.stop()); await restarted.configure({ remoteEnabled: true })
 assert.equal(restarted.status().running, true)
 assert.deepEqual(new m.RemoteAuthStore(authFile).devices(), [])
 assert.equal(new m.RemoteAuthStore(authFile).session(f.token, f.origin), undefined)

})

test('SettingsStore.flush propagates disk errors; failed disable stops remote until settings save succeeds, including restart', async t => {
 const f = await fixture(t), tmp = join(f.dir, 'settings.json.tmp'); mkdirSync(tmp)
 assert.throws(() => f.settings.flush())
 await assert.rejects(f.server.configure({ remoteEnabled: false })); assert.equal(f.server.status().running, false); assert.ok(f.server.status().error)
 const loaded = m.SettingsStore.at(f.dir)
 const restarted = new m.RemoteServer({ webRoot: f.dir, userData: f.dir, attachmentsDir: join(f.dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => loaded.get(), saveSettings: s => { loaded.set(s); loaded.flush() }, statusChanged: () => {} })
 t.after(() => restarted.stop()); await restarted.sync(); assert.equal(restarted.status().running, false)
 rmSync(tmp, { recursive: true })
 await assert.rejects(f.server.configure({ remoteEnabled: false }), { code: 'remote_restart_required' })
 await restarted.configure({ remoteEnabled: false })
 assert.equal(f.server.status().running, false); assert.equal(m.SettingsStore.at(f.dir).get().remoteEnabled, false)
})

test('failed revoke and failed disabled-state write followed by restart can never resurrect the old session', async t => {
 const f = await fixture(t), file = join(f.dir, 'remote-auth.json'), backup = file + '.backup'
 renameSync(file, backup); mkdirSync(file)
 mkdirSync(join(f.dir, 'settings.json.tmp'))
 await assert.rejects(f.server.revoke(f.device.id))
 assert.equal(f.server.status().running, false)
 assert.equal(m.SettingsStore.at(f.dir).get().remoteEnabled, true, 'both writes failed, leaving the enabled settings on disk')
 assert.ok(statSync(file + '.poison').isFile(), 'small poison marker is recorded only after a real save failure')
 await f.server.stop()
 rmSync(file, { recursive: true }); renameSync(backup, file)
 rmSync(join(f.dir, 'settings.json.tmp'), { recursive: true })
 const settings = m.SettingsStore.at(f.dir)
 const restarted = new m.RemoteServer({ webRoot: f.dir, userData: f.dir, attachmentsDir: join(f.dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings.get(), saveSettings: s => { settings.set(s); settings.flush() }, statusChanged: () => {} })
 t.after(() => restarted.stop()); await restarted.sync()
 assert.equal(restarted.status().running, true)
 assert.deepEqual(restarted.devices(), [], 'all old credentials require pairing again')
 assert.equal((await f.http('/attachments/upload', { auth: true })).status, 401)
 assert.equal(JSON.parse((await f.http('/auth/session', { auth: true, method: 'GET' })).body).authenticated, false)
 await restarted.stop()
 assert.equal(new m.RemoteAuthStore(file).session(f.token, f.origin), undefined)
 assert.deepEqual(new m.RemoteAuthStore(file).devices(), [], 'invalidated data was durably replaced')
})

test('clean shutdown preserves paired devices and sessions across restart', async t => {
 const f = await fixture(t)
 await f.server.stop()
 const restored = new m.RemoteAuthStore(join(f.dir, 'remote-auth.json'))
 assert.equal(restored.session(f.token, f.origin).device.id, f.device.id)
})

test('debounced settings save reports disk errors without an unhandled timer exception', async t => {
 const dir = temp(t), s = m.SettingsStore.at(dir)
 mkdirSync(join(dir, 'settings.json.tmp'))
 t.mock.method(console, 'error', () => {})
 const failure = new Promise(done => s.onSaveError(done))
 s.set({ language: 'ru' })
 const error = await failure
 assert.ok(error instanceof Error); assert.match(error.message, /EISDIR/)
})

test('only explicitly trusted proxy supplies a single validated forwarded IP; independent visitor and global limits recover', () => {
 for (const forwarded of ['198.51.100.1', '198.51.100.1, 1.2.3.4', ['198.51.100.1'], 'bad']) assert.equal(m.visitorAddress('127.0.0.1', forwarded), '127.0.0.1')
 assert.equal(m.visitorAddress('10.0.0.2', '198.51.100.1', '127.0.0.1'), '10.0.0.2')
 assert.equal(m.visitorAddress('::ffff:127.0.0.1', '198.51.100.1', '127.0.0.1'), '198.51.100.1')
 assert.equal(m.visitorAddress('127.0.0.1', '2001:db8::1', '127.0.0.1'), '2001:db8::1')
 assert.equal(m.visitorAddress('127.0.0.1', '198.51.100.1, 1.2.3.4', '127.0.0.1'), '127.0.0.1')
 let now = 1; const limiter = new m.AttemptLimiter(() => now)
 for (let n = 0; n < 30; n++) limiter.check('attacker')
 for (let n = 0; n < 100; n++) assert.throws(() => limiter.check('attacker'), { code: 'rate_limited' })
 assert.doesNotThrow(() => limiter.check('owner'))
 for (let n = 0; n < 89; n++) limiter.check(`other-${n}`)
 assert.throws(() => limiter.check('another'), { code: 'rate_limited' }); now += 60000; assert.doesNotThrow(() => limiter.check('owner'))
})

test('HTTP trusted-proxy visitors have separate login budgets; authenticated owner survives exhausted unauthenticated global budget', async t => {
 const f = await fixture(t)
 await f.server.configure({ remoteBehindProxy: true })
 f.handlers.register('push:preferences', () => ({ finished: true, blocked: true }))
 for (let n = 0; n < 30; n++) assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 403)
 assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 429)
 assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 403)
 for (let n = 0; n < 89; n++) await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': `203.0.113.${n + 1}` } })
 assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 429)
 assert.equal((await f.http('/push/preferences', { auth: true })).status, 200)
 const ws = new WebSocket(`ws://127.0.0.1:${f.p}/ws`, { headers: { Host: `localhost:${f.p}`, Origin: f.origin, Cookie: `drover_session=${f.token}` } }); await once(ws, 'open'); ws.close(); await once(ws, 'close')
})

test('proxy default follows public HTTPS address; explicit choice persists and invalid choices never change settings', t => {
 const dir = temp(t), file = join(dir, 'settings.json')
 const store = m.SettingsStore.at(dir)
 assert.equal(m.remoteUsesProxy(store.get()), false)
 store.set({ remotePublicUrl: 'https://public.example.test' }); store.flush()
 assert.equal(m.remoteUsesProxy(m.SettingsStore.at(dir).get()), true, 'existing HTTPS settings need no environment variable or migration')
 store.set({ remoteBehindProxy: false }); store.flush()
 assert.equal(m.remoteUsesProxy(m.SettingsStore.at(dir).get()), false)
 const before = readFileSync(file, 'utf8'), previous = store.get()
 for (const value of ['true', 1, null, undefined, {}]) {
  assert.throws(() => m.validateRemoteSettings({ remoteBehindProxy: value }, previous), { code: 'invalid_settings' })
  assert.throws(() => store.set({ remoteBehindProxy: value }), { code: 'invalid_args' })
 }
 assert.equal(store.get(), previous); assert.equal(readFileSync(file, 'utf8'), before)
 assert.throws(() => m.validateSettingsPatch({ remoteBehindProxy: true }, true), { code: 'not_available_remotely' })
 const next = m.validateRemoteSettings({ remoteBehindProxy: true, remotePublicUrl: '' }, previous)
 store.set(next); store.flush()
 assert.equal(m.remoteUsesProxy(m.SettingsStore.at(dir).get()), true, 'explicit opt-in also works for a local address')
})

test('HTTP proxy disabled ignores forged forwarded addresses for login and logout limits', async t => {
 const f = await fixture(t)
 // HTTPS would enable trust automatically, but the saved choice must win.
 await f.server.configure({ remotePublicUrl: 'https://public.example.test', remoteBehindProxy: false })
 const headers = n => ({ Host: 'public.example.test', Origin: 'https://public.example.test', 'X-Forwarded-For': `198.51.100.${n + 1}` })
 for (let n = 0; n < 30; n++) assert.equal((await f.http('/auth/login/verify', { headers: headers(n) })).status, 403)
 assert.equal((await f.http('/auth/login/verify', { headers: headers(30) })).status, 429)
 for (let n = 0; n < 10; n++) assert.equal((await f.http('/auth/logout', { headers: headers(n) })).status, 200)
 assert.equal((await f.http('/auth/logout', { headers: headers(10) })).status, 429)
})

test('HTTP public HTTPS automatically trusts the local proxy for login and logout limits', async t => {
 const f = await fixture(t)
 await f.server.configure({ remotePublicUrl: 'https://public.example.test' })
 const headers = ip => ({ Host: 'public.example.test', Origin: 'https://public.example.test', 'X-Forwarded-For': ip })
 for (let n = 0; n < 30; n++) assert.equal((await f.http('/auth/login/verify', { headers: headers('198.51.100.1') })).status, 403)
 assert.equal((await f.http('/auth/login/verify', { headers: headers('198.51.100.1') })).status, 429)
 assert.equal((await f.http('/auth/login/verify', { headers: headers('198.51.100.2') })).status, 403)
 for (let n = 0; n < 10; n++) assert.equal((await f.http('/auth/logout', { headers: headers('198.51.100.1') })).status, 200)
 assert.equal((await f.http('/auth/logout', { headers: headers('198.51.100.1') })).status, 429)
 assert.equal((await f.http('/auth/logout', { headers: headers('198.51.100.2') })).status, 200)
})

test('test proxy override takes precedence over the persisted switch', async t => {
 const f = await fixture(t, { trustedProxy: '' })
 await f.server.configure({ remoteBehindProxy: true })
 for (let n = 0; n < 30; n++) assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': `198.51.100.${n + 1}` } })).status, 403)
 assert.equal((await f.http('/auth/login/verify', { headers: { 'X-Forwarded-For': '198.51.100.100' } })).status, 429)
})

test('environment proxy override is ignored in ordinary launches and available only to explicit tests', () => {
 for (const NODE_ENV of [undefined, 'production', 'development']) {
  assert.equal(m.testTrustedProxy({ NODE_ENV, DROVER_TRUSTED_PROXY_IP: '127.0.0.1' }), undefined)
 }
 assert.equal(m.testTrustedProxy({ NODE_ENV: 'test', DROVER_TRUSTED_PROXY_IP: '127.0.0.1' }), '127.0.0.1')
 assert.equal(m.testTrustedProxy({ NODE_ENV: 'test', DROVER_TRUSTED_PROXY_IP: '' }), '')
})

test('unknown logout does not write auth store; frequency is limited independently, valid logout clears/revokes the session', async t => {
 const f = await fixture(t), file = join(f.dir, 'remote-auth.json'), before = readFileSync(file), stamp = statSync(file).mtimeMs
 // Writes would fail now, proving fictitious cookies do not call store.save().
 const backup = file + '.backup'; renameSync(file, backup); mkdirSync(file)
 for (let n = 0; n < 10; n++) {
  const res = await f.http('/auth/logout', { headers: { Cookie: `drover_session=${'x'.repeat(43)}` } }); assert.equal(res.status, 200); assert.match(res.headers['set-cookie'][0], /Max-Age=0/)
 }
 assert.equal((await f.http('/auth/logout')).status, 429)
 assert.equal(f.server.status().running, true)
 rmSync(file, { recursive: true }); renameSync(backup, file)
 assert.deepEqual(readFileSync(file), before); assert.equal(statSync(file).mtimeMs, stamp)
 const res = await f.http('/auth/logout', { auth: true }); assert.equal(res.status, 200); assert.match(res.headers['set-cookie'][0], /Max-Age=0/)
 assert.equal(JSON.parse((await f.http('/auth/session', { method: 'GET', auth: true })).body).authenticated, false)
 assert.equal(new m.RemoteAuthStore(file).session(f.token, f.origin), undefined)
 assert.equal(readdirSync(f.dir).some(n => n.endsWith('.tmp')), false)
})

test('CSP connects only to the current HTTP/WS origins and restricts forms, locally and via public HTTPS', async t => {
 const f = await fixture(t)
 const local = (await f.http('/auth/session', { method: 'GET' })).headers['content-security-policy']
 assert.match(local, new RegExp(`connect-src http://localhost:${f.p} ws://localhost:${f.p};`)); assert.match(local, /form-action 'self'/); assert.doesNotMatch(local, /wss:;|localhost:\*/)
 await f.server.configure({ remotePublicUrl: 'https://public.example.test' })
 const pub = (await f.http('/auth/session', { method: 'GET', headers: { Host: 'public.example.test' } })).headers['content-security-policy']
 assert.match(pub, /connect-src https:\/\/public\.example\.test wss:\/\/public\.example\.test;/); assert.match(pub, /form-action 'self'/)
})

test('web Sign out posts cookie-authenticated JSON and navigates only after success; failures allow retry', async () => {
 let requestSeen, destination
 await m.logoutRemote(async (...args) => { requestSeen = args; return { ok: true } }, url => { destination = url })
 assert.equal(requestSeen[0], '/auth/logout'); assert.equal(requestSeen[1].method, 'POST'); assert.equal(requestSeen[1].credentials, 'same-origin'); assert.equal(requestSeen[1].body, '{}'); assert.equal(destination, '/login')
 destination = undefined
 await assert.rejects(m.logoutRemote(async () => ({ ok: false }), url => { destination = url }), /Could not sign out/)
 assert.equal(destination, undefined)
 await assert.rejects(m.logoutRemote(async () => { throw new Error('Offline') }, url => { destination = url }), /Offline/); assert.equal(destination, undefined)
})


test('SIGKILL and restart preserve paired devices and usable sessions, including legacy .active leftovers', async t => {
 const dir = temp(t), bundle = join(dir, 'child.cjs'), p = await port(), origin = `http://localhost:${p}`
 writeFileSync(bundle, bundleSource)
 const child = spawn(process.execPath, ['-e', `
 const m = require(process.argv[1]), dir = process.argv[2], port = Number(process.argv[3]);
 const { join } = require('node:path');
 (async () => {
  const store = new m.RemoteAuthStore(join(dir, 'remote-auth.json'));
  const d = store.addDevice({ name: 'Crash test phone', rpID: 'localhost', userID: 'test', credential: { id: 'cred', publicKey: 'AA', counter: 0 } });
  const token = store.issueSession(d.id, 'http://localhost:' + port).token;
  const settings = { ...m.DEFAULT_REMOTE_SETTINGS, remoteEnabled: true, remotePort: port };
  const server = new m.RemoteServer({ webRoot: dir, userData: dir, attachmentsDir: join(dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings, saveSettings: () => {}, statusChanged: () => {} });
  await server.sync(); if (!server.status().running) throw Error(server.status().error);
  console.log(JSON.stringify({ token, deviceId: d.id }));
 })().catch(e => { console.error(e); process.exit(1) });
 `, bundle, dir, String(p)], { stdio: ['ignore', 'pipe', 'pipe'] })
 t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
 let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
 const ready = await new Promise((resolve, reject) => {
  let stdout = ''
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('\n')) resolve(JSON.parse(stdout.trim())) })
  child.on('error', reject); child.on('exit', () => reject(new Error('child exited before ready: ' + stderr)))
 })
 const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
 const file = join(dir, 'remote-auth.json')
 assert.equal(m.authPoisonPaths(file).some(path => require('node:fs').existsSync(path)), false)
 mkdirSync(file + '.active') // Obsolete marker from the previous implementation.
 const restored = new m.RemoteAuthStore(file)
 assert.equal(restored.devices()[0].id, ready.deviceId)
 assert.equal(restored.session(ready.token, origin).device.id, ready.deviceId)
 const settings = { ...m.DEFAULT_REMOTE_SETTINGS, remoteEnabled: true, remotePort: p }
 const restarted = new m.RemoteServer({ webRoot: dir, userData: dir, attachmentsDir: join(dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings, saveSettings: () => {}, statusChanged: () => {} })
 t.after(() => restarted.stop()); await restarted.sync()
 const response = await fetch(`http://localhost:${p}/auth/session`, { headers: { Cookie: `drover_session=${ready.token}` } })
 assert.equal(response.status, 200)
 assert.equal((await response.json()).authenticated, true)
})

test('poison falls back to temporary storage when the whole profile is unwritable; restart requires pairing', async t => {
 const f = await fixture(t), backup = f.dir + '-offline', file = join(f.dir, 'remote-auth.json')
 renameSync(f.dir, backup); writeFileSync(f.dir, 'blocked profile')
 try {
  await assert.rejects(f.server.revoke(f.device.id))
  assert.equal(f.server.status().running, false)
  assert.equal(f.warnings[0].poisonSaved, true)
  assert.ok(statSync(m.authPoisonPaths(file)[1]).isFile())
 } finally { rmSync(f.dir); renameSync(backup, f.dir) }
 await assert.rejects(f.server.configure({ remoteEnabled: true }), { code: 'remote_restart_required' })
 const settings = m.SettingsStore.at(f.dir)
 const restarted = new m.RemoteServer({ webRoot: f.dir, userData: f.dir, attachmentsDir: join(f.dir, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings.get(), saveSettings: s => { settings.set(s); settings.flush() }, statusChanged: () => {} })
 t.after(() => restarted.stop()); await restarted.sync()
 assert.equal(restarted.status().running, true)
 assert.deepEqual(restarted.devices(), [])
 assert.equal(JSON.parse((await f.http('/auth/session', { auth: true, method: 'GET' })).body).authenticated, false)
 assert.equal(require('node:fs').existsSync(m.authPoisonPaths(file)[1]), false, 'poison removed only after durable empty-store recovery')
})

test('accepted total-write-failure risk is reported; current process stays closed even after disk recovery', async t => {
 const f = await fixture(t), file = join(f.dir, 'remote-auth.json'), backup = file + '.backup'
 const fs = require('node:fs'), originalOpen = fs.openSync, markers = m.authPoisonPaths(file)
 t.mock.method(fs, 'openSync', (path, ...args) => {
  if (markers.includes(path)) throw Object.assign(new Error('ENOSPC: cannot save poison anywhere'), { code: 'ENOSPC' })
  return originalOpen(path, ...args)
 })
 renameSync(file, backup); mkdirSync(file)
 await assert.rejects(f.server.revoke(f.device.id))
 assert.equal(f.server.status().running, false)
 assert.equal(f.warnings[0].poisonSaved, false)
 assert.match(f.warnings[0].error, /Unable to persist authorization invalidation/)
 rmSync(file, { recursive: true }); renameSync(backup, file); t.mock.restoreAll()
 await assert.rejects(f.server.configure({ remoteEnabled: true }), { code: 'remote_restart_required' })
 await f.server.sync(); assert.equal(f.server.status().running, false)
 assert.equal(markers.some(path => fs.existsSync(path)), false)
 // Explicitly accepted: without any persisted marker, old disk credentials
 // remain readable after restart. The stopped process never reopens them.
 assert.equal(new m.RemoteAuthStore(file).session(f.token, f.origin).device.id, f.device.id)
})

test('unrelated settings-write failure stops access without poisoning paired devices', async t => {
 const f = await fixture(t), tmp = join(f.dir, 'settings.json.tmp'), file = join(f.dir, 'remote-auth.json')
 mkdirSync(tmp)
 await assert.rejects(f.server.configure({ remotePublicUrl: '' }))
 assert.equal(f.server.status().running, false)
 assert.equal(m.authPoisonPaths(file).some(path => require('node:fs').existsSync(path)), false)
 assert.equal(new m.RemoteAuthStore(file).session(f.token, f.origin).device.id, f.device.id)
 assert.deepEqual(f.warnings, [])
 rmSync(tmp, { recursive: true }); await f.server.configure({ remoteEnabled: true })
 assert.equal(f.server.status().running, true)
})
