import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check, Crown, TriangleAlert, X } from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import { choiceFor, modelArgs, type ModelChoice } from '@shared/models'
import type { RoleTemplate } from '@shared/types'
import { api, humanizeError } from '../api'
import { t, tp } from '../i18n'
import { basename } from '../model'
import { effectiveRole, firstMessage, rolesFor, starterRoles } from '../roles'
import { getModel, select, toast, useModel, useStore } from '../store'
import { splitArgs } from '../util'
import { Modal } from './Modal'
import { ModelFields } from './ModelPicker'
import { AgentAvatar, Spinner, StatusDot } from './primitives'

type RowState = 'idle' | 'starting' | 'ready' | 'attention' | 'error' | 'running'

interface Row {
  role: RoleTemplate
  checked: boolean
  kind: string
  model: ModelChoice
  state: RowState
  error?: string
  paneId?: string
}

export function TeamDialog({ workspaceId }: { workspaceId: string }) {
  useModel()
  const kinds = useStore((s) => s.kinds)
  const group = getModel().groups.find((g) => g.workspace.workspace_id === workspaceId) ?? null
  const cwd = group?.cwd ?? null
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const close = () => useStore.setState({ dialog: null })

  useEffect(() => {
    let alive = true
    void rolesFor(cwd).then(({ project, custom }) => {
      if (!alive) return
      const all = [...project, ...custom.filter((c) => !project.some((p) => p.name === c.name))]
      if (!all.some((r) => r.orchestrator)) all.unshift(starterRoles()[0])
      const live = new Set(group?.threads.map((th) => th.agent?.name).filter(Boolean) as string[])
      const sorted = [...all].sort((a, b) => Number(!!b.orchestrator) - Number(!!a.orchestrator))
      setRows(
        sorted.map((r) => {
          const eff = effectiveRole(r, cwd)
          const running = live.has(eff.name)
          const s = useStore.getState().settings
          const model = eff.model !== undefined || eff.effort !== undefined ? { model: eff.model || null, effort: eff.effort || null } : s.agentModels[eff.kind] ?? {}
          return { role: eff, checked: !running, kind: eff.kind, model, state: running ? 'running' : 'idle' }
        })
      )
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => (rs ? rs.map((r, j) => (j === i ? { ...r, ...p } : r)) : rs))
  const chosen = (rows ?? []).filter((r) => r.checked && r.state !== 'running')

  const start = async () => {
    if (!rows || !chosen.length) return
    setBusy(true)
    const order = [...rows.keys()].filter((i) => rows[i].checked && rows[i].state !== 'running')
    const members = order.filter((i) => !rows[i].role.orchestrator)
    const leads = order.filter((i) => rows[i].role.orchestrator)
    const team: { name: string; kind: string; label: string }[] = []
    // Existing agents of this project are part of the team too.
    for (const th of group?.threads ?? []) {
      if (th.agent?.name && th.kind) team.push({ name: th.agent.name, kind: th.kind, label: th.name })
    }
    let firstPane: string | null = null
    for (const i of [...members, ...leads]) {
      const r = rows[i]
      patch(i, { state: 'starting', error: undefined })
      const role = { ...r.role, kind: r.kind }
      const res = await api.createAgent({
        workspaceId,
        folder: null,
        kind: r.kind,
        name: role.name,
        placement: 'tab',
        tabLabel: role.label,
        args: [...modelArgs(r.kind, choiceFor(r.kind, r.model, useStore.getState().models)), ...splitArgs(role.args)],
        prompt: firstMessage(role, role.orchestrator ? { team } : {})
      })
      if (res.ok && res.paneId) {
        patch(i, { state: res.needsAttention ? 'attention' : 'ready', paneId: res.paneId, error: res.needsAttention ? res.error : undefined })
        if (!role.orchestrator) team.push({ name: role.name, kind: r.kind, label: role.label })
        if (!firstPane || role.orchestrator) firstPane = res.paneId
      } else {
        patch(i, { state: 'error', error: humanizeError(res.code, res.error) })
      }
    }
    setBusy(false)
    setDone(true)
    if (firstPane) select(firstPane)
  }

  const installed = kinds.filter((k) => k.installed)

  return (
    <Modal title={t('Start a team in {project}', { project: group?.workspace.label || basename(cwd) })} onClose={close} width={780}>
      <div className="form">
        <p className="setting-hint block">
          {t('Each agent opens in its own tab and immediately gets its role instructions. The orchestrator starts last and is told who is on the team and how to give them work.')}
        </p>
        {!rows && <Spinner />}
        {rows && (
          <div className="team-rows">
            {rows.map((r, i) => (
              <div key={r.role.id} className={clsx('team-row', r.state === 'running' && 'muted')}>
                <input
                  type="checkbox"
                  checked={r.checked && r.state !== 'running'}
                  disabled={busy || done || r.state === 'running'}
                  onChange={(e) => patch(i, { checked: e.target.checked })}
                />
                <AgentAvatar kind={r.kind} size={22} />
                <div className="team-role">
                  <div className="team-role-name">
                    {r.role.orchestrator && <Crown size={12} className="crown" />}
                    {r.role.label}
                    <span className="team-role-agent">{r.role.name}</span>
                  </div>
                  <div className="team-role-sub">{r.role.file ?? (r.role.instructions.slice(0, 90) || t('Default instructions'))}</div>
                </div>
                <div className="team-agent">
                  <select
                    className="input select"
                    value={r.kind}
                    disabled={busy || done || r.state === 'running'}
                    onChange={(e) => patch(i, { kind: e.target.value, model: useStore.getState().settings.agentModels[e.target.value] ?? {} })}
                  >
                    {(installed.length ? installed : kinds).map((k) => (
                      <option key={k.kind} value={k.kind}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <ModelFields compact kind={r.kind} value={r.model} disabled={busy || done || r.state === 'running'} onChange={(v) => patch(i, { model: v })} />
                </div>
                <span className="team-state" title={r.error}>
                  {r.state === 'running' && <span className="dim">{t('running')}</span>}
                  {r.state === 'starting' && <Spinner size={13} />}
                  {r.state === 'ready' && <Check size={15} className="ok" />}
                  {r.state === 'attention' && <TriangleAlert size={15} className="warn" />}
                  {r.state === 'error' && <X size={15} className="err" />}
                </span>
              </div>
            ))}
          </div>
        )}
        {rows?.some((r) => r.state === 'attention') && (
          <div className="field-hint warn">{t('Some agents ask something on startup (for example folder trust). Open them and answer in the terminal panel.')}</div>
        )}
        {rows?.some((r) => r.state === 'error') && (
          <div className="form-error">{rows.filter((r) => r.error && r.state === 'error').map((r) => `${r.role.label}: ${r.error}`).join('\n')}</div>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={close}>
            {done ? t('Close') : t('Cancel')}
          </button>
          {!done && (
            <button type="button" className="btn btn-primary" disabled={busy || !chosen.length} onClick={() => void start()}>
              {busy && <Spinner size={13} />}
              {busy ? t('Starting…') : tp({ one: 'Start {n} agent', other: 'Start {n} agents' }, chosen.length)}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function BroadcastDialog({ workspaceId }: { workspaceId: string }) {
  useModel()
  const group = getModel().groups.find((g) => g.workspace.workspace_id === workspaceId) ?? null
  const agents = useMemo(() => (group?.threads ?? []).filter((th) => th.kind), [group])
  const [checked, setChecked] = useState<Set<string>>(() => new Set(agents.filter((a) => a.status !== 'blocked').map((a) => a.paneId)))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => useStore.setState({ dialog: null })

  const send = async () => {
    const targets = agents.filter((a) => checked.has(a.paneId))
    if (!text.trim() || !targets.length) return
    setBusy(true)
    const results = await Promise.all(
      targets.map((a) =>
        api.sendPrompt({ paneId: a.paneId, target: a.paneId, agentKind: a.kind, text: text.trim(), imagePaths: [], isShell: false })
      )
    )
    setBusy(false)
    const failed = results.map((r, i) => (r.ok ? null : `${targets[i].name}: ${humanizeError(r.code, r.error)}`)).filter(Boolean)
    if (failed.length) toast('error', failed.join('\n'))
    else toast('success', tp({ one: 'Sent to {n} agent', other: 'Sent to {n} agents' }, targets.length))
    if (!failed.length) close()
  }

  return (
    <Modal title={t('Message several agents')} onClose={close} width={560}>
      <div className="form">
        <div className="team-rows compact">
          {agents.map((a) => (
            <label key={a.paneId} className="team-row">
              <input
                type="checkbox"
                checked={checked.has(a.paneId)}
                onChange={(e) => {
                  const next = new Set(checked)
                  if (e.target.checked) next.add(a.paneId)
                  else next.delete(a.paneId)
                  setChecked(next)
                }}
              />
              <AgentAvatar kind={a.kind} size={20} />
              <div className="team-role">
                <div className="team-role-name">{a.name}</div>
                <div className="team-role-sub">{agentKindDef(a.kind)?.label}</div>
              </div>
              {a.status !== 'idle' && a.status !== 'unknown' && <StatusDot status={a.status} size={7} />}
            </label>
          ))}
          {!agents.length && <div className="hint">{t('No agents in this project yet.')}</div>}
        </div>
        <textarea
          className="input"
          rows={4}
          autoFocus
          value={text}
          placeholder={t('For example: pull the latest main and rebase your work')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
        />
        <div className="form-actions">
          <button type="button" className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim() || !checked.size} onClick={() => void send()}>
            {busy && <Spinner size={13} />} {tp({ one: 'Send to {n} agent', other: 'Send to {n} agents' }, checked.size)}
          </button>
        </div>
      </div>
    </Modal>
  )
}
