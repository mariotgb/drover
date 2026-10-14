import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { locale, t } from '../i18n'
import { errorText } from '../api'
import { Spinner } from './primitives'
import { CopyCode } from './MachinesSettings'
import { HostKeyCard } from './AddMachineWizard'
import { activeRoute, ROUTE_ORDER, routeName, routesOf, purposeOf, type RouteKind } from '../machineRoutes'
import { osName, type HostKey, type InstallCommand, type Machine, type MachineOs, type MachinesApi } from '../machines'

// Older backends may lack these calls; the UI then shows routes read-only.
type RoutesApi = Partial<Pick<MachinesApi, 'setPurpose' | 'addRoute' | 'removeRoute'>>
const routesApi = (api: MachinesApi) => api as Omit<MachinesApi, keyof RoutesApi> & RoutesApi

/** "What is this machine for?" — a short role shown in the list and the office. */
export function PurposeField({ api, machine: m }: { api: MachinesApi; machine: Machine }) {
  const saved = purposeOf(m)
  const [value, setValue] = useState(saved)
  const [error, setError] = useState('')
  useEffect(() => setValue(saved), [saved])
  const save = () => {
    const next = value.trim()
    if (next === saved || !routesApi(api).setPurpose) return
    setError('')
    routesApi(api).setPurpose!(m.id, next).catch((e) => { setError(errorText(e)); setValue(saved) })
  }
  return (
    <div className="machine-field purpose-field">
      <label className="machine-field-label" htmlFor={`purpose-${m.id}`}>{t('What is this machine for?')}</label>
      <span className="machine-field-value">
        <input id={`purpose-${m.id}`} className="input" value={value} maxLength={60} placeholder={t('For example: builds, staging, rendering')} disabled={!routesApi(api).setPurpose}
          onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        {error && <span className="form-error">{error}</span>}
      </span>
    </div>
  )
}

/** Routes to this machine, in the order Drover tries them; add the missing ones here. */
export function RoutesSection({ api, machine: m, bridge, isBridge }: { api: MachinesApi; machine: Machine; bridge: Machine | null; isBridge: boolean }) {
  const routes = routesOf(m)
  const active = activeRoute(m)
  const [adding, setAdding] = useState<RouteKind | null>(null)
  const [removing, setRemoving] = useState<RouteKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const r = routesApi(api)
  const missing = ROUTE_ORDER.filter((k) => !routes.some((x) => x.kind === k) && !(k === 'bridge' && (isBridge || !bridge)))
  const remove = async (kind: RouteKind) => {
    setBusy(true); setError('')
    try { await r.removeRoute!(m.id, kind, { confirmed: true }); setRemoving(null) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="machine-section">
      <div className="machine-section-title">{t('Routes to this machine')}</div>
      <p className="setting-hint">{t('Drover tries them in this order and uses the first one that works: at home directly, away from home through the bridge.')}</p>
      <div className="route-table">
        {routes.map((x, i) => (
          <div key={x.kind} className="route-row">
            <span className={clsx('route-dot', `s-${x.state}`)} />
            <span className="route-name">{routeName(x.kind)}</span>
            <span className="route-addr">{x.kind === 'bridge' ? (bridge ? t('through {bridge}', { bridge: bridge.name }) : '') : x.address}{x.latencyMs !== undefined && x.state === 'ok' ? <span className="dim"> · {t('{n} ms', { n: x.latencyMs })}</span> : null}</span>
            <span className="route-tail">
              {x.kind === active ? <span className={clsx('mroute now', `k-${x.kind}`)}><i />{t('in use')}</span>
                : x.state === 'setup' ? <span className="dim">{t('waiting for setup')}</span>
                : x.state === 'down' ? <span className="route-bad">{t('not answering')}</span>
                : <span className="dim">{i === 0 ? t('first choice') : t('backup')}</span>}
              {routes.length > 1 && r.removeRoute && removing !== x.kind && <button type="button" className="link-btn" onClick={() => setRemoving(x.kind)}>{t('Remove')}</button>}
            </span>
            {removing === x.kind && (
              <div className="machine-confirm route-confirm">
                <p>{t('Stop using the route “{route}” for {name}? The other routes keep working.', { route: routeName(x.kind), name: m.name })}</p>
                <div className="machine-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setRemoving(null)}>{t('Cancel')}</button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove(x.kind)}>{busy && <Spinner size={12} />}{t('Remove route')}</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {missing.map((k) => (
          <div key={k} className="route-row missing">
            <span className="route-dot s-off" />
            <span className="route-name">{routeName(k)}</span>
            <span className="route-addr dim">{k === 'bridge' ? t('Not set up: away from home this machine is out of reach.') : k === 'internet' ? t('No public address.') : t('No home network address.')}</span>
            <span className="route-tail">
              {r.addRoute && adding !== k && (k === 'bridge'
                ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(k)}>{t('Make reachable away from home')}</button>
                : <button type="button" className="link-btn" onClick={() => setAdding(k)}>{k === 'internet' ? t('Add public address…') : t('Add home address…')}</button>)}
            </span>
            {adding === k && (k === 'bridge'
              ? <AddBridgeRoute api={api} machine={m} bridge={bridge!} onClose={() => setAdding(null)} />
              : <AddAddressRoute api={api} machine={m} kind={k} onClose={() => setAdding(null)} />)}
          </div>
        ))}
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}

/** Bridge route: explain, then one command for the machine; it connects out to the bridge by itself. */
function AddBridgeRoute({ api, machine: m, bridge, onClose }: { api: MachinesApi; machine: Machine; bridge: Machine; onClose: () => void }) {
  const [cmd, setCmd] = useState<InstallCommand | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [os, setOs] = useState<MachineOs>(m.os ?? 'linux')
  const route = routesOf(m).find((x) => x.kind === 'bridge')
  const start = async (forOs = os) => {
    setBusy(true); setError('')
    try { setCmd(await routesApi(api).addRoute!(m.id, { kind: 'bridge', os: forOs }, { confirmed: true }) as InstallCommand) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="machine-confirm route-confirm">
      {!cmd ? <>
        <p>{t('Make {name} reachable away from home? You run one command on {name}; it connects out to your bridge {bridge} by itself. Your router stays as it is, and no password is needed.', { name: m.name, bridge: bridge.name })}</p>
        <div className="machine-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void start()}>{busy && <Spinner size={12} />}{t('Show the command')}</button>
        </div>
      </> : <>
        <div className="segmented small" role="tablist" aria-label={t('Operating system')}>
          {(['linux', 'macos', 'windows'] as MachineOs[]).map((o) => <button key={o} type="button" role="tab" aria-selected={os === o} className={clsx(os === o && 'active')} disabled={busy} onClick={() => { setOs(o); void start(o) }}>{osName(o)}</button>)}
        </div>
        <p>{t('Run this on {name}. It works once, until {time}.', { name: m.name, time: new Date(cmd.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}</p>
        <CopyCode text={cmd.command} block />
        <div className={clsx('install-wait', route?.state === 'ok' ? 'ok' : 'wait')} role="status" aria-live="polite">
          {route?.state === 'ok' ? null : <span className="install-pulse" />}
          <div><strong>{route?.state === 'ok' ? t('{name} is reachable away from home', { name: m.name }) : t('Waiting for {name} to connect to the bridge…', { name: m.name })}</strong></div>
        </div>
        <div className="machine-actions"><button type="button" className="btn btn-sm" onClick={onClose}>{route?.state === 'ok' ? t('Done') : t('Finish later')}</button></div>
      </>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}

/** Home or public address: check the machine's key first, then add the route. */
function AddAddressRoute({ api, machine: m, kind, onClose }: { api: MachinesApi; machine: Machine; kind: 'lan' | 'internet'; onClose: () => void }) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [key, setKey] = useState<HostKey | null>(null)
  const [matches, setMatches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const validPort = /^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536
  useEffect(() => { setKey(null); setMatches(false) }, [host, port])
  const submit = async () => {
    setBusy(true); setError('')
    try {
      const route = { kind, host: host.trim(), port: Number(port) }
      if (!key) { const k = await routesApi(api).addRoute!(m.id, route, { confirmed: true }) as HostKey; setKey(k); setMatches(k.known); return }
      await routesApi(api).addRoute!(m.id, { ...route, acceptedFingerprint: key.fingerprint }, { confirmed: true })
      onClose()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <form className="machine-confirm route-confirm" onSubmit={(e) => { e.preventDefault(); if (host.trim() && validPort && (!key || matches)) void submit() }}>
      <p>{kind === 'lan' ? t('The address of {name} on your home network, for example 192.168.1.40.', { name: m.name }) : t('The public address of {name}, for example a VPS IP.', { name: m.name })}</p>
      <div className="field-row">
        <div className="field grow"><label htmlFor={`route-host-${m.id}`}>{t('Address')}</label><input id={`route-host-${m.id}`} className="input mono" value={host} autoFocus spellCheck={false} onChange={(e) => setHost(e.target.value)} /></div>
        <div className="field machine-port"><label htmlFor={`route-port-${m.id}`}>{t('Port')}</label><input id={`route-port-${m.id}`} className={clsx('input mono', !validPort && 'invalid')} value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} /></div>
      </div>
      {key && <HostKeyCard hostKey={key} matches={matches} onMatches={setMatches} hint={t('Make sure this is {name}: compare the key with the one shown on the machine. Drover refuses to connect if it ever changes.', { name: m.name })} />}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="machine-actions">
        <button type="button" className="btn btn-sm" onClick={onClose}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !host.trim() || !validPort || (!!key && !matches)}>{busy && <Spinner size={12} />}{key ? t('Add route') : t('Check address')}</button>
      </div>
    </form>
  )
}
