import type { OfficeState } from '@shared/office'
import { projectImportance, type ProjectPreferences, type ProjectImportance } from '@shared/projects'

/** Office departments may combine several workspaces for the same project. */
export function officeProjectPreferences(state: OfficeState | null, groups: { workspace: { workspace_id: string }; cwd: string | null }[], settings: ProjectPreferences) {
  const importance = new Map<string, ProjectImportance>()
  const rank = (department: NonNullable<typeof state>['departments'][number]) => {
    const index = groups.findIndex(group => department.workspaceIds.includes(group.workspace.workspace_id))
    return index < 0 ? Infinity : index
  }
  const departments = [...state?.departments ?? []].sort((a, b) => rank(a) - rank(b))
  for (const department of departments) {
    const group = groups.find(group => department.workspaceIds.includes(group.workspace.workspace_id))
    importance.set(department.id, group ? projectImportance(group.cwd, settings) : 'normal')
  }
  return { departments, importance }
}
