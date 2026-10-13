import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Check, House, Server, ShieldCheck, TriangleAlert } from 'lucide-react'
import { locale, t } from '../i18n'
import { errorText } from '../api'
import { Spinner } from './primitives'
import { CopyCode } from './MachinesSettings'
import { homePort, isLan, phoneOnlyBridge, machineErrorText, needsHostKey, osName, validName, type HostKey, type InstallCommand, type Machine, type MachineKind, type MachineOs, type MachinesApi, type MachinesState } from '../machines'

const OSES: MachineOs[] = ['linux', 'macos', 'windows']

/** Settings > Machines > Add machine: type → name/address → connect. */
export function AddMachineWizard({ api, state, onClose }: { api: MachinesApi; state: MachinesState; onClose: (openId?: string) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [kind, setKind] = useState<MachineKind | null>(null)
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('root')
  const [os, setOs] = useState<MachineOs>('linux')
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [machineId, setMachineId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bridge = state.machines.find((m) => m.id === state.bridgeMachineId) ?? null
  const machine = machineId ? state.machines.find((m) => m.id === machineId) ?? null : null
  const nameError = validName(name, state.machines.map((m) => m.name))
  const validPort = /^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536
  const directReady = !!name && !nameError && !!host.trim() && validPort && !!user.trim()
  const next = async () => {
    setBusy(true)
    setError('')
    try {
      if (kind === 'direct') setHostKey(await api.probeHostKey(host.trim(), Number(port)))
      else {
        // A bridged machine is saved now so its tunnel has somewhere to land.
        const added = await api.add({ kind: 'bridged', name, os })
        setMachineId(added.id)
      }
      setStep(3)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="settings-section machines wizard">
      <div className="wizard-head">
        <button type="button" className="link-btn" onClick={() => (step === 1 || (step === 3 && machineId) ? onClose(machineId ?? undefined) : setStep(step === 3 ? 2 : 1))}>
          <ArrowLeft size={13} />{step === 1 || (step === 3 && machineId) ? t('Machines') : t('Back')}
        </button>
        <ol className="wizard-steps" aria-label={t('Step {n} of 3', { n: step })}>
          {[t('Type'), t('Details'), t('Connection')].map((label, i) => (
            <li key={label} className={clsx(i + 1 === step && 'current', i + 1 < step && 'done')}>
              <span>{i + 1 < step ? <Check size={10} strokeWidth={3} /> : i + 1}</span>{label}
            </li>
          ))}
        </ol>
      </div>

      {step === 1 && (
        <>
          <h3>{t('What are you adding?')}</h3>
          <div className="kind-cards">
            <button type="button" className={clsx('kind-card', kind === 'direct' && 'active')} aria-pressed={kind === 'direct'} onClick={() => setKind('direct')}>
              <Server size={20} strokeWidth={1.7} />
              <strong>{t('Server with a public IP')}</strong>
              <span>{t('A VPS or any computer Drover can reach directly — also one on your home network, by its local address.')}</span>
            </button>
            <button type="button" className={clsx('kind-card', kind === 'bridged' && 'active')} aria-pressed={kind === 'bridged'} disabled={phoneOnlyBridge(bridge)} onClick={() => setKind('bridged')}>
              <House size={20} strokeWidth={1.7} />
              <strong>{t('Home server or PC behind a router')}</strong>
              <span>{t('It connects out to your bridge, so you need no port forwarding. Works away from home too.')}</span>
              {bridge && phoneOnlyBridge(bridge) && <span className="kind-card-warn"><TriangleAlert size={12} />{t('Upgrade your bridge {bridge} for home machines first, in Settings › Machines.', { bridge: bridge.name })}</span>}
              {!bridge && <span className="kind-card-warn"><TriangleAlert size={12} />{t('No bridge yet: it will work on your home network only.')}</span>}
            </button>
          </div>
          {kind === 'bridged' && !bridge && <p className="setting-hint">{state.machines.some((m) => m.kind === 'direct' && m.publicIp)
            ? t('Without a bridge, this computer reaches it only on the same trusted home network: not away from home and not from your phone. To change that later, open one of your servers in the list and choose Use as bridge.')
            : t('Without a bridge, this computer reaches it only on the same trusted home network: not away from home and not from your phone. A bridge is a server with a public IP (a VPS); add one later to change that.')}</p>}
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={() => onClose()}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={!kind} onClick={() => setStep(2)}>{t('Next')}</button>
          </div>
        </>
      )}

      {step === 2 && kind && (
        <form onSubmit={(e) => { e.preventDefault(); if (kind === 'direct' ? directReady : name && !nameError) void next() }}>
          <h3>{kind === 'direct' ? t('Where is the server?') : t('Name the machine')}</h3>
          <div className="field">
            <label htmlFor="machine-name">{t('Name')}</label>
            <input id="machine-name" className={clsx('input', nameError && 'invalid')} value={name} autoFocus placeholder={kind === 'direct' ? 'vps' : 'homeserver'} onChange={(e) => setName(e.target.value.toLowerCase())} />
            <span className={clsx('field-hint', nameError && 'warn')}>{nameError ?? t('Agents will reach it as ssh {name}.', { name: name || '…' })}</span>
          </div>
          {kind === 'direct' ? (
            <>
              <div className="field-row">
                <div className="field grow">
                  <label htmlFor="machine-host">{t('Address')}</label>
                  <input id="machine-host" className="input mono" value={host} placeholder="203.0.113.5" spellCheck={false} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="field machine-port">
                  <label htmlFor="machine-port">{t('Port')}</label>
                  <input id="machine-port" className={clsx('input mono', !validPort && 'invalid')} value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="machine-user">{t('User')}</label>
                <input id="machine-user" className="input mono" value={user} spellCheck={false} onChange={(e) => setUser(e.target.value)} />
                <span className="field-hint">{t('The account agents sign in as, for example root or ubuntu.')}</span>
              </div>
            </>
          ) : (
            <div className="field">
              <label>{t('Operating system')}</label>
              <div className="segmented small">
                {OSES.map((o) => <button key={o} type="button" className={clsx(os === o && 'active')} onClick={() => setOs(o)}>{osName(o)}</button>)}
              </div>
              <span className="field-hint">{bridge ? t('It will connect through {bridge}.', { bridge: bridge.name }) : t('Home network only: this computer connects to it directly on your LAN.')}</span>
            </div>
          )}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="wizard-actions">
            <button type="button" className="btn" onClick={() => onClose()}>{t('Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy || (kind === 'direct' ? !directReady : !name || !!nameError)}>
              {busy && <Spinner size={13} />}{kind === 'direct' ? t('Next') : t('Create setup command')}
            </button>
          </div>
        </form>
      )}

      {step === 3 && kind === 'direct' && hostKey && (
        <DirectConnect api={api} draft={{ name, host: host.trim(), port: Number(port), user: user.trim() }} hostKey={hostKey} machine={machine} onAdded={setMachineId} onClose={onClose} bridge={bridge} />
      )}
      {step === 3 && kind === 'bridged' && machine && (
        <>
          <h3>{t('Run one command on {name}', { name: machine.name })}</h3>
          <InstallCommandPanel api={api} machine={machine} initialOs={os} />
          <div className="wizard-actions">
            {machine.status.state === 'online'
              ? <button type="button" className="btn btn-primary" onClick={() => onClose(machine.id)}>{t('Done')}</button>
              : <button type="button" className="btn" onClick={() => onClose(machine.id)}>{t('Finish later')}</button>}
          </div>
        </>
      )}
    </div>
  )
}

function DirectConnect({ api, draft, hostKey, machine, onAdded, onClose, bridge }: {
  api: MachinesApi
  draft: { name: string; host: string; port: number; user: string }
  hostKey: HostKey
  machine: Machine | null
  onAdded: (id: string) => void
  onClose: (openId?: string) => void
  bridge: Machine | null
}) {
  const [matches, setMatches] = useState(hostKey.known)
  const [method, setMethod] = useState<'password' | 'installed'>('password')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Machine | null>(null)
  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      const m = machine ?? await api.add({ kind: 'direct', ...draft })
      onAdded(m.id)
      const done = await api.installKey(m.id, { password: method === 'password' ? password : undefined, acceptedFingerprint: hostKey.fingerprint })
      if (done.status.state === 'online') setResult(done)
      else setError(machineErrorText(done.status.error, done) || t('Could not connect.'))
    } catch (e) { setError(errorText(e)) } finally {
      // The password is good for one attempt only, whatever the outcome.
      setPassword('')
      setBusy(false)
    }
  }
  if (result) {
    return (
      <div className="wizard-done">
        <span className="wizard-done-icon"><Check size={18} strokeWidth={2.6} /></span>
        <h3>{t('{name} is connected', { name: result.name })}</h3>
        <p className="setting-hint">{[result.osLabel || osName(result.os), result.status.latencyMs !== undefined ? t('{n} ms', { n: result.status.latencyMs }) : ''].filter(Boolean).join(' · ')}</p>
        <p className="setting-hint">{t('Agents can now use ssh {name}. They have full access; you can limit it in the machine’s settings.', { name: result.alias })}</p>
        {result.publicIp && !bridge && <p className="machine-note"><ShieldCheck size={13} />{t('This server can also be your bridge for home machines. Open it in the list and choose Use as bridge.')}</p>}
        <div className="wizard-actions"><button type="button" className="btn btn-primary" onClick={() => onClose(result.id)}>{t('Done')}</button></div>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (matches && (method === 'installed' || password)) void connect() }}>
      <h3>{t('Connect to {name}', { name: draft.name })}</h3>
      <HostKeyCard hostKey={hostKey} matches={matches} onMatches={setMatches} hint={t('Compare it with the fingerprint in your provider’s console. If they match, Drover remembers this key and refuses to connect if it ever changes.')} />
      <div className="field">
        <label>{t('Agents key')}</label>
        <div className="segmented small">
          <button type="button" className={clsx(method === 'password' && 'active')} onClick={() => setMethod('password')}>{t('Install with a password')}</button>
          <button type="button" className={clsx(method === 'installed' && 'active')} onClick={() => setMethod('installed')}>{t('Already installed')}</button>
        </div>
      </div>
      {method === 'password' ? (
        <div className="field">
          <label htmlFor="machine-password">{t('Password for {user}', { user: draft.user })}</label>
          <input id="machine-password" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">{t('Used once to put the agents key on the server, then forgotten. Drover never saves it. After that, only the key works.')}</span>
        </div>
      ) : (
        <p className="setting-hint">{t('Use this when the agents key is already in ~/.ssh/authorized_keys on the server — for example after you added it in your provider’s panel.')}</p>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="wizard-actions">
        <button type="button" className="btn" onClick={() => onClose(machine?.id)}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !matches || (method === 'password' && !password)}>
          {busy && <Spinner size={13} />}{busy ? t('Connecting…') : t('Connect')}
        </button>
      </div>
    </form>
  )
}

export function HostKeyCard({ hostKey, matches, onMatches, hint }: { hostKey: HostKey; matches: boolean; onMatches: (v: boolean) => void; hint: string }) {
  return (
    <div className={clsx('hostkey', hostKey.known && 'known')}>
      <div className="hostkey-head"><ShieldCheck size={14} />{hostKey.known ? t('This server’s key is already trusted') : t('Check the server’s key')}</div>
      <code className="hostkey-print">{hostKey.algorithm} {hostKey.fingerprint}</code>
      {!hostKey.known && <>
        <p className="setting-hint">{hint}</p>
        <label className="check"><input type="checkbox" checked={matches} onChange={(e) => onMatches(e.target.checked)} />{t('The fingerprint matches')}</label>
      </>}
    </div>
  )
}

/** A bridged machine reached the bridge: its SSH key must be confirmed before Drover checks or signs in. */
export function BridgedHostKey({ api, machine }: { api: MachinesApi; machine: Machine }) {
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [matches, setMatches] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setHostKey(null)
    api.probeHostKey(machine.alias, homePort(machine)!).then((k) => { if (live) { setHostKey(k); setMatches(k.known) } }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [api, machine.alias, machine.bridgePort, machine.port])
  const trust = async () => {
    if (!hostKey) return
    setBusy(true)
    setError('')
    try {
      const done = await api.installKey(machine.id, { acceptedFingerprint: hostKey.fingerprint })
      if (done.status.state !== 'online') setError(machineErrorText(done.status.error, done) || t('Could not connect.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <div className="install-panel">
      <p className="machine-note"><Check size={13} />{isLan(machine) ? t('{name} answers on your home network: its SSH port is reachable. Confirm its key to finish.', { name: machine.name }) : t('{name} reached the bridge. Confirm its key to finish.', { name: machine.name })}</p>
      {!hostKey && !error && <div className="install-cmd loading"><Spinner size={13} /></div>}
      {hostKey && <HostKeyCard hostKey={hostKey} matches={matches} onMatches={setMatches} hint={machine.os === 'windows'
        ? t('To compare, run this on {name} in PowerShell: {command}', { name: machine.name, command: 'ssh-keygen -lf $env:ProgramData/ssh/ssh_host_ed25519_key.pub' })
        : t('To compare, run this on {name}: {command}', { name: machine.name, command: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' })} />}
      {error && <p role="alert" className="form-error">{error}</p>}
      {hostKey && <div className="machine-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !matches} onClick={() => void trust()}>{busy && <Spinner size={12} />}{t('Trust and connect')}</button>
      </div>}
    </div>
  )
}

const runHint = (os: MachineOs) =>
  os === 'windows' ? t('On the PC, open PowerShell as Administrator and run:')
    : os === 'macos' ? t('On that Mac, open Terminal and run this. It asks for the Mac’s password once and turns on Remote Login if needed:')
    : t('On the server, open a terminal and run this as a user with sudo:')

/** One-line setup command for a bridged machine with a live "waiting to connect" state. */
export function InstallCommandPanel({ api, machine, initialOs, onClose }: { api: MachinesApi; machine: Machine; initialOs?: MachineOs; onClose?: () => void }) {
  const [os, setOs] = useState<MachineOs>(initialOs ?? machine.os ?? 'linux')
  const [cmd, setCmd] = useState<InstallCommand | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [round, setRound] = useState(0)
  useEffect(() => {
    let live = true
    setCmd(null)
    setError('')
    api.installCommand(machine.id, os).then((c) => { if (live) setCmd(c) }, (e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [api, machine.id, os, round])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const online = machine.status.state === 'online' && !machine.needsReinstall
  const expired = !!cmd && now >= cmd.expiresAt
  return (
    <div className="install-panel">
      <div className="segmented small" role="tablist" aria-label={t('Operating system')}>
        {OSES.map((o) => <button key={o} type="button" role="tab" aria-selected={os === o} className={clsx(os === o && 'active')} onClick={() => setOs(o)}>{osName(o)}</button>)}
      </div>
      <p className="setting-hint">{runHint(os)}</p>
      {!cmd && !error && <div className="install-cmd loading"><Spinner size={13} /></div>}
      {cmd && !expired && <CopyCode text={cmd.command} block />}
      {cmd && (expired
        ? <p className="machine-note warn"><TriangleAlert size={13} />{t('This command expired.')} <button type="button" className="link-btn" onClick={() => setRound(round + 1)}>{t('Create a new one')}</button></p>
        : isLan(machine)
          ? <>
            <p className="setting-hint">{t('Works once, until {time}. It creates an agent account and installs the agents key. Run it while {name} and this computer are on the same home network.', { time: new Date(cmd.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }), name: machine.name })}</p>
            <p className="machine-note warn"><TriangleAlert size={13} /><span>{t('Use this only on a trusted home network: the setup link is plain HTTP inside your network. Without a bridge, the machine is not reachable away from home or from your phone.')}</span></p>
          </>
          : <p className="setting-hint">{t('Works once, until {time}. It creates an agent account, installs the agents key and connects to the bridge; the connection comes back by itself after restarts.', { time: new Date(cmd.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}</p>)}
      {error && <p role="alert" className="form-error">{error}</p>}
      {needsHostKey(machine) ? <BridgedHostKey api={api} machine={machine} /> : <div className={clsx('install-wait', online ? 'ok' : machine.status.state === 'offline' && machine.status.error ? 'bad' : 'wait')} role="status" aria-live="polite">
        {online ? <Check size={14} strokeWidth={2.6} /> : <span className="install-pulse" />}
        <div>
          <strong>{online ? t('{name} is connected', { name: machine.name }) : t('Waiting for {name} to connect…', { name: machine.name })}</strong>
          <span>{online
            ? [machine.osLabel || osName(machine.os), machine.status.latencyMs !== undefined ? t('{n} ms', { n: machine.status.latencyMs }) : ''].filter(Boolean).join(' · ')
            : machine.status.error ? machineErrorText(machine.status.error, machine) : t('This updates by itself, usually within a minute after the command finishes.')}</span>
        </div>
      </div>}
      {onClose && <div className="machine-actions"><button type="button" className="btn btn-sm" onClick={onClose}>{t('Hide')}</button></div>}
    </div>
  )
}
