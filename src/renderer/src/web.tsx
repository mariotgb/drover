import { createRoot } from 'react-dom/client'
import { useState, useSyncExternalStore } from 'react'
import { RotateCw, WifiOff } from 'lucide-react'
import { createRemoteApi, getRemoteConnection, subscribeRemoteConnection } from './remote-api'
import { resolveLang, setLanguage, t } from './i18n'
import { REMOTE_AUTH_ROUTES } from '@shared/remote'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/dialogs.css'
import './styles/remote.css'
import './styles/mobile.css'
import './styles/mobile-design.css'
import { trackMobileViewport } from './mobile'

// Install before loading any module that captures the API singleton.
if (!window.api && !window.herdr) { window.droverRemote = true; window.api = window.herdr = createRemoteApi() }
else window.api ??= window.herdr
setLanguage(resolveLang('system'))
trackMobileViewport()
const root = createRoot(document.getElementById('root')!)

function ConnectionIndicator() {
  const connection = useSyncExternalStore(subscribeRemoteConnection, getRemoteConnection)
  if (connection === 'connected') return null
  return <div className="remote-connection" role="status"><WifiOff size={16} />{connection === 'connecting' ? t('Connecting…') : t('No connection')}<span>{t('Reconnecting automatically')}</span></div>
}
function StartupError({ retry }: { retry: () => void }) {
  const [busy, setBusy] = useState(false)
  return <div className="remote-auth"><div className="remote-auth-content"><WifiOff size={32} /><h1>{t('No connection')}</h1><p>{t('Keep Drover running on your Mac and try again.')}</p><button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setBusy(true); retry() }}><RotateCw size={18} />{t('Retry')}</button></div></div>
}
let pendingPane = new URLSearchParams(location.search).get('pane')
let openPane: ((paneId: string) => void) | null = null
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'drover:open-pane' && typeof event.data.paneId === 'string') {
    const paneId: string = event.data.paneId
    pendingPane = paneId
    openPane?.(paneId)
  }
})
async function start() {
  try {
    const res = await fetch(REMOTE_AUTH_ROUTES.session, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401 || (res.ok && !(await res.json()).authenticated)) { location.replace(pendingPane ? `/login?pane=${encodeURIComponent(pendingPane)}` : '/login'); return }
    const [{ App }, { bootstrap, getModel, select, useStore }] = await Promise.all([import('./components/App'), import('./store')])
    await bootstrap()
    openPane = (paneId) => {
      if (!getModel().byPane.has(paneId)) return
      pendingPane = null
      select(paneId)
      // On the phone the agent from a notification comes to the front of every panel.
      useStore.setState({ mobileDrawer: false, mobileTerminal: null, mobileSettings: false })
      const url = new URL(location.href)
      url.searchParams.delete('pane')
      history.replaceState(null, '', url)
    }
    if (pendingPane) openPane(pendingPane)
    useStore.subscribe(() => { if (pendingPane) openPane?.(pendingPane) })
    if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
    root.render(<div className="remote-shell"><ConnectionIndicator /><App /></div>)
  } catch {
    root.render(<StartupError retry={() => void start()} />)
  }
}
root.render(<div className="boot" role="status">{t('Connecting…')}</div>)
void start()
