import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createECDH, createHash } from 'node:crypto'
import webPush from 'web-push'
import type { RemoteAccessSettings, RemotePushPayload, RemotePushSubscription } from '@shared/remote'
import type { HerdrSnapshot } from '@shared/types'
import type { StatusChange } from '../herdr/service'
import type { RemoteAuthStore } from './store'
import { remoteIdentity } from './security'

export class VapidKeys {
  private keys: { publicKey: string; privateKey: string } | null = null
  constructor(private file: string) {}
  get(): { publicKey: string; privateKey: string } {
    if (this.keys) return this.keys
    if (!existsSync(this.file)) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const generated = webPush.generateVAPIDKeys()
      try { writeFileSync(this.file, JSON.stringify(generated), { mode: 0o600, flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    chmodSync(this.file, 0o600)
    const keys = JSON.parse(readFileSync(this.file, 'utf8')) as { publicKey: string; privateKey: string }
    if (!/^[A-Za-z0-9_-]{87}$/.test(keys.publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(keys.privateKey)) throw new Error('Invalid stored VAPID keys')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'))
    if (ecdh.getPublicKey().toString('base64url') !== keys.publicKey) throw new Error('Stored VAPID key pair does not match')
    return this.keys = keys
  }
}

export function pushTrigger(from: StatusChange['from'], to: StatusChange['to']): 'finished' | 'blocked' | null {
  // Undefined is the first observation of a new pane, not a transition.
  if (from === undefined || from === to) return null
  if (to === 'blocked') return 'blocked'
  return from === 'working' && (to === 'done' || to === 'idle') ? 'finished' : null
}
const label = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
export function pushPayload(change: StatusChange, snapshot: HerdrSnapshot | null, session: string): RemotePushPayload | null {
  const kind = pushTrigger(change.from, change.to)
  if (!kind || !change.pane.agent) return null
  const name = label(change.name || change.pane.label || change.pane.agent)
  const workspace = snapshot?.workspaces.find((w) => w.workspace_id === change.pane.workspace_id)
  const project = label(workspace?.label || (change.pane.cwd ? basename(change.pane.cwd) : session))
  return {
    title: `${name} ${kind === 'finished' ? 'finished' : 'needs your input'}`,
    body: project,
    tag: `drover-${createHash('sha256').update(`${session}:${change.pane.pane_id}`).digest('hex').slice(0, 24)}`,
    data: { url: `/?pane=${encodeURIComponent(change.pane.pane_id)}`, paneId: change.pane.pane_id, kind }
  }
}
export type PushSender = (subscription: RemotePushSubscription, payload: string, options: webPush.RequestOptions) => Promise<unknown>
interface PushHost {
  userData: string
  store: () => RemoteAuthStore
  settings: () => RemoteAccessSettings
  enabled: () => boolean
  title?: (name: string, kind: 'finished' | 'blocked') => string
}

export class PushNotifications {
  private vapid: VapidKeys
  private lastSent = new Map<string, number>()
  constructor(private host: PushHost, private sender: PushSender = (subscription, payload, options) => webPush.sendNotification(subscription, payload, options), private now: () => number = Date.now) {
    this.vapid = new VapidKeys(join(host.userData, 'remote-vapid.json'))
  }
  publicKey(): string { return this.vapid.get().publicKey }
  async statusChanged(change: StatusChange, snapshot: HerdrSnapshot | null, session: string): Promise<void> {
    if (!this.host.enabled()) return
    const payload = pushPayload(change, snapshot, session)
    if (!payload) return
    const identity = remoteIdentity(this.host.settings())
    const store = this.host.store()
    const recipients = store.pushRecipients(identity.rpID).filter((r) => r.preferences[payload.data.kind])
    if (!recipients.length) return
    const agentId = `${session}:${change.pane.pane_id}:${change.pane.agent_session?.value ?? change.name ?? change.pane.agent}`
    const last = this.lastSent.get(agentId)
    if (last !== undefined && this.now() - last < 30_000) return
    for (const [id, time] of this.lastSent) if (this.now() - time > 86400_000) this.lastSent.delete(id)
    this.lastSent.set(agentId, this.now()) // Before await: parallel transitions cannot double-send.
    if (this.host.title) payload.title = this.host.title(label(change.name || change.pane.label || change.pane.agent!), payload.data.kind)
    const keys = this.vapid.get()
    const options: webPush.RequestOptions = {
      vapidDetails: { subject: identity.secure ? identity.origin : 'mailto:notifications@localhost', ...keys },
      TTL: 300, urgency: 'high', contentEncoding: 'aes128gcm', timeout: 10_000
    }
    // Small batches bound concurrent HTTPS requests; check revocation before each send.
    for (let i = 0; i < recipients.length; i += 4) {
      await Promise.all(recipients.slice(i, i + 4).map(async ({ deviceId, subscription }) => {
        if (!this.host.enabled() || !store.ownsPushSubscription(deviceId, subscription) || !store.pushStatus(deviceId).preferences[payload.data.kind]) return
        try { await this.sender(subscription, JSON.stringify(payload), options) }
        catch (error) {
          const status = (error as { statusCode?: number })?.statusCode
          if ((status === 404 || status === 410) && store.ownsPushSubscription(deviceId, subscription)) {
            store.removePushSubscription(deviceId, subscription.endpoint, subscription)
          } else if (status !== 404 && status !== 410) {
            // Don't log endpoint capabilities, encryption keys or provider response bodies.
            console.warn('[web-push] delivery failed', typeof status === 'number' ? status : 'network error')
          }
        }
      }))
    }
  }
}
