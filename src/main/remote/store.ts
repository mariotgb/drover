import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, fsyncSync, closeSync, lstatSync, constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PUSH_PREFERENCES, REMOTE_SESSION_DAYS, type RemoteDevice,
  type RemotePushPreferences, type RemotePushStatus, type RemotePushSubscription
} from '@shared/remote'
import { hashSecret, newSecret, RemoteFailure } from './security'
import { validatePushPreferences, validatePushSubscription } from './push-subscription'

export interface StoredDevice extends RemoteDevice {
  rpID: string
  userID: string
  credential: { id: string; publicKey: string; counter: number; transports?: string[] }
  pushPreferences?: RemotePushPreferences
  pushSubscriptions?: RemotePushSubscription[]
}
export interface StoredSession { hash: string; deviceId: string; origin: string; expiresAt: number }
interface AuthData { version: 1; devices: StoredDevice[]; sessions: StoredSession[] }

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
/** Stable across process restarts, isolated by user and absolute profile path. */
export function authPoisonPaths(file: string): string[] {
  return [file + '.poison', join(tmpdir(), `drover-auth-poison-${process.getuid?.() ?? 'user'}`, hashSecret(resolve(file)) + '.poison')]
}
export function poisonAuthStore(file: string): { saved: boolean; errors: string[] } {
  const errors: string[] = []
  for (const marker of authPoisonPaths(file)) {
    try {
      const parent = dirname(marker)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      const st = lstatSync(parent)
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('Invalid poison marker directory')
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, '1\n'); fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory(parent)
      return { saved: true, errors }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  // Accepted risk: if neither the profile nor temporary storage is writable,
  // no durable invalidation is possible. Keep this process closed and warn the
  // owner; a restart may load stale credentials. A fallback in os.tmpdir() can
  // also be lost if the OS cleans temporary storage before the next startup.
  return { saved: false, errors }
}

/** Public keys and hashed session secrets only. No private passkey key lives here. */
export class RemoteAuthStore {
  private data: AuthData = { version: 1, devices: [], sessions: [] }
  private poisoned: boolean
  constructor(private file: string, private now: () => number = Date.now) {
    this.poisoned = authPoisonPaths(file).some(marker => existsSync(marker))
    // Legacy .active markers are deliberately ignored: crashes alone must not
    // revoke access. Only an actual failed revocation/disable creates poison.
    if (!this.poisoned && existsSync(file)) {
      chmodSync(file, 0o600)
      const loaded = JSON.parse(readFileSync(file, 'utf8')) as AuthData
      if (loaded.version !== 1 || !Array.isArray(loaded.devices) || !Array.isArray(loaded.sessions)) {
        throw new Error('Invalid remote authentication store')
      }
      this.data = loaded
    }
  }
  invalidate(): void { this.data = { version: 1, devices: [], sessions: [] } }
  /** Persist the invalidated store before removing poison or opening the port. */
  recover(): void {
    if (!this.poisoned) return
    this.save()
    for (const marker of authPoisonPaths(this.file)) if (existsSync(marker)) {
      rmSync(marker, { force: true })
      syncDirectory(dirname(marker))
    }
    this.poisoned = false
  }
  devices(): RemoteDevice[] {
    return this.data.devices.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }))
  }
  credentials(rpID: string): StoredDevice[] { return this.data.devices.filter((d) => d.rpID === rpID) }
  credential(id: string, rpID: string): StoredDevice | undefined {
    return this.data.devices.find((d) => d.credential.id === id && d.rpID === rpID)
  }
  addDevice(input: Pick<StoredDevice, 'name' | 'rpID' | 'userID' | 'credential'>): StoredDevice {
    if (this.credential(input.credential.id, input.rpID)) throw new RemoteFailure('duplicate_credential', 'Passkey already registered')
    const device = { ...input, id: randomUUID(), createdAt: this.now(), lastUsedAt: this.now() }
    this.data.devices.push(device)
    this.save()
    return device
  }
  updateCredential(id: string, counter: number): StoredDevice {
    const device = this.data.devices.find((d) => d.id === id)
    if (!device) throw new RemoteFailure('unauthorized', 'Device was revoked', 401)
    // Concurrent verification must not decrease an already advanced counter.
    if (device.credential.counter > 0 && counter <= device.credential.counter) throw new RemoteFailure('invalid_authentication', 'Stale signature counter', 403)
    device.credential.counter = counter
    device.lastUsedAt = this.now()
    this.save()
    return device
  }
  issueSession(deviceId: string, origin: string): { token: string; expiresAt: number } {
    if (!this.data.devices.some((d) => d.id === deviceId)) throw new RemoteFailure('unauthorized', 'Device was revoked', 401)
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > this.now())
    const token = newSecret()
    const expiresAt = this.now() + REMOTE_SESSION_DAYS * 86400_000
    this.data.sessions.push({ hash: hashSecret(token), deviceId, origin, expiresAt })
    this.save()
    return { token, expiresAt }
  }
  session(token: unknown, origin: string): { session: StoredSession; device: RemoteDevice } | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const session = this.data.sessions.find((s) => s.hash === hashSecret(token) && s.origin === origin && s.expiresAt > this.now())
    if (!session) return undefined
    const device = this.devices().find((d) => d.id === session.deviceId)
    return device ? { session, device } : undefined
  }
  logout(token: string): void {
    const sessions = this.data.sessions.filter((s) => s.hash !== hashSecret(token))
    if (sessions.length === this.data.sessions.length) return
    this.data.sessions = sessions
    this.save()
  }
  revoke(deviceId: string): void {
    // Preferences and subscriptions live inside the device, so revoke is atomic.
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId)
    this.data.sessions = this.data.sessions.filter((s) => s.deviceId !== deviceId)
    this.save()
  }
  /** Retry the in-memory revocation before reopening remote access. */
  flush(): void { this.save() }
  private pushDevice(id: string): StoredDevice {
    const device = this.data.devices.find((d) => d.id === id)
    if (!device) throw new RemoteFailure('unauthorized', 'Device was revoked', 401)
    return device
  }
  pushStatus(deviceId: string): RemotePushStatus {
    const device = this.pushDevice(deviceId)
    const subscriptionCount = (device.pushSubscriptions ?? []).filter((s) => !s.expirationTime || s.expirationTime > this.now()).length
    return { subscribed: subscriptionCount > 0, subscriptionCount, preferences: { ...DEFAULT_PUSH_PREFERENCES, ...device.pushPreferences } }
  }
  savePushSubscription(deviceId: string, input: unknown): RemotePushStatus {
    const device = this.pushDevice(deviceId)
    const subscription = validatePushSubscription(input)
    if (subscription.expirationTime && subscription.expirationTime <= this.now()) throw new RemoteFailure('invalid_subscription', 'Subscription expired')
    if (this.data.devices.some((d) => d.id !== deviceId && d.pushSubscriptions?.some((s) => s.endpoint === subscription.endpoint))) {
      throw new RemoteFailure('subscription_in_use', 'Subscription already belongs to another device', 409)
    }
    const next = (device.pushSubscriptions ?? []).filter((s) => s.endpoint !== subscription.endpoint && (!s.expirationTime || s.expirationTime > this.now()))
    if (next.length >= 8) throw new RemoteFailure('too_many_subscriptions', 'Too many push subscriptions for this device')
    device.pushSubscriptions = [...next, subscription]
    this.save()
    return this.pushStatus(deviceId)
  }
  removePushSubscription(deviceId: string, endpoint?: string, expected?: RemotePushSubscription): RemotePushStatus {
    const device = this.pushDevice(deviceId)
    if (endpoint !== undefined && typeof endpoint !== 'string') throw new RemoteFailure('invalid_subscription', 'Expected subscription endpoint')
    device.pushSubscriptions = (device.pushSubscriptions ?? []).filter((s) => {
      if (endpoint !== undefined && s.endpoint !== endpoint) return true
      // A stale 410 must not delete a concurrently refreshed subscription.
      return !!expected && (s.keys.auth !== expected.keys.auth || s.keys.p256dh !== expected.keys.p256dh)
    })
    this.save()
    return this.pushStatus(deviceId)
  }
  setPushPreferences(deviceId: string, input: unknown): RemotePushStatus {
    const device = this.pushDevice(deviceId)
    device.pushPreferences = { ...this.pushStatus(deviceId).preferences, ...validatePushPreferences(input) }
    this.save()
    return this.pushStatus(deviceId)
  }
  pushRecipients(rpID: string): { deviceId: string; subscription: RemotePushSubscription; preferences: RemotePushPreferences }[] {
    return this.credentials(rpID).flatMap((d) => (d.pushSubscriptions ?? [])
      .filter((s) => !s.expirationTime || s.expirationTime > this.now())
      .map((subscription) => ({ deviceId: d.id, subscription, preferences: this.pushStatus(d.id).preferences })))
  }
  ownsPushSubscription(deviceId: string, subscription: RemotePushSubscription): boolean {
    return !!this.data.devices.find((d) => d.id === deviceId)?.pushSubscriptions?.some((s) =>
      s.endpoint === subscription.endpoint && s.keys.auth === subscription.keys.auth && s.keys.p256dh === subscription.keys.p256dh)
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${newSecret()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' })
      const fd = openSync(tmp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, this.file)
      syncDirectory(dirname(this.file))
    } finally { rmSync(tmp, { force: true }) }
  }
}

export function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `drover_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : REMOTE_SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
}
export function sessionToken(cookie: string | undefined): string | undefined {
  const values = (cookie ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith('drover_session='))
  return values.length === 1 ? values[0].slice('drover_session='.length) : undefined
}
