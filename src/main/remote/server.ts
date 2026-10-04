import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { WebSocket, WebSocketServer } from 'ws'
import {
  REMOTE_AUTH_ENTRY, REMOTE_AUTH_ROUTES, REMOTE_EVENT_CHANNELS, REMOTE_WEB_ENTRY, REMOTE_WS_PATH, REMOTE_PUSH_ROUTES, REMOTE_ATTACHMENT_ROUTES, remoteUsesProxy,
  type RemoteAccessSettings, type RemotePairingCode, type RemoteStatus, type RemotePushPreferences, type RemotePushStatus
} from '@shared/remote'
import { RemoteAuth } from './auth'
import { RemoteAuthStore, sessionCookie, sessionToken, poisonAuthStore } from './store'
import { allowedOrigin, AttemptLimiter, RemoteFailure, remoteIdentity, visitorAddress } from './security'
import { dispatchRemoteRpc, releaseRemoteRpc, RemoteRpcConnection, type RpcHandlers } from './rpc'
import { PushNotifications } from './push'
import { attachmentStorage, attachmentType, readAttachment, readAttachmentBody, saveAttachment } from './attachments'
import type { HerdrSnapshot } from '@shared/types'
import type { StatusChange } from '../herdr/service'

interface Host {
  webRoot: string
  userData: string
  handlers: RpcHandlers
  settings: () => RemoteAccessSettings
  saveSettings: (patch: RemoteAccessSettings) => void
  statusChanged: (status: RemoteStatus) => void
  persistenceWarning?: (error: string, poisonSaved: boolean) => void
  pushTitle?: (name: string, kind: 'finished' | 'blocked') => string
  attachmentsDir?: string
  /** Test override of the configured loopback proxy; empty string disables trust. */
  trustedProxy?: string
}
interface Client { ws: WebSocket; rpc: RemoteRpcConnection; token: string; alive: boolean; pending: number; queue: Promise<void> }
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
}
const wireJson = (value: unknown): string => JSON.stringify(value, (_key, v) => v instanceof Uint8Array ? Array.from(v) : v)

export function validateRemoteSettings(patch: Partial<RemoteAccessSettings>, current: RemoteAccessSettings): RemoteAccessSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some((k) => !['remoteEnabled', 'remotePort', 'remotePublicUrl', 'remoteBehindProxy'].includes(k)) ||
      ('remoteBehindProxy' in patch && typeof patch.remoteBehindProxy !== 'boolean')) {
    throw new RemoteFailure('invalid_settings', 'Invalid remote settings patch')
  }
  const next = { ...current, ...patch }
  if (typeof next.remoteEnabled !== 'boolean' || typeof next.remotePublicUrl !== 'string') throw new RemoteFailure('invalid_settings', 'Invalid remote settings')
  remoteIdentity(next)
  return next
}

export class RemoteServer {
  private uploads = 0
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private authInstance: RemoteAuth | null = null
  private limiter = new AttemptLimiter()
  private authenticatedLimiter = new AttemptLimiter(Date.now, 60_000, 120, 1200)
  private logoutLimiter = new AttemptLimiter(Date.now, 60_000, 10, 120)
  private persistencePending = false
  private restartRequired = false
  private heartbeat: NodeJS.Timeout | null = null
  private applied = ''
  private error: string | undefined
  private changing = Promise.resolve()
  private push: PushNotifications
  constructor(private host: Host) {
    this.push = new PushNotifications({ userData: host.userData, store: () => this.auth.store,
      settings: host.settings, enabled: () => !!this.server?.listening, title: host.pushTitle })
  }
  private get auth(): RemoteAuth {
    return this.authInstance ??= new RemoteAuth(new RemoteAuthStore(join(this.host.userData, 'remote-auth.json')), this.host.settings)
  }
  private requireNoPoisonFailure(): void {
    if (this.restartRequired) throw new RemoteFailure('remote_restart_required', this.error ?? 'Restart Drover before enabling remote access', 503)
  }
  private visitor(req: IncomingMessage): string {
    const proxy = this.host.trustedProxy ?? (remoteUsesProxy(this.host.settings()) ? '127.0.0.1' : undefined)
    return visitorAddress(req.socket.remoteAddress, req.headers['x-forwarded-for'], proxy)
  }
  status(): RemoteStatus {
    const settings = this.host.settings()
    let identity
    try { identity = remoteIdentity(settings) } catch { identity = { origin: '', localUrl: '' } }
    return { ...settings, running: !!this.server?.listening, origin: identity.origin, localUrl: identity.localUrl,
      connectedDevices: new Set([...this.clients].map((c) => this.auth.store.session(c.token, identity.origin)?.device.id).filter(Boolean)).size, error: this.error }
  }
  private emitStatus(): void { this.host.statusChanged(this.status()) }
  async configure(patch: Partial<RemoteAccessSettings>): Promise<RemoteStatus> {
    this.requireNoPoisonFailure()
    const next = validateRemoteSettings(patch, this.host.settings())
    try {
      if (this.persistencePending) this.auth.store.flush()
      this.host.saveSettings(next)
      this.persistencePending = false
      this.error = undefined
    } catch (error) { await this.persistenceFailed(error, patch.remoteEnabled === false); throw error }
    await this.sync()
    return this.status()
  }
  sync(): Promise<void> {
    const run = async () => {
      if (this.restartRequired) { await this.stop(); this.emitStatus(); return }
      const settings = this.host.settings()
      if (this.persistencePending) {
        try { this.auth.store.flush(); this.host.saveSettings(settings); this.persistencePending = false }
        catch (error) { await this.persistenceFailed(error); return }
      }
      const key = JSON.stringify(settings)
      if (this.applied === key && (this.server?.listening || !settings.remoteEnabled)) return
      await this.stop()
      if (this.persistencePending) { this.emitStatus(); return }
      this.error = undefined
      this.applied = key
      if (settings.remoteEnabled) {
        try { this.host.saveSettings(settings) }
        catch (error) { await this.persistenceFailed(error); return }
        try { remoteIdentity(settings); await this.start() }
        catch (error) { await this.stop(); this.error = error instanceof Error ? error.message : 'Unable to start remote access' }
      }
      this.emitStatus()
    }
    this.changing = this.changing.then(run, run)
    return this.changing
  }
  pairingCode(): RemotePairingCode {
    if (!this.server?.listening) throw new RemoteFailure('remote_disabled', 'Enable remote access first')
    const code = this.auth.codes.create()
    return { ...code, url: `${remoteIdentity(this.host.settings()).origin}/pair?code=${encodeURIComponent(code.code)}` }
  }
  devices() { return this.auth.store.devices() }
  async revoke(id: string): Promise<void> {
    this.requireNoPoisonFailure()
    try { this.auth.store.revoke(id) }
    catch (error) { await this.persistenceFailed(error, true); throw error }
    this.expireClients(); this.emitStatus()
  }
  async persistenceFailed(error: unknown, invalidateAuth = false): Promise<void> {
    this.persistencePending = true
    const warn = invalidateAuth && !this.restartRequired
    this.restartRequired ||= invalidateAuth
    const stopped = this.stop() // Stops accepting connections before any marker I/O.
    this.error = error instanceof Error ? error.message : 'Unable to save remote access'
    let poisonSaved = false
    if (invalidateAuth) {
      this.authInstance?.store.invalidate()
      const result = poisonAuthStore(join(this.host.userData, 'remote-auth.json'))
      poisonSaved = result.saved
      this.error = `Remote access stopped until Drover restarts. ${this.error}`
      if (!result.saved) this.error += `; Unable to persist authorization invalidation: ${result.errors.join('; ')}`
    }
    await stopped
    try { this.host.saveSettings({ ...this.host.settings(), remoteEnabled: false }) }
    catch (saveError) { this.error += `; ${saveError instanceof Error ? saveError.message : 'Unable to save disabled state'}` }
    this.emitStatus()
    if (warn) this.host.persistenceWarning?.(this.error, poisonSaved)
  }
  pushPublicKey(): string { return this.push.publicKey() }
  private pushDevice(deviceId?: string): string {
    if (!deviceId) throw new RemoteFailure('unauthorized', 'Push settings require an authenticated browser device', 401)
    return deviceId
  }
  pushStatus(deviceId?: string): RemotePushStatus { return this.auth.store.pushStatus(this.pushDevice(deviceId)) }
  savePushSubscription(deviceId: string | undefined, subscription: unknown): RemotePushStatus {
    return this.auth.store.savePushSubscription(this.pushDevice(deviceId), subscription)
  }
  deletePushSubscription(deviceId: string | undefined, endpoint?: string): RemotePushStatus {
    return this.auth.store.removePushSubscription(this.pushDevice(deviceId), endpoint)
  }
  setPushPreferences(deviceId: string | undefined, patch: Partial<RemotePushPreferences>): RemotePushStatus {
    return this.auth.store.setPushPreferences(this.pushDevice(deviceId), patch)
  }
  agentStatusChanged(change: StatusChange, snapshot: HerdrSnapshot | null, session: string): Promise<void> {
    return this.push.statusChanged(change, snapshot, session)
  }
  private expireClients(): void {
    const origin = remoteIdentity(this.host.settings()).origin
    for (const client of this.clients) if (!this.auth.store.session(client.token, origin)) client.ws.close(4001, 'Session expired or revoked')
  }
  private async start(): Promise<void> {
    this.auth.store.recover() // Poison recovery must reach disk before opening the port.
    await attachmentStorage(this.host.attachmentsDir).cleanup()
    const server = createServer((req, res) => { void this.http(req, res).catch((e) => this.httpError(res, e)) })
    server.headersTimeout = 10_000
    server.requestTimeout = 120_000 // Allow bounded 20 MB uploads over a phone connection.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
    this.server = server
    this.wss = wss
    server.on('upgrade', (req, socket, head) => {
      const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`) }
      if (req.url !== REMOTE_WS_PATH || !this.validHost(req) || !allowedOrigin(req.headers.origin, this.host.settings())) return reject(403)
      const token = sessionToken(req.headers.cookie)
      if (!token || !this.auth.store.session(token, remoteIdentity(this.host.settings()).origin)) return reject(401)
      if (this.clients.size >= 32) return reject(429)
      wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, token))
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(this.host.settings().remotePort, '127.0.0.1', () => { server.off('error', reject); resolvePromise() })
    })
    server.on('error', (e) => { this.error = e.message; this.emitStatus() })
    this.heartbeat = setInterval(() => {
      this.expireClients()
      for (const client of this.clients) {
        if (!client.alive) client.ws.terminate()
        else { client.alive = false; client.ws.ping() }
      }
    }, 30_000)
    this.heartbeat.unref()
    attachmentStorage(this.host.attachmentsDir).startCleanup()
  }
  async stop(): Promise<void> {
    attachmentStorage(this.host.attachmentsDir).stopCleanup()
    this.authInstance?.clearPending()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) { releaseRemoteRpc(this.host.handlers, client.rpc); client.ws.terminate() }
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() })
  }
  private validHost(req: IncomingMessage): boolean {
    const identity = remoteIdentity(this.host.settings())
    return req.headers.host === new URL(identity.origin).host || req.headers.host === new URL(identity.localUrl).host
  }
  private connect(ws: WebSocket, token: string): void {
    const deviceId = this.auth.store.session(token, remoteIdentity(this.host.settings()).origin)!.device.id
    const client: Client = { ws, token, rpc: new RemoteRpcConnection(randomUUID(), deviceId), alive: true, pending: 0, queue: Promise.resolve() }
    this.clients.add(client)
    ws.on('error', () => ws.terminate())
    ws.on('pong', () => { client.alive = true })
    ws.on('close', () => { releaseRemoteRpc(this.host.handlers, client.rpc); this.clients.delete(client); this.emitStatus() })
    ws.on('message', (data, binary) => {
      if (binary || ++client.pending > 32) { ws.close(1008, 'Invalid or excessive RPC calls'); return }
      // Ordered per connection: terminal close/input cannot overtake terminal open.
      client.queue = client.queue.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (!this.auth.store.session(token, remoteIdentity(this.host.settings()).origin)) { ws.close(4001, 'Unauthorized'); return }
        let message: unknown
        try { message = JSON.parse(data.toString()) } catch { ws.close(1008, 'Invalid JSON'); return }
        const result = await dispatchRemoteRpc(this.host.handlers, client.rpc, message)
        this.write(client, result)
      }).catch(() => ws.close(1011, 'RPC transport failed')).finally(() => { client.pending-- })
    })
    this.emitStatus()
  }
  private write(client: Client, value: unknown): void {
    if (client.ws.readyState !== WebSocket.OPEN) return
    if (client.ws.bufferedAmount > 4 * 1024 * 1024) { client.ws.close(1008, 'Client too slow'); return }
    client.ws.send(wireJson(value))
  }
  broadcast(channel: string, args: unknown[]): void {
    if (!(REMOTE_EVENT_CHANNELS as readonly string[]).includes(channel)) return
    for (const client of this.clients) {
      if (!this.auth.store.session(client.token, remoteIdentity(this.host.settings()).origin)) { client.ws.close(4001, 'Unauthorized'); continue }
      let eventArgs = args
      if (channel === 'term:frames' || channel === 'term:closed') {
        const entry = [...client.rpc.terminals].find(([, internalId]) => internalId === args[0])
        if (!entry) continue
        eventArgs = [entry[0], ...args.slice(1)]
      }
      if (channel === 'transcript:update' && !client.rpc.transcripts.has((args[0] as { paneId?: string })?.paneId ?? '')) continue
      this.write(client, { t: 'event', channel, args: eventArgs })
    }
  }
  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  private httpError(res: ServerResponse, error: unknown): void {
    if (res.headersSent || res.destroyed) { res.destroy(); return }
    // Rejected POST bodies may be unread (or have a dishonest Content-Length).
    // Return the error, then close rather than reusing an incomplete request.
    if (res.req.method === 'POST') res.setHeader('Connection', 'close')
    if (error instanceof RemoteFailure) {
      if (error.status === 429) res.setHeader('Retry-After', '60')
      this.json(res, error.status, { error: { code: error.code, message: error.message } })
    } else this.json(res, 500, { error: { code: 'error', message: 'Remote server request failed' } })
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new RemoteFailure('invalid_content_type', 'Expected application/json', 415)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 128 * 1024) throw new RemoteFailure('body_too_large', 'Request too large', 413)
      chunks.push(Buffer.from(chunk))
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new RemoteFailure('invalid_json', 'Invalid JSON') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteFailure('invalid_json', 'Expected a JSON object')
    return value
  }
  private staticFile(res: ServerResponse, relative: string, head: boolean): void {
    let root: string
    try { root = realpathSync(this.host.webRoot) } catch { throw new RemoteFailure('web_build_missing', 'Web entry not built; build the web renderer', 404) }
    const file = resolve(root, relative)
    if (!file.startsWith(root + sep)) throw new RemoteFailure('not_found', 'Not found', 404)
    let actual: string
    try { actual = realpathSync(file) } catch { throw new RemoteFailure('web_build_missing', 'Web entry not built; build the web renderer', 404) }
    if (!actual.startsWith(root + sep) || !statSync(actual).isFile() || !MIME[extname(actual)]) throw new RemoteFailure('not_found', 'Not found', 404)
    res.writeHead(200, { 'Content-Type': MIME[extname(actual)] })
    res.end(head ? undefined : readFileSync(actual))
  }
  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (!this.validHost(req)) throw new RemoteFailure('invalid_host', 'Invalid Host', 403)
    const identity = remoteIdentity(this.host.settings())
    const currentOrigin = req.headers.host === new URL(identity.origin).host ? identity.origin : identity.localUrl
    const wsOrigin = currentOrigin.replace(/^http/, 'ws')
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src ${currentOrigin} ${wsOrigin}; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
    let path: string
    try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname) }
    catch { throw new RemoteFailure('invalid_path', 'Invalid path') }
    if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) throw new RemoteFailure('not_found', 'Not found', 404)
    const token = sessionToken(req.headers.cookie)
    const session = this.auth.store.session(token, identity.origin)
    if (req.method === 'POST') {
      if (!allowedOrigin(req.headers.origin, this.host.settings())) throw new RemoteFailure('invalid_origin', 'Invalid Origin', 403)
      if (path === REMOTE_ATTACHMENT_ROUTES.upload) {
        if (!session) throw new RemoteFailure('unauthorized', 'Login required', 401)
        this.authenticatedLimiter.check(session.device.id)
        if (this.uploads >= 3) throw new RemoteFailure('rate_limited', 'Too many uploads', 429)
        let name: string
        try { name = decodeURIComponent(String(req.headers['x-drover-filename'] ?? '')) } catch { throw new RemoteFailure('invalid_filename', 'Invalid filename') }
        if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new RemoteFailure('invalid_filename', 'Invalid filename')
        const mime = req.headers['content-type'] ?? ''
        attachmentType(name, mime)
        this.uploads++
        try {
          const bytes = await readAttachmentBody(req)
          if (!this.auth.store.session(token, identity.origin)) throw new RemoteFailure('unauthorized', 'Login required', 401)
          const attachment = await saveAttachment(bytes, name, mime, this.host.attachmentsDir)
          if (!this.auth.store.session(token, identity.origin)) {
            await rm(attachment.path, { force: true })
            throw new RemoteFailure('unauthorized', 'Login required', 401)
          }
          this.json(res, 200, attachment)
        } finally { this.uploads-- }
        return
      }
      if ([REMOTE_PUSH_ROUTES.subscribe, REMOTE_PUSH_ROUTES.unsubscribe, REMOTE_PUSH_ROUTES.preferences].includes(path as never)) {
        if (!session) throw new RemoteFailure('unauthorized', 'Login required', 401)
        this.authenticatedLimiter.check(session.device.id)
        const body = await this.body(req)
        const channel = path === REMOTE_PUSH_ROUTES.subscribe ? 'push:subscribe' : path === REMOTE_PUSH_ROUTES.unsubscribe ? 'push:unsubscribe' : 'push:preferences'
        const args = path === REMOTE_PUSH_ROUTES.unsubscribe ? [body.endpoint] : [body]
        const value = await this.host.handlers.invoke(channel, { remote: new RemoteRpcConnection('http', session.device.id) }, args)
        this.json(res, 200, value)
        return
      }
      if (path === REMOTE_AUTH_ROUTES.logout) {
        if (session) this.authenticatedLimiter.check(session.device.id)
        else this.logoutLimiter.check(this.visitor(req))
        res.setHeader('Set-Cookie', sessionCookie('', identity.secure, true))
        if (Object.keys(await this.body(req)).length) throw new RemoteFailure('invalid_args', 'Expected an empty logout body')
        if (session && token) {
          try { this.auth.store.logout(token) }
          catch (error) { await this.persistenceFailed(error, true); throw error }
        }
        this.expireClients()
        this.json(res, 200, { ok: true })
        return
      }
      if (!Object.values(REMOTE_AUTH_ROUTES).includes(path as never) || path === REMOTE_AUTH_ROUTES.session) throw new RemoteFailure('not_found', 'Not found', 404)
      this.limiter.check(this.visitor(req))
      const result = await this.auth.post(path, await this.body(req), req.headers.origin!)
      if (result.cookie) res.setHeader('Set-Cookie', result.cookie)
      this.json(res, 200, result.body)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new RemoteFailure('method_not_allowed', 'Method not allowed', 405)
    if (path === REMOTE_PUSH_ROUTES.key || path === REMOTE_PUSH_ROUTES.status) {
      if (!session) throw new RemoteFailure('unauthorized', 'Login required', 401)
      const value = await this.host.handlers.invoke(path === REMOTE_PUSH_ROUTES.key ? 'push:key' : 'push:status',
        { remote: new RemoteRpcConnection('http', session.device.id) }, [])
      this.json(res, 200, value)
      return
    }
    if (path === REMOTE_AUTH_ROUTES.session) {
      this.json(res, 200, session ? { authenticated: true, device: session.device, expiresAt: session.session.expiresAt } : { authenticated: false })
      return
    }
    if (path === '/login' || path === '/pair') { this.staticFile(res, REMOTE_AUTH_ENTRY, req.method === 'HEAD'); return }
    if (path.startsWith('/auth/assets/')) { this.staticFile(res, path.slice(1), req.method === 'HEAD'); return }
    if (path.startsWith('/auth/')) throw new RemoteFailure('not_found', 'Not found', 404)
    if (!session) {
      if (path === '/') { res.writeHead(302, { Location: '/login' }); res.end(); return }
      throw new RemoteFailure('unauthorized', 'Login required', 401)
    }
    if (path.startsWith(REMOTE_ATTACHMENT_ROUTES.previewPrefix)) {
      const attachment = await readAttachment(path.slice(REMOTE_ATTACHMENT_ROUTES.previewPrefix.length), this.host.attachmentsDir)
      res.writeHead(200, { 'Content-Type': attachment.mime, 'Content-Security-Policy': "default-src 'none'; sandbox" })
      res.end(req.method === 'HEAD' ? undefined : attachment.bytes)
      return
    }
    this.staticFile(res, path === '/' ? REMOTE_WEB_ENTRY : path.slice(1), req.method === 'HEAD')
  }
}
