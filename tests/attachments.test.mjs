import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync, statSync, writeFileSync, chmodSync, truncateSync, existsSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { once } from 'node:events'

const bundled = mkdtempSync(join(tmpdir(), 'drover-upload-tests-'))
await build({ stdin: { contents: `
  export * from './src/main/remote/attachments'
  export * from './src/main/remote/server'
  export * from './src/main/remote/store'
  export * from './src/main/remote/rpc'
  export * from './src/shared/remote'
  export { uploadAttachment as uploadBrowserAttachment } from './src/renderer/src/attachments'
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: join(bundled, 'uploads.cjs'), alias: { '@shared': resolve('src/shared') }, logLevel: 'silent' })
const m = createRequire(import.meta.url)(join(bundled, 'uploads.cjs'))
rmSync(bundled, { recursive: true })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'drover-upload-case-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('attachments accept images and UTF-8 text; reject SVG, active types, binaries and mismatched content', () => {
  for (const [name, mime, bytes] of [['photo.png', 'image/png', png], ['photo.png', '', png], ['notes.txt', 'text/plain', Buffer.from('Привет')], ['data.json', 'application/json', Buffer.from('{}')], ['notes.md', '', Buffer.from('# notes')]]) assert.doesNotThrow(() => m.validateAttachment(bytes, name, mime))
  for (const [name, mime, bytes] of [['photo.svg', 'image/svg+xml', Buffer.from('<svg/>')], ['page.html', 'text/html', Buffer.from('<script/>')], ['payload.exe', 'text/plain', Buffer.from('plain')], ['photo.png', 'image/jpeg', png], ['photo.png', 'image/png', Buffer.from('<html>')], ['notes.txt', 'text/plain', Buffer.from([255, 0])], ['notes.txt', 'text/plain', Buffer.from('a\0b')]]) assert.throws(() => m.validateAttachment(bytes, name, mime), { code: 'unsupported_attachment' })
  assert.throws(() => m.validateAttachment(Buffer.alloc(0), 'empty.txt', 'text/plain'), { code: 'empty_attachment' })
})

test('20 MB boundary is accepted, 20 MB + 1 is rejected', () => {
  assert.doesNotThrow(() => m.validateAttachment(Buffer.alloc(m.REMOTE_ATTACHMENT_MAX_BYTES, 65), 'limit.txt', 'text/plain'))
  assert.throws(() => m.validateAttachment(Buffer.alloc(m.REMOTE_ATTACHMENT_MAX_BYTES + 1), 'limit.txt', 'text/plain'), { code: 'attachment_too_large', status: 413 })
})

test('Mac converts a TIFF upload to a private JPEG and removes the source', { skip: process.platform !== 'darwin' }, async t => {
  const dir = temp(t), source = join(dir, 'source.png'), tiff = join(dir, 'source.tiff')
  writeFileSync(source, png)
  execFileSync('/usr/bin/sips', ['-s', 'format', 'tiff', source, '--out', tiff], { stdio: 'ignore' })
  const attachment = await m.saveAttachment(readFileSync(tiff), 'camera.tiff', 'image/tiff', dir)
  assert.ok(attachment.id.endsWith('.jpg'))
  assert.equal(statSync(attachment.path).mode & 0o777, 0o600)
  assert.equal((await m.readAttachment(attachment.id, dir)).mime, 'image/jpeg')
  assert.equal(readdirSync(dir).filter(name => name.startsWith('remote-')).length, 1)
})

test('safe names cannot escape the attachment directory, collide, or contain shell syntax; preview rejects symlinks', async t => {
  const dir = temp(t)
  for (const name of ['../../photo.png', '..\\..\\photo.png', '$(touch hacked).png', '";evil.png', 'фото.png']) {
    const one = await m.saveAttachment(png, name, 'image/png', dir)
    const two = await m.saveAttachment(png, name, 'image/png', dir)
    assert.equal(resolve(one.path, '..'), dir)
    assert.match(one.name, /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/)
    assert.notEqual(one.path, two.path)
    assert.deepEqual(readFileSync(one.path), png)
    assert.equal(statSync(one.path).mode & 0o777, 0o600)
    assert.deepEqual((await m.readAttachment(one.id, dir)).bytes, png)
  }
  for (const id of ['../secret', '/etc/passwd', 'remote-../../../photo.png']) await assert.rejects(m.readAttachment(id, dir), { code: 'not_found' })
  const id = 'remote-00000000-0000-0000-0000-000000000000.png'
  symlinkSync(join(dir, readdirSync(dir)[0]), join(dir, id))
  await assert.rejects(m.readAttachment(id, dir), { code: 'not_found' })
})

test('HTTP upload/preview enforce auth, Origin, streamed size, names, content and revocation', async t => {
  const dir = temp(t), attachmentsDir = join(dir, 'attachments')
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(r => listener.close(r))
  const origin = `http://localhost:${port}`
  const store = new m.RemoteAuthStore(join(dir, 'remote-auth.json'))
  const device = store.addDevice({ name: 'Test', rpID: 'localhost', userID: 'test', credential: { id: 'cred', publicKey: 'AA', counter: 0 } })
  const token = store.issueSession(device.id, origin).token
  const settings = { ...m.DEFAULT_REMOTE_SETTINGS, remoteEnabled: true, remotePort: port }
  const server = new m.RemoteServer({ webRoot: dir, userData: dir, attachmentsDir, settings: () => settings, saveSettings: () => {}, statusChanged: () => {}, handlers: new m.RpcHandlers() })
  t.after(() => server.stop())
  await server.sync()
  const send = (body = png, headers = {}, auth = true, path = m.REMOTE_ATTACHMENT_ROUTES.upload, method = 'POST', chunks = false) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, Origin: origin, 'Content-Type': 'image/png', 'X-Drover-Filename': encodeURIComponent('../../phone.png'), ...(auth ? { Cookie: `drover_session=${token}` } : {}), ...headers } }, res => {
      const out = []
      res.on('data', chunk => out.push(chunk))
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(out), headers: res.headers }))
    })
    req.on('error', reject)
    if (chunks) { req.write(body); req.end() } else req.end(method === 'GET' || method === 'HEAD' ? undefined : body)
  })
  assert.equal((await send(png, {}, false)).status, 401)
  assert.equal((await send(png, { Origin: 'https://evil.test' })).status, 403)
  assert.equal((await send(png, { Origin: 'null' })).status, 403)
  assert.equal((await send(png, { 'X-Drover-Filename': 'bad%00.png' })).status, 400)
  assert.equal((await send(png, { 'X-Drover-Filename': 'bad%ZZ.png' })).status, 400)
  assert.equal((await send(Buffer.alloc(0))).status, 400)
  assert.equal((await send(Buffer.from('<script/>'))).status, 415)
  assert.equal((await send(png, { 'X-Drover-Filename': 'photo.svg', 'Content-Type': 'image/svg+xml' })).status, 415)
  assert.equal((await send(Buffer.alloc(m.REMOTE_ATTACHMENT_MAX_BYTES + 1), {}, true, undefined, 'POST', true)).status, 413)
  assert.equal((await send(png, { 'Content-Length': m.REMOTE_ATTACHMENT_MAX_BYTES + 1 })).status, 413)
  const uploaded = await send()
  assert.equal(uploaded.status, 200)
  const file = JSON.parse(uploaded.body)
  assert.equal(file.isImage, true)
  assert.equal(file.name, 'phone.png')
  assert.deepEqual(readFileSync(file.path), png)
  assert.equal((await send(undefined, {}, false, file.previewUrl, 'GET')).status, 401)
  const preview = await send(undefined, {}, true, file.previewUrl, 'GET')
  assert.equal(preview.status, 200)
  assert.equal(preview.headers['content-type'], 'image/png')
  assert.deepEqual(preview.body, png)
  const text = JSON.parse((await send(Buffer.from('hello'), { 'Content-Type': 'text/plain', 'X-Drover-Filename': 'notes.txt' })).body)
  assert.equal(text.isImage, false)
  assert.equal((await send(undefined, {}, true, text.previewUrl, 'GET')).headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal((await send(undefined, {}, true, '/attachments/files/%2Fetc%2Fpasswd', 'GET')).status, 404)
  assert.equal(readdirSync(attachmentsDir).length, 2, 'invalid uploads left no files')
  // Revocation after the first chunk must prevent committing the completed body.
  const revoked = new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: m.REMOTE_ATTACHMENT_ROUTES.upload, method: 'POST', headers: { Host: `localhost:${port}`, Origin: origin, Cookie: `drover_session=${token}`, 'Content-Type': 'image/png', 'X-Drover-Filename': 'revoked.png' } }, res => {
      res.resume(); res.on('end', () => done(res.statusCode))
    })
    req.on('error', reject)
    req.write(png.subarray(0, 8))
    setTimeout(() => { server.revoke(device.id); req.end(png.subarray(8)) }, 30)
  })
  assert.equal(await revoked, 401)
  assert.equal(readdirSync(attachmentsDir).length, 2, 'revoked upload left no files')
  assert.equal((await send()).status, 401)
  assert.equal((await send(undefined, {}, true, file.previewUrl, 'GET')).status, 401)
})


test('proxy HTTP 413 gives a clear upload error for plain text, HTML and JSON responses', async t => {
 const file = new File(['small'], 'phone.txt', { type: 'text/plain' })
 for (const body of ['Request Entity Too Large', '<html>413</html>', '{}']) {
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 413 }))
  await assert.rejects(m.uploadBrowserAttachment(file), /Files must be 20 MB or smaller/)
  t.mock.restoreAll()
 }
})

const caddyScript = join(process.env.HOME, 'remote-mac/bridge/vps-web.sh')
test('Caddy generator uses 20MiB by default and renders that body limit', { skip: !existsSync(caddyScript) }, t => {
 execFileSync('bash', ['-n', caddyScript])
 const file = join(temp(t), 'Caddyfile')
 const output = execFileSync('bash', ['-c', 'source "$1"; require_root() { :; }; require_debian_like() { :; }; install_caddy() { :; }; caddy() { :; }; systemctl() { :; }; main --ip 203.0.113.1 --yes', '--', caddyScript], { encoding: 'utf8', env: { ...process.env, CADDYFILE: file } })
 assert.match(output, /Body cap: 20MiB/)
 assert.match(readFileSync(file, 'utf8'), /request_body\s*\{\s*max_size 20MiB/)
})

const tiffHeader = Buffer.from('49492a0008000000', 'hex')
test('image dimensions are bounded before conversion starts, and rejected sources are removed', async t => {
 for (const dimensions of [{ width: 16385, height: 1 }, { width: 8000, height: 8000 }]) {
  const dir = temp(t); let converted = false
  const storage = new m.AttachmentStorage(dir, { inspectImage: async () => dimensions, convertImage: async () => { converted = true } })
  await assert.rejects(storage.save(tiffHeader, 'huge.tiff', 'image/tiff'), { code: 'attachment_dimensions' })
  assert.equal(converted, false); assert.deepEqual(readdirSync(dir), [])
 }
 assert.doesNotThrow(() => m.validateImageDimensions({ width: 8064, height: 6048 }))
 for (const width of [0, -1, NaN, Infinity]) assert.throws(() => m.validateImageDimensions({ width, height: 1 }))
})

test('converted result over 20MiB is deleted; existing directories and all conversion stages are private', async t => {
 const dir = temp(t); chmodSync(dir, 0o755)
 const storage = new m.AttachmentStorage(dir, {
  inspectImage: async source => {
   assert.equal(statSync(dir).mode & 0o777, 0o700)
   assert.equal(statSync(resolve(source, '..')).mode & 0o777, 0o700)
   assert.equal(statSync(source).mode & 0o777, 0o600)
   return { width: 10, height: 10 }
  },
  convertImage: async (source, dest) => {
   assert.equal(statSync(dest).mode & 0o777, 0o600, 'output starts private, before sips')
   chmodSync(dest, 0o644) // Simulate sips replacing the output's permissions.
   assert.equal(statSync(resolve(dest, '..')).mode & 0o777, 0o700, 'a 0644 intermediate is enclosed by 0700')
   assert.equal(statSync(dir).mode & 0o777, 0o700)
   truncateSync(dest, m.REMOTE_ATTACHMENT_MAX_BYTES + 1)
  }
 })
 await assert.rejects(storage.save(tiffHeader, 'camera.tiff', 'image/tiff'), { code: 'attachment_too_large', status: 413 })
 assert.deepEqual(readdirSync(dir), [], 'neither intermediate nor final result survives')
 const file = await m.saveAttachment(png, 'phone.png', 'image/png', dir)
 assert.equal(statSync(file.path).mode & 0o777, 0o600)
 assert.equal(statSync(dir).mode & 0o777, 0o700)
})

test('directory-wide quota counts existing Mac attachments and simultaneous browser uploads', async t => {
 const dir = temp(t); writeFileSync(join(dir, 'mac-notes.txt'), 'old')
 const storage = new m.AttachmentStorage(dir, { quotaBytes: 8 })
 const results = await Promise.allSettled(Array.from({ length: 3 }, () => storage.save(Buffer.from('1234'), 'notes.txt', 'text/plain')))
 assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
 assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'attachment_quota').length, 2)
 assert.equal(readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0), 7)
})

test('conversions reserve source and maximum result atomically; completion and failure release reservations', async t => {
 const dir = temp(t); let finish, started
 const ready = new Promise(r => { started = r }), gate = new Promise(r => { finish = r })
 let calls = 0
 const storage = new m.AttachmentStorage(dir, { quotaBytes: m.REMOTE_ATTACHMENT_MAX_BYTES + tiffHeader.length + 4,
  inspectImage: async () => ({ width: 1, height: 1 }),
  convertImage: async (_src, dest) => { if (++calls === 1) { started(); await gate }; writeFileSync(dest, Buffer.from([255, 216, 255, 0])) }
 })
 const first = storage.save(tiffHeader, 'one.tiff', 'image/tiff'); await ready
 await assert.rejects(storage.save(tiffHeader, 'two.tiff', 'image/tiff'), { code: 'attachment_quota' })
 finish(); await first
 await storage.save(tiffHeader, 'three.tiff', 'image/tiff')
 assert.equal(readdirSync(dir).length, 2)
 const failedDir = temp(t); let fail = true
 const retry = new m.AttachmentStorage(failedDir, { quotaBytes: m.REMOTE_ATTACHMENT_MAX_BYTES + tiffHeader.length,
  inspectImage: async () => ({ width: 1, height: 1 }), convertImage: async (_src, dest) => { if (fail) { fail = false; throw new Error('conversion failed') }; writeFileSync(dest, 'jpg') }
 })
 await assert.rejects(retry.save(tiffHeader, 'bad.tiff', 'image/tiff'))
 await retry.save(tiffHeader, 'good.tiff', 'image/tiff')
 assert.equal(readdirSync(failedDir).length, 1)
})

test('periodic cleanup expires old files and orphan conversions, retains current/active files and restores quota', async t => {
 const dir = temp(t), old = join(dir, 'old.txt'), fresh = join(dir, 'fresh.txt')
 let now = Date.now()
 writeFileSync(old, 'expired'); writeFileSync(fresh, 'new')
 utimesSync(old, new Date(now - 31 * 864e5), new Date(now - 31 * 864e5))
 const storage = new m.AttachmentStorage(dir, { quotaBytes: 6, now: () => now, cleanupIntervalMs: 20 })
 storage.startCleanup(); t.after(() => storage.stopCleanup())
 for (let n = 0; n < 50 && existsSync(old); n++) await new Promise(r => setTimeout(r, 10))
 assert.equal(existsSync(old), false); assert.equal(existsSync(fresh), true)
 await storage.save(Buffer.from('new'), 'new.txt', 'text/plain')
 storage.stopCleanup()
 const activeDir = temp(t); let finish, started
 const ready = new Promise(r => { started = r }), gate = new Promise(r => { finish = r })
 const active = new m.AttachmentStorage(activeDir, { now: () => now, inspectImage: async () => ({ width: 1, height: 1 }),
  convertImage: async (src, dest) => { started(); await gate; assert.equal(existsSync(src), true); writeFileSync(dest, 'jpg') }
 })
 const uploading = active.save(tiffHeader, 'active.tiff', 'image/tiff'); await ready
 now += 31 * 864e5
 await active.cleanup(); finish(); await uploading
 assert.equal(readdirSync(activeDir).length, 1)
 // A crash leftover has no live reservation and is removed after a day.
 const orphan = join(activeDir, '.upload-00000000-0000-0000-0000-000000000000')
 const { mkdirSync } = await import('node:fs'); mkdirSync(orphan)
 writeFileSync(join(orphan, 'source.tiff'), 'orphan')
 utimesSync(orphan, new Date(now - 2 * 864e5), new Date(now - 2 * 864e5))
 await active.cleanup(); assert.equal(existsSync(orphan), false)
})
