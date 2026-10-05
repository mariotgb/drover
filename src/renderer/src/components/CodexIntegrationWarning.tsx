import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { AlertTriangle, CircleHelp } from 'lucide-react'
import type { CodexIntegrationStatus, CodexDaemonRestartPlan } from '@shared/codexIntegration'
import { api, isRemote } from '../api'
import { t } from '../i18n'
import { useStore } from '../store'
import { statusLabel } from '../model'
import { Modal } from './Modal'
import '../styles/codex-integration.css'
import { codexWarningKey } from '../codex-warning'

const useIntegration = create<{
  status: CodexIntegrationStatus | null
  busy: boolean
  dismissed: string | null
  result: { operation: 'integration' | 'daemon'; outcome: 'ok' | 'warning' | 'error'; detail: string } | null
}>(() => ({ status: null, busy: false, result: null, dismissed: null }))
let checking: Promise<void> | null = null
function refreshStatus() {
  if (isRemote || useStore.getState().platform !== 'darwin' || checking || useIntegration.getState().busy) return
  checking = api.codexIntegrationStatus().then(status => {
    useIntegration.setState(state => ({ status, dismissed: status.status === 'unavailable' || state.dismissed === codexWarningKey(status) ? state.dismissed : null }))
  })
    .catch(() => { /* An unavailable check must not claim the integration is broken. */ })
    .finally(() => { checking = null })
}

async function installIntegration() {
  if (isRemote || useStore.getState().platform !== 'darwin' || useIntegration.getState().busy) return
  useIntegration.setState({ busy: true, result: null })
  try {
    // Wait out a previous status read so it cannot overwrite the install result.
    await checking
    const result = await api.codexIntegrationInstall()
    useIntegration.setState({ status: result.status, result: {
      operation: 'integration',
      outcome: result.code !== 0 ? 'error' : result.status.status === 'ok' ? 'ok' : 'warning',
      detail: [result.stdout, result.stderr, result.status.message].filter(Boolean).join('\n').trim()
    } })
  } catch {
    useIntegration.setState({ result: { operation: 'integration', outcome: 'error', detail: t('Could not reinstall Codex integration. Check the herdr connection and try again.') } })
  } finally { useIntegration.setState({ busy: false }) }
}

/** Local preload only. Mounting/focus checks status; installation requires a click. */
export function CodexIntegrationWarning() {
  const { status, busy, result, dismissed } = useIntegration()
  const [plan, setPlan] = useState<CodexDaemonRestartPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planExpired, setPlanExpired] = useState(false)
  const planRequest = useRef(0)
  const closePlan = () => {
    if (busy) return
    planRequest.current++
    setPlan(null); setPlanError(null); setPlanLoading(false)
  }
  useEffect(() => () => { planRequest.current++ }, [])
  const connectionStatus = useStore(s => s.connection.status)
  const session = useStore(s => s.connection.session)
  const platform = useStore(s => s.platform)
  useEffect(() => {
    if (isRemote || platform !== 'darwin') return
    refreshStatus()
    const timer = window.setInterval(refreshStatus, 15000)
    window.addEventListener('focus', refreshStatus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshStatus) }
  }, [connectionStatus, session, platform])
  useEffect(() => {
    if (!plan) return
    setPlanExpired(Date.now() >= plan.expiresAt)
    const timer = window.setTimeout(() => setPlanExpired(true), Math.max(0, plan.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [plan])
  const loadPlan = async () => {
    if (isRemote || platform !== 'darwin' || busy || planLoading) return
    const request = ++planRequest.current
    setPlanLoading(true); setPlanError(null)
    try {
      const next = await api.codexDaemonRestartPlan()
      if (request === planRequest.current) setPlan(next)
    } catch {
      if (request === planRequest.current) setPlanError(t('Could not load the Codex agent list. Check the herdr connection and try again.'))
    } finally { if (request === planRequest.current) setPlanLoading(false) }
  }
  const restart = async () => {
    if (isRemote || platform !== 'darwin' || !plan?.canRestart || busy || planLoading) return
    if (Date.now() >= plan.expiresAt) { setPlanExpired(true); return }
    useIntegration.setState({ busy: true, result: null }); setPlanError(null)
    try {
      await checking
      // A second, explicit click confirms this plan; the backend revalidates it.
      const result = await api.codexDaemonRestart(plan.token)
      if (result.outcome === 'plan_changed') {
        setPlan(result.plan); setPlanExpired(false)
        setPlanError(t('The Codex agent list changed — review it and confirm again.'))
        return
      }
      useIntegration.setState({ status: result.status, result: {
        operation: 'daemon', outcome: result.code !== 0 ? 'error' : result.status.status === 'ok' ? 'ok' : 'warning',
        detail: [result.stdout, result.stderr, result.status.message].filter(Boolean).join('\n').trim()
      } })
      setPlan(null)
    } catch {
      setPlanError(t('Could not restart the Codex service. Refresh the agent list and try again.')); setPlanExpired(true)
    } finally { useIntegration.setState({ busy: false }) }
  }
  const warningVisible = status?.status === 'warning' && dismissed !== codexWarningKey(status)
  if (isRemote || platform !== 'darwin' || (!warningVisible && !result && !busy && !plan)) return null
  const resultLabel = result?.operation === 'daemon'
    ? result.outcome === 'ok' ? t('Codex service restarted') : result.outcome === 'warning' ? t('Codex service restarted, but the warning remains.') : t('Could not restart the Codex service')
    : result?.outcome === 'ok' ? t('Codex integration reinstalled') : result?.outcome === 'warning' ? t('Codex integration reinstalled, but the warning remains.') : t('Could not reinstall Codex integration')
  return <><div className="codex-integration-warning" role="status">
    {warningVisible && <>
      <p><AlertTriangle size={15} aria-hidden="true" />{t('Codex agents will not be restored after restarting herdr.')}</p>
      <p className="codex-integration-explanation">{t('The shared Codex service may retain stale HERDR_* variables from another pane.')} <button type="button" className="codex-issue-link" title="herdrdev/herdr#4649" aria-label={t('Known herdr issue')} onClick={() => void api.openExternal('https://github.com/herdrdev/herdr/issues/4649')}><CircleHelp size={14} /></button></p>
    </>}
    {warningVisible && <div className="codex-repair-actions">
      <button type="button" className="btn btn-sm btn-primary" disabled={busy || planLoading} onClick={() => void loadPlan()}>{planLoading ? t('Checking Codex agents…') : t('Restart Codex service')}</button>
      <button type="button" className="btn btn-sm" disabled={busy || planLoading} onClick={() => void installIntegration()}>{t('Reinstall Codex integration')}</button>
      <button type="button" className="btn btn-sm" disabled={busy || planLoading} onClick={() => useIntegration.setState({ dismissed: codexWarningKey(status), result: null })}>{t('Dismiss')}</button>
    </div>}
    {busy && <p>{t('Applying Codex repair…')}</p>}
    {planError && !plan && <p className="form-error">{planError}</p>}
    {result && <div className="codex-integration-result">
      <strong>{resultLabel}</strong>
      {result.outcome === 'warning' && <p>{t('If session reports still fail, check the Codex daemon’s per-pane herdr environment.')}</p>}
      {result.detail && <details><summary>{t('Details')}</summary><pre>{result.detail}</pre></details>}
      <button type="button" className="btn btn-sm" onClick={() => useIntegration.setState({ result: null })}>{t('Dismiss')}</button>
    </div>}
  </div>
  {plan && createPortal(<Modal title={t('Restart Codex service')} onClose={closePlan} width={520}>
    <div className="form codex-daemon-plan">
      <p>{t('Review the Codex agents that may be affected before restarting the shared service.')}</p>
      {plan.busy && <p className="codex-plan-caution">{t('Some Codex agents are working, waiting for input, or have an unknown status. Wait for them to finish before restarting.')}</p>}
      {plan.otherClientsMayBeAffected && <p className="codex-plan-caution">{t('Codex clients in other terminals or IDEs may also be affected.')}</p>}
      {plan.agents.length ? <ul className="codex-daemon-agents">{plan.agents.map(agent => <li key={`${agent.session}:${agent.paneId}`}>
        <strong>{agent.name}</strong><span>{agent.session} · {agent.paneId} · {statusLabel(agent.status) || t('Unknown status')}</span>
        {!agent.hasSession && <span className="form-error">{t('Session not saved')}</span>}
      </li>)}</ul> : <p>{t('No Codex agents found in running herdr sessions.')}</p>}
      {!plan.canRestart && <p className="form-error">{t(plan.reason || 'Codex service restart is unavailable.')}</p>}
      {planExpired && <p role="status">{t('The agent list changed or expired. Refresh it before restarting.')}</p>}
      {planError && <p className="form-error" role="alert">{planError}</p>}
      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={closePlan}>{plan.busy ? t('Wait for agents') : t('Cancel')}</button>
        <button type="button" className="btn" disabled={busy || planLoading} onClick={() => void loadPlan()}>{t('Refresh agent list')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || planLoading || planExpired || !plan.canRestart} onClick={() => void restart()}>{busy ? t('Restarting Codex service…') : plan.busy ? t('Restart anyway') : t('Confirm restart')}</button>
      </div>
    </div>
  </Modal>, document.body)}
  </>
}
