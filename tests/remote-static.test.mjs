import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { once } from 'node:events'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
const root = mkdtempSync(join(tmpdir(), 'drover-static-'))
await build({ stdin: { contents: "export * from './src/main/remote/server'; export * from './src/main/remote/store'; export * from './src/main/remote/rpc'", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'test.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(root, 'test.cjs'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

test('hashed build assets compress before SSH and cache privately; auth and non-build content stays protected', async t => {
  const { createServer } = await import('node:net')
  const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port; await new Promise(r => reserve.close(r))
  const web = join(root, 'web'); mkdirSync(join(web, 'assets'), { recursive: true }); mkdirSync(join(web, 'auth/assets'), { recursive: true })
  const body = 'const text = "synthetic build fixture";\n'.repeat(4000)
  for (const file of ['assets/app-12345678.js', 'auth/assets/login-abcdefgh.js', 'sw.js', 'index.html', 'auth/index.html']) writeFileSync(join(web, file), body)
  writeFileSync(join(root, 'secret.js'), body); symlinkSync(join(root, 'secret.js'), join(web, 'assets/leak-12345678.js'))
  const origin = `http://localhost:${port}`, store = new m.RemoteAuthStore(join(root, 'remote-auth.json'))
  const d = store.addDevice({ name: 'Fixture', rpID: 'localhost', userID: 'fixture', credential: { id: 'fixture', publicKey: 'AA', counter: 0 } })
  const token = store.issueSession(d.id, origin).token
  const settings = { remoteEnabled: true, remotePort: port, remotePublicUrl: '' }
  const server = new m.RemoteServer({ userData: root, webRoot: web, attachmentsDir: join(root, 'attachments'), handlers: new m.RpcHandlers(), settings: () => settings, saveSettings() {}, statusChanged() {} })
  t.after(() => server.stop()); await server.sync()
  const get = (path, headers = {}, auth = true, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...(auth ? { Cookie: `drover_session=${token}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }); req.on('error', reject); req.end()
  })
  const path = '/assets/app-12345678.js'
  const raw = await get(path), gz = await get(path, { 'Accept-Encoding': 'gzip' }), br = await get(path, { 'Accept-Encoding': 'br, gzip' })
  assert.equal(raw.body.toString(), body)
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(gz.body).toString(), body)
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(brotliDecompressSync(br.body).toString(), body)
  assert.ok(br.body.length < raw.body.length / 10)
  assert.equal(br.headers.vary, 'Accept-Encoding')
  assert.equal(br.headers['cache-control'], 'private, max-age=31536000, immutable')
  assert.equal((await get(path, { 'Accept-Encoding': 'br;q=0, gzip;q=0' })).headers['content-encoding'], undefined)
  const head = await get(path, { 'Accept-Encoding': 'br' }, true, 'HEAD')
  assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], br.headers['content-length'])
  const cached = await get(path, { 'If-None-Match': raw.headers.etag }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0)
  assert.equal((await get(path, { 'If-None-Match': raw.headers.etag }, false)).status, 401)
  assert.equal((await get('/auth/assets/login-abcdefgh.js', {}, false)).headers['cache-control'], raw.headers['cache-control'])
  for (const path of ['/', '/login', '/pair?code=fixture', '/sw.js', '/auth/session']) assert.equal((await get(path)).headers['cache-control'], 'no-store', path)
  assert.equal((await get('/assets/leak-12345678.js')).status, 404)
  // A rebuilt file cannot reuse an old compressed representation or validator.
  writeFileSync(join(web, 'assets/app-12345678.js'), body + 'changed')
  const changed = await get(path, { 'If-None-Match': raw.headers.etag, 'Accept-Encoding': 'gzip' })
  assert.equal(changed.status, 200); assert.equal(gunzipSync(changed.body).toString(), body + 'changed')
})
