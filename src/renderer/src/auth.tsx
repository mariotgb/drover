import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Fingerprint, Smartphone } from 'lucide-react'
import { browserSupportsWebAuthn, startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { REMOTE_AUTH_ROUTES, type RemoteAuthSession, type RemoteAuthOptionsResponse, type RemoteAuthVerifyResponse } from '@shared/remote'
import { resolveLang, setLanguage, t } from './i18n'
import { trackMobileViewport } from './mobile'
import './styles/tokens.css'
import './styles/app.css'
import './styles/remote.css'
import './styles/mobile.css'

setLanguage(resolveLang('system'))
trackMobileViewport()
async function post<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(route, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) {
    if (data.error?.code === 'invalid_pairing_code' || data.error?.code === 'pairing_expired') throw new Error(t('This pairing link has expired. Create a new one on your Mac.'))
    throw new Error(t('Could not sign in. Try again or create a new pairing link on your Mac.'))
  }
  return data
}
function AuthScreen() {
  const pairing = location.pathname === '/pair'
  const params = new URLSearchParams(location.search)
  const code = params.get('code') ?? ''
  const pane = params.get('pane')
  const target = pane ? `/?pane=${encodeURIComponent(pane)}` : '/'
  useEffect(() => {
    if (pairing) return
    void fetch(REMOTE_AUTH_ROUTES.session, { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.json() as Promise<RemoteAuthSession>).then((session) => { if (session.authenticated) location.replace(target) }).catch(() => undefined)
  }, [])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const supported = window.isSecureContext && browserSupportsWebAuthn()
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      let result: RemoteAuthVerifyResponse
      if (pairing) {
        const { challengeId, options } = await post<RemoteAuthOptionsResponse>(REMOTE_AUTH_ROUTES.registerOptions, { code, name: name.trim() || t('My phone') })
        const response = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON })
        result = await post<RemoteAuthVerifyResponse>(REMOTE_AUTH_ROUTES.registerVerify, { challengeId, response })
      } else {
        const { challengeId, options } = await post<RemoteAuthOptionsResponse>(REMOTE_AUTH_ROUTES.loginOptions, {})
        const response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON })
        result = await post<RemoteAuthVerifyResponse>(REMOTE_AUTH_ROUTES.loginVerify, { challengeId, response })
      }
      if (!result.ok) throw new Error(t('Could not sign in. Try again or create a new pairing link on your Mac.'))
      history.replaceState(null, '', '/login')
      location.replace(target)
    } catch (cause) {
      if (cause instanceof Error && ['NotAllowedError', 'AbortError'].includes(cause.name)) setError(t('Passkey request cancelled. Tap the button to try again.'))
      else setError(cause instanceof TypeError ? t('No connection') : cause instanceof Error ? cause.message : t('Could not sign in. Try again or create a new pairing link on your Mac.'))
    } finally { setBusy(false) }
  }
  return <main className="remote-auth"><div className="remote-auth-content">
    <div className="remote-auth-mark">{pairing ? <Smartphone size={32} /> : <Fingerprint size={32} />}</div>
    <h1>{pairing ? t('Pair your phone') : t('Sign in to Drover')}</h1>
    <p>{pairing ? t('Create a passkey to securely connect this phone to Drover on your Mac.') : t('Use your passkey to open your agents, conversations and tasks.')}</p>
    {pairing && <label className="remote-auth-field">{t('Device name')}<input className="input" value={name} maxLength={80} placeholder={t('My phone')} autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>}
    {!supported && <p className="remote-auth-error" role="alert">{t('Passkeys require HTTPS and a browser that supports them. Open the public HTTPS address in Safari.')}</p>}
    {pairing && !code && <p className="remote-auth-error" role="alert">{t('Open the pairing link or QR code from Drover settings on your Mac.')}</p>}
    {error && <p className="remote-auth-error" role="alert">{error}</p>}
    <button type="button" className="btn btn-primary btn-lg" disabled={busy || !supported || (pairing && !code)} onClick={() => void submit()}><Fingerprint size={20} />{busy ? t('Please wait…') : pairing ? t('Create passkey and connect') : t('Sign in with passkey')}</button>
    <p className="remote-auth-hint">{pairing ? t('The pairing link is valid for 10 minutes.') : t('First time? In Drover on your Mac, open Settings → Remote access → Pair phone.')}</p>
    {pairing && <a href="/login">{t('Already paired? Sign in')}</a>}
  </div></main>
}
createRoot(document.getElementById('root')!).render(<AuthScreen />)
