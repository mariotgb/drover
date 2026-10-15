import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Check, KeyRound } from 'lucide-react'
import { t } from '../i18n'
import { errorText } from '../api'
import { Spinner } from './primitives'
import { HostKeyCard } from './AddMachineWizard'
import { AccessEditor } from './MachinesSettings'
import { machineErrorText, type HostKey, type Machine, type MachinesApi, type MachinesState } from '../machines'
import type { BridgeKeyCandidate } from '@shared/machines'

type Step = 1 | 2 | 3 | 4

/** Errors of the one-time sign-in, in this flow's words (the generic texts talk about the agents key). */
function signInError(e: unknown, user: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (raw.includes('[auth_failed]')) return t('The server refused this key for {user}. Pick another key, or check that this key belongs to {user}.', { user })
  if (raw.includes('[login_key_unreadable]')) return t('Drover could not read this key. If it has a passphrase, unlock it in ssh-agent on this computer and try again.')
  return errorText(e)
}

/** A machine is listed (for example imported from herdr) but Drover's agents cannot sign in yet. */
export function needsConnect(m: Machine): boolean {
  // The backend marks a listed-but-unconnected machine (or a bridge without the agents key) durably with key_not_installed.
  return !!m.host && m.status.error?.code === 'key_not_installed'
}

/** A direct machine Drover connected before, now refusing the agents key or showing a new server key (for example
 * after its address changed). One-click connect repairs it; the wizard opens only for the step that needs the user. */
export function needsRepair(m: Machine): boolean {
  const code = m.status.error?.code
  return m.kind === 'direct' && !!m.host && (code === 'auth_failed' || code === 'connection_closed' || code === 'host_key_unconfirmed' || code === 'host_key_unknown')
}

/** Connected means Drover's agents key signed in. For a not-connected machine "online" only means its port answers. */
export function signedIn(m: Machine): boolean {
  return m.status.state === 'online' && m.status.checks?.auth === true && m.status.error?.code !== 'key_not_installed'
}

/**
 * Connect an existing machine: check its server key, sign in once with a key from this computer
 * (or a one-time password), install Drover's agents key, then choose what agents may do there.
 */
export function ConnectMachineWizard({ api, state, machineId, initialStep = 1, onClose }: { api: MachinesApi; state: MachinesState; machineId: string; initialStep?: 1 | 2; onClose: () => void }) {
  const m = state.machines.find((x) => x.id === machineId) ?? null
  // Step 2 when the server key is already trusted and only the sign-in key is missing.
  const [step, setStep] = useState<Step>(initialStep)
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [keys, setKeys] = useState<BridgeKeyCandidate[]>([])
  const [keyPath, setKeyPath] = useState('')
  const [method, setMethod] = useState<'key' | 'password'>('key')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keysError, setKeysError] = useState('')
  const [keysTry, setKeysTry] = useState(0)

  // Step 1: fetch the server key for this login; a key already in known_hosts still needs a click.
  useEffect(() => {
    if (!m?.host) return
    let live = true
    api.probeHostKey(m.host, m.port ?? 22, m.user).then((k) => { if (live) { setHostKey(k); setConfirmed(k.known) } }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [api, m?.host, m?.port, m?.user])
  // Keys on this computer that fit; a failure is shown with a retry instead of an empty list.
  useEffect(() => {
    if (!m?.host) return
    let live = true
    setKeysError('')
    api.loginKeyCandidates(m.host).then((list) => { if (live) { setKeys(list); setKeyPath((p) => p || list[0]?.path || '') } }, (e) => { if (live) setKeysError(errorText(e)) })
    return () => { live = false }
  }, [api, m?.host, keysTry])

  if (!m) return null
  const passwordAllowed = !!hostKey?.passwordAllowed
  const usePassword = method === 'password' && passwordAllowed
  const choose = async () => {
    setError('')
    try {
      const path = await api.chooseBridgeKeyFile()
      if (!path) return
      setKeys((list) => list.some((k) => k.path === path) ? list : [{ path, name: path.split('/').pop() || path, fingerprint: '', algorithm: '', comment: '' }, ...list])
      setKeyPath(path)
    } catch (e) { setError(errorText(e)) }
  }
  const install = async () => {
    if (!hostKey) return
    setBusy(true); setError('')
    const secret = usePassword ? password : undefined
    // A password is good for one attempt only, whatever the outcome.
    setPassword('')
    try {
      const done = await api.installKey(m.id, usePassword ? { password: secret, acceptedFingerprint: hostKey.fingerprint } : { keyPath, acceptedFingerprint: hostKey.fingerprint })
      if (signedIn(done)) setStep(3)
      else setError(machineErrorText(done.status.error, done) || t('Could not connect.'))
    } catch (e) { setError(signInError(e, m.user)) } finally { setBusy(false) }
  }

  const labels = [t('Server key'), t('Sign-in key'), t('Access')]
  return (
    <div className="settings-section machines wizard">
      <div className="wizard-head">
        <button type="button" className="link-btn" disabled={busy} onClick={() => (step === 2 ? setStep(1) : onClose())}>
          <ArrowLeft size={13} />{step === 2 ? t('Back') : t('Machines')}
        </button>
        <ol className="wizard-steps" aria-label={t('Step {n} of 3', { n: Math.min(step, 3) })}>
          {labels.map((label, i) => (
            <li key={label} className={clsx(i + 1 === step && 'current', i + 1 < step && 'done')}>
              <span>{i + 1 < step ? <Check size={10} strokeWidth={3} /> : i + 1}</span>{label}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>{t('Connect {name}', { name: m.name })}</h3>
        <p className="setting-hint">{t('Drover signs in to {target} once, installs its own key for agents and checks that it works. Nothing else on the machine changes.', { target: `${m.user}@${m.host}` })}</p>
      </div>

      {step === 1 && (
        <>
          {!hostKey && !error && <div className="install-cmd loading"><Spinner size={13} /></div>}
          {hostKey && <HostKeyCard hostKey={hostKey} matches={confirmed} onMatches={setConfirmed} hint={t('Compare it with the fingerprint in your provider’s console. If they match, Drover remembers this key and refuses to connect if it ever changes.')} />}
          {hostKey?.known && <p className="setting-hint">{t('This key matches the one already saved on this computer (known_hosts).')}</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={!hostKey || !confirmed} onClick={() => { setError(''); setStep(2) }}>{t('This is the right server')}</button>
          </div>
        </>
      )}

      {step === 2 && (
        <form onSubmit={(e) => { e.preventDefault(); if (usePassword ? password : keyPath) void install() }}>
          {!usePassword ? <>
            <div className="field">
              <label>{t('Sign in as {user} with', { user: m.user })}</label>
              {keys.length > 0 ? (
                <div className="bridge-keys" role="radiogroup" aria-label={t('Sign-in key')}>
                  {keys.map((k, i) => (
                    <label key={k.path} className={clsx('bridge-key', keyPath === k.path && 'on')} title={[k.path, k.comment].filter(Boolean).join(' · ')}>
                      <input type="radio" name="connect-key" checked={keyPath === k.path} onChange={() => setKeyPath(k.path)} />
                      <span className="bridge-key-text">
                        <span className="bridge-key-name">{k.name}{i === 0 && k.fingerprint && <span className="machine-badge">{t('Best match')}</span>}</span>
                        <code className="bridge-key-print">{k.fingerprint ? [k.algorithm, k.fingerprint].filter(Boolean).join(' ') : t('Chosen file · checked when you connect')}</code>
                      </span>
                    </label>
                  ))}
                </div>
              ) : keysError ? <p role="alert" className="form-error">{t('Could not read the keys on this computer: {error}', { error: keysError })} <button type="button" className="link-btn" onClick={() => setKeysTry((n) => n + 1)}>{t('Try again')}</button></p>
                : <p className="setting-hint">{t('Drover found no key in ~/.ssh that fits. Choose the key file you use to sign in to {name}.', { name: m.name })}</p>}
              <button type="button" className="link-btn bridge-choose" onClick={() => void choose()}><KeyRound size={12} />{t('Choose key file…')}</button>
              <span className="field-hint">{t('The key stays on this computer. Drover uses it once to install the agents key.')}</span>
            </div>
          </> : (
            <div className="field">
              <label htmlFor="connect-password">{t('One-time password for {user}', { user: m.user })}</label>
              <input id="connect-password" className="input" type="password" autoComplete="off" value={password} autoFocus onChange={(e) => setPassword(e.target.value)} />
              <span className="field-hint">{t('Used once to install the agents key, then forgotten. Drover never saves it.')}</span>
            </div>
          )}
          {passwordAllowed && <button type="button" className="link-btn bridge-method" onClick={() => setMethod(usePassword ? 'key' : 'password')}>{usePassword ? t('Use a key from this computer instead') : t('No key? Use a one-time password instead')}</button>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={onClose}>{t('Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || (usePassword ? !password : !keyPath)}>{busy && <Spinner size={13} />}{busy ? t('Connecting…') : t('Install agents key')}</button>
          </div>
        </form>
      )}

      {step === 3 && (
        <>
          <p className="machine-note ok"><Check size={13} /><span>{t('{name} is connected. Agents can use ssh {alias}.', { name: m.name, alias: m.alias })}</span></p>
          <AccessEditor api={api} machine={m} />
          <div className="wizard-actions"><button type="button" className="btn btn-primary" onClick={() => setStep(4)}>{t('Done')}</button></div>
        </>
      )}

      {step === 4 && (
        <div className="wizard-done">
          <span className="wizard-done-icon"><Check size={18} strokeWidth={2.6} /></span>
          <h3>{t('{name} is ready', { name: m.name })}</h3>
          <p className="setting-hint">{t('You can change what agents may do at any time in the machine’s details.')}</p>
          <div className="wizard-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{t('Back to machines')}</button></div>
        </div>
      )}
    </div>
  )
}
