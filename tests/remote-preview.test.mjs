import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as netServer } from 'node:net'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import { WebSocket, WebSocketServer } from 'ws'

const bundled = mkdtempSync(join(tmpdir(), 'drover-preview-tests-'))
await build({
  stdin: { contents: `
    export * from './src/shared/remote'
    export * from './src/main/remote/preview'
    export * from './src/main/remote/transfers'
    export * from './src/main/remote/rpc'
    export * from './src/main/remote/store'
    export * from './src/main/remote/server'
  `, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'preview.cjs'),
  alias: { '@shared': resolve('src/shared') }, logLevel: 'silent'
})
const m = createRequire(import.meta.url)(join(bundled, 'preview.cjs'))
rmSync(bundled, { recursive: true })

function temp(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'drover-preview-case-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function freePort() {
  const server = netServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
/** A fake dev server that records what reaches it. */
async function upstream(t, handler) {
  const seen = []
  const server = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res) })
  const sockets = new Set()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((r) => { for (const socket of sockets) socket.destroy(); server.close(r) }))
  return { port: server.address().port, seen, server }
}
function get(port, path, headers = {}, method = 'GET') {
  return new Promise((done, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('agent tokens resolve only to loopback ports or local HTML pages', (t) => {
  const dir = temp(t), home = join(dir, 'home'), project = join(home, 'project')
  mkdirSync(join(project, 'site'), { recursive: true })
  writeFileSync(join(project, 'site/index.html'), '<h1>hi</h1>')
  writeFileSync(join(project, 'notes.txt'), 'x')
  writeFileSync(join(home, 'top.html'), 'x')
  const r = (raw) => m.resolvePreviewTarget(raw, project, home)
  assert.deepEqual(r('localhost:5173'), { kind: 'http', port: 5173, path: '/', label: 'localhost:5173' })
  assert.equal(r('5173').port, 5173)
  assert.equal(r('http://127.0.0.1:3000/app?x=1').path, '/app?x=1')
  assert.equal(r('http://[::1]:8080/').port, 8080)
  assert.equal(r('http://0.0.0.0:4000').port, 4000)
  assert.equal(r('http://app.localhost:4000').port, 4000)
  for (const evil of ['https://example.com', 'http://localhost.evil.test:80', 'http://127.0.0.1.nip.io:80', 'http://169.254.169.254/latest',
    'http://localhost:80@evil.test/', 'http://user:pass@localhost:3000/', 'http://10.0.0.5:3000']) assert.equal(r(evil), 'not_local', evil)
  assert.equal(r('https://localhost:5173'), 'unsupported')
  assert.equal(r('ftp://localhost/x'), 'unsupported')
  const page = r('site/index.html')
  assert.equal(page.kind, 'file')
  assert.equal(page.dir, join(project, 'site'))
  assert.equal(page.entry, 'index.html')
  assert.equal(page.label, 'site/index.html')
  assert.equal(r('./site/index.html').dir, join(project, 'site'))
  assert.equal(r('notes.txt'), 'unsupported')
  assert.equal(r('site/missing.html'), 'not_found')
  assert.equal(r('~/top.html'), 'unsupported', 'a page in the home folder would expose all of it')
  assert.equal(r('/etc'), 'not_found')
  assert.equal(r(''), 'no_preview')
  assert.equal(r('a/'.repeat(40) + 'x.html'), 'too_long')
})

async function setup(t, { source, now, previewOptions, background } = {}) {
  const dir = temp(t), port = await freePort(), origin = `http://localhost:${port}`
  const web = join(dir, 'web')
  mkdirSync(join(web, 'assets'), { recursive: true })
  writeFileSync(join(web, 'index.html'), '<html>app</html>')
  writeFileSync(join(web, 'assets/app.js'), 'private app')
  const store = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
  const device = store.addDevice({ name: 'Phone', rpID: 'localhost', userID: 'u', credential: { id: 'c', publicKey: 'AA', counter: 0 } })
  const session = store.issueSession(device.id, origin).token
  const handlers = new m.RpcHandlers()
  handlers.register('app:init', () => ({ secret: 'drover-api' }))
  let clock = Date.now()
  const settings = { ...m.DEFAULT_REMOTE_SETTINGS, remoteEnabled: true, remotePort: port }
  const server = new m.RemoteServer({ webRoot: web, userData: dir, attachmentsDir: join(dir, 'att'), handlers, settings: () => settings,
    saveSettings: () => {}, statusChanged: () => {}, background: background && (() => background(dir)), home: join(dir, 'home'), previewSource: (paneId) => source?.(paneId, dir) ?? null })
  t.after(() => server.stop())
  await server.sync()
  Object.assign(server.previews.opts, previewOptions)
  if (previewOptions) server.previews.transfers = new m.RemoteTransfers(previewOptions.maxConnections ?? 32, previewOptions.httpTimeoutMs ?? 60_000)
  // Tests drive time through the module's clock.
  if (now) server.previews.opts.now = () => clock
  return { dir, port, origin, store, device, session, server, tick: (ms) => { clock += ms } }
}

test('local pages: only files inside the page folder, safe types, no traversal or symlink escape', async (t) => {
  const ctx = await setup(t, { source: (_pane, dir) => ({ raw: 'site/index.html', cwd: join(dir, 'project'), project: 'p' }) })
  const site = join(ctx.dir, 'project/site')
  mkdirSync(join(site, 'img'), { recursive: true })
  mkdirSync(join(site, '.git'))
  writeFileSync(join(site, 'index.html'), '<h1>page</h1>')
  writeFileSync(join(site, 'img/a.png'), 'png')
  writeFileSync(join(site, 'run.sh'), 'rm -rf /')
  writeFileSync(join(site, '.env'), 'SECRET=1')
  writeFileSync(join(site, '.git/config'), 'x')
  writeFileSync(join(ctx.dir, 'project/secret.html'), 'outside')
  writeFileSync(join(ctx.dir, 'secret.txt'), 'outside')
  symlinkSync(join(ctx.dir, 'secret.txt'), join(site, 'leak.txt'))
  symlinkSync(join(ctx.dir, 'project'), join(site, 'up'))
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  assert.equal(link.ok, true)
  assert.equal(link.kind, 'file')
  const token = link.url.split('/')[2]
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '256-bit token')
  assert.ok(Buffer.from(token, 'base64url').length * 8 >= 128)
  const page = await get(ctx.port, link.url)
  assert.equal(page.status, 200)
  assert.match(page.body, /<h1>page<\/h1>$/)
  assert.equal(page.headers['content-security-policy'], 'sandbox allow-scripts allow-forms allow-popups')
  assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/)
  assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(page.headers['access-control-allow-credentials'], undefined)
  assert.equal((await get(ctx.port, `/preview/${token}/img/a.png`)).status, 200)
  assert.match((await get(ctx.port, `/preview/${token}/`)).body, /<h1>page<\/h1>$/)
  for (const bad of ['../secret.html', '..%2fsecret.html', '%2e%2e/secret.html', 'img/..%2f..%2fsecret.html', 'leak.txt', 'up/secret.html',
    'run.sh', '.env', '.git/config', '%2e%2e%2f%2e%2e%2fsecret.txt', 'img', 'nope.html', 'a%00.html']) {
    assert.equal((await get(ctx.port, `/preview/${token}/${bad}`)).status, 404, bad)
  }
  assert.equal((await get(ctx.port, `/preview/${token}/index.html`, {}, 'POST')).status, 405)
  // A made-up or truncated token reaches nothing.
  assert.equal((await get(ctx.port, `/preview/${'A'.repeat(43)}/index.html`)).status, 404)
  assert.equal((await get(ctx.port, `/preview/${token.slice(1)}/index.html`)).status, 404)
})

test('loopback proxy: only the agent port, no Drover cookie either way, rewritten redirects, sandbox headers', async (t) => {
  const dev = await upstream(t, (req, res) => {
    if (req.url === '/go') { res.writeHead(302, { Location: `http://localhost:${dev.port}/next?a=1` }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'drover_session=attacker; Path=/', 'Clear-Site-Data': '"cookies"',
      'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=1', 'Access-Control-Allow-Credentials': 'true' })
    res.end(`dev ${req.url}`)
  })
  const other = await upstream(t, (_req, res) => res.end('other port'))
  const ctx = await setup(t, { source: (pane) => pane === 'w1:p1' ? { raw: `localhost:${dev.port}/app`, cwd: null, project: 'p' }
    : pane === 'w1:p2' ? { raw: `http://example.com:${other.port}/`, cwd: null, project: 'p' } : null })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  assert.equal(link.ok, true)
  assert.equal(link.reachable, true)
  assert.equal(link.url.endsWith('/app'), true)
  const token = link.url.split('/')[2]
  const res = await get(ctx.port, `${link.url}?x=1`, { Cookie: `drover_session=${ctx.session}`, Authorization: 'Basic eDp5', Referer: `${ctx.origin}/`, 'X-Forwarded-For': '1.2.3.4' })
  assert.equal(res.status, 200)
  assert.match(res.body, /dev \/app\?x=1$/)
  const seen = dev.seen.at(-1)
  assert.equal(seen.headers.host, `localhost:${dev.port}`)
  for (const h of ['cookie', 'authorization', 'referer', 'x-forwarded-for']) assert.equal(seen.headers[h], undefined, h)
  for (const h of ['set-cookie', 'clear-site-data', 'strict-transport-security', 'access-control-allow-credentials']) assert.equal(res.headers[h], undefined, h)
  assert.equal(res.headers['content-security-policy'], 'sandbox allow-scripts allow-forms allow-popups')
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
  assert.equal(res.headers['access-control-allow-origin'], '*')
  const redirect = await get(ctx.port, `/preview/${token}/go`)
  assert.equal(redirect.headers.location, `/preview/${token}/next?a=1`)
  // The path can never name another host or port.
  await get(ctx.port, `/preview/${token}/http://localhost:${other.port}/`)
  await get(ctx.port, `/preview/${token}//localhost:${other.port}/`)
  assert.equal(other.seen.length, 0)
  assert.equal(dev.seen.at(-1).url, `//localhost:${other.port}/`)
  assert.deepEqual((await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p2' })).code, 'not_local')
  // Referer never routes non-capability URLs into a preview.
  assert.equal((await get(ctx.port, '/@vite/client', { Referer: `${ctx.origin}/preview/${token}/app` })).status, 401)
  const api = await get(ctx.port, '/auth/session', { Referer: `${ctx.origin}/preview/${token}/app`, Cookie: `drover_session=${ctx.session}` })
  assert.equal(JSON.parse(api.body).authenticated, true)
  assert.equal((await get(ctx.port, `/preview/${token}/auth/session`)).body.endsWith('dev /auth/session'), true)
  assert.equal(dev.seen.at(-1).headers.cookie, undefined)
  // Drover itself answers only with its own session, and a preview token is not one.
  assert.equal((await get(ctx.port, '/assets/app.js', { Cookie: `drover_session=${token}` })).status, 401)
  assert.equal((await get(ctx.port, '/auth/session', { Cookie: `drover_session=${ctx.session}` })).body.includes('"authenticated":true'), true)
})

test('preview links expire, die with the device and need a paired device', async (t) => {
  const dev = await upstream(t, (_req, res) => res.end('ok'))
  const ctx = await setup(t, { now: true, source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  await assert.rejects(ctx.server.previewLink(undefined, { paneId: 'w1:p1' }), { code: 'unauthorized' })
  await assert.rejects(ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1', recentId: 'x' }), { code: 'invalid_args' })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  assert.equal((await get(ctx.port, link.url)).status, 200)
  ctx.tick(m.REMOTE_PREVIEW_TTL_MS + 1)
  assert.equal((await get(ctx.port, link.url)).status, 404)
  const again = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  assert.equal((await get(ctx.port, again.url)).status, 200)
  // Recent previews of the project can be reopened by id.
  assert.equal(again.recent.length, 1)
  const reopened = await ctx.server.previewLink(ctx.device.id, { recentId: again.recent[0].id })
  assert.equal(reopened.ok, true)
  await ctx.server.revoke(ctx.device.id)
  assert.equal((await get(ctx.port, again.url)).status, 404)
})

test('WebSocket proxy reaches only the agent port; the Drover socket refuses a preview page', async (t) => {
  const dev = await upstream(t, (_req, res) => res.end('ok'))
  const wss = new WebSocketServer({ server: dev.server })
  wss.on('connection', (ws, req) => ws.on('message', (data) => ws.send(`${req.url}:${data}`)))
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${link.url}hmr`, { headers: { Host: `localhost:${ctx.port}`, Origin: 'null', Cookie: `drover_session=${ctx.session}` } })
  await once(ws, 'open')
  ws.send('ping')
  const [reply] = await once(ws, 'message')
  assert.equal(reply.toString(), '/hmr:ping')
  ws.close()
  const status = (path, headers) => new Promise((done) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}${path}`, { headers: { Host: `localhost:${ctx.port}`, ...headers } })
    socket.on('error', () => {})
    socket.once('unexpected-response', (_req, res) => { res.resume(); done(res.statusCode) })
    socket.once('open', () => { socket.terminate(); done(101) })
  })
  assert.equal(await status(`/preview/${'B'.repeat(43)}/hmr`, {}), 404)
  // A sandboxed page has Origin: null; the Drover API socket rejects it even with the cookie.
  assert.equal(await status('/ws', { Origin: 'null', Cookie: `drover_session=${ctx.session}` }), 403)
})

function bounded(promise, ms = 1500) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), ms) })]).finally(() => clearTimeout(timer))
}
function connectPreview(ctx, link, path = 'hmr') {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${link.url}${path}`, { headers: { Host: `localhost:${ctx.port}`, Origin: 'null' } })
  ws.on('error', () => {})
  return ws
}
async function echoServer(t) {
  const dev = await upstream(t, (_req, res) => res.end('ok'))
  const wss = new WebSocketServer({ server: dev.server })
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(data)))
  return dev
}

test('an already open preview WS is destroyed on revoke, including its upstream', async (t) => {
  const dev = await echoServer(t)
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const accepted = once(dev.server, 'upgrade')
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const ws = connectPreview(ctx, link)
  await bounded(once(ws, 'open'))
  const [, upSocket] = await accepted
  const upClosed = once(upSocket, 'close')
  const closed = once(ws, 'close')
  await ctx.server.revoke(ctx.device.id)
  await bounded(Promise.all([closed, upClosed]))
  await assert.rejects(ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' }), { code: 'unauthorized' })
})

test('token expiry destroys an open preview WS without another request', async (t) => {
  const dev = await echoServer(t)
  const ctx = await setup(t, { previewOptions: { ttlMs: 200 }, source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const ws = connectPreview(ctx, link)
  await bounded(once(ws, 'open'))
  await bounded(once(ws, 'close'))
  assert.equal((await get(ctx.port, link.url)).status, 404)
})

test('stop resolves with an open preview WS and a pending WS handshake', async (t) => {
  const dev = await echoServer(t)
  const stalled = await upstream(t, () => {})
  stalled.server.on('upgrade', () => {})
  const ctx = await setup(t, { source: (pane) => ({ raw: `localhost:${pane === 'open' ? dev.port : stalled.port}`, cwd: null, project: 'p' }) })
  const ws = connectPreview(ctx, await ctx.server.previewLink(ctx.device.id, { paneId: 'open' }))
  await bounded(once(ws, 'open'))
  const waiting = connectPreview(ctx, await ctx.server.previewLink(ctx.device.id, { paneId: 'pending' }))
  // Ensure the handshake is actually in flight, not just queued locally.
  await bounded(once(stalled.server, 'upgrade'))
  const closed = new Promise((done) => waiting.once('close', done))
  await bounded(ctx.server.stop())
  await bounded(closed)
  assert.equal(ctx.server.previews.transfers.active.size, 0)
})

test('WS handshakes have a wall deadline and HTTP/WS share a concurrency limit', async (t) => {
  const dev = await upstream(t, () => {})
  dev.server.on('upgrade', () => {})
  const ctx = await setup(t, { previewOptions: { handshakeTimeoutMs: 150, maxConnections: 1 }, source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const ws = connectPreview(ctx, link)
  await bounded(once(dev.server, 'upgrade'))
  assert.equal((await get(ctx.port, link.url)).status, 429)
  const extra = connectPreview(ctx, link)
  const [ , rejected] = await bounded(once(extra, 'unexpected-response'))
  assert.equal(rejected.statusCode, 429)
  rejected.resume()
  extra.terminate()
  await bounded(new Promise((done) => ws.once('close', done)))
  assert.equal(ctx.server.previews.transfers.active.size, 0)
})

async function openResponse(ctx, path, headers = {}) {
  const req = httpRequest({ host: '127.0.0.1', port: ctx.port, path, headers: { Host: `localhost:${ctx.port}`, ...headers } })
  req.on('error', () => {})
  req.end()
  const [res] = await bounded(once(req, 'response'))
  return { req, res }
}

test('HTTP disconnect, total deadline, revoke and expiry destroy an upstream trickle', async (t) => {
  const dev = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    const timer = setInterval(() => res.write('data'), 10)
    res.on('close', () => clearInterval(timer))
  })
  for (const reason of ['disconnect', 'deadline', 'expiry', 'revoke']) {
    const ctx = await setup(t, { previewOptions: { httpTimeoutMs: reason === 'deadline' ? 100 : 2000, ttlMs: reason === 'expiry' ? 100 : 5000 }, source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
    const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
    const upRequest = new Promise((done) => dev.server.once('request', done))
    const { req, res } = await openResponse(ctx, link.url)
    const request = await upRequest
    const upClosed = new Promise((done) => request.socket.once('close', done))
    const closed = new Promise((done) => res.once('close', done))
    res.resume()
    if (reason === 'disconnect') req.destroy()
    if (reason === 'revoke') await ctx.server.revoke(ctx.device.id)
    await bounded(Promise.all([closed, upClosed]))
    assert.equal(ctx.server.previews.transfers.active.size, 0, reason)
  }
})

test('HTTP upload size is bounded for content-length and chunked bodies', async (t) => {
  let received = 0
  const dev = await upstream(t, (req, res) => { req.on('data', (chunk) => { received += chunk.length }); req.on('end', () => res.end('ok')) })
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  assert.equal((await get(ctx.port, link.url, { 'Content-Length': String(m.REMOTE_PREVIEW_BODY_LIMIT + 1) }, 'POST')).status, 413)
  assert.equal(dev.seen.length, 0)
  const request = httpRequest({ host: '127.0.0.1', port: ctx.port, path: link.url, method: 'POST', headers: { Host: `localhost:${ctx.port}`, 'Transfer-Encoding': 'chunked' } })
  const failed = new Promise((done) => request.once('error', done))
  request.end(Buffer.alloc(m.REMOTE_PREVIEW_BODY_LIMIT + 1))
  await bounded(failed)
  assert.ok(received <= m.REMOTE_PREVIEW_BODY_LIMIT)
})

test('cancelled local preview and background downloads close their file streams; background concurrency and deadline are bounded', async (t) => {
  const fs = createRequire(import.meta.url)('node:fs')
  const original = fs.createReadStream
  const streams = []
  fs.createReadStream = (...args) => { const stream = original(...args); streams.push(stream); return stream }
  t.after(() => { fs.createReadStream = original })
  const ctx = await setup(t, { background: (dir) => ({ path: join(dir, 'project/site/movie.mp4'), dir: join(dir, 'project/site') }), source: (_pane, dir) => ({ raw: 'site/index.html', cwd: join(dir, 'project'), project: 'p' }) })
  const site = join(ctx.dir, 'project/site')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<html>hi</html>')
  writeFileSync(join(site, 'movie.mp4'), '')
  truncateSync(join(site, 'movie.mp4'), 256 * 1024 * 1024)
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const previewPath = link.url.replace('index.html', 'movie.mp4')
  const backgroundPath = m.REMOTE_APPEARANCE_ROUTES.background
  for (const path of [previewPath, backgroundPath]) {
    const { req, res } = await openResponse(ctx, path, { Cookie: `drover_session=${ctx.session}` })
    res.pause()
    assert.equal(res.headers['cache-control'], 'no-store')
    const stream = streams.at(-1)
    const closed = once(stream, 'close')
    req.destroy()
    await bounded(closed)
    assert.equal(stream.destroyed, true)
    assert.equal(stream.fd, null)
  }
  ctx.server.backgrounds = new m.RemoteTransfers(1, 150)
  const { res } = await openResponse(ctx, backgroundPath, { Cookie: `drover_session=${ctx.session}` })
  res.pause()
  const stream = streams.at(-1)
  const closed = once(stream, 'close')
  assert.equal((await get(ctx.port, backgroundPath, { Cookie: `drover_session=${ctx.session}` })).status, 429)
  assert.equal((await get(ctx.port, backgroundPath, { Cookie: `drover_session=${ctx.session}`, 'Content-Length': '1' })).status, 413)
  await bounded(closed)
  assert.equal(stream.fd, null)
  res.destroy()
  assert.equal(ctx.server.backgrounds.active.size, 0)
  ctx.server.backgrounds = new m.RemoteTransfers(8)
  const preview = await openResponse(ctx, previewPath)
  preview.res.pause()
  const previewStream = streams.at(-1)
  const bg = await openResponse(ctx, backgroundPath, { Cookie: `drover_session=${ctx.session}` })
  bg.res.pause()
  const backgroundStream = streams.at(-1)
  const bothClosed = Promise.all([once(previewStream, 'close'), once(backgroundStream, 'close')])
  await bounded(ctx.server.stop())
  await bounded(bothClosed)
  assert.equal(previewStream.fd, null)
  assert.equal(backgroundStream.fd, null)
  preview.res.destroy()
  bg.res.destroy()
})

test('Cache-Control cannot be overwritten; redirects resolve against the current upstream URL', async (t) => {
  const dev = await upstream(t, (req, res) => {
    if (req.url.startsWith('/nested/')) { res.writeHead(302, { Location: req.url.includes('query') ? '?q=2#anchor' : 'next?x=1', 'Cache-Control': 'public, max-age=3600', Expires: 'Wed, 21 Oct 2030 07:28:00 GMT' }); res.end(); return }
    res.writeHead(200, { 'Cache-Control': 'public, max-age=3600', Expires: 'Wed, 21 Oct 2030 07:28:00 GMT', 'Content-Type': 'text/plain' }); res.end('ok')
  })
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const prefix = link.url.slice(0, -1)
  for (const path of ['/', '/nested/page', '/nested/query?old=1']) {
    const reply = await get(ctx.port, prefix + path)
    assert.equal(reply.headers['cache-control'], 'no-store')
    assert.equal(reply.headers.expires, undefined)
    if (path === '/nested/page') assert.equal(reply.headers.location, prefix + '/nested/next?x=1')
    if (path.includes('query')) assert.equal(reply.headers.location, prefix + '/nested/query?q=2#anchor')
  }
})

test('HTML, CSS, modules and runtime HMR/fetch URLs stay under the token without Referer', async (t) => {
  const dev = await upstream(t, (req, res) => {
    const bodies = {
      '/nested/index.html': ['text/html', '<!doctype html><html><head><script type="module" src="/@vite/client"></script><link href="/styles.css" rel="stylesheet"></head><body><img src="/image.png"><script>new WebSocket("ws://localhost:' + dev.port + '/_next/webpack-hmr")</script></body></html>'],
      '/styles.css': ['text/css', 'body { background: url(/image.png) } @import "/theme.css";'],
      '/@vite/client': ['text/javascript', 'import "/module.js"; const next="/_next/static/chunk.js"; const separator="/";'],
      '/module.js': ['text/javascript', 'export const ok=true;']
    }
    const [type, body] = bodies[req.url] ?? ['text/plain', 'asset']
    const bytes = gzipSync(body)
    res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Content-Length': bytes.length, 'Cache-Control': 'public', Expires: 'Wed, 21 Oct 2030 07:28:00 GMT' })
    res.end(bytes)
  })
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}/nested/index.html`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const prefix = link.url.replace('/nested/index.html', '')
  const html = await get(ctx.port, link.url)
  assert.ok(html.body.startsWith('<!doctype html><script>'))
  assert.ok(html.body.includes(`src="${prefix}/@vite/client"`))
  assert.ok(html.body.includes(`href="${prefix}/styles.css"`))
  assert.equal(html.headers['content-length'], undefined)
  assert.equal(html.headers['content-encoding'], undefined)
  assert.equal(html.headers['cache-control'], 'no-store')
  assert.equal(html.headers['referrer-policy'], 'no-referrer')
  assert.doesNotMatch(html.headers['content-security-policy'], /allow-same-origin/)
  const css = await get(ctx.port, prefix + '/styles.css')
  assert.ok(css.body.includes(`url(${prefix}/image.png)`))
  assert.ok(css.body.includes(`"${prefix}/theme.css"`))
  const js = await get(ctx.port, prefix + '/@vite/client')
  assert.ok(js.body.includes(`import "${prefix}/module.js"`))
  assert.ok(js.body.includes('"/_next/static/chunk.js"'), 'non-import JS strings keep their semantics')
  assert.ok(js.body.includes('const separator="/";'))
  assert.equal(dev.seen.at(-1).headers.referer, undefined)
  assert.equal(dev.seen.at(-1).headers['accept-encoding'], 'identity')

  // Execute the injected bootstrap with browser-shaped APIs, including Next's
  // dynamically assembled absolute HMR URL and Vite's loopback HMR authority.
  const called = []
  class Element { setAttribute(name, value) { called.push([name, value]) } }
  class XHR { open(...args) { called.push(['xhr', ...args]) } }
  const window = { fetch: (url) => { called.push(['fetch', url]); return Promise.resolve() }, WebSocket: class { constructor(url) { called.push(['ws', url]) } } }
  const globals = { window, location: new URL(ctx.origin + link.url), URL, Request, XMLHttpRequest: XHR, Element }
  for (const name of ['HTMLScriptElement', 'HTMLImageElement', 'HTMLLinkElement', 'HTMLAnchorElement', 'HTMLFormElement', 'HTMLMediaElement', 'HTMLSourceElement', 'HTMLIFrameElement', 'HTMLVideoElement']) globals[name] = class extends Element {}
  runInNewContext(html.body.match(/<script>([\s\S]*?)<\/script>/)[1], globals)
  new window.WebSocket(ctx.origin.replace('http:', 'ws:') + '/_next/webpack-hmr')
  new window.WebSocket(`ws://localhost:${dev.port}/vite-hmr`)
  await window.fetch('/auth/session')
  new XHR().open('POST', '/api/save', true)
  new Element().setAttribute('src', '/image.png')
  assert.deepEqual(called.slice(0, 5), [
    ['ws', ctx.origin.replace('http:', 'ws:') + prefix + '/_next/webpack-hmr'],
    ['ws', ctx.origin.replace('http:', 'ws:') + prefix + '/vite-hmr'],
    ['fetch', ctx.origin + prefix + '/auth/session'],
    ['xhr', 'POST', ctx.origin + prefix + '/api/save', true],
    ['src', ctx.origin + prefix + '/image.png']
  ])
  const wss = new WebSocketServer({ server: dev.server })
  wss.on('connection', (ws, req) => ws.send(req.url))
  const ws = connectPreview(ctx, { url: prefix + '/' }, '_next/webpack-hmr')
  const [reply] = await bounded(once(ws, 'message'))
  assert.equal(reply.toString(), '/_next/webpack-hmr')
  ws.close()
})

test('computed dynamic imports retain arguments/options and resolve from their module URL', async (t) => {
  const source = `
    const separator = '/';
    const text = "import('/leave-this-string')";
    const pattern = /import\\(['"].*['"]\\)/;
    let invocations = 0;
    function path() { invocations++; return separator + 'src/update.js' }
    globalThis.loaded = Promise.all([
      import /* comment */ (path(), { with: { type: 'json' } }),
      import('./relative.js'),
      import('bare-package'),
      (async () => import((await import('./loader.js')).value))()
    ]).then(() => { globalThis.invocations = invocations })
  `
  const dev = await upstream(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(source) })
  const ctx = await setup(t, { source: () => ({ raw: `localhost:${dev.port}/nested/client.js`, cwd: null, project: 'p' }) })
  const link = await ctx.server.previewLink(ctx.device.id, { paneId: 'w1:p1' })
  const reply = await get(ctx.port, link.url)
  assert.ok(reply.body.includes("const separator = '/';"))
  assert.ok(reply.body.includes('"import(\'/leave-this-string\')"'))
  // VM import callbacks need this Node flag. No real modules, agents or app
  // profiles are involved; the callback records the actual mapped specifiers.
  const { execFileSync } = await import('node:child_process')
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import vm from 'node:vm';
    import fs from 'node:fs';
    const { code, href } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const seen = [];
    const context = vm.createContext({ URL, location: new URL(href) });
    vm.runInContext(code, context, { importModuleDynamically: async (specifier, _script, attributes) => {
      seen.push({ specifier, attributes });
      const module = new vm.SyntheticModule(['value'], function() { this.setExport('value', './nested.js') }, { context });
      await module.link(() => {}); await module.evaluate(); return module;
    } });
    await context.loaded;
    process.stdout.write(JSON.stringify({ seen, invocations: context.invocations }));
  `], { input: JSON.stringify({ code: reply.body, href: ctx.origin + '/preview/other/document.html' }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const result = JSON.parse(output)
  const prefix = ctx.origin + link.url.replace('/nested/client.js', '')
  assert.deepEqual(result.seen.map((s) => s.specifier).sort(), [...['/src/update.js', '/nested/relative.js', '/nested/loader.js', '/nested/nested.js'].map((p) => prefix + p), 'bare-package'].sort())
  assert.equal(result.invocations, 1)
  assert.equal(result.seen.find((s) => s.specifier.endsWith('/src/update.js')).attributes.type, 'json')
})
