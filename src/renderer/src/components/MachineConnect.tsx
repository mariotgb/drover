// One-click connect: a trusted machine connects without the wizard; the wizard opens only when the
// server key needs confirming or the existing SSH login does not work. Every run starts from a user click.
import { useCallback, useEffect, useState } from 'react'
import { Check, Plug } from 'lucide-react'
import type { MachineConnectProgress, MachineConnectResult } from '@shared/machines'
import { errorText } from '../api'
import { t } from '../i18n'
import { machineErrorText, type Machine, type MachinesApi } from '../machines'
import { Spinner } from './primitives'

export type ConnectPhase = MachineConnectProgress['phase'] | 'queued'
export interface ConnectRun { phase: ConnectPhase; result?: MachineConnectResult; error?: string }
/** Where the wizard should start when a run needs the user: the server key, or the sign-in key. */
export type WizardStart = { machineId: string; step: 1 | 2 }

type OneClickApi = Omit<MachinesApi, 'connectTrusted' | 'connectAll' | 'onConnectProgress'> & Partial<Pick<MachinesApi, 'connectTrusted' | 'connectAll' | 'onConnectProgress'>>
/** An older or partial machines API (no one-click methods) keeps working: Connect then opens the wizard. */
export function useMachineConnect(api: OneClickApi, onWizard: (start: WizardStart) => void) {
  const [runs, setRuns] = useState<Record<string, ConnectRun>>({})
  const [batch, setBatch] = useState<string[] | null>(null)
  const set = (id: string, run: ConnectRun | null) => setRuns((all) => { const next = { ...all }; if (run) next[id] = run; else delete next[id]; return next })
  useEffect(() => api.onConnectProgress?.((p) => setRuns((all) => all[p.machineId] ? { ...all, [p.machineId]: { ...all[p.machineId], phase: p.phase } } : all)) ?? undefined, [api])
  const settle = useCallback((r: MachineConnectResult) => {
    // A connected machine shows a short "connected" mark; its card then reads like any other.
    if (r.state === 'connected') { set(r.machineId, { phase: 'done', result: r }); setTimeout(() => set(r.machineId, null), 4000) }
    else set(r.machineId, { phase: r.state === 'failed' ? 'failed' : 'done', result: r })
  }, [])
  const connect = useCallback(async (id: string) => {
    if (!api.connectTrusted) { onWizard({ machineId: id, step: 1 }); return }
    set(id, { phase: 'host_key' })
    try {
      const r = await api.connectTrusted(id, { confirmed: true })
      settle(r)
      // A single click goes on to the step that needs the user.
      if (r.state === 'host_key_confirmation' || r.state === 'login_required') { set(id, null); onWizard({ machineId: id, step: r.state === 'login_required' ? 2 : 1 }) }
    } catch (e) { set(id, { phase: 'failed', error: errorText(e) }) }
  }, [api, settle, onWizard])
  const connectAll = useCallback(async (ids: string[]) => {
    if (!api.connectAll) return
    setBatch(ids)
    setRuns((all) => ({ ...all, ...Object.fromEntries(ids.map((id) => [id, { phase: 'queued' as const }])) }))
    try { (await api.connectAll({ confirmed: true, machineIds: ids })).forEach(settle) }
    catch (e) { const message = errorText(e); setRuns((all) => Object.fromEntries(Object.entries(all).map(([id, run]) => [id, run.phase === 'done' || run.phase === 'failed' ? run : { phase: 'failed', error: message }]))) }
    finally { setBatch(null) }
  }, [api, settle])
  return { runs, batch, connect, connectAll, canConnectAll: !!api.connectAll }
}

const phaseText = (phase: ConnectPhase) => phase === 'queued' ? t('Waiting in line…') : phase === 'host_key' ? t('Checking the server key…') : phase === 'login' ? t('Signing in…') : phase === 'install' ? t('Installing the agents key…') : t('Checking that it works…')

/** Card line for a run: progress, connected, the step that needs the user, or the real error with a retry. */
export function ConnectRunLine({ machine: m, run, onRetry, onWizard }: { machine: Machine; run: ConnectRun; onRetry: () => void; onWizard: (step: 1 | 2) => void }) {
  const r = run.result
  if (r?.state === 'connected') return <span className="machine-run ok" role="status"><Check size={12} strokeWidth={3} />{t('Connected')}</span>
  if (r?.state === 'host_key_confirmation') return <span className="machine-run warn">{t('Confirm the server key of {name} to connect it.', { name: m.name })} <button type="button" className="link-btn" onClick={() => onWizard(1)}>{t('Confirm…')}</button></span>
  if (r?.state === 'login_required') return <span className="machine-run warn">{t('Your usual SSH login did not work here. Choose the key to sign in with.')} <button type="button" className="link-btn" onClick={() => onWizard(2)}>{t('Choose key…')}</button></span>
  if (run.phase === 'failed' || r?.state === 'failed') return <span className="machine-run bad" role="alert">{run.error || machineErrorText(r?.error, m) || t('Could not connect.')} <button type="button" className="link-btn" onClick={onRetry}>{t('Try again')}</button></span>
  return <span className="machine-run" role="status">{run.phase === 'queued' ? null : <Spinner size={11} />}{phaseText(run.phase)}</span>
}

/** Above the list: one explicit click connects every machine that is listed but not connected yet. */
export function ConnectAllBar({ pending, runs, batch, onConnectAll }: { pending: Machine[]; runs: Record<string, ConnectRun>; batch: string[] | null; onConnectAll: () => void }) {
  if (pending.length < 2 && !batch) return null
  const total = batch?.length ?? pending.length
  const done = (batch ?? []).filter((id) => runs[id]?.result || runs[id]?.phase === 'done' || runs[id]?.phase === 'failed').length
  return (
    <div className="machines-connect-all">
      <Plug size={15} />
      <span>{batch ? t('Connecting {done} of {n}…', { done: Math.min(done + 1, total), n: total }) : t('{n} machines are not connected yet. Drover can connect them one after another, using the SSH login you already have.', { n: pending.length })}</span>
      <button type="button" className="btn btn-sm btn-primary" disabled={!!batch} onClick={onConnectAll}>{batch ? <Spinner size={12} /> : null}{t('Connect all')}</button>
    </div>
  )
}
