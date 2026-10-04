import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'

const dir = mkdtempSync(join(tmpdir(), 'drover-new-user-tests-'))
await build({ stdin: { contents: `
  export * from './src/renderer/src/auth-client'
  export * from './src/renderer/src/new-agent-kind'
  export { remotePhoneOrigin } from './src/shared/remote'
  export { setLanguage } from './src/renderer/src/i18n'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(dir, 'ui.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(dir, 'ui.cjs'))
rmSync(dir, { recursive: true })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
const problem = kind => error => error instanceof m.AuthScreenError && error.problem === kind
const kind = (kind, installed) => ({ kind, installed, binary: kind, label: kind, transcript: true })

test('phone pairing accepts HTTPS host origins; excludes local, IP, unsafe and non-origin URLs', () => {
  for (const address of ['', 'http://localhost:7780', 'https://localhost', 'https://a.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://192.168.1.3', 'http://drover.example', 'https://u:p@drover.example', 'https://drover.example/pair', 'https://drover.example/?code=x', 'https://drover.example/#x']) assert.equal(m.remotePhoneOrigin(address), null, address)
  assert.equal(m.remotePhoneOrigin(' https://drover.example/ '), 'https://drover.example')
  assert.equal(m.remotePhoneOrigin('https://drover.example:443'), null, 'use a canonical origin')
  assert.equal(m.remotePhoneOrigin('https://drover.example:8780'), 'https://drover.example:8780')
})

test('proxy errors and rate limits are identified before attempting to parse HTML', async () => {
  for (const status of [502, 503, 504]) {
    const response = new Response('<html>gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })
    let parsed = false; response.json = async () => { parsed = true; throw new Error('must not parse HTML') }
    await assert.rejects(m.readAuthResponse(response), problem('unavailable')); assert.equal(parsed, false)
  }
  await assert.rejects(m.readAuthResponse(new Response('limit', { status: 429 })), problem('rate_limited'))
})

test('auth distinguishes wrong origin/host, expired pairing, challenge and failed passkey verification', async () => {
  for (const code of ['invalid_origin', 'invalid_host', 'invalid_settings']) await assert.rejects(m.readAuthResponse(json({ error: { code } }, 403)), problem('address'))
  for (const code of ['invalid_pairing_code', 'pairing_expired']) await assert.rejects(m.readAuthResponse(json({ error: { code } }, 403)), problem('pairing_expired'))
  await assert.rejects(m.readAuthResponse(json({ error: { code: 'invalid_challenge' } }, 403)), problem('challenge_expired'))
  await assert.rejects(m.readAuthResponse(json({ error: { code: 'invalid_authentication' } }, 403)), problem('passkey'))
  await assert.rejects(m.readAuthResponse(json({ error: { code: 'unknown', message: 'INTERNAL SECRET' } }, 500)), error => problem('unknown')(error) && !m.authErrorText(error).includes('SECRET'))
})

test('wrong Content-Type, malformed JSON and wrong response shapes have readable errors', async () => {
  await assert.rejects(m.readAuthResponse(new Response('<html>wrong site</html>', { headers: { 'Content-Type': 'text/html' } })), problem('invalid_response'))
  await assert.rejects(m.readAuthResponse(new Response('false', { headers: { 'Content-Type': 'application/json' } })), problem('invalid_response'))
  await assert.rejects(m.readAuthResponse(new Response('broken', { headers: { 'Content-Type': 'application/json' } })), problem('invalid_response'))
  await assert.rejects(m.readAuthResponse(json([], 200)), problem('invalid_response'))
  for (const value of [{}, { challengeId: 'id', options: {} }, { challengeId: 42, options: { challenge: 'value' } }]) assert.throws(() => m.checkedAuthOptions(value), problem('invalid_response'))
  const valid = { challengeId: 'id', options: { challenge: 'value' } }; assert.equal(m.checkedAuthOptions(valid), valid)
  assert.deepEqual(await m.readAuthResponse(json({ authenticated: false })), { authenticated: false })
})

test('passkey cancellation, RP/domain mismatch and authenticator errors stay distinct from network failures', async () => {
  for (const name of ['NotAllowedError', 'AbortError']) await assert.rejects(m.requestPasskey(async () => { throw new DOMException('raw details', name) }), problem('cancelled'))
  for (const error of [{ name: 'SecurityError' }, { code: 'ERROR_INVALID_RP_ID' }, { code: 'ERROR_INVALID_DOMAIN' }, { cause: { name: 'SecurityError' } }]) await assert.rejects(m.requestPasskey(async () => { throw error }), problem('address'))
  await assert.rejects(m.requestPasskey(async () => { throw new TypeError('authenticator internal text') }), problem('passkey'))
  assert.equal(await m.requestPasskey(async () => 'credential'), 'credential')
})

test('auth uses cookie-authenticated POST/GET and reports fetch failures without raw errors', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const requests = []; globalThis.fetch = async (url, options) => { requests.push({ url, options }); return json({ ok: true }) }
  assert.deepEqual(await m.authRequest('/auth/verify', { fixture: 1 }), { ok: true })
  await m.authRequest('/auth/session')
  assert.equal(requests[0].options.method, 'POST'); assert.equal(requests[0].options.credentials, 'same-origin')
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json'); assert.equal(requests[0].options.body, '{"fixture":1}')
  assert.equal(requests[1].options.method, 'GET'); assert.equal(requests[1].options.cache, 'no-store')
  globalThis.fetch = async () => { throw new TypeError('TLS internal details') }
  await assert.rejects(m.authRequest('/auth/session'), problem('network'))
})

test('new agent default falls back to an installed kind or plain terminal, respecting an installed preference', () => {
  const kinds = [kind('claude', false), kind('codex', true)]
  assert.equal(m.installedDefaultAgent('claude', kinds), 'codex')
  assert.equal(m.installedDefaultAgent('codex', kinds), 'codex')
  assert.equal(m.installedDefaultAgent('unknown', kinds), 'codex')
  assert.equal(m.installedDefaultAgent('claude', []), null)
  assert.equal(m.installedDefaultAgent('claude', [kind('claude', false)]), null)
  assert.equal(m.installedDefaultAgent(null, kinds), null)
})

test('every auth failure has a translated actionable message in all five languages', t => {
  const previous = globalThis.document; globalThis.document = { documentElement: {} }; t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document })
  for (const language of ['en', 'ru', 'de', 'es', 'zh']) {
    m.setLanguage(language)
    const messages = ['unavailable', 'rate_limited', 'address', 'pairing_expired', 'challenge_expired', 'passkey', 'cancelled', 'network', 'invalid_response', 'unknown'].map(kind => m.authErrorText(new m.AuthScreenError(kind)))
    assert.equal(new Set(messages).size, 10)
    assert.ok(messages.every(message => message.trim().length > 0))
    if (language !== 'en') assert.ok(!messages[0].startsWith('Drover on your Mac'))
  }
  m.setLanguage('en')
})

async function envBundle(t) {
  const root = mkdtempSync(join(tmpdir(), 'drover-login-env-test-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  await build({ stdin: { contents: "export * from './src/main/env'; export {HerdrService} from './src/main/herdr/service'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'env.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent', plugins: [{ name: 'isolated-shell-and-herdr', setup(b) {
    b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child', namespace: 'fixture' }))
    b.onResolve({ filter: /^\.\/cli$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'cli', namespace: 'fixture' } : undefined)
    b.onResolve({ filter: /^\.\/client$/ }, args => args.importer.endsWith('/herdr/service.ts') ? { path: 'client', namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'child' ? 'export const spawn = (...args) => globalThis.__droverTestSpawn(...args)' : args.path === 'cli' ? `
      export const findHerdr = env => env.PATH.includes('fixture-installed') ? '/fixture/herdr' : null
      export const listSessions = async () => []; export const defaultSocketPath = () => '/fixture/socket'
      export const startServer = () => { throw new Error('Test must not start a real server') }
      export const herdrVersion = async () => 'fixture'; export const runHerdr = async () => ({}); export const sessionArgs = () => []
    ` : `export class HerdrClient {
      async request(method) { return method === 'ping' ? {version: 'fixture'} : {snapshot: {panes: [], agents: [], workspaces: [], tabs: [], layouts: []}} }
      subscribe() { return {closed: false, close(){this.closed = true}} }
    }` }))
  } }] })
  return { root, env: createRequire(import.meta.url)(join(root, 'env.cjs')) }
}
function shell(t) {
  const children = [], previous = globalThis.__droverTestSpawn; t.after(() => { if (previous) globalThis.__droverTestSpawn = previous; else delete globalThis.__droverTestSpawn })
  globalThis.__droverTestSpawn = (_exe, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {}
    const mark = args[1].match(/__DROVER_ENV_\d+__/)[0]
    child.finish = env => { child.stdout.emit('data', Buffer.from(mark + JSON.stringify(env) + mark)); child.emit('close') }
    children.push(child); return child
  }
  return children
}

test('explicit environment refresh re-reads PATH and uncached agent binaries without restarting Drover', async t => {
  const { root, env } = await envBundle(t), children = shell(t)
  const first = env.loginEnv(); children[0].finish({ PATH: '/fixture-missing' }); const before = await first
  assert.equal(env.loginEnv(), first); assert.equal(children.length, 1)
  assert.equal(env.which('new-user-fixture-agent', before), null)
  writeFileSync(join(root, 'new-user-fixture-agent'), 'fixture only')
  const fresh = env.loginEnv(true); children[1].finish({ PATH: root }); const after = await fresh
  assert.equal(children.length, 2); assert.equal(env.loginEnv(), fresh)
  assert.equal(env.which('new-user-fixture-agent', after), join(root, 'new-user-fixture-agent'))
})

test('reconnect discovers a newly installed herdr; stale shell resolution cannot overwrite the new environment', async t => {
  const { env } = await envBundle(t), children = shell(t)
  const service = new env.HerdrService({ logDir: '/fixture', autoStartServer: () => false }); t.after(() => service.stop())
  const starting = service.start('isolated-fixture')
  const reconnecting = service.start('isolated-fixture', true)
  assert.equal(children.length, 2)
  children[1].finish({ PATH: '/fixture-installed' }); await reconnecting
  assert.equal(service.herdrPath, '/fixture/herdr'); assert.equal(service.connection.status, 'connected')
  children[0].finish({ PATH: '/fixture-missing' }); await starting
  assert.ok(service.env.PATH.includes('/fixture-installed'))
  assert.equal(service.connection.status, 'connected')
})
