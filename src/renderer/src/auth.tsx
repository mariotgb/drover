import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { browserSupportsWebAuthn, startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { REMOTE_AUTH_ROUTES, type RemoteAuthSession, type RemoteAuthOptionsResponse, type RemoteAuthVerifyResponse } from '@shared/remote'
import { resolveLang, setLanguage, t } from './i18n'
import appIcon from './assets/app-icon.png'
import { AuthScreenError, authErrorText, authRequest, checkedAuthOptions, requestPasskey } from './auth-client'
import { trackMobileViewport } from './mobile'
import './styles/tokens.css'
import './styles/app.css'
import './styles/remote.css'
import './styles/mobile.css'
import './styles/mobile-design.css'

setLanguage(resolveLang('system'))
trackMobileViewport()
function AuthScreen() {
  const pairing = location.pathname === '/pair'
  const params = new URLSearchParams(location.search)
  const code = params.get('code') ?? ''
  const pane = params.get('pane')
  const target = pane ? `/?pane=${encodeURIComponent(pane)}` : '/'
  useEffect(() => {
    if (pairing) return
    let alive = true
    void authRequest<RemoteAuthSession>(REMOTE_AUTH_ROUTES.session).then(session => {
      if (typeof session.authenticated !== 'boolean') throw new AuthScreenError('invalid_response')
      if (alive && session.authenticated) location.replace(target)
    }).catch(cause => { if (alive) setError(previous => previous || authErrorText(cause)) })
    return () => { alive = false }
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
        const { challengeId, options } = checkedAuthOptions(await authRequest<RemoteAuthOptionsResponse>(REMOTE_AUTH_ROUTES.registerOptions, { code, name: name.trim() || t('My phone') }))
        const response = await requestPasskey(() => startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON }))
        result = await authRequest<RemoteAuthVerifyResponse>(REMOTE_AUTH_ROUTES.registerVerify, { challengeId, response })
      } else {
        const { challengeId, options } = checkedAuthOptions(await authRequest<RemoteAuthOptionsResponse>(REMOTE_AUTH_ROUTES.loginOptions, {}))
        const response = await requestPasskey(() => startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON }))
        result = await authRequest<RemoteAuthVerifyResponse>(REMOTE_AUTH_ROUTES.loginVerify, { challengeId, response })
      }
      if (result.ok !== true) throw new AuthScreenError('passkey')
      history.replaceState(null, '', '/login')
      location.replace(target)
    } catch (cause) {
      setError(authErrorText(cause))
    } finally { setBusy(false) }
  }
  return <main className="remote-auth"><div className="remote-auth-content">
    <div className="remote-auth-mark"><img src={appIcon} width={80} height={80} alt="Drover" /></div>
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
