import { createReadStream, realpathSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline, Transform, type Duplex } from 'node:stream'
import { initSync, parse as moduleImports } from 'es-module-lexer'
import { PREVIEW_RUNTIME, PREVIEW_ROUTE } from './preview-runtime'
import { RemoteTransfers, type Transfer, bodyLimit, REMOTE_PREVIEW_BODY_LIMIT } from './transfers'
import {
  REMOTE_PREVIEW_CSP, REMOTE_PREVIEW_PREFIX, REMOTE_PREVIEW_TTL_MS,
  type RemotePreviewError, type RemotePreviewLink, type RemotePreviewRecent
} from '@shared/remote'
import { RemoteFailure } from './security'

/** Phone previews of the pages agents show on the Mac (pane token `preview=`).
 * The phone cannot reach the Mac's localhost or files, so Drover serves them,
 * only through capability links: /preview/<random token>/… Each token is bound
 * to one target from an agent's own token — a page's folder or one loopback
 * port — expires, and needs no cookie. Responses are sandboxed to an opaque
 * origin: the page cannot reach the Drover API, its session or its cookie. */

export interface PreviewSource {
  /** The agent's `preview` token, as herdr reports it. */
  raw: string
  /** The agent's folder, for relative paths. */
  cwd: string | null
  /** Recent previews are kept per project. */
  project: string
}
export type PreviewTarget =
  | { kind: 'http'; port: number; path: string; label: string }
  | { kind: 'file'; dir: string; entry: string; label: string }
interface Grant { target: PreviewTarget; deviceId: string; expiresAt: number; host?: string }
interface Recent extends RemotePreviewRecent { source: Omit<PreviewSource, 'project'>; project: string; key: string }

initSync()

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PAGE = new Set(['.html', '.htm', '.xhtml', '.svg'])
/** What a page folder may serve. No scripts for shells, no dotfiles. */
const SAFE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.wasm': 'application/wasm'
}
/** Never forwarded to a dev server: Drover's own credentials and proxy hints. */
const DROP_REQUEST = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'referer', 'origin', 'forwarded', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'if-none-match', 'if-modified-since', 'if-range'])
/** Only harmless response headers pass: no cookies, CSP, framing, HSTS or Clear-Site-Data from the page's server. */
const PASS_RESPONSE = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-range', 'accept-ranges',
  'vary', 'date']
const LOOPBACK = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host) || host.endsWith('.localhost')

/** The page an agent's token points at; never anything but loopback or a local HTML file. */
export function resolvePreviewTarget(raw: string, cwd: string | null, home: string): PreviewTarget | RemotePreviewError {
  let s = raw.trim()
  if (s.length > 1 && /^(["']).*\1$/.test(s)) s = s.slice(1, -1).trim()
  if (!s) return 'no_preview'
  // herdr keeps 80 characters of a token: a longer path arrives cut off.
  if ([...raw].length >= 80 && !/^https?:\/\//i.test(s)) return 'too_long'
  const urlLike = /^\d{2,5}$/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|[\w-]+\.localhost)(:\d+)?([/?#]|$)/i.test(s)
  if (urlLike && !/^file:/i.test(s)) {
    let url: URL
    try { url = new URL(/^\d+$/.test(s) ? `http://localhost:${s}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`) } catch { return 'unsupported' }
    if (!LOOPBACK(url.hostname.toLowerCase()) || url.username || url.password) return 'not_local'
    if (url.protocol !== 'http:') return 'unsupported'
    const port = Number(url.port || 80)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'unsupported'
    const path = (url.pathname || '/') + url.search
    return { kind: 'http', port, path, label: `localhost:${port}${path === '/' ? '' : path}` }
  }
  let file: string
  if (/^file:\/\//i.test(s)) {
    try { file = decodeURIComponent(new URL(s).pathname) } catch { return 'unsupported' }
  } else if (s === '~' || s.startsWith('~/')) file = home + s.slice(1)
  else if (isAbsolute(s)) file = s
  else if (cwd && isAbsolute(cwd)) file = resolve(cwd, s)
  else return 'not_found'
  let real: string
  try {
    real = realpathSync(file)
    if (!statSync(real).isFile()) return 'not_found'
  } catch { return 'not_found' }
  if (!PAGE.has(extname(real).toLowerCase())) return 'unsupported'
  const dir = dirname(real)
  let homeReal = home
  try { homeReal = realpathSync(home) } catch { /* a missing home cannot match */ }
  // A page right in / or the home folder would expose all of it.
  if (dir === sep || dir === homeReal) return 'unsupported'
  let base = cwd
  try { if (cwd) base = realpathSync(cwd) } catch { /* label only */ }
  const inside = base && (real.startsWith(base + sep))
  const label = inside ? relative(base!, real) : real.startsWith(homeReal + sep) ? `~/${relative(homeReal, real)}` : real
  return { kind: 'file', dir, entry: basename(real), label }
}

function targetKey(t: PreviewTarget) {
  return t.kind === 'http' ? `http:${t.port}${t.path}` : `file:${t.dir}/${t.entry}`
}
function probe(host: string, port: number, transfer?: Transfer, timeout = 800): Promise<boolean> {
  return new Promise((done) => {
    const socket = netConnect({ host, port })
    transfer?.own(socket)
    const timer = setTimeout(() => { socket.destroy(); done(false) }, timeout)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); done(true) })
    socket.once('error', () => { clearTimeout(timer); done(false) })
    socket.once('close', () => { clearTimeout(timer); done(false) })
  })
}
/** Dev servers listen on IPv4 or IPv6 loopback; nothing is ever resolved by name. */
async function loopbackHost(port: number, transfer?: Transfer): Promise<string | null> {
  for (const host of ['127.0.0.1', '::1']) {
    if (transfer?.closed) break
    if (await probe(host, port, transfer)) return host
  }
  return null
}

export class RemotePreviews {
  private transfers: RemoteTransfers
  private connections = new Map<Transfer, string>()
  private grants = new Map<string, Grant>()
  private recents = new Map<string, Recent[]>()
  constructor(private opts: {
    source: (paneId: string) => PreviewSource | null
    deviceActive: (deviceId: string) => boolean
    home: string
    now?: () => number
    ttlMs?: number
    httpTimeoutMs?: number
    handshakeTimeoutMs?: number
    maxConnections?: number
  }) { this.transfers = new RemoteTransfers(opts.maxConnections ?? 32, opts.httpTimeoutMs ?? 60_000) }
  private get now() { return (this.opts.now ?? Date.now)() }

  /** RPC from an authenticated device: a fresh capability link for an agent's page. */
  async link(deviceId: string | undefined, request: unknown): Promise<RemotePreviewLink> {
    if (!deviceId || !this.opts.deviceActive(deviceId)) throw new RemoteFailure('unauthorized', 'Preview links are for paired devices', 401)
    const req = request as { paneId?: unknown; recentId?: unknown } | null
    const keys = req && typeof req === 'object' && !Array.isArray(req) ? Object.keys(req) : []
    const paneId = keys.length === 1 && typeof req!.paneId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(req!.paneId) ? req!.paneId : null
    const recentId = keys.length === 1 && typeof req!.recentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req!.recentId) ? req!.recentId : null
    if (!paneId && !recentId) throw new RemoteFailure('invalid_args', 'Expected {paneId} or {recentId}')
    let source: PreviewSource | null
    if (paneId) source = this.opts.source(paneId)
    else {
      const recent = [...this.recents.values()].flat().find((r) => r.id === recentId)
      source = recent ? { ...recent.source, project: recent.project } : null
    }
    if (!source?.raw) return { ok: false, code: 'no_preview', recent: this.recentFor(source?.project) }
    const target = resolvePreviewTarget(source.raw, source.cwd, this.opts.home)
    if (typeof target === 'string') return { ok: false, code: target, recent: this.recentFor(source.project) }
    this.prune()
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now + (this.opts.ttlMs ?? REMOTE_PREVIEW_TTL_MS)
    const grant: Grant = { target, deviceId, expiresAt }
    let reachable = true
    if (target.kind === 'http') {
      grant.host = (await loopbackHost(target.port)) ?? undefined
      reachable = !!grant.host
    }
    // Bound memory: a device keeps its 32 newest links.
    const own = [...this.grants].filter(([, g]) => g.deviceId === deviceId)
    for (const [old] of own.slice(0, Math.max(0, own.length - 31))) this.drop(old)
    this.grants.set(token, grant)
    this.remember(source, target)
    const path = target.kind === 'http' ? target.path : `/${encodeURIComponent(target.entry)}`
    return { ok: true, url: `${REMOTE_PREVIEW_PREFIX}${token}${path}`, label: target.label, kind: target.kind, reachable, expiresAt, recent: this.recentFor(source.project) }
  }

  clear(): void {
    this.grants.clear()
    this.transfers.clear()
    this.connections.clear()
  }
  revoke(deviceId: string): void {
    for (const [token, grant] of this.grants) if (grant.deviceId === deviceId) this.drop(token)
  }
  private drop(token: string): void {
    this.grants.delete(token)
    for (const [transfer, owner] of this.connections) if (owner === token) { transfer.close(); this.connections.delete(transfer) }
  }
  expire(): void { this.prune() }
  private track(req: IncomingMessage, downstream: ServerResponse | Duplex, token: string, grant: Grant): Transfer | null {
    const transfer = this.transfers.open(req, downstream, () => { if (transfer) this.connections.delete(transfer) })
    if (transfer) {
      this.connections.set(transfer, token)
      transfer.after(grant.expiresAt - this.now)
    }
    return transfer
  }

  private prune() {
    for (const [token, grant] of this.grants) if (grant.expiresAt <= this.now || !this.opts.deviceActive(grant.deviceId)) this.drop(token)
  }
  private remember(source: PreviewSource, target: PreviewTarget) {
    const list = this.recents.get(source.project) ?? []
    const key = targetKey(target)
    const existing = list.find((r) => r.key === key)
    const entry: Recent = { id: existing?.id ?? randomBytes(9).toString('base64url'), key, label: target.label, kind: target.kind, at: this.now, source: { raw: source.raw, cwd: source.cwd }, project: source.project }
    this.recents.set(source.project, [entry, ...list.filter((r) => r !== existing)].slice(0, 8))
  }
  private recentFor(project: string | undefined): RemotePreviewRecent[] {
    return (project ? this.recents.get(project) ?? [] : []).map(({ id, label, kind, at }) => ({ id, label, kind, at }))
  }

  /** Only explicit capability paths belong to the preview, never Referer. */
  private route(req: IncomingMessage): { token: string; grant: Grant | null; rest: string } | null {
    const raw = new URL(req.url ?? '/', 'http://preview.invalid')
    if (!raw.pathname.startsWith(REMOTE_PREVIEW_PREFIX)) return null
    const own = raw.pathname.slice(REMOTE_PREVIEW_PREFIX.length)
    const slash = own.indexOf('/')
    const token = slash < 0 ? own : own.slice(0, slash)
    const rest = (slash < 0 ? '/' : own.slice(slash)) + raw.search
    this.prune()
    return { token, grant: TOKEN.test(token) ? this.grants.get(token) ?? null : null, rest }
  }

  async http(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const route = this.route(req)
    if (!route) return false
    isolate(res)
    if (!route.grant) { notFound(res); return true }
    if (Number(req.headers['content-length'] ?? 0) > REMOTE_PREVIEW_BODY_LIMIT) {
      res.writeHead(413, { Connection: 'close' }); res.end(); return true
    }
    const transfer = this.track(req, res, route.token, route.grant)
    if (!transfer) { res.writeHead(429, { Connection: 'close' }); res.end(); return true }
    if (route.grant.target.kind === 'file') this.file(req, res, route.grant.target, route.rest, route.token, transfer)
    else await this.proxy(req, res, route.grant, route.token, route.rest, transfer)
    return true
  }

  private file(req: IncomingMessage, res: ServerResponse, target: Extract<PreviewTarget, { kind: 'file' }>, rest: string, token: string, transfer: Transfer) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) { res.writeHead(413, { Connection: 'close' }); res.end(); return }
    let path: string
    try { path = decodeURIComponent(rest.split('?')[0]) } catch { notFound(res); return }
    const parts = path.split('/').filter(Boolean)
    if (parts.some((p) => p === '..' || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) { notFound(res); return }
    if (!parts.length || path.endsWith('/')) parts.push('index.html')
    const file = resolve(target.dir, ...parts)
    let real: string, size: number
    try {
      if (!file.startsWith(target.dir + sep)) throw new Error('outside')
      real = realpathSync(file)
      const st = statSync(real)
      // A symlink must not lead out of the page's folder.
      if (!real.startsWith(target.dir + sep) || !st.isFile()) throw new Error('outside')
      size = st.size
    } catch { notFound(res); return }
    const mime = SAFE_TYPES[extname(real).toLowerCase()]
    if (!mime) { notFound(res); return }
    const range = rewritable(mime) ? null : /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    let start = 0, end = size - 1, status = 200
    if (range && (range[1] || range[2]) && size > 0) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return }
      status = 206
    }
    const rewrite = status === 200 && req.method !== 'HEAD' && rewritable(mime)
    res.writeHead(status, { 'Content-Type': mime, ...(rewrite ? {} : { 'Accept-Ranges': 'bytes', 'Content-Length': String(size ? end - start + 1 : 0) }),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) })
    if (req.method === 'HEAD' || !size) { res.end(); return }
    const stream = transfer.own(createReadStream(real, { start, end }))
    if (rewrite) pipeline(stream, transfer.own(rewriteResponse(mime, token, undefined, rest)), res, () => transfer.close())
    else pipeline(stream, res, () => transfer.close())
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, grant: Grant, token: string, rest: string, transfer: Transfer) {
    const target = grant.target as Extract<PreviewTarget, { kind: 'http' }>
    // The sandboxed page has an opaque origin, so its own fetches are cross-origin.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] ?? '').slice(0, 1024), 'Access-Control-Max-Age': '600' })
      res.end()
      return
    }
    const host = grant.host ?? (await loopbackHost(target.port, transfer))
    if (transfer.closed) return
    if (!host) { unreachable(res, target.port); return }
    grant.host = host
    const upstream = transfer.own(httpRequest({ host, port: target.port, method: req.method, path: rest || '/', headers: forwardHeaders(req.headers, target.port) }, (answer) => {
      transfer.own(answer)
      if (transfer.closed) return
      const headers = responseHeaders(answer.headers, token, target.port, rest)
      const mime = String(answer.headers['content-type'] ?? '')
      if (answer.statusCode === 206 && rewritable(mime)) { res.writeHead(416); res.end(); return }
      const rewrite = req.method !== 'HEAD' && rewritable(mime)
      if (rewrite) {
        delete headers['content-length']
        delete headers['content-encoding']
        delete headers['accept-ranges']
      }
      res.writeHead(answer.statusCode ?? 502, headers)
      if (rewrite) {
        const encoding = answer.headers['content-encoding']
        const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null
        if (encoding && encoding !== 'identity' && !decoder) { transfer.close(); return }
        const rewriteStream = transfer.own(rewriteResponse(mime, token, target.port, rest))
        if (decoder) pipeline(answer, transfer.own(decoder), rewriteStream, res, () => transfer.close())
        else pipeline(answer, rewriteStream, res, () => transfer.close())
      } else pipeline(answer, res, () => transfer.close())
    }))
    upstream.on('error', () => { if (!res.headersSent && !transfer.closed) unreachable(res, target.port); else transfer.close() })
    // pipeline tears down both the request and the upstream on abort/overflow.
    pipeline(req, transfer.own(bodyLimit()), upstream, (error) => { if (error) transfer.close() })
  }

  /** WebSocket for dev-server live reload, only on the preview path of a valid http grant. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!new URL(req.url ?? '/', 'http://preview.invalid').pathname.startsWith(REMOTE_PREVIEW_PREFIX)) return false
    const route = this.route(req)
    const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`, () => socket.destroy())
    if (!route?.grant || route.grant.target.kind !== 'http') { reject(404); return true }
    const grant = route.grant
    const target = grant.target as Extract<PreviewTarget, { kind: 'http' }>
    const port = target.port
    const transfer = this.track(req, socket, route.token, grant)
    if (!transfer) { reject(429); return true }
    transfer.connected()
    const handshake = transfer.after(this.opts.handshakeTimeoutMs ?? 10_000)
    socket.on('error', () => transfer.close())
    void (async () => {
      const host = grant.host ?? (await loopbackHost(port, transfer))
      if (transfer.closed) return
      if (!host) { reject(502); return }
      const headers = { ...forwardHeaders(req.headers, port), connection: 'Upgrade', upgrade: String(req.headers.upgrade ?? 'websocket') }
      const upstream = transfer.own(httpRequest({ host, port, method: 'GET', path: route.rest || '/', headers }))
      upstream.on('upgrade', (answer, upSocket, upHead) => {
        transfer.own(upSocket)
        if (transfer.closed) return
        clearTimeout(handshake)
        const lines = ['HTTP/1.1 101 Switching Protocols']
        for (const name of ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          const value = answer.headers[name]
          if (value) lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
        }
        lines.push('Cache-Control: no-store')
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead.length) socket.write(upHead)
        if (head.length) upSocket.write(head)
        pipeline(upSocket, socket, () => transfer.close())
        pipeline(socket, upSocket, () => transfer.close())
      })
      upstream.on('response', (answer) => { transfer.own(answer); reject(answer.statusCode ?? 502) })
      upstream.on('error', () => transfer.close())
      upstream.end()
    })()
    return true
  }
}

/** Every preview answer: an opaque-origin sandbox that may be framed by Drover only. */
function isolate(res: ServerResponse) {
  res.setHeader('Content-Security-Policy', REMOTE_PREVIEW_CSP)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Module scripts and fetches of an opaque origin are CORS requests; never with credentials.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}
function notFound(res: ServerResponse) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}
function unreachable(res: ServerResponse, port: number) {
  res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px -apple-system,system-ui,sans-serif;padding:24px;color:#666">localhost:${port} — 502</body>`)
}
function forwardHeaders(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROP_REQUEST.has(name) || name.startsWith('x-forwarded-') || name.startsWith('cf-')) continue
    out[name] = value
  }
  out['accept-encoding'] = 'identity' // Text rewriting must see decoded bytes.
  out.host = `localhost:${port}`
  if (headers.origin) out.origin = `http://localhost:${port}`
  return out
}
function responseHeaders(headers: IncomingHttpHeaders, token: string, port: number, rest: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const name of PASS_RESPONSE) if (headers[name] !== undefined) out[name] = headers[name]
  out['cache-control'] = 'no-store'
  const location = headers.location
  if (typeof location === 'string') {
    try {
      const url = new URL(location, new URL(rest, `http://localhost:${port}`))
      const local = LOOPBACK(url.hostname.toLowerCase()) && Number(url.port || 80) === port
      out.location = local ? `${REMOTE_PREVIEW_PREFIX}${token}${url.pathname}${url.search}${url.hash}` : url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
      if (!out.location) delete out.location
    } catch { /* drop a broken redirect */ }
  }
  return out
}

function rewritable(mime: string): boolean {
  return /^(text\/(html|css|javascript)|application\/(javascript|xhtml\+xml))/i.test(mime)
}

/** Bound transformed responses as well as uploads. Binary/media stays streamed. */
function rewriteResponse(mime: string, token: string, port?: number, rest = '/'): Transform {
  const chunks: Buffer[] = []
  let bytes = 0
  const prefix = `${REMOTE_PREVIEW_PREFIX}${token}`
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) { done(new Error('Preview document too large')); return }
      chunks.push(Buffer.from(chunk))
      done()
    },
    flush(done) {
      try {
        let body = Buffer.concat(chunks).toString('utf8')
        const route = (path: string): string => {
          if (path.startsWith(prefix + '/') || path === prefix) return path
          if (path.startsWith('/') && !path.startsWith('//')) return prefix + path
          try {
            const url = new URL(path.startsWith('//') ? 'http:' + path : path)
            if (port && LOOPBACK(url.hostname.toLowerCase()) && Number(url.port || 80) === port) return prefix + url.pathname + url.search + url.hash
          } catch { /* leave external/non-URL text alone */ }
          return path
        }
        body = /html/i.test(mime) ? rewriteHTML(body, route, token, port, rest) : /css/i.test(mime) ? rewriteCSS(body, route) : rewriteJS(body, route, token, port, rest)
        if (/html/i.test(mime)) {
          const runtime = `(${PREVIEW_RUNTIME})(${JSON.stringify(prefix)},${port ?? 0});`
          if (/xhtml/i.test(mime)) {
            const script = `<script><![CDATA[${runtime}]]></script>`
            body = /<head\b[^>]*>/i.test(body) ? body.replace(/<head\b[^>]*>/i, (head) => head + script)
              : body.replace(/<html\b[^>]*>/i, (html) => html + '<head>' + script + '</head>')
          } else {
            const script = `<script>${runtime}</script>`
            // Before any application script or resource, retaining the doctype.
            body = body.replace(/^(\s*<!doctype[^>]*>)?/i, (doctype) => doctype + script)
          }
        }
        done(null, body)
      } catch (error) { done(error instanceof Error ? error : new Error(String(error))) }
    }
  })
}

/** Rewrite URL-bearing syntax only: arbitrary JS strings (e.g. join('/'))
 * must keep their meaning. Dynamic network/DOM URLs use the early runtime. */
function rewriteJS(body: string, route: (path: string) => string, token: string, port: number | undefined, rest: string): string {
  const parsed = moduleImports(body)
  if (!Array.isArray(parsed)) throw new Error('Module lexer not initialized')
  const edits: { start: number; end: number; text: string }[] = []
  for (const entry of parsed[0]) {
    if (entry.t === 2) {
      // Replace the import operator with a promise-returning wrapper. Keeping
      // its argument list intact handles templates, nested calls and options.
      const map = `(typeof value === 'string' && !value.startsWith('/') && !value.startsWith('./') && !value.startsWith('../') && !value.includes('://') ? value : (${PREVIEW_ROUTE})(${JSON.stringify(REMOTE_PREVIEW_PREFIX + token)},${port ?? 0},value,${JSON.stringify(REMOTE_PREVIEW_PREFIX + token + rest)}))`
      edits.push({ start: entry.ss, end: entry.d, text: `((value, options) => import(${map}, options))` })
    } else if (entry.d === -1 && entry.n !== undefined) {
      const mapped = route(entry.n)
      if (mapped !== entry.n) edits.push({ start: entry.s - 1, end: entry.e + 1, text: JSON.stringify(mapped) })
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end)
  return body
}
function rewriteCSS(body: string, route: (path: string) => string): string {
  return body.replace(/(url\(\s*)(["']?)([^\s"')]+)\2(\s*\))|(@import\s*)(["'])([^"']+)\6/gi,
    (_match, before: string, quote: string, path: string, end: string, imp: string, iq: string, ip: string) =>
      before ? before + quote + route(path) + quote + end : imp + iq + route(ip) + iq)
}
function rewriteHTML(body: string, route: (path: string) => string, token: string, port: number | undefined, rest: string): string {
  const attrs = (tag: string) => tag
    .replace(/(\b(?:src|href|action|poster|data|formaction)\s*=\s*)(?:(["'])([\s\S]*?)\2|([^\s>]+))/gi,
      (_match, before: string, quote: string, path: string, unquoted: string) => before + (quote ? quote + route(path) + quote : route(unquoted)))
    .replace(/(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
      (_match, before: string, quote: string, list: string) => before + quote + list.replace(/(^|,\s*)([^\s,]+)/g, (_entry, comma: string, path: string) => comma + route(path)) + quote)
    .replace(/(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi,
      (_match, before: string, quote: string, css: string) => before + quote + rewriteCSS(css, route) + quote)
  return body.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi, (tag) => {
    if (tag.startsWith('<!--')) return tag
    const raw = /^(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)$/i.exec(tag)
    if (raw && raw[2].toLowerCase() === 'script') {
      const type = /\btype\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/i.exec(raw[1])
      const format = (type?.[1] ?? type?.[2] ?? '').toLowerCase()
      if (format && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(format)) {
        if (format === 'importmap') {
          const map = JSON.parse(raw[3])
          const imports = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, typeof value === 'string' ? route(value) : value]))
          if (map.imports) map.imports = imports(map.imports)
          if (map.scopes) map.scopes = Object.fromEntries(Object.entries(map.scopes).map(([scope, entries]) => [route(scope), imports(entries as Record<string, unknown>)]))
          return attrs(raw[1]) + JSON.stringify(map).replace(/</g, '\\u003c') + raw[4]
        }
        return attrs(raw[1]) + raw[3] + raw[4]
      }
    }
    if (raw) return attrs(raw[1]) + (raw[2].toLowerCase() === 'script' ? rewriteJS(raw[3], route, token, port, rest) : rewriteCSS(raw[3], route)) + raw[4]
    return attrs(tag)
  })
}
