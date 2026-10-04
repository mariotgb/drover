import { useEffect, useState } from 'react'
import { Copy, Smartphone, RefreshCw } from 'lucide-react'
import QRCode from 'qrcode'
import { remotePhoneOrigin, remoteUsesProxy, type RemoteDevice, type RemotePairingCode, type RemoteStatus } from '@shared/remote'
import { api, errorText } from '../api'
import { locale, t } from '../i18n'
import { toast } from '../store'
import { Spinner } from './primitives'

export function RemoteAccessSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [port, setPort] = useState('7780')
  const [url, setUrl] = useState('')
  const [behindProxy, setBehindProxy] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pair, setPair] = useState<RemotePairingCode | null>(null)
  const [qr, setQr] = useState('')
  const [now, setNow] = useState(Date.now())
  const available = !!api.remoteStatus && !!api.setRemoteAccess && !!api.remoteDevices && !!api.createRemotePairingCode && !!api.revokeRemoteDevice
  const load = async () => {
    if (!available) return
    const [next, list] = await Promise.all([api.remoteStatus!(), api.remoteDevices!()])
    setStatus(next)
    setPort(String(next.remotePort))
    setUrl(next.remotePublicUrl)
    setBehindProxy(next.remoteBehindProxy)
    setDevices(list)
  }
  useEffect(() => { void load().catch((e) => setError(errorText(e))) }, [])
  useEffect(() => {
    if (!pair) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [pair])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await fn() } catch (e) {
      // A failed write can stop the server; show its actual state, not the
      // checkbox state from before the unsuccessful revoke/disable operation.
      await load().catch(() => undefined)
      setPair(null)
      setError(errorText(e))
    } finally { setBusy(false) }
  }
  const validPort = /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535
  let validUrl = !url.trim()
  validUrl ||= remotePhoneOrigin(url) !== null
  const proxyPatch = behindProxy === undefined ? {} : { remoteBehindProxy: behindProxy }
  const phoneOrigin = remotePhoneOrigin(status?.remotePublicUrl ?? '')
  const canPair = !!status?.running && !!phoneOrigin && status.origin === phoneOrigin && remotePhoneOrigin(url) === phoneOrigin && Number(port) === status.remotePort
  const expired = pair ? now >= pair.expiresAt : false
  return <div className="settings-section remote-settings">
    <h3>{t('Remote access')}</h3>
    <p className="setting-hint block">{t('Open Drover in Safari on your phone. Your Mac must stay on and Drover must be running.')}</p>
    {!available ? <p role="status">{t('Remote access is not available in this build.')}</p> : <>
      {!status && !error && <Spinner />}
      {status && <>
        <label className="remote-toggle"><input type="checkbox" checked={status.remoteEnabled} disabled={busy || (!status.remoteEnabled && (!validPort || !validUrl))} onChange={(e) => { const enabled = e.target.checked; void run(async () => { const next = await api.setRemoteAccess!(enabled ? { remoteEnabled: true, remotePort: Number(port), remotePublicUrl: url.trim().replace(/\/$/, ''), ...proxyPatch } : { remoteEnabled: false }); setStatus(next); setPair(null); if (next.error) setError(next.error) }) }} />{t('Enable remote access')}</label>
        <label className="remote-setting-field">{t('Port')}<input className="input" type="number" min={1024} max={65535} value={port} onChange={(e) => { setPort(e.target.value); setPair(null) }} /></label>
        <label className="remote-setting-field">{t('Public HTTPS address')}<input className="input" type="url" value={url} placeholder="https://1-2-3-4.sslip.io" onChange={(e) => { setUrl(e.target.value); setPair(null) }} /></label>
        <p className="setting-hint">{t('Use the HTTPS address configured by your remote bridge. Changing it may require pairing devices again.')}</p>
        <label className="remote-toggle"><input type="checkbox" checked={remoteUsesProxy({ remotePublicUrl: url.trim(), remoteBehindProxy: behindProxy })} disabled={busy} onChange={(e) => setBehindProxy(e.target.checked)} />{t('Works through a proxy (Caddy on VPS)')}</label>
        <p className="setting-hint">{t('This switch controls trust in proxy headers. Set up Caddy and the SSH tunnel separately.')} {' '}
          <a href="https://github.com/mariotgb/drover/blob/remote-web/docs/remote-access.md" onClick={(e) => { e.preventDefault(); void api.openExternal('https://github.com/mariotgb/drover/blob/remote-web/docs/remote-access.md') }}>{t('Remote access setup guide')}</a>
        </p>
        {(!validPort || !validUrl) && <p className="remote-auth-error">{t('Enter a port from 1024 to 65535 and an HTTPS origin without a path.')}</p>}
        <div className="remote-setting-actions"><button type="button" className="btn" disabled={busy || !validPort || !validUrl} onClick={() => void run(async () => { const next = await api.setRemoteAccess!({ remotePort: Number(port), remotePublicUrl: url.trim().replace(/\/$/, ''), ...proxyPatch }); setStatus(next); setPair(null); if (next.error) setError(next.error) })}>{t('Save')}</button><span role="status">{status.running ? (phoneOrigin ? t('Remote access is running') : t('Local mode (this Mac only)')) : t('Remote access is off')}</span></div>
        {status.error && <p role="alert" className="remote-auth-error">{status.error}</p>}
        {status.running && <>
          {!canPair && <p className="setting-hint" role="status">{t('Enter and save a public HTTPS address to pair your phone. The local address works only on this Mac.')}</p>}
          <button type="button" className="btn btn-primary" disabled={busy || !canPair} onClick={() => { if (!canPair) return; void run(async () => { const next = await api.createRemotePairingCode!();
            if (new URL(next.url).origin !== phoneOrigin) throw new Error(t('Enter and save a public HTTPS address to pair your phone. The local address works only on this Mac.')); const image = await QRCode.toDataURL(next.url, { width: 240, margin: 4, errorCorrectionLevel: 'M' }); setQr(image); setPair(next); setNow(Date.now()) }) }}><Smartphone size={16} />{t('Pair phone')}</button>
          {pair && canPair && new URL(pair.url).origin === phoneOrigin && <div className="remote-pair">
            {expired ? <p role="status">{t('This pairing link has expired. Create a new one on your Mac.')}</p> : <>
              <img className="remote-qr" src={qr} width={240} height={240} alt={t('Scan to pair your phone')} />
              <a href={pair.url} onClick={(e) => { e.preventDefault(); void api.openExternal(pair.url) }}>{pair.url}</a>
              <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(pair.url).then(() => toast('success', t('Link copied'))).catch(() => setError(t('Could not copy the link. Select and copy it manually.')))}><Copy size={16} />{t('Copy link')}</button>
              <p className="setting-hint">{t('Expires at {time}', { time: new Date(pair.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}</p>
            </>}
          </div>}
        </>}
      </>}
      <div className="remote-devices-heading"><h3>{t('Paired devices')}</h3><button type="button" className="btn" disabled={busy} aria-label={t('Refresh')} onClick={() => void run(load)}><RefreshCw size={16} /></button></div>
      {!devices.length && <p className="setting-hint">{t('No paired devices yet')}</p>}
      {devices.map((device) => <div className="remote-device" key={device.id}><Smartphone size={18} /><div><strong>{device.name}</strong><span>{t('Last used: {date}', { date: new Date(device.lastUsedAt).toLocaleString(locale()) })}</span></div><button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { await api.revokeRemoteDevice!(device.id); setDevices(await api.remoteDevices!()) })}>{t('Revoke')}</button></div>)}
    </>}
    {error && <p role="alert" className="remote-auth-error">{error}</p>}
  </div>
}
