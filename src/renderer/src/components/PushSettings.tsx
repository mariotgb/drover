import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { REMOTE_PUSH_ROUTES, type RemotePushPreferences, type RemotePushStatus } from '@shared/remote'
import { disablePush, enablePush, installedPwa, pushRequest, supportsPush } from '../push'
import { t } from '../i18n'
import { errorText } from '../api'
import { Spinner } from './primitives'

export function PushSettings() {
  const [status, setStatus] = useState<RemotePushStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const supported = supportsPush()
  const installed = installedPwa()
  const [localSubscription, setLocalSubscription] = useState(false)
  const refresh = async () => {
    const next = await pushRequest<RemotePushStatus>(REMOTE_PUSH_ROUTES.status)
    setStatus(next)
    if (supported) {
      const registration = await navigator.serviceWorker.getRegistration('/')
      setLocalSubscription(!!await registration?.pushManager.getSubscription())
    }
  }
  useEffect(() => { void refresh().catch((e) => setError(errorText(e))) }, [])
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const changePreference = (patch: Partial<RemotePushPreferences>) => {
    if (!status) return
    const previous = status
    setStatus({ ...status, preferences: { ...status.preferences, ...patch } })
    void run(async () => {
      try { setStatus(await pushRequest(REMOTE_PUSH_ROUTES.preferences, patch)) }
      catch (cause) { setStatus(previous); throw cause }
    })
  }
  return <div className="settings-section push-settings">
    <h3>{t('Phone notifications')}</h3>
    <p className="setting-hint block">{t('Get notified when an agent finishes or needs your answer. Notification previews do not contain chat messages.')}</p>
    {!installed && <p className="push-install-hint">{t('On iPhone, add Drover to your Home Screen from Safari’s Share menu, then open it from there to enable notifications.')}</p>}
    {!supported && <p role="status">{t('Push notifications are not available in this browser. Try the installed Drover app on your Home Screen.')}</p>}
    {!status && !error && <Spinner />}
    {status && <>
      <button type="button" className="btn btn-primary" disabled={busy || !supported} onClick={() => void run(async () => {
        if (status.subscribed && localSubscription) { setStatus(await disablePush()); setLocalSubscription(false) }
        else { setStatus(await enablePush()); setLocalSubscription(true) }
      })}><Bell size={16} />{busy ? t('Please wait…') : status.subscribed && localSubscription ? t('Turn off phone notifications') : t('Enable phone notifications')}</button>
      {status.subscribed && <p className="setting-hint">{t('Notifications are enabled for this device.')}</p>}
      <label className="push-preference"><input type="checkbox" checked={status.preferences.finished} disabled={busy} onChange={(e) => changePreference({ finished: e.target.checked })} />{t('When an agent finishes')}</label>
      <label className="push-preference"><input type="checkbox" checked={status.preferences.blocked} disabled={busy} onChange={(e) => changePreference({ blocked: e.target.checked })} />{t('When an agent needs an answer')}</label>
    </>}
    {error && <p role="alert" className="remote-auth-error">{error}</p>}
  </div>
}
