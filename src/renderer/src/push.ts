import { REMOTE_PUSH_ROUTES, type RemotePushStatus, type RemotePushSubscription } from '@shared/remote'
import { t } from './i18n'

export async function pushRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  if (!response.ok) throw new Error(t('Could not update notifications. Check your connection and try again.'))
  return response.json()
}

export function supportsPush() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
export function installedPwa() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}
function keyBytes(key: string) {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export async function enablePush(): Promise<RemotePushStatus> {
  // This runs only from an explicit click. Never request permission while loading settings.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(t('Notifications are blocked. Allow them in your browser or phone settings.'))
  const [registration, key] = await Promise.all([
    navigator.serviceWorker.register('/sw.js', { scope: '/' }),
    pushRequest<string>(REMOTE_PUSH_ROUTES.key)
  ])
  const ready = registration.active ? registration : await navigator.serviceWorker.ready
  const existing = await ready.pushManager.getSubscription()
  const subscription = existing ?? await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
  const json = subscription.toJSON() as RemotePushSubscription
  try { return await pushRequest<RemotePushStatus>(REMOTE_PUSH_ROUTES.subscribe, json) }
  catch (error) { if (!existing) await subscription.unsubscribe(); throw error }
}

export async function disablePush(): Promise<RemotePushStatus> {
  // Remove the server subscriptions even if this browser lost its local subscription.
  const status = await pushRequest<RemotePushStatus>(REMOTE_PUSH_ROUTES.unsubscribe, {})
  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe()
  return status
}
