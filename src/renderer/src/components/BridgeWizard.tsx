import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Check, Minus, X } from 'lucide-react'
import { t } from '../i18n'
import { errorText } from '../api'
import { Spinner } from './primitives'
import { HostKeyCard } from './AddMachineWizard'
import { applyProgress, bridgeStepLabel, initialSteps, machineErrorText, REPAIR_STEPS, SETUP_STEPS, type BridgeApi, type Machine, type BridgeProgress, type BridgeSetupReport, type BridgeStepId, type HostKey } from '../machines'

/** Live checklist for bridge adopt/setup: one row per step, the failed one says why in plain words. */
export function BridgeChecklist({ steps, label }: { steps: BridgeProgress[]; label?: string }) {
  return (
    <ol className="bridge-steps" aria-label={label ?? t('Bridge setup')} aria-live="polite">
      {steps.map((s) => (
        <li key={s.step} className={`is-${s.state}`}>
          <span className="bridge-step-mark" aria-hidden>
            {s.state === 'running' ? <Spinner size={11} /> : s.state === 'done' ? <Check size={11} strokeWidth={3} /> : s.state === 'failed' ? <X size={11} strokeWidth={3} /> : s.state === 'skipped' ? <Minus size={11} strokeWidth={3} /> : null}
          </span>
          <span className="bridge-step-text">
            <span>{bridgeStepLabel(s.step)}{s.state === 'skipped' && <span className="dim"> · {t('skipped')}</span>}</span>
            {s.state === 'failed' && <span className="bridge-step-error">{s.error ? machineErrorText(s.error) : t('This step failed.')}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Runs a bridge job with live progress. Steps stay visible after the job ends, so the user sees what happened. */
export function useBridgeJob(api: BridgeApi, ids: BridgeStepId[]) {
  const [steps, setSteps] = useState<BridgeProgress[] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [error, setError] = useState('')
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const start = async (job: () => Promise<BridgeSetupReport>, caddy = true): Promise<BridgeSetupReport | null> => {
    setSteps(initialSteps(ids, caddy))
    setPhase('running')
    setError('')
    const off = api.onBridgeProgress?.((p) => { if (live.current) setSteps((cur) => applyProgress(cur ?? [], p)) })
    try {
      const report = await job()
      if (!live.current) return report
      // The report is the final word: it lists exactly the steps this job ran, in order.
      setSteps((cur) => (report.steps.length ? report.steps : cur))
      const failed = report.steps.find((s) => s.state === 'failed')
      setPhase(failed ? 'failed' : 'done')
      return failed ? null : report
    } catch (e) {
      if (!live.current) return null
      // Mark the step that was running as the failed one; the error text goes under it.
      const message = errorText(e)
      setSteps((cur) => {
        const list = cur ?? []
        const at = list.find((s) => s.state === 'running') ?? list.find((s) => s.state === 'pending')
        return at ? list.map((s) => (s === at ? { ...s, state: 'failed', error: { code: 'job_failed', detail: message } } : s.state === 'running' ? { ...s, state: 'pending' } : s)) : list
      })
      setError(message)
      setPhase('failed')
      return null
    } finally { off?.() }
  }
  const reset = () => { setSteps(null); setPhase('idle'); setError('') }
  return { steps, phase, error, start, reset }
}

/** Settings > Machines > Set up bridge: server details → live progress. */
export function BridgeWizard({ api, onClose }: { api: BridgeApi; onClose: (machineId?: string) => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('root')
  const [password, setPassword] = useState('')
  const [caddy, setCaddy] = useState(true)
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [matches, setMatches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [machineId, setMachineId] = useState<string | undefined>()
  const job = useBridgeJob(api, SETUP_STEPS)
  const validPort = /^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536
  const ready = !!host.trim() && validPort && !!user.trim() && !!password
  const supported = !!api.setupBridgeFromScratch

  // A changed address needs its key checked again.
  useEffect(() => { setHostKey(null); setMatches(false) }, [host, port])

  const submit = async () => {
    setError('')
    if (!hostKey) {
      setBusy(true)
      try { const k = await api.probeHostKey(host.trim(), Number(port)); setHostKey(k); setMatches(k.known) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
      return
    }
    const secret = password
    // The password is good for one attempt only, whatever the outcome.
    setPassword('')
    setStep(2)
    const report = await job.start(() => api.setupBridgeFromScratch!({ host: host.trim(), port: Number(port), user: user.trim(), password: secret, caddy, acceptedFingerprint: hostKey.fingerprint }), caddy)
    if (report) setMachineId(report.machineId)
  }

  return (
    <div className="settings-section machines wizard bridge-wizard">
      <div className="wizard-head">
        <button type="button" className="link-btn" disabled={job.phase === 'running'} onClick={() => (step === 1 || job.phase === 'done' ? onClose(machineId) : (job.reset(), setStep(1)))}>
          <ArrowLeft size={13} />{step === 1 || job.phase === 'done' ? t('Machines') : t('Back')}
        </button>
        <ol className="wizard-steps" aria-label={t('Step {n} of 2', { n: step })}>
          {[t('Server'), t('Setup')].map((label, i) => (
            <li key={label} className={clsx(i + 1 === step && 'current', (i + 1 < step || (i === 1 && job.phase === 'done')) && 'done')}>
              <span>{i + 1 < step || (i === 1 && job.phase === 'done') ? <Check size={10} strokeWidth={3} /> : i + 1}</span>{label}
            </li>
          ))}
        </ol>
      </div>

      {step === 1 && (
        <form onSubmit={(e) => { e.preventDefault(); if (ready && (!hostKey || matches)) void submit() }}>
          <div>
            <h3>{t('Set up a bridge')}</h3>
            <p className="setting-hint">{t('A bridge is a small server with a public IP (a VPS), so your machines and phone can reach this computer from anywhere. Drover sets everything up on it.')}</p>
          </div>
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="bridge-host">{t('Server IP address')}</label>
              <input id="bridge-host" className="input mono" value={host} autoFocus placeholder="203.0.113.5" spellCheck={false} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="field machine-port">
              <label htmlFor="bridge-port">{t('Port')}</label>
              <input id="bridge-port" className={clsx('input mono', !validPort && 'invalid')} value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="bridge-user">{t('Login')}</label>
            <input id="bridge-user" className="input mono" value={user} spellCheck={false} onChange={(e) => setUser(e.target.value)} />
            <span className="field-hint">{t('An administrator account from your provider, usually root.')}</span>
          </div>
          <div className="field">
            <label htmlFor="bridge-password">{t('One-time password')}</label>
            <input id="bridge-password" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="field-hint">{t('Used once to set up the server, then forgotten. Drover never saves it.')}</span>
          </div>
          <label className="check bridge-toggle">
            <input type="checkbox" checked={caddy} onChange={(e) => setCaddy(e.target.checked)} />
            <span>
              <strong>{t('Phone site')}</strong>
              <span className="setting-hint">{t('Also open Drover on your phone at a secure https:// address on this server.')}</span>
            </span>
          </label>
          {hostKey && <HostKeyCard hostKey={hostKey} matches={matches} onMatches={setMatches} hint={t('Compare it with the fingerprint in your provider’s console. If they match, Drover remembers this key and refuses to connect if it ever changes.')} />}
          {!supported && <p className="machine-note warn">{t('This version of Drover cannot set up a bridge yet.')}</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={() => onClose()}>{t('Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={!supported || busy || !ready || (!!hostKey && !matches)}>
              {busy && <Spinner size={13} />}{hostKey ? t('Set up bridge') : t('Check server')}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="bridge-run">
          <h3>{job.phase === 'done' ? t('Your bridge is ready') : job.phase === 'failed' ? t('Setup stopped') : t('Setting up {host}…', { host: host.trim() })}</h3>
          <p className="setting-hint">{job.phase === 'done'
            ? (caddy ? t('Your machines and phone can now reach this computer from anywhere through {host}.', { host: host.trim() }) : t('Your machines can now reach this computer from anywhere through {host}.', { host: host.trim() }))
            : job.phase === 'failed'
              ? t('Fix the problem marked below and run setup again.')
              : t('This takes about a minute. You can keep this window open.')}</p>
          {job.steps && <BridgeChecklist steps={job.steps} />}
          <div className="wizard-actions">
            {job.phase === 'done' && <button type="button" className="btn btn-primary" onClick={() => onClose(machineId)}>{t('Done')}</button>}
            {job.phase === 'failed' && <>
              <button type="button" className="btn" onClick={() => onClose()}>{t('Cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => { job.reset(); setStep(1) }}>{t('Try again')}</button>
            </>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Upgrade a phone-only bridge for home machines: fresh host-key check, plain confirmation, live checklist. */
export function UpgradeBridge({ api, machine: m, onDone }: { api: BridgeApi; machine: Machine; onDone: (steps: BridgeProgress[]) => void }) {
  const [open, setOpen] = useState(false)
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [matches, setMatches] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const job = useBridgeJob(api, REPAIR_STEPS)
  const supported = !!api.repairExistingBridge
  const scratch = m.bridgeConnection?.source === 'scratch'
  useEffect(() => {
    if (!open || !m.host) return
    let live = true
    setHostKey(null)
    setError('')
    // Always a fresh probe: the upgrade signs in with admin rights.
    api.probeHostKey(m.host, m.port ?? 22).then((k) => { if (live) { setHostKey(k); setMatches(k.known) } }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [open, api, m.host, m.port])
  const upgrade = async () => {
    if (!hostKey) return
    const secret = password || undefined
    // The password is good for one attempt only, whatever the outcome.
    setPassword('')
    const report = await job.start(() => api.repairExistingBridge!({ machineId: m.id, acceptedFingerprint: hostKey.fingerprint, password: secret, confirmed: true }))
    if (report) onDone(report.steps)
  }
  const title = scratch ? t('Finish setup for home machines') : t('Upgrade for home machines')
  if (!open) return <div className="machine-actions bridge-actions"><button type="button" className="btn btn-sm btn-primary" disabled={!supported} title={supported ? undefined : t('This version of Drover cannot upgrade a bridge yet.')} onClick={() => setOpen(true)}>{title}…</button></div>
  const running = job.phase === 'running'
  return (
    <div className="machine-confirm bridge-upgrade">
      <strong>{scratch ? t('Finish {name} for home machines', { name: m.name }) : t('Upgrade {name} for home machines', { name: m.name })}</strong>
      <ul className="bridge-upgrade-list">
        <li><Check size={12} strokeWidth={2.6} />{t('Adds SSH access for Drover agents only, and a route that new home machines use to connect.')}</li>
        <li><Check size={12} strokeWidth={2.6} />{t('Keeps your phone site, its login and the keys you already use exactly as they are.')}</li>
      </ul>
      {!hostKey && !error && <div className="install-cmd loading"><Spinner size={13} /></div>}
      {hostKey && job.phase === 'idle' && <HostKeyCard hostKey={hostKey} matches={matches} onMatches={setMatches} hint={t('Compare it with the fingerprint in your provider’s console. If they match, Drover remembers this key and refuses to connect if it ever changes.')} />}
      {job.phase !== 'done' && !running && (
        <div className="field">
          <label htmlFor={`upgrade-password-${m.id}`}>{t('One-time password for {user} (optional)', { user: m.user })}</label>
          <input id={`upgrade-password-${m.id}`} className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">{t('Leave empty to use the admin key already on this computer. Without one, enter the password once: Drover installs its own key and forgets the password.')}</span>
        </div>
      )}
      {job.steps && <BridgeChecklist steps={job.steps} label={title} />}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="machine-actions">
        {!running && job.phase !== 'done' && <button type="button" className="btn btn-sm" onClick={() => { setOpen(false); job.reset() }}>{t('Cancel')}</button>}
        {!running && job.phase !== 'done' && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!hostKey || !(hostKey.known || matches)} onClick={() => void upgrade()}>
            {job.phase === 'failed' ? t('Try again') : t('Upgrade bridge')}
          </button>
        )}
      </div>
    </div>
  )
}
