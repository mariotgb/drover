import type { RoleTemplate } from '@shared/types'
import { agentKindDef } from '@shared/agents'
import { api } from './api'
import { t } from './i18n'
import { useStore } from './store'

// Role templates: what an agent is and what it is told right after it starts.

export function starterRoles(): RoleTemplate[] {
  const r = (name: string, label: string, kind: string, instructions: string, orchestrator = false): RoleTemplate => ({
    id: `starter:${name}`,
    name,
    label,
    kind,
    args: '',
    instructions,
    source: 'custom',
    orchestrator
  })
  return [
    r(
      'orchestrator',
      t('Orchestrator'),
      'claude',
      t('You are the team lead. Split my requests into tasks, hand them to the right agents, check their results and report back to me briefly. Do not write large amounts of code yourself.'),
      true
    ),
    r('frontend', t('Frontend'), 'claude', t('You are the frontend engineer of this project: UI, components, styles and client logic. Wait for tasks.')),
    r('backend', t('Backend'), 'codex', t('You are the backend engineer of this project: APIs, data, business logic and migrations. Wait for tasks.')),
    r('review', t('Reviewer'), 'codex', t('You are the code reviewer. When given a change, review it for bugs, security and regressions and report only actionable findings. Do not edit code unless asked.')),
    r('qa', t('QA'), 'claude', t('You are the QA engineer: write and run tests, reproduce bugs and verify fixes. Wait for tasks.'))
  ]
}

function overrideKey(cwd: string | null, name: string) {
  return `${cwd ?? ''}::${name}`
}

/** A role with the user's per-project tweaks and defaults applied. */
export function effectiveRole(role: RoleTemplate, cwd: string | null): RoleTemplate {
  const s = useStore.getState().settings
  const o = s.roleOverrides[overrideKey(cwd, role.name)] ?? {}
  const kind = o.kind || role.kind || s.defaultAgentKind
  return {
    ...role,
    kind: agentKindDef(kind) ? kind : s.defaultAgentKind,
    args: o.args ?? role.args,
    instructions: o.instructions ?? role.instructions,
    model: o.model ?? role.model,
    effort: o.effort ?? role.effort
  }
}

export function rememberRole(cwd: string | null, role: RoleTemplate, patch: Partial<Pick<RoleTemplate, 'kind' | 'args' | 'instructions' | 'model' | 'effort'>>) {
  const s = useStore.getState().settings
  const key = overrideKey(cwd, role.name)
  return { roleOverrides: { ...s.roleOverrides, [key]: { ...(s.roleOverrides[key] ?? {}), ...patch } } }
}

export function defaultInstructions(role: RoleTemplate): string {
  if (role.file) {
    return t('Read AGENTS.md (if present) and {file} — that is your role “{label}”. Confirm briefly that you understand it, then wait for tasks.', {
      file: role.file,
      label: role.label
    })
  }
  return t('Your role: {label}. Confirm briefly, then wait for tasks.', { label: role.label })
}

export function previewHint(): string {
  return t(
    'Tip: the user works in Drover. To show them a page in its built-in preview, run: herdr pane report-metadata "$HERDR_PANE_ID" --source drover --token preview=<url>'
  )
}

export function teamNote(members: { name: string; kind: string; label: string }[]): string {
  const list = members.map((m) => `${m.name} (${m.label}, ${agentKindDef(m.kind)?.label ?? m.kind})`).join(', ')
  return t(
    'Your team runs in herdr: {list}. Give them work with `herdr agent prompt <name> "<task>" --wait` and read their answers with `herdr agent read <name> --source recent-unwrapped --lines 120`. Follow the herdr skill for details.',
    { list }
  )
}

/** First message for an agent started from a role. */
export function firstMessage(role: RoleTemplate, opts: { team?: { name: string; kind: string; label: string }[] } = {}): string {
  const parts = [role.instructions.trim() || defaultInstructions(role)]
  if (opts.team?.length) parts.push(teamNote(opts.team))
  if (useStore.getState().settings.agentPreviewHint) parts.push(previewHint())
  return parts.join('\n\n')
}

/** Project roles, falling back to the user's roles, then the starter set. */
export async function rolesFor(cwd: string | null): Promise<{ project: RoleTemplate[]; custom: RoleTemplate[] }> {
  const project = cwd ? await api.discoverRoles(cwd).catch(() => []) : []
  const custom = useStore.getState().settings.roles
  return { project, custom: custom.length ? custom : project.length ? [] : starterRoles() }
}
