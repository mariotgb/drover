/* Push only: no chats, credentials or API responses are cached here. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('push', (event) => {
  let payload
  try { payload = event.data.json() } catch { return }
  if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string' || !payload.data) return
  let url
  try { url = new URL(payload.data.url, self.location.origin) } catch { return }
  if (url.origin !== self.location.origin || url.pathname !== '/' || typeof payload.data.paneId !== 'string') return
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body, tag: payload.tag, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { ...payload.data, url: url.href }
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  if (!data || typeof data.paneId !== 'string') return
  let url
  try { url = new URL(data.url, self.location.origin) } catch { return }
  if (url.origin !== self.location.origin || url.pathname !== '/') return
  url.searchParams.set('pane', data.paneId)
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const current = clients.find((client) => new URL(client.url).origin === url.origin && new URL(client.url).pathname === '/')
    if (current) {
      current.postMessage({ type: 'drover:open-pane', paneId: data.paneId })
      return current.focus()
    }
    // Preserve the target through an expired session; the auth entry carries ?pane forward.
    let authenticated = false
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      authenticated = response.ok && (await response.json()).authenticated === true
    } catch { /* The sign-in screen can recover when the Mac is reachable again. */ }
    if (!authenticated) url.pathname = '/login'
    return self.clients.openWindow(url.href)
  })())
})
