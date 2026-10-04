import { ECDH } from 'node:crypto'
import type { RemotePushPreferences, RemotePushSubscription } from '@shared/remote'
import { RemoteFailure } from './security'

export function validatePushSubscription(input: unknown): RemotePushSubscription {
  const value = input as Partial<RemotePushSubscription> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['endpoint', 'keys', 'expirationTime'].includes(k)) || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) {
    throw new RemoteFailure('invalid_subscription', 'Invalid push subscription')
  }
  let endpoint: URL
  try { endpoint = new URL(value.endpoint) } catch { throw new RemoteFailure('invalid_subscription', 'Invalid push endpoint') }
  // Browser-managed providers only; never let a stored subscription probe LAN URLs.
  const host = endpoint.hostname
  const provider = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(host) ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)
  if (!provider || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash) {
    throw new RemoteFailure('invalid_subscription', 'Expected an HTTPS browser push provider endpoint')
  }
  const keys = value.keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).some(k => !['p256dh', 'auth'].includes(k)) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)) {
    throw new RemoteFailure('invalid_subscription', 'Invalid push encryption keys')
  }
  try {
    ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1')
  } catch { throw new RemoteFailure('invalid_subscription', 'Invalid P-256 public key') }
  if (value.expirationTime !== undefined && value.expirationTime !== null &&
      (typeof value.expirationTime !== 'number' || !Number.isFinite(value.expirationTime) || value.expirationTime <= 0)) {
    throw new RemoteFailure('invalid_subscription', 'Invalid subscription expiration')
  }
  return { endpoint: endpoint.href, expirationTime: value.expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

export function validatePushPreferences(input: unknown): Partial<RemotePushPreferences> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.entries(input).some(([key, value]) => !['finished', 'blocked'].includes(key) || typeof value !== 'boolean')) {
    throw new RemoteFailure('invalid_preferences', 'Expected finished/blocked boolean preferences')
  }
  return input as Partial<RemotePushPreferences>
}
