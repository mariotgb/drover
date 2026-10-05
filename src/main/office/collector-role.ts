import type { RoleTemplate } from '@shared/types'

const STARTER_NAMES = ['orchestrator', 'frontend', 'backend', 'review', 'qa'] as const

/** IDs are references only: never interpret one as a filesystem path. */
export function validOfficeRoleId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 &&
    /^(?:project|custom|starter):[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..')
}

export function resolveOfficeRole(roleId: unknown, templates: readonly RoleTemplate[]): RoleTemplate | null {
  if (!validOfficeRoleId(roleId)) return null
  const matches = templates.filter(role => role.id === roleId)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return null
  const name = STARTER_NAMES.find(name => roleId === `starter:${name}`)
  if (!name) return null
  // These are the same built-in choices offered by the role dialogs.
  return { id: roleId, name, label: name, kind: '', args: '', instructions: '',
    source: 'custom', orchestrator: name === 'orchestrator' }
}
