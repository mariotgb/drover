import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Cable, Check, ChevronRight, Copy, House, KeyRound, Minus, Plus, RefreshCw, Server, Smartphone, TriangleAlert } from 'lucide-react'
import { locale, t, tp } from '../i18n'
import { errorText } from '../api'
import { toast, useModel } from '../store'
import { Spinner } from './primitives'
import { AddMachineWizard, BridgedHostKey, HostKeyCard, InstallCommandPanel } from './AddMachineWizard'
import { BridgeChecklist, BridgeWizard, UpgradeBridge, useBridgeJob } from './BridgeWizard'
import type { MachineChecks } from '@shared/machines'
import { ago, cleanupNote, isLan, machineErrorText, suppliedAccount, type CleanupNote, machinesApi, needsHostKey, osName, type Machine, type MachineAccess, type MachinesApi, type MachinesState, ADOPT_STEPS, phoneOnlyBridge, type BridgeApi, type BridgeProgress, type ExistingBridge, type HostKey } from '../machines'

export function MachinesSettings() {
  const machines = machinesApi()
  const [state, setState] = useState<MachinesState | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [notes, setNotes] = useState<CleanupNote[]>([])
  const [bridgeWizard, setBridgeWizard] = useState(false)
  const [bridgeReport, setBridgeReport] = useState<BridgeProgress[] | null>(null)
  useEffect(() => {
    if (!machines) return
    void machines.state().then(setState, (e) => setError(errorText(e)))
    return machines.onChange(setState)
  }, [machines])
  if (!machines) return <div className="settings-section machines"><p role="status" className="setting-hint block">{t('Machines are not available in this build.')}</p></div>
  if (!state) return <div className="settings-section machines">{error ? <p role="alert" className="form-error">{error}</p> : <Spinner />}</div>
  if (adding) return <AddMachineWizard api={machines} state={state} onClose={(id) => { setAdding(false); if (id) setOpen(id) }} />
  if (bridgeWizard) return <BridgeWizard api={machines} onClose={() => setBridgeWizard(false)} />
  const bridge = state.machines.find((m) => m.id === state.bridgeMachineId) ?? null
  return (
    <div className="settings-section machines">
      <div className="machines-head">
        <div>
          <h3>{t('Machines')}</h3>
          <p className="setting-hint">{t('Computers your agents can reach over SSH. Agents learn about them automatically and connect with their own key; passwords are never stored.')}</p>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Plus size={13} />{t('Add machine')}</button>
      </div>
      {notes.length > 0 && <CleanupNotes notes={notes} onDismiss={() => setNotes([])} />}
      <BridgeCard api={machines} state={state} bridge={bridge} report={bridgeReport} onReport={setBridgeReport} onOpen={setOpen} onSetup={() => setBridgeWizard(true)} />
      {state.machines.length ? (
        <div className="machine-list" role="list">
          {state.machines.map((m) => (
            <MachineRow key={m.id} api={machines} machine={m} bridge={bridge} via={state.machines.find((x) => x.id === (m.bridgeMachineId ?? state.bridgeMachineId)) ?? null} homes={state.machines.filter((x) => x.kind === 'bridged').length} isBridge={m.id === state.bridgeMachineId} onNotes={setNotes} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} />
          ))}
        </div>
      ) : (
        <div className="machines-empty">
          <Server size={22} strokeWidth={1.6} />
          <p>{t('No machines yet. Add a VPS, a home server or another computer, and your agents can work on it.')}</p>
        </div>
      )}
      <SshIncludeBlock api={machines} state={state} />
      <AgentsKeyBlock api={machines} state={state} onNotes={setNotes} />
    </div>
  )
}

export function MachineDot({ machine }: { machine: Pick<Machine, 'status'> }) {
  const s = machine.status.state
  if (s === 'checking') return <span className="machine-dot"><Spinner size={10} /></span>
  return <span className={clsx('machine-dot', `is-${s}`)} title={stateLabel(s)}><span /></span>
}

function stateLabel(s: Machine['status']['state']): string {
  return s === 'online' ? t('Online') : s === 'offline' ? t('Offline') : s === 'waiting' ? t('Waiting to connect') : s === 'checking' ? t('Checking…') : t('Not checked yet')
}

function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError('')
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  return { busy, error, setError, run }
}

type Detect = { state: 'idle' | 'looking' | 'done'; found: ExistingBridge | null; error?: string }

/** Looks once for a bridge set up by hand earlier (LaunchAgent tunnel, Caddy phone site, admin key). */
function useDetectBridge(api: BridgeApi, skip: boolean) {
  const [detect, setDetect] = useState<Detect>({ state: 'idle', found: null })
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (skip || !api.detectExistingBridge) { setDetect({ state: 'done', found: null }); return }
    let live = true
    setDetect((d) => ({ state: 'looking', found: d.found }))
    // Detection reads only local files; any failure means the old setup is unreadable (existing_bridge_invalid).
    api.detectExistingBridge().then((found) => { if (live) setDetect({ state: 'done', found }) }, () => { if (live) setDetect({ state: 'done', found: null, error: machineErrorText({ code: 'existing_bridge_invalid' }) }) })
    return () => { live = false }
  }, [api, skip, round])
  return { ...detect, again: () => setRound((r) => r + 1) }
}

function BridgeFacts({ url, tunnel, children }: { url?: string; tunnel: 'running' | 'stopped' | 'missing'; children?: React.ReactNode }) {
  return (
    <ul className="bridge-facts">
      <li className={url ? 'ok' : 'off'}>{url ? <Check size={12} strokeWidth={2.6} /> : <Minus size={12} />}<span>{t('Phone site')}</span>{url ? <code>{url}</code> : <span className="dim">{t('not set up')}</span>}</li>
      <li className={tunnel === 'running' ? 'ok' : 'warn'}>{tunnel === 'running' ? <Check size={12} strokeWidth={2.6} /> : <TriangleAlert size={12} />}<span>{t('Mac tunnel')}</span><span className="dim">{tunnel === 'running' ? t('running') : tunnel === 'stopped' ? t('stopped') : t('not set up')}</span></li>
      {children}
    </ul>
  )
}

/** A bridge connected from the phone setup keeps its own accounts; Drover does not change them yet. */
function PhoneOnlyNote() {
  return <p className="machine-note"><Smartphone size={13} /><span>{t('For now this bridge only serves your phone. Home machines can connect through it after you upgrade it.')}</span></p>
}

const WHY = () => t('A bridge is a small server with a public IP (a VPS), so your machines and phone can reach this Mac from anywhere.')

function BridgeCard({ api, state, bridge, report, onReport, onOpen, onSetup }: { api: BridgeApi; state: MachinesState; bridge: Machine | null; report: BridgeProgress[] | null; onReport: (steps: BridgeProgress[] | null) => void; onOpen: (id: string) => void; onSetup: () => void }) {
  const detect = useDetectBridge(api, !!bridge)
  const homes = state.machines.filter((m) => m.kind === 'bridged')
  const homesOnline = homes.filter((m) => m.status.state === 'online').length
  if (bridge) {
    const setup = bridge.bridgeSetup
    const working = bridge.status.state === 'online' && setup?.state === 'ready'
    return (
      <div className="bridge-card">
        <span className="bridge-icon"><Cable size={16} /></span>
        <div className="bridge-text">
          <div className="bridge-title">
            {t('Bridge')} <button type="button" className="link-btn" onClick={() => onOpen(bridge.id)}>{bridge.name}</button>
            <span className="dim">{bridge.host}</span>
          </div>
          <div className="setting-hint">
            {setup?.state === 'running' ? t('Setting up: {step}', { step: setup.step ?? '…' })
              : working && phoneOnlyBridge(bridge) ? t('Your phone reaches this Mac through it.')
              : working ? `${t('Your machines and phone reach this Mac through it — no router setup needed.')} ${homes.length ? tp({ one: '{online} of {n} home machine connected.', other: '{online} of {n} home machines connected.' }, homes.length, { online: homesOnline }) : ''}`
              : machineErrorText(bridge.status.error ?? setup?.error ?? { code: 'bridge_down' }, bridge, bridge.name)}
          </div>
          <PhoneTunnelNote machine={bridge} />
          {bridge.bridgeConnection && <>
            <BridgeFacts url={bridge.bridgeConnection.publicUrl} tunnel={bridge.bridgeConnection.macTunnel} />
            {phoneOnlyBridge(bridge) && <>
              <PhoneOnlyNote />
              <UpgradeBridge api={api} machine={bridge} onDone={onReport} />
            </>}
          </>}
          {report && (
            <div className="bridge-result">
              <BridgeChecklist steps={report} label={t('Bridge connected')} />
              <button type="button" className="link-btn" onClick={() => onReport(null)}>{t('Hide')}</button>
            </div>
          )}
        </div>
        <span className={clsx('bridge-state', working ? 'ok' : setup?.state === 'running' ? 'wait' : 'bad')}>
          {setup?.state === 'running' ? <Spinner size={11} /> : <span className="conn-dot" />}
          {setup?.state === 'running' ? t('Setting up') : working ? t('Working') : t('Not working')}
        </span>
      </div>
    )
  }
  if (detect.state !== 'done') {
    return (
      <div className="bridge-card muted" role="status">
        <span className="bridge-icon"><Spinner size={13} /></span>
        <div className="bridge-text">
          <div className="bridge-title">{t('Looking for your bridge…')}</div>
          <div className="setting-hint">{t('Checking this Mac for a bridge you set up earlier.')}</div>
        </div>
      </div>
    )
  }
  if (detect.found) return <FoundBridge api={api} found={detect.found} onReport={onReport} onAgain={detect.again} />
  return <NoBridge api={api} state={state} onSetup={onSetup} onAgain={detect.again} detectError={detect.error} />
}

function FoundBridge({ api, found, onReport, onAgain }: { api: BridgeApi; found: ExistingBridge; onReport: (steps: BridgeProgress[]) => void; onAgain: () => void }) {
  const job = useBridgeJob(api, ADOPT_STEPS)
  // Adoption needs a fresh probe even when this Mac pinned the key before; a pinned key comes back as known.
  const [hostKey, setHostKey] = useState<HostKey | null>(null)
  const [matches, setMatches] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  // Without an admin key on this Mac, one sign-in with a one-time password installs Drover's own admin key.
  const [user, setUser] = useState('root')
  const [password, setPassword] = useState('')
  const signIn = !found.adminKey
  const url = found.phoneUrl ?? found.publicUrl
  const tunnel = found.tunnelRunning || found.macTunnel === 'running' ? 'running' : found.macTunnel
  const connect = async () => {
    setError('')
    let key = hostKey
    if (!key) {
      // No local pin: show the server's key first; the user confirms, then presses Connect again.
      setChecking(true)
      try { key = await api.probeHostKey(found.host, found.port); setHostKey(key); setMatches(key.known) } catch (e) { setError(errorText(e)) } finally { setChecking(false) }
      if (!key?.known) return
    }
    const secret = signIn ? password : undefined
    // The password is good for one attempt only, whatever the outcome.
    setPassword('')
    const report = await job.start(() => api.adoptExistingBridge!(signIn ? { acceptedFingerprint: key!.fingerprint, user: user.trim() || 'root', password: secret } : { acceptedFingerprint: key!.fingerprint }), !!url)
    if (report) onReport(report.steps)
  }
  const confirmed = !!hostKey && (hostKey.known || matches)
  return (
    <div className="bridge-card found">
      <span className="bridge-icon"><Cable size={16} /></span>
      <div className="bridge-text">
        <div className="bridge-title">{t('Found your bridge')}<span className="dim">{found.host}</span></div>
        <p className="setting-hint">{t('Set up earlier on this Mac. Connect it so Drover can use and check it.')} {WHY()}</p>
        <BridgeFacts url={url} tunnel={tunnel}>
          {!found.adminKey && <li className="warn"><TriangleAlert size={12} /><span>{t('Admin key')}</span><span className="dim">{t('not on this Mac yet — sign in once below')}</span></li>}
        </BridgeFacts>
        {hostKey && !hostKey.known && job.phase === 'idle' && <HostKeyCard hostKey={hostKey} matches={matches} onMatches={setMatches} hint={t('Compare it with the fingerprint in your provider’s console. If they match, Drover remembers this key and refuses to connect if it ever changes.')} />}
        {signIn && job.phase !== 'running' && job.phase !== 'done' && (
          <div className="bridge-signin">
            <p className="setting-hint">{t('Sign in to {host} once as an administrator. Drover installs its own admin key there and forgets the password; nothing else on the server changes.', { host: found.host })}</p>
            <div className="field-row">
              <div className="field bridge-signin-user">
                <label htmlFor="found-user">{t('Login')}</label>
                <input id="found-user" className="input mono" value={user} spellCheck={false} onChange={(e) => setUser(e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="found-password">{t('One-time password')}</label>
                <input id="found-password" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
          </div>
        )}
        {job.steps && <BridgeChecklist steps={job.steps} label={t('Connecting the bridge')} />}
        {!api.adoptExistingBridge && <p className="machine-note warn">{t('This version of Drover cannot connect an existing bridge yet.')}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="machine-actions bridge-actions">
          {job.phase !== 'running' && job.phase !== 'done' && (
            <button type="button" className="btn btn-sm btn-primary" disabled={!api.adoptExistingBridge || (signIn && (!password || !user.trim())) || checking || (!!hostKey && !confirmed)} onClick={() => void connect()}>
              {checking && <Spinner size={12} />}{job.phase === 'failed' ? t('Try again') : t('Connect this bridge')}
            </button>
          )}
          {job.phase === 'idle' && <button type="button" className="link-btn" onClick={onAgain}>{t('Look again')}</button>}
        </div>
      </div>
    </div>
  )
}

function NoBridge({ api, state, onSetup, onAgain, detectError }: { api: BridgeApi; state: MachinesState; onSetup: () => void; onAgain: () => void; detectError?: string }) {
  const candidates = state.machines.filter((m) => m.kind === 'direct' && m.publicIp)
  const [pick, setPick] = useState(candidates[0]?.id ?? '')
  const [picking, setPicking] = useState(false)
  const [caddy, setCaddy] = useState(true)
  const { busy, error, run } = useAction()
  useEffect(() => { if (!candidates.some((m) => m.id === pick)) setPick(candidates[0]?.id ?? '') }, [candidates.map((m) => m.id).join()])
  return (
    <div className="bridge-card">
      <span className="bridge-icon"><Cable size={16} /></span>
      <div className="bridge-text">
        <div className="bridge-title">{t('No bridge yet')}</div>
        <p className="setting-hint">{WHY()} {t('Without one, home machines work only while this Mac is on the same home network.')}</p>
        {detectError && <p className="machine-note warn bridge-detect-error"><TriangleAlert size={13} /><span>{detectError}</span></p>}
        <div className="machine-actions bridge-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={onSetup}>{t('Set up bridge')}</button>
          {candidates.length > 0 && !picking && <button type="button" className="link-btn" onClick={() => setPicking(true)}>{t('Use a server you already added')}</button>}
          {api.detectExistingBridge && !picking && <button type="button" className="link-btn" onClick={onAgain}>{t('Look again')}</button>}
        </div>
        {picking && (
          <div className="bridge-pick">
            <select className="input select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t('Bridge server')}>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.host}</option>)}
            </select>
            <PhoneSiteCheck value={caddy} onChange={setCaddy} />
            <button type="button" className="btn btn-sm" onClick={() => setPicking(false)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!pick || busy !== null} onClick={() => void run('setup', async () => { await api.setupBridge(pick, { caddy, confirmed: true }); await api.setBridge(pick, { confirmed: true }) })}>
              {busy && <Spinner size={12} />}{t('Set up as bridge')}
            </button>
          </div>
        )}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
    </div>
  )
}

function MachineRow({ api, machine: m, bridge, via, homes, isBridge, onNotes, open, onToggle }: { api: MachinesApi; machine: Machine; bridge: Machine | null; via: Machine | null; homes: number; isBridge: boolean; onNotes: (notes: CleanupNote[]) => void; open: boolean; onToggle: () => void }) {
  const { busy, error, run } = useAction()
  const checking = busy === 'check' || m.status.state === 'checking'
  const reason = needsHostKey(m) ? (isLan(m) ? t('{name} answers on your home network: its SSH port is reachable. Confirm its key to finish.', { name: m.name }) : t('{name} reached the bridge. Confirm its key to finish.', { name: m.name })) : m.status.state === 'offline' || m.status.state === 'waiting' ? machineErrorText(m.status.error, m, via?.name) : ''
  const where = m.kind === 'direct' ? `${m.user}@${m.host}${m.port && m.port !== 22 ? `:${m.port}` : ''}` : via ? t('Through {bridge}', { bridge: via.name }) : m.host ? t('Home network · {address}', { address: m.host }) : t('Home network')
  return (
    <div className={clsx('machine', open && 'open', m.status.state === 'offline' && 'is-offline')} role="listitem">
      <div className="machine-head">
        <button type="button" className="machine-toggle" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={13} className="machine-chev" />
          <MachineDot machine={m} />
          <span className="machine-icon">{m.kind === 'direct' ? <Server size={14} /> : <House size={14} />}</span>
          <span className="machine-text">
            <span className="machine-name">
              {m.name}
              {isBridge && <span className="machine-badge">{t('Bridge')}</span>}
              {m.needsReinstall && <span className="machine-badge warn">{t('Needs update')}</span>}
            </span>
            <span className="machine-sub">{[m.kind === 'direct' && t('Direct'), where, m.osLabel || osName(m.os)].filter(Boolean).join(' · ')}</span>
            {reason && <span className={clsx('machine-reason', needsHostKey(m) && 'warn')}>{reason}</span>}
          </span>
        </button>
        <span className="machine-meta">
          <span className="machine-latency">{m.status.state === 'online' && m.status.latencyMs !== undefined ? t('{n} ms', { n: m.status.latencyMs }) : stateLabel(m.status.state)}</span>
          <span className="machine-ago">{ago(m.status.checkedAt)}</span>
        </span>
        <button type="button" className="icon-btn icon-btn-sm" title={t('Check now')} aria-label={t('Check now')} disabled={checking} onClick={() => void run('check', () => api.check(m.id))}>
          {checking ? <Spinner size={12} /> : <RefreshCw size={13} />}
        </button>
      </div>
      {error && !open && <p role="alert" className="form-error machine-error">{error}</p>}
      {open && <MachineDetails api={api} machine={m} bridge={bridge} homes={homes} isBridge={isBridge} onNotes={onNotes} />}
    </div>
  )
}

function MachineDetails({ api, machine: m, bridge, homes, isBridge, onNotes }: { api: MachinesApi; machine: Machine; bridge: Machine | null; homes: number; isBridge: boolean; onNotes: (notes: CleanupNote[]) => void }) {
  const { busy, error, run } = useAction()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmBridge, setConfirmBridge] = useState(false)
  const [confirmRepair, setConfirmRepair] = useState(false)
  const [caddy, setCaddy] = useState(m.bridgeSetup?.caddy ?? true)
  const [command, setCommand] = useState(false)
  const setup = m.bridgeSetup
  return (
    <div className="machine-details">
      <div className="machine-field">
        <span className="machine-field-label">{t('Agents connect with')}</span>
        <CopyCode text={`ssh ${m.alias}`} />
      </div>
      {m.kind === 'bridged' && isLan(m) && (
        <div className="machine-field">
          <span className="machine-field-label">{t('Home network')}</span>
          <span className="machine-field-value">{m.host ?? t('Waiting for its address')} <span className="dim">{t('(this Mac reaches it only on the same network)')}</span></span>
        </div>
      )}
      {m.kind === 'bridged' && !isLan(m) && m.bridgePort !== undefined && (
        <div className="machine-field">
          <span className="machine-field-label">{t('Port on the bridge')}</span>
          <span className="machine-field-value">{m.bridgePort} <span className="dim">{t('(closed to the internet)')}</span></span>
        </div>
      )}
      {m.status.checks && (
        <div className="machine-field">
          <span className="machine-field-label">{t('Last check')}</span>
          <span className="machine-field-value machine-checks">{checksText(m.status.checks)}</span>
        </div>
      )}
      {phoneOnlyBridge(m)
        ? <div className="machine-section"><div className="machine-section-title">{t('What agents may do')}</div><p className="setting-hint">{t('Access to this bridge can be changed after you upgrade it for home machines.')}</p></div>
        : <AccessEditor api={api} machine={m} />}
      <LastCleanup machine={m} />

      {m.kind === 'bridged' && (
        <div className="machine-section">
          <div className="machine-section-title">{t('Connection')}</div>
          {m.needsReinstall && <p className="machine-note warn"><TriangleAlert size={13} />{t('The bridge changed. Run the setup command on {name} again so it connects to {bridge}.', { name: m.name, bridge: bridge?.name ?? t('the new bridge') })}</p>}
          {needsHostKey(m) && !command && <BridgedHostKey api={api} machine={m} />}
          {command ? <InstallCommandPanel api={api} machine={m} onClose={() => setCommand(false)} /> : (
            <button type="button" className="btn btn-sm" onClick={() => setCommand(true)}>{t('Show setup command')}</button>
          )}
        </div>
      )}

      {m.kind === 'direct' && m.publicIp && (
        <div className="machine-section">
          <div className="machine-section-title">{t('Bridge')}</div>
          {isBridge ? (
            <>
              {phoneOnlyBridge(m) ? <PhoneOnlyNote /> : <>
              <p className="setting-hint">{setup?.state === 'ready' ? t('This server links your home machines. Last checked {when}.', { when: ago(setup.checkedAt) }) : t('This server is chosen as the bridge but is not set up yet.')}</p>
              <BridgeSteps machine={m} />
              {confirmRepair ? (
                <div className="machine-confirm">
                  <p>{setup?.state === 'ready'
                    ? t('Check and repair {name}? Drover rewrites the bridge users, SSH access rules and firewall on the server to match what home machines need.', { name: m.name })
                    : t('Set up {name} as the bridge? Drover writes the bridge users, SSH access rules and firewall on the server.', { name: m.name })}
                    {' '}{caddy ? t('It also updates the phone site setup; the phone site keeps working.') : t('The phone site keeps working.')}</p>
                  <PhoneSiteCheck value={caddy} onChange={setCaddy} />
                  <div className="machine-actions">
                    <button type="button" className="btn btn-sm" onClick={() => setConfirmRepair(false)}>{t('Cancel')}</button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || setup?.state === 'running'} onClick={() => void run('setup', async () => { await api.setupBridge(m.id, { caddy, confirmed: true }); setConfirmRepair(false) })}>
                      {busy === 'setup' && <Spinner size={12} />}{setup?.state === 'ready' ? t('Repair') : t('Set up')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="machine-actions">
                  <button type="button" className="btn btn-sm" disabled={busy !== null || setup?.state === 'running'} onClick={() => setConfirmRepair(true)}>
                    {setup?.state === 'ready' ? t('Check and repair…') : t('Set up as bridge…')}
                  </button>
                </div>
              )}
              </>}
            </>
          ) : confirmBridge ? (
            <div className="machine-confirm">
              <p>{bridge
                ? t('Make {name} the bridge instead of {bridge}? Drover sets it up, then moves {n} home machines to it. Machines it cannot reach will need their setup command run again.', { name: m.name, bridge: bridge.name, n: homes })
                : t('Make {name} the bridge? Drover creates the bridge users, sets up the firewall and checks that it works.', { name: m.name })}
                {bridge?.bridgeConnection && ` ${t('Your phone site stays on {bridge}: this Mac’s phone tunnel keeps running there.', { bridge: bridge.name })}`}</p>
              <PhoneSiteCheck value={caddy} onChange={setCaddy} />
              <div className="machine-actions">
                <button type="button" className="btn btn-sm" onClick={() => setConfirmBridge(false)}>{t('Cancel')}</button>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void run('bridge', async () => { await api.setupBridge(m.id, { caddy, confirmed: true }); await api.setBridge(m.id, { confirmed: true }); setConfirmBridge(false) })}>
                  {busy === 'bridge' && <Spinner size={12} />}{bridge ? t('Switch bridge') : t('Set up as bridge')}
                </button>
              </div>
            </div>
          ) : bridge && phoneOnlyBridge(bridge) ? (
            <p className="setting-hint">{t('This server has a public IP. To switch bridges, first upgrade {bridge} for home machines.', { bridge: bridge.name })}</p>
          ) : (
            <>
              <p className="setting-hint">{t('This server has a public IP, so it can link home machines that sit behind a router.')}</p>
              <div className="machine-actions"><button type="button" className="btn btn-sm" onClick={() => setConfirmBridge(true)}><Cable size={13} />{t('Use as bridge…')}</button></div>
            </>
          )}
        </div>
      )}

      {error && <p role="alert" className="form-error">{error}</p>}

      <div className="machine-section machine-remove">
        {confirmRemove ? (
          <div className="machine-confirm danger">
            <p>{phoneOnlyBridge(m) ? t('Drover forgets {name}. Nothing changes on the server, and the phone tunnel on this Mac keeps running.', { name: m.name }) : m.bridgeConnection ? t('{name} is the bridge. Removing it disconnects every home machine until you choose another bridge. The phone tunnel on this Mac keeps running.', { name: m.name }) : isBridge ? t('{name} is the bridge. Removing it disconnects every home machine until you choose another bridge.', { name: m.name }) : t('Remove {name}? Agents lose access to it. Nothing on the machine is deleted.', { name: m.name })}</p>
            {suppliedAccount(m) && <SuppliedWarning name={m.name} />}
            <div className="machine-actions">
              <button type="button" className="btn btn-sm" onClick={() => setConfirmRemove(false)}>{t('Cancel')}</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void run('remove', async () => { const result = await api.remove(m.id, { confirmed: true }); onNotes([cleanupNote(result, m.name, suppliedAccount(m))]) })}>{busy === 'remove' && <Spinner size={12} />}{t('Remove')}</button>
            </div>
          </div>
        ) : (
          m.bridgeConnection?.source === 'scratch' && phoneOnlyBridge(m)
            ? <p className="setting-hint">{t('This bridge runs the phone tunnel Drover set up. Finish its setup for home machines before removing it.')}</p>
            : <button type="button" className="link-btn danger" onClick={() => setConfirmRemove(true)}>{phoneOnlyBridge(m) ? t('Forget this bridge…') : t('Remove machine…')}</button>
        )}
      </div>
    </div>
  )
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toLocaleString(locale(), { maximumFractionDigits: bytes < 10 * 1024 ** 3 ? 1 : 0 })

function checksText(c: MachineChecks): string {
  return [
    c.tcp ? (c.auth ? t('Signs in with the agents key') : t('Reachable, but the agents key is refused')) : t('Not reachable'),
    c.diskAvailableBytes !== undefined && t('{n} GB free on disk', { n: gb(c.diskAvailableBytes) }),
    c.memoryAvailableBytes !== undefined && c.memoryTotalBytes !== undefined && t('{free} of {total} GB memory free', { free: gb(c.memoryAvailableBytes), total: gb(c.memoryTotalBytes) }),
    c.docker && 'Docker',
    c.herdr && 'herdr'
  ].filter(Boolean).join(' · ')
}

function SuppliedWarning({ name }: { name: string }) {
  return <p className="machine-note warn"><TriangleAlert size={13} /><span>{t('{name} uses an account you supplied, so Drover will not end sessions that are already open: they may keep their access until they end. Use a dedicated account for agents to make changes immediate.', { name })}</span></p>
}

function LastCleanup({ machine: m }: { machine: Machine }) {
  const last = m.sessionCleanup?.last
  // Only a recent permission change is worth repeating here; removals and revokes report in the list notes.
  if (!last || last.reason !== 'permissions' || Date.now() - last.at > 10 * 60_000) return null
  // A supplied account always leaves sessions open; the standing warning above already says so.
  if (suppliedAccount(m) && last.incomplete && !last.error) return null
  const note = cleanupNote(last, m.name, suppliedAccount(m))
  return <p className={clsx('machine-note', note.tone === 'bad' ? 'bad' : note.tone === 'warn' ? 'warn' : 'ok')}>{note.tone === 'ok' ? <Check size={13} /> : <TriangleAlert size={13} />}<span>{note.text}</span></p>
}

function CleanupNotes({ notes, onDismiss }: { notes: CleanupNote[]; onDismiss: () => void }) {
  return (
    <div className="cleanup-notes" role="status">
      {notes.map((n, i) => <p key={i} className={clsx('machine-note', n.tone === 'bad' ? 'bad' : n.tone === 'warn' ? 'warn' : 'ok')}>{n.tone === 'ok' ? <Check size={13} /> : <TriangleAlert size={13} />}<span>{n.text}</span></p>)}
      <button type="button" className="link-btn" onClick={onDismiss}>{t('Dismiss')}</button>
    </div>
  )
}

function PhoneSiteCheck({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="phone-site">
      <label className="check"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{t('Also serve the phone site (HTTPS)')}</label>
      {value && <span className="setting-hint">{t('Sets up the HTTPS address on the bridge. Linking this Mac to it is still done in Settings › Remote access.')}</span>}
    </span>
  )
}

function PhoneTunnelNote({ machine: m }: { machine: Machine }) {
  if (m.bridgeSetup?.state !== 'ready' || m.bridgeSetup.step !== 'phone_tunnel_required') return null
  return (
    <p className="machine-note warn">
      <TriangleAlert size={13} />
      <span>{t('Caddy route is ready. Finish the Mac reverse tunnel in Remote access (docs/remote-access.md) to make the phone site reachable.')}</span>
    </p>
  )
}

function BridgeSteps({ machine: m }: { machine: Machine }) {
  const s = m.bridgeSetup
  if (s?.state === 'ready') return <PhoneTunnelNote machine={m} />
  if (!s || s.state === 'none') return null
  return (
    <div className={clsx('machine-note', s.state === 'failed' ? 'bad' : 'wait')}>
      {s.state === 'running' ? <Spinner size={12} /> : <TriangleAlert size={13} />}
      {s.state === 'running' ? t('Setting up: {step}', { step: s.step ?? '…' }) : machineErrorText(s.error, m)}
    </div>
  )
}

const access = (m: Machine): { id: MachineAccess; label: string; hint: string; unavailable?: string }[] => {
  const noSandbox = m.os === 'macos' || m.os === 'windows'
  return [
    { id: 'full', label: t('Full access'), hint: t('Agents sign in as {user} and can run any command, install software and change settings.', { user: m.user }) },
    {
      id: 'read-only', label: t('Read-only'),
      hint: t('Agents can read files and logs but not change anything. Enforced on the machine by a bubblewrap sandbox: needs Linux with bubblewrap installed, otherwise agents get no access at all.'),
      unavailable: noSandbox ? t('Read-only needs Linux with bubblewrap. It is not available on {os}.', { os: osName(m.os) }) : undefined
    },
    { id: 'projects', label: t('Selected projects'), hint: t('Only agents of the projects you tick are told about this machine. Advisory scope: agents sharing this Mac account can still access the key; this is not a security boundary.') }
  ]
}

function AccessEditor({ api, machine: m }: { api: MachinesApi; machine: Machine }) {
  const groups = useModel((model) => model.groups)
  const projects = useMemo(() => {
    const seen = new Map<string, string>()
    for (const g of groups) if (g.cwd && !seen.has(g.cwd)) seen.set(g.cwd, g.workspace.label || g.cwd.split('/').pop() || g.cwd)
    for (const p of m.permissions.projects) if (!seen.has(p)) seen.set(p, p.split('/').pop() || p)
    return [...seen]
  }, [groups, m.permissions.projects])
  const [error, setError] = useState('')
  // Switching to Selected projects needs a project first: pick locally, then save (the backend rejects an empty list).
  const [picking, setPicking] = useState<string[] | null>(null)
  const save = (permissions: Machine['permissions']) => { setError(''); return api.setPermissions(m.id, permissions).then(() => true, (e) => { setError(errorText(e)); return false }) }
  const mode = picking ? 'projects' : m.permissions.mode
  const chosen = picking ?? m.permissions.projects
  const modes = access(m)
  const current = modes.find((a) => a.id === mode)!
  const choose = (id: MachineAccess) => {
    if (id === 'projects') { if (m.permissions.mode !== 'projects') setPicking(m.permissions.projects); return }
    setPicking(null)
    void save({ mode: id, projects: [] })
  }
  const toggle = (cwd: string) => {
    const next = chosen.includes(cwd) ? chosen.filter((p) => p !== cwd) : [...chosen, cwd]
    if (picking) setPicking(next)
    else if (next.length) void save({ mode: 'projects', projects: next })
  }
  return (
    <div className="machine-section">
      <div className="machine-section-title">{t('What agents may do')}</div>
      <div className="segmented small" role="radiogroup" aria-label={t('What agents may do')}>
        {modes.map((a) => (
          <button key={a.id} type="button" role="radio" aria-checked={mode === a.id} className={clsx(mode === a.id && 'active')} disabled={!!a.unavailable && mode !== a.id} title={a.unavailable} onClick={() => choose(a.id)}>{a.label}</button>
        ))}
      </div>
      <p className={clsx('setting-hint', mode === 'projects' && 'machine-advisory')}>{current.hint}</p>
      {current.unavailable && <p className="machine-note bad"><TriangleAlert size={13} />{current.unavailable}</p>}
      {!current.unavailable && modes.find((a) => a.id === 'read-only')!.unavailable && mode !== 'read-only' && <p className="setting-hint">{modes.find((a) => a.id === 'read-only')!.unavailable}</p>}
      {suppliedAccount(m) && <SuppliedWarning name={m.name} />}
      {mode === 'projects' && (
        <div className="machine-projects">
          {!projects.length && <span className="setting-hint">{t('No projects open in herdr.')}</span>}
          {projects.map(([cwd, label]) => {
            const on = chosen.includes(cwd)
            const last = on && !picking && chosen.length === 1
            return (
              <button key={cwd} type="button" className={clsx('machine-project', on && 'on')} aria-pressed={on} disabled={last} title={last ? t('Keep at least one project, or choose another option above.') : cwd} onClick={() => toggle(cwd)}>
                {on && <Check size={12} />}{label}
              </button>
            )
          })}
        </div>
      )}
      {picking && (
        <div className="machine-actions">
          <span className="setting-hint">{picking.length ? tp({ one: '{n} project selected', other: '{n} projects selected' }, picking.length) : t('Pick at least one project.')}</span>
          <button type="button" className="btn btn-sm" onClick={() => setPicking(null)}>{t('Cancel')}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!picking.length} onClick={() => void save({ mode: 'projects', projects: picking }).then((ok) => { if (ok) setPicking(null) })}>{t('Save')}</button>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}

export function CopyCode({ text, block }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(id) }, [copied])
  return (
    <span className={clsx('copy-code', block && 'block')}>
      <code>{text}</code>
      <button type="button" className={clsx(block ? 'btn btn-sm' : 'icon-btn icon-btn-sm', copied && 'copied')} title={block ? undefined : t('Copy')} aria-label={t('Copy')} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => toast('error', t('Could not copy. Select the text and copy it manually.')))}>
        {copied ? <Check size={12} /> : <Copy size={12} />}{block && (copied ? t('Copied') : t('Copy'))}
      </button>
    </span>
  )
}

function SshIncludeBlock({ api, state }: { api: MachinesApi; state: MachinesState }) {
  const [confirm, setConfirm] = useState(false)
  const { busy, error, run } = useAction()
  const inc = state.sshInclude
  return (
    <div className="setting-block machines-block">
      <div className="setting-block-head big"><span>{t('Use the machines from your own Terminal')}</span></div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">{inc.installed ? t('ssh <name> works in your Terminal') : t('Only agents can use ssh <name>')}</div>
          <div className="setting-hint">{inc.installed ? t('{path} includes the Drover machines file.', { path: inc.configPath }) : t('Agents already have it. Add one line to {path} to use the same names yourself.', { path: inc.configPath })}</div>
        </div>
        <div className="setting-control">
          {inc.installed ? <span className="conn-text ok"><Check size={13} /> {t('Added')}</span> : !confirm && <button type="button" className="btn btn-sm" onClick={() => setConfirm(true)}>{t('Add line…')}</button>}
        </div>
      </div>
      {confirm && !inc.installed && (
        <div className="machine-confirm">
          <p>{t('Drover will add this line at the top of {path} and keep a backup next to it. Nothing else in the file changes.', { path: inc.configPath })}</p>
          <pre className="machine-pre">{inc.line}</pre>
          <div className="machine-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void run('include', async () => { await api.addSshInclude(); setConfirm(false) })}>{busy && <Spinner size={12} />}{t('Add the line')}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}

function AgentsKeyBlock({ api, state, onNotes }: { api: MachinesApi; state: MachinesState; onNotes: (notes: CleanupNote[]) => void }) {
  const [confirm, setConfirm] = useState(false)
  const { busy, error, run } = useAction()
  const key = state.agentsKey
  return (
    <div className="setting-block machines-block">
      <div className="setting-block-head big"><span>{t('Agents key')}</span></div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label machine-key"><KeyRound size={13} />{key ? <code>{key.fingerprint}</code> : t('Not created yet')}</div>
          <div className="setting-hint">{key ? t('Created {date}. Used only by agents, separate from your own SSH keys.', { date: new Date(key.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('Drover creates it when you add the first machine.')}</div>
        </div>
        {key && !confirm && (
          <div className="setting-control machine-key-actions">
            <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(key.publicKey).then(() => toast('success', t('Public key copied')))}><Copy size={12} />{t('Copy public key')}</button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirm(true)}>{t('Revoke…')}</button>
          </div>
        )}
      </div>
      {confirm && key && (
        <div className="machine-confirm danger">
          <p>{t('Revoke the agents key? The old key stops working for new connections, and Drover ends the agent sessions it can. Drover makes a new key and puts it on the machines it can still reach; the rest need their setup again.')}</p>
          {state.machines.some(suppliedAccount) && <p className="machine-note warn"><TriangleAlert size={13} /><span>{t('Some machines use an account you supplied ({names}). Drover will not end their open sessions: those may keep their access until they end.', { names: state.machines.filter(suppliedAccount).map((m) => m.name).join(', ') })}</span></p>}
          <div className="machine-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void run('revoke', async () => {
              const reports = await api.revokeAgentsKey({ confirmed: true })
              setConfirm(false)
              toast('success', t('Agents key replaced'))
              onNotes(reports.map((r) => cleanupNote(r, r.name, state.machines.find((m) => m.id === r.machineId)?.sessionCleanup?.account === 'supplied')))
            })}>{busy && <Spinner size={12} />}{t('Revoke and replace')}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  )
}
