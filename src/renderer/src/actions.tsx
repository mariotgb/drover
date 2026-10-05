import {
  Bot,
  Columns2,
  Crown,
  Globe,
  Megaphone,
  Users,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  PanelTop,
  Pencil,
  Plus,
  Rows2,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import { AGENT_NAME_RE, toAgentName } from '@shared/agents'
import type { PaneInfo, WorkspaceInfo } from '@shared/types'
import { api, call, humanizeError, isRemote } from './api'
import { supportsBypass } from '@shared/models'
import type { RestartSelection } from '@shared/agentRestart'
import { t } from './i18n'
import type { MenuItem } from './components/Menu'
import type { Thread, WorkspaceGroup } from './model'
import { basename } from './model'
import { getModel, guard, select, setViewMode, toast, togglePreview, updateSettings, useStore } from './store'
import { agentName, projectKey, projectLead } from './leads'
import { projectImportanceMenu } from './components/ProjectPreferences'

const set = useStore.setState

export function openNewAgent(preset: Omit<Extract<import('./store').DialogState, { type: 'new-agent' }>, 'type'> = {}) {
  set({ dialog: { type: 'new-agent', ...preset } })
}

export function openSettings(tab?: string) {
  set({ dialog: { type: 'settings', tab } })
}

function prompt(opts: { title: string; label?: string; value: string; placeholder?: string; confirm?: string; validate?: (v: string) => string | null; onSubmit: (v: string) => Promise<void> | void }) {
  set({ dialog: { type: 'prompt', confirm: opts.confirm ?? t('Save'), ...opts } })
}

function confirm(opts: { title: string; message: string; confirm: string; danger?: boolean; onConfirm: () => Promise<void> | void }) {
  set({ dialog: { type: 'confirm', ...opts } })
}

export function renameAgent(th: Thread) {
  prompt({
    title: t('Rename agent'),
    label: t('Agent name (a–z, 0–9, "-", "_")'),
    value: th.agent?.name ?? '',
    placeholder: t('reviewer'),
    validate: (v) => (v === '' || AGENT_NAME_RE.test(v) ? null : t('Try “{name}”', { name: toAgentName(v) })),
    onSubmit: async (v) => {
      const group = getModel().groups.find((g) => g.workspace.workspace_id === th.workspaceId)
      const key = group && projectKey(group)
      const previousName = agentName(th)
      await call('agent.rename', v ? { target: th.paneId, name: v } : { target: th.paneId, name: null })
      const leads = useStore.getState().settings.projectLeads
      if (key && leads[key] === previousName) {
        const projectLeads = { ...leads }
        if (v) projectLeads[key] = v
        else delete projectLeads[key]
        await updateSettings({ projectLeads })
      }
    }
  })
}

export function renameTab(th: Thread) {
  prompt({
    title: t('Rename tab'),
    value: th.tab.label === String(th.tab.number) ? '' : th.tab.label,
    placeholder: th.name,
    onSubmit: async (v) => {
      await call('tab.rename', { tab_id: th.tabId, label: v.trim() || String(th.tab.number) })
    }
  })
}

export function renamePane(th: Thread) {
  prompt({
    title: t('Rename pane'),
    value: th.pane.label ?? '',
    placeholder: th.name,
    onSubmit: async (v) => {
      await call('pane.rename', { pane_id: th.paneId, label: v.trim() || null })
    }
  })
}

export function renameWorkspace(ws: WorkspaceInfo) {
  prompt({
    title: t('Rename project'),
    value: ws.label,
    onSubmit: async (v) => {
      if (v.trim()) await call('workspace.rename', { workspace_id: ws.workspace_id, label: v.trim() })
    }
  })
}

export function closePane(th: Thread) {
  const running = th.kind ? t('The {kind} agent “{name}” will be stopped.', { kind: th.kind, name: th.name }) : t('The terminal and anything running in it will be closed.')
  confirm({
    title: th.tabPaneCount > 1 ? t('Close pane?') : t('Close tab?'),
    message: running,
    confirm: t('Close'),
    danger: true,
    onConfirm: async () => {
      await call('pane.close', { pane_id: th.paneId })
    }
  })
}

export const restartLabel = (bypass: boolean | undefined) => bypass ? t('Restart with confirmations') : t('Restart without confirmations')

export async function restartAgent(selection: RestartSelection) {
  if (isRemote) return
  await guard((async () => {
    const plan = await api.planAgentRestart(selection)
    const skipped = plan.skipped.map(a => `${a.name}: ${a.reason === 'already_bypass' ? t('Already without confirmations') : humanizeError(a.reason, a.reason)}`).join('\n')
    if (!plan.agents.length) { toast('info', skipped || t('No agents to restart')); return }
    const unknown = plan.agents.filter(a => !a.sessionId).map(a => a.name)
    confirm({
      title: selection.workspaceId ? t('Restart all project agents without confirmations') : restartLabel(!plan.bypass),
      message: [
        plan.bypass ? t('Without confirmations, agents can edit files and run commands with your permissions. Codex also disables its sandbox. Only use this for agents and projects you trust.') : t('Permission confirmations will be enabled again.'),
        plan.agents.map(a => `${a.name} (${a.kind})`).join('\n'),
        unknown.length ? t('Session unknown for {names}: a new conversation will start.', { names: unknown.join(', ') }) : t('The same conversation will continue in the same pane.'),
        skipped ? `${t('Skipped agents (wait for working agents to finish, then try again):')}\n${skipped}` : ''
      ].filter(Boolean).join('\n\n'),
      confirm: t('Restart'),
      danger: plan.bypass,
      onConfirm: async () => {
        const results = await api.restartAgents(plan.token)
        const succeeded = results.filter(r => r.ok).length
        if (succeeded) toast('success', t('Restarted agents: {n}', { n: succeeded }))
        const failed = results.filter(r => !r.ok)
        if (failed.length) toast('error', failed.map(r => `${r.name}: ${humanizeError(r.code, r.error)}`).join('\n'))
      }
    })
  })())
}

export function closeTab(th: Thread) {
  confirm({
    title: t('Close tab?'),
    message: t('All {n} panes in this tab and their processes will be closed.', { n: th.tabPaneCount }),
    confirm: t('Close tab'),
    danger: true,
    onConfirm: async () => {
      await call('tab.close', { tab_id: th.tabId })
    }
  })
}

export function closeWorkspace(ws: WorkspaceInfo) {
  confirm({
    title: t('Close project “{name}”?', { name: ws.label }),
    message: t('All {tabs} tabs, {panes} panes and every agent in them will be stopped. Files on disk are not touched.', { tabs: ws.tab_count, panes: ws.pane_count }),
    confirm: t('Close project'),
    danger: true,
    onConfirm: async () => {
      try {
        await call('workspace.close', { workspace_id: ws.workspace_id })
      } catch (e) {
        if ((e as { code?: string }).code === 'workspace_group_close_required') {
          await call('workspace.close', { workspace_id: ws.workspace_id, close_group: true })
        } else throw e
      }
    }
  })
}

export async function newTerminalTab(workspaceId: string | null, cwd?: string | null) {
  if (!workspaceId) {
    openNewAgent({ kind: null, pickFolder: true })
    return
  }
  const res = await guard(call<{ root_pane: PaneInfo }>('tab.create', { workspace_id: workspaceId, ...(cwd ? { cwd } : {}), focus: false }))
  if (res) {
    setViewMode(res.root_pane.pane_id, 'terminal')
    select(res.root_pane.pane_id)
  }
}

export async function splitPane(th: Thread, direction: 'right' | 'down') {
  const res = await guard(
    call<{ pane: PaneInfo }>('pane.split', {
      target_pane_id: th.paneId,
      direction,
      ...(th.cwd ? { cwd: th.cwd } : {}),
      focus: false
    })
  )
  if (res) {
    setViewMode(res.pane.pane_id, 'terminal')
    select(res.pane.pane_id)
  }
}

export async function interrupt(th: Thread | null) {
  if (!th) return
  if (th.kind) await guard(call('agent.send_keys', { target: th.paneId, keys: ['esc'] }))
  else await guard(call('pane.send_keys', { pane_id: th.paneId, keys: ['ctrl+c'] }))
}

export async function sendKeys(th: Thread, keys: string[]) {
  if (th.kind) await guard(call('agent.send_keys', { target: th.paneId, keys }))
  else await guard(call('pane.send_keys', { pane_id: th.paneId, keys }))
}

export async function moveToNewTab(th: Thread) {
  const res = await guard(call<{ move_result?: { pane?: { pane_id: string } } }>('pane.move', { pane_id: th.paneId, destination: { type: 'new_tab', workspace_id: th.workspaceId }, focus: false }))
  const id = res?.move_result?.pane?.pane_id
  if (id) select(id)
}

export async function toggleZoom(th: Thread) {
  await guard(call('pane.zoom', { pane_id: th.paneId, mode: 'toggle' }))
}

export function newWorktree(group: WorkspaceGroup) {
  prompt({
    title: t('New git worktree'),
    label: t('Branch name (created from HEAD if it does not exist)'),
    value: '',
    placeholder: t('feature/my-change'),
    confirm: t('Create'),
    validate: (v) => (/^[\w./-]+$/.test(v) ? null : t('Use letters, digits, "/", "-", "_" or "."')),
    onSubmit: async (branch) => {
      const res = await call<{ root_pane?: PaneInfo }>('worktree.create', { workspace_id: group.workspace.workspace_id, branch, focus: false }, 60000)
      if (res.root_pane) {
        toast('success', t('Worktree “{branch}” created', { branch }))
        openNewAgent({ workspaceId: res.root_pane.workspace_id, paneId: res.root_pane.pane_id })
      }
    }
  })
}

/** "Make project lead", unless it already is (or the project has one agent). */
export function leadMenuItem(th: Thread, iconSize = 14): MenuItem | null {
  const group = getModel().groups.find((g) => g.workspace.workspace_id === th.workspaceId)
  if (!th.kind || !group || group.threads.filter((x) => x.kind).length < 2) return null
  const leads = useStore.getState().settings.projectLeads
  if (projectLead(group, leads)?.paneId === th.paneId) return null
  return {
    label: t('Make project lead'),
    icon: <Crown size={iconSize} />,
    onClick: () => void updateSettings({ projectLeads: { ...useStore.getState().settings.projectLeads, [projectKey(group)]: agentName(th) } })
  }
}

export function threadMenu(th: Thread): MenuItem[] {
  const items: MenuItem[] = []
  if (th.kind) items.push({ label: t('Rename agent…'), icon: <Pencil size={14} />, onClick: () => renameAgent(th) })
  if (!isRemote && supportsBypass(th.kind)) items.push({ label: restartLabel(th.pane.bypass), icon: <RotateCcw size={14} />, onClick: () => void restartAgent({ paneId: th.paneId, bypass: !th.pane.bypass }) })
  const lead = leadMenuItem(th)
  if (lead) items.push(lead)
  items.push({ label: th.tabPaneCount > 1 ? t('Rename tab…') : t('Rename…'), icon: <Pencil size={14} />, onClick: () => renameTab(th) })
  if (th.tabPaneCount > 1) items.push({ label: t('Rename pane…'), icon: <Pencil size={14} />, onClick: () => renamePane(th) })
  items.push('separator')
  if (th.isShell) {
    items.push({
      label: t('Start agent here…'),
      icon: <Bot size={14} />,
      onClick: () => openNewAgent({ workspaceId: th.workspaceId, paneId: th.paneId })
    })
  }
  items.push(
    { label: t('Split right'), icon: <Columns2 size={14} />, onClick: () => void splitPane(th, 'right') },
    { label: t('Split down'), icon: <Rows2 size={14} />, onClick: () => void splitPane(th, 'down') }
  )
  if (th.tabPaneCount > 1) {
    items.push(
      { label: t('Move to new tab'), icon: <PanelTop size={14} />, onClick: () => void moveToNewTab(th) },
      { label: t('Toggle zoom'), icon: <Square size={14} />, onClick: () => void toggleZoom(th) }
    )
  }
  items.push('separator')
  if (th.cwd) {
    items.push(
      { label: t('Reveal in Finder'), icon: <FolderOpen size={14} />, onClick: () => void api.openPath(th.cwd!) },
      { label: t('Open in editor'), icon: <ExternalLink size={14} />, onClick: () => void api.openInEditor(th.cwd!) }
    )
  }
  items.push({
    label: t('Copy pane id'),
    icon: <Copy size={14} />,
    hint: th.paneId,
    onClick: () => void navigator.clipboard.writeText(th.agent?.name ?? th.paneId)
  })
  items.push('separator')
  if (th.tabPaneCount > 1) items.push({ label: t('Close tab…'), icon: <X size={14} />, danger: true, onClick: () => closeTab(th) })
  items.push({ label: th.tabPaneCount > 1 ? t('Close pane…') : t('Close…'), icon: <Trash2 size={14} />, danger: true, onClick: () => closePane(th) })
  return items
}

export function workspaceMenu(g: WorkspaceGroup): MenuItem[] {
  const ws = g.workspace
  return [
    ...(!isRemote ? [{ label: t('Restart all project agents without confirmations'), icon: <RotateCcw size={14} />, onClick: () => void restartAgent({ workspaceId: ws.workspace_id, bypass: true }) }] : []),
    ...projectImportanceMenu(g),
    'separator',
    { label: t('New agent…'), icon: <Bot size={14} />, onClick: () => openNewAgent({ workspaceId: ws.workspace_id }) },
    { label: t('Start team…'), icon: <Users size={14} />, onClick: () => set({ dialog: { type: 'team', workspaceId: ws.workspace_id } }) },
    {
      label: t('Message several agents…'),
      icon: <Megaphone size={14} />,
      disabled: !g.threads.some((th) => th.kind),
      onClick: () => set({ dialog: { type: 'broadcast', workspaceId: ws.workspace_id } })
    },
    { label: t('Open preview'), icon: <Globe size={14} />, onClick: () => togglePreview(ws.workspace_id, true) },
    { label: t('New terminal tab'), icon: <SquareTerminal size={14} />, onClick: () => void newTerminalTab(ws.workspace_id, g.cwd) },
    { label: t('New git worktree…'), icon: <GitBranch size={14} />, onClick: () => newWorktree(g) },
    'separator',
    { label: t('Rename…'), icon: <Pencil size={14} />, onClick: () => renameWorkspace(ws) },
    ...(g.cwd
      ? [
          { label: t('Reveal in Finder'), icon: <FolderOpen size={14} />, onClick: () => void api.openPath(g.cwd!) },
          { label: t('Open in editor'), icon: <ExternalLink size={14} />, onClick: () => void api.openInEditor(g.cwd!) }
        ]
      : []),
    'separator',
    { label: t('Close project…'), icon: <Trash2 size={14} />, danger: true, onClick: () => closeWorkspace(ws) }
  ]
}

export function newAgentMenu(): MenuItem[] {
  const { groups } = getModel()
  return [
    { header: t('New agent in…') },
    ...groups.map((g) => ({
      label: g.workspace.label || basename(g.cwd),
      icon: <FolderOpen size={14} />,
      onClick: () => openNewAgent({ workspaceId: g.workspace.workspace_id })
    })),
    'separator' as const,
    { label: t('New project…'), icon: <Plus size={14} />, onClick: () => openNewAgent({ workspaceId: null, pickFolder: true }) }
  ]
}
