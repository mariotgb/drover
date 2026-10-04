import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { REMOTE_PAIRING_TTL_MS, type RemoteAccessSettings } from '@shared/remote'

export class RemoteFailure extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}
export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')
export const newSecret = (): string => randomBytes(32).toString('base64url')

/** The desktop app ignores environment overrides; tests opt in explicitly. */
export function testTrustedProxy(env: NodeJS.ProcessEnv): string | undefined {
  return env.NODE_ENV === 'test' ? env.DROVER_TRUSTED_PROXY_IP : undefined
}

export function remoteIdentity(settings: RemoteAccessSettings): { origin: string; rpID: string; localUrl: string; secure: boolean } {
  if (!Number.isInteger(settings.remotePort) || settings.remotePort < 1024 || settings.remotePort > 65535) {
    throw new RemoteFailure('invalid_settings', 'Remote port must be between 1024 and 65535')
  }
  const localUrl = `http://localhost:${settings.remotePort}`
  let url: URL
  try { url = new URL(settings.remotePublicUrl || localUrl) }
  catch { throw new RemoteFailure('invalid_settings', 'Public address must be an HTTPS origin') }
  const local = url.hostname === 'localhost'
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || (!local && /^[\d.]+$/.test(url.hostname))) {
    throw new RemoteFailure('invalid_settings', 'Use an HTTPS domain origin, or http://localhost:<port>')
  }
  if (local && url.origin !== localUrl) throw new RemoteFailure('invalid_settings', 'Local address must use the configured port')
  return { origin: url.origin, rpID: url.hostname, localUrl, secure: !local }
}

/** Exact strings, no suffix match, no forwarded headers, no missing/null Origin. */
export function allowedOrigin(origin: unknown, settings: RemoteAccessSettings): origin is string {
  const identity = remoteIdentity(settings)
  return typeof origin === 'string' && (origin === identity.origin || origin === identity.localUrl)
}

export class PairingCodes {
  private codes = new Map<string, number>()
  constructor(private now: () => number = Date.now) {}
  create(): { code: string; expiresAt: number } {
    this.codes.clear()
    const code = randomBytes(18).toString('base64url')
    const expiresAt = this.now() + REMOTE_PAIRING_TTL_MS
    this.codes.set(hashSecret(code), expiresAt)
    return { code, expiresAt }
  }
  validHash(hash: string): boolean { return (this.codes.get(hash) ?? 0) > this.now() }
  check(code: unknown): string {
    if (typeof code !== 'string' || code.length > 100 || !this.validHash(hashSecret(code))) {
      throw new RemoteFailure('invalid_pairing_code', 'Pairing code expired or already used', 403)
    }
    return hashSecret(code)
  }
  consume(hash: string): void {
    if (!this.validHash(hash)) throw new RemoteFailure('invalid_pairing_code', 'Pairing code expired or already used', 403)
    this.codes.delete(hash)
  }
  clear(): void { this.codes.clear() }
}

export class Challenges<T> {
  private entries = new Map<string, { expiresAt: number; value: T }>()
  constructor(private now: () => number = Date.now) {}
  add(value: T): string {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(id)
    if (this.entries.size >= 100) throw new RemoteFailure('rate_limited', 'Too many pending login attempts', 429)
    const id = newSecret()
    this.entries.set(id, { value, expiresAt: this.now() + 5 * 60 * 1000 })
    return id
  }
  take(id: unknown): T {
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined
    if (typeof id === 'string') this.entries.delete(id)
    if (!entry || entry.expiresAt <= this.now()) throw new RemoteFailure('invalid_challenge', 'Challenge expired or already used', 403)
    return entry.value
  }
  clear(): void { this.entries.clear() }
}

/** Forwarded values are never accepted without an explicitly trusted socket peer.
 * Require a single IP: proxy must replace, rather than append, untrusted headers.
 */
export function visitorAddress(peer: string | undefined, forwarded: unknown, trustedProxy?: string): string {
  const normalize = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip.toLowerCase()
  const address = normalize(peer ?? 'unknown')
  return trustedProxy && isIP(trustedProxy) && address === normalize(trustedProxy) && typeof forwarded === 'string' && isIP(forwarded)
    ? normalize(forwarded) : address
}
/** Rejected attempts from an exhausted visitor do not consume other visitors' budget. */
export class AttemptLimiter {
  private buckets = new Map<string, { start: number; count: number }>()
  constructor(private now: () => number = Date.now, private windowMs = 60_000, private perVisitor = 30, private total = 120) {}
  check(address: string): void {
    for (const [key, entry] of this.buckets) if (entry.start + this.windowMs <= this.now()) this.buckets.delete(key)
    const visitor = this.buckets.get(`ip:${address}`) ?? { start: this.now(), count: 0 }
    const global = this.buckets.get('global') ?? { start: this.now(), count: 0 }
    if (visitor.count >= this.perVisitor || global.count >= this.total) throw new RemoteFailure('rate_limited', 'Too many attempts; try again in a minute', 429)
    this.buckets.set(`ip:${address}`, visitor)
    this.buckets.set('global', global)
    visitor.count++; global.count++
  }
}
