import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, FolderOpen, GitBranch, Settings2, SquareTerminal, Users } from 'lucide-react'
import { AGENT_NAME_RE, agentKindDef, toAgentName } from '@shared/agents'
import { choiceFor, modelArgs, supportsModels, type ModelChoice } from '@shared/models'
import type { NewAgentRequest, RoleTemplate } from '@shared/types'
import { api, humanizeError } from '../api'
import { openSettings } from '../actions'
import { t } from '../i18n'
import { basename, shortPath } from '../model'
import { defaultInstructions, effectiveRole, firstMessage, rememberRole, rolesFor } from '../roles'
import { getModel, select, setViewMode, toast, toggleDrawer, updateSettings, useModel, useStore, type DialogState } from '../store'
import { splitArgs } from '../util'
import { Modal } from './Modal'
import { ModelFields } from './ModelPicker'
import { AgentAvatar, Spinner } from './primitives'

type Preset = Extract<DialogState, { type: 'new-agent' }>

export function NewAgentDialog({ preset }: { preset: Preset }) {
  const { groups } = useModel()
  const kinds = useStore((s) => s.kinds)
  const settings = useStore((s) => s.settings)
  const home = useStore((s) => s.home)
  const selectedPaneId = useStore((s) => s.selectedPaneId)
  const existingPane = preset.paneId ? getModel().byPane.get(preset.paneId) ?? null : null

  const initialWs =
    preset.workspaceId !== undefined
      ? preset.workspaceId
      : (selectedPaneId && getModel().byPane.get(selectedPaneId)?.workspaceId) || groups[0]?.workspace.workspace_id || null
  const [workspaceId, setWorkspaceId] = useState<string | null>(existingPane ? existingPane.workspaceId : initialWs)
  const [folder, setFolder] = useState<string | null>(preset.folder ?? null)
  const [kind, setKind] = useState<string | null>(preset.kind === undefined ? settings.defaultAgentKind : preset.kind)
  const [name, setName] = useState('')
  const [placement, setPlacement] = useState<NewAgentRequest['placement']>(existingPane ? 'existing' : 'tab')
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [args, setArgs] = useState(() => (kind ? settings.agentArgs[kind] ?? '' : ''))
  const [modelChoice, setModelChoice] = useState<ModelChoice>(() => (kind ? settings.agentModels[kind] ?? {} : {}))
  const catalog = useStore((s) => s.models)
  const [prompt, setPrompt] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roles, setRoles] = useState<{ project: RoleTemplate[]; custom: RoleTemplate[] }>({ project: [], custom: [] })
  const [role, setRole] = useState<RoleTemplate | null>(null)
  const pickedOnce = useRef(false)

  const close = () => useStore.setState({ dialog: null })
  const group = groups.find((g) => g.workspace.workspace_id === workspaceId) ?? null
  const projectCwd = group?.cwd ?? folder ?? null

  const pickFolder = async () => {
    const p = await api.pickFolder(folder ?? group?.cwd ?? undefined)
    if (p) {
      setFolder(p)
      setWorkspaceId(null)
    }
  }

  useEffect(() => {
    if (preset.pickFolder && !pickedOnce.current) {
      pickedOnce.current = true
      void pickFolder()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Roles of the chosen project (its .ai/roles files) plus the user's own.
  useEffect(() => {
    let alive = true
    setRole(null)
    void rolesFor(projectCwd).then((r) => alive && setRoles(r))
    return () => {
      alive = false
    }
  }, [projectCwd])

  useEffect(() => {
    if (role) return
    setArgs(kind ? settings.agentArgs[kind] ?? '' : '')
    setModelChoice(kind ? settings.agentModels[kind] ?? {} : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const applyRole = (r: RoleTemplate | null) => {
    setRole(r)
    if (!r) {
      setName('')
      setPrompt('')
      return
    }
    const eff = effectiveRole(r, projectCwd)
    setKind(eff.kind)
    setName(eff.name)
    setArgs(eff.args)
    setModelChoice(eff.model !== undefined || eff.effort !== undefined ? { model: eff.model || null, effort: eff.effort || null } : settings.agentModels[eff.kind] ?? {})
    setPrompt(eff.instructions.trim() || defaultInstructions(eff))
  }

  const installed = kinds.filter((k) => k.installed)
  const others = kinds.filter((k) => !k.installed)
  const splitTarget = selectedPaneId && getModel().byPane.get(selectedPaneId)?.workspaceId === workspaceId ? selectedPaneId : null
  const nameValid = !name || AGENT_NAME_RE.test(name)
  const allRoles = [...roles.project, ...roles.custom]

  const submit = async () => {
    if (!workspaceId && !folder) {
      setError(t('Choose a project or a folder'))
      return
    }
    if (!nameValid) {
      setError(t('Invalid name. Try “{name}”', { name: toAgentName(name) }))
      return
    }
    setBusy(true)
    setError(null)
    const patch: Parameters<typeof updateSettings>[0] = {}
    const choice = choiceFor(kind, modelChoice, catalog)
    if (kind) {
      patch.defaultAgentKind = kind
      if (!role) {
        patch.agentArgs = { ...settings.agentArgs, [kind]: args }
        if (supportsModels(kind)) patch.agentModels = { ...settings.agentModels, [kind]: choice }
      }
    }
    let message = prompt.trim()
    if (role && kind) {
      Object.assign(
        patch,
        rememberRole(projectCwd, role, {
          kind,
          args,
          instructions: message === defaultInstructions(effectiveRole(role, projectCwd)) ? '' : message,
          model: choice.model ?? '',
          effort: choice.effort ?? ''
        })
      )
      message = firstMessage({ ...role, instructions: message })
    }
    void updateSettings(patch)
    const req: NewAgentRequest = {
      workspaceId,
      folder: workspaceId ? null : folder,
      workspaceLabel: folder ? basename(folder) : undefined,
      kind,
      name: name || null,
      placement: placement === 'existing' ? 'existing' : workspaceId ? placement : 'workspace-root',
      splitTarget: placement === 'existing' ? preset.paneId ?? null : splitTarget,
      tabLabel: role?.label || name || null,
      args: [...modelArgs(kind, choice), ...splitArgs(args)],
      prompt: message || undefined,
      worktreeBranch: useWorktree && workspaceId && branch.trim() ? branch.trim() : null
    }
    if (role?.orchestrator && projectCwd) await api.ensureBoard(projectCwd).catch(() => undefined)
    const res = await api.createAgent(req)
    setBusy(false)
    if (!res.ok || !res.paneId) {
      setError(humanizeError(res.code, res.error))
      return
    }
    close()
    if (!kind) setViewMode(res.paneId, 'terminal')
    select(res.paneId)
    if (res.needsAttention) {
      toggleDrawer(res.paneId, true)
      toast('info', res.error ? humanizeError(res.code, res.error) : t('The agent is asking something on startup — answer it in the terminal panel.'))
    }
  }

  return (
    <Modal title={existingPane ? t('Start agent in this terminal') : t('New agent')} onClose={close} width={640}>
      <div className="form">
        {!existingPane && (
          <div className="field">
            <label>{t('Project')}</label>
            <div className="project-picker">
              {groups.map((g) => (
                <button
                  key={g.workspace.workspace_id}
                  type="button"
                  className={clsx('project-opt', workspaceId === g.workspace.workspace_id && 'active')}
                  onClick={() => {
                    setWorkspaceId(g.workspace.workspace_id)
                    setFolder(null)
                  }}
                  title={g.cwd ?? ''}
                >
                  <span className="project-name">{g.workspace.label}</span>
                  <span className="project-path">{shortPath(g.cwd, home)}</span>
                </button>
              ))}
              {folder && !workspaceId && (
                <button type="button" className="project-opt active" title={folder}>
                  <span className="project-name">{basename(folder)}</span>
                  <span className="project-path">
                    {shortPath(folder, home)} · {t('new project')}
                  </span>
                </button>
              )}
              <button type="button" className="project-opt add" onClick={() => void pickFolder()}>
                <FolderOpen size={15} />
                <span className="project-name">{t('Open folder…')}</span>
              </button>
            </div>
            {!workspaceId && settings.recentFolders.length > 0 && (
              <div className="recent">
                {settings.recentFolders
                  .filter((f) => f !== folder && !groups.some((g) => g.cwd === f))
                  .slice(0, 5)
                  .map((f) => (
                    <button key={f} type="button" className="recent-chip" onClick={() => setFolder(f)} title={f}>
                      {basename(f)}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}

        {allRoles.length > 0 && (
          <div className="field">
            <label className="label-row">
              <span>{t('Role')}</span>
              <span className="label-actions">
                {workspaceId && !existingPane && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => useStore.setState({ dialog: { type: 'team', workspaceId } })}
                  >
                    <Users size={12} /> {t('Start a whole team…')}
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => openSettings('roles')}>
                  <Settings2 size={12} /> {t('Manage roles')}
                </button>
              </span>
            </label>
            <div className="role-chips">
              <button type="button" className={clsx('role-chip', !role && 'active')} onClick={() => applyRole(null)}>
                {t('No role')}
              </button>
              {allRoles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={clsx('role-chip', role?.id === r.id && 'active')}
                  title={r.file ?? r.instructions}
                  onClick={() => applyRole(r)}
                >
                  {r.label}
                  {r.source === 'project' && <span className="role-chip-src">{t('project')}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>{t('Agent')}</label>
          <div className="kind-grid">
            {installed.map((k) => (
              <button key={k.kind} type="button" className={clsx('kind-opt', kind === k.kind && 'active')} onClick={() => setKind(k.kind)}>
                <AgentAvatar kind={k.kind} size={24} />
                <span>{k.label}</span>
              </button>
            ))}
            {!existingPane && !role && (
              <button type="button" className={clsx('kind-opt', kind === null && 'active')} onClick={() => setKind(null)}>
                <AgentAvatar kind={null} size={24} />
                <span>{t('Terminal only')}</span>
              </button>
            )}
          </div>
          {others.length > 0 && (
            <button type="button" className="disclosure" onClick={() => setShowMore(!showMore)}>
              <ChevronDown size={13} className={clsx('chev', showMore && 'open')} /> {t('Other agents herdr supports')}
            </button>
          )}
          {showMore && (
            <div className="kind-grid dim">
              {others.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  className={clsx('kind-opt', kind === k.kind && 'active')}
                  onClick={() => setKind(k.kind)}
                  title={t('{binary} not found in PATH', { binary: k.binary })}
                >
                  <AgentAvatar kind={k.kind} size={24} />
                  <span>{k.label}</span>
                </button>
              ))}
            </div>
          )}
          {!kinds.length && <div className="hint">{t('Detecting installed agents…')}</div>}
        </div>

        {supportsModels(kind) && (
          <div className="field">
            <label>
              {t('Model')} <span className="dim">{t('(and how hard it thinks)')}</span>
            </label>
            <ModelFields kind={kind} value={choiceFor(kind, modelChoice, catalog)} onChange={setModelChoice} />
          </div>
        )}

        <div className="field-row">
          {kind && (
            <div className="field grow">
              <label>{t('Name')}</label>
              <input
                className={clsx('input', !nameValid && 'invalid')}
                value={name}
                placeholder={kind}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                spellCheck={false}
              />
            </div>
          )}
          {!existingPane && workspaceId && (
            <div className="field">
              <label>{t('Open in')}</label>
              <div className="segmented small">
                <button type="button" className={clsx(placement === 'tab' && 'active')} onClick={() => setPlacement('tab')}>
                  {t('New tab')}
                </button>
                <button
                  type="button"
                  className={clsx(placement === 'split-right' && 'active')}
                  disabled={!splitTarget}
                  onClick={() => setPlacement('split-right')}
                  title={splitTarget ? '' : t('Select a thread in this project first')}
                >
                  {t('Split →')}
                </button>
                <button type="button" className={clsx(placement === 'split-down' && 'active')} disabled={!splitTarget} onClick={() => setPlacement('split-down')}>
                  {t('Split ↓')}
                </button>
              </div>
            </div>
          )}
        </div>

        {!existingPane && workspaceId && (
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
              <GitBranch size={13} /> {t('Work in a separate git worktree')}
            </label>
            {useWorktree && (
              <input className="input" value={branch} placeholder={t('branch name, e.g. feature/login')} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
            )}
          </div>
        )}

        {kind && (
          <>
            <div className="field">
              <label>
                {t('Launch arguments')} <span className="dim">{t('(optional, passed to {agent})', { agent: agentKindDef(kind)?.label ?? kind })}</span>
              </label>
              <input
                className="input mono"
                value={args}
                placeholder={kind === 'claude' ? '--permission-mode plan' : kind === 'codex' ? '--search' : ''}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>
                {role ? t('Instructions') : t('First message')} <span className="dim">{role ? t('(sent as soon as the agent starts)') : t('(optional)')}</span>
              </label>
              <textarea
                className="input"
                rows={role ? 4 : 3}
                value={prompt}
                placeholder={t('What should the agent do?')}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
                }}
              />
              {role && settings.agentPreviewHint && <div className="field-hint">{t('A short note on how to open the preview panel is added automatically.')}</div>}
            </div>
          </>
        )}

        {!kind && !existingPane && (
          <div className="hint">
            <SquareTerminal size={13} /> {t('Opens a plain shell. You can start an agent in it later from its menu.')}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner size={13} /> : null}
            {busy ? t('Starting…') : kind ? t('Start {agent}', { agent: agentKindDef(kind)?.label ?? kind }) : t('Open terminal')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
