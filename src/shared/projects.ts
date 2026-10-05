/** Preferences use project folders, so they survive workspace/session recreation. */
export const PROJECT_IMPORTANCE = ['primary', 'important', 'normal', 'background'] as const
export type ProjectImportance = typeof PROJECT_IMPORTANCE[number]
export interface ProjectPreferences {
  projectOrder: string[]
  projectImportance: Record<string, ProjectImportance>
}

export function projectFolders(projects: { cwd: string | null }[]): string[] {
  return [...new Set(projects.flatMap(project => project.cwd ? [project.cwd] : []))]
}

export function projectImportance(cwd: string | null, preferences: ProjectPreferences): ProjectImportance {
  return cwd ? preferences.projectImportance[cwd] ?? 'normal' : 'normal'
}

/** Manual positions win. Unplaced projects follow, ordered by importance stably. */
export function orderedProjects<T extends { cwd: string | null }>(projects: T[], preferences: ProjectPreferences): T[] {
  const positions = new Map(preferences.projectOrder.map((folder, i) => [folder, i]))
  const rank = (project: T) => PROJECT_IMPORTANCE.indexOf(projectImportance(project.cwd, preferences))
  const ordered = [...projects].sort((a, b) => {
    const aPosition = a.cwd ? positions.get(a.cwd) : undefined
    const bPosition = b.cwd ? positions.get(b.cwd) : undefined
    if (aPosition !== undefined || bPosition !== undefined) return (aPosition ?? Infinity) - (bPosition ?? Infinity)
    return rank(a) - rank(b)
  })
  return ordered.every((project, i) => project === projects[i]) ? projects : ordered
}

/** Drop/arrow movement captures the full visible order and keeps closed folders. */
export function moveProjectOrder(projects: { cwd: string | null }[], preferences: ProjectPreferences, source: string, target: string, after = false): string[] {
  const visible = projectFolders(orderedProjects(projects, preferences))
  if (source === target || !visible.includes(source) || !visible.includes(target)) return preferences.projectOrder
  const next = visible.filter(folder => folder !== source)
  next.splice(next.indexOf(target) + Number(after), 0, source)
  return [...next, ...preferences.projectOrder.filter(folder => !visible.includes(folder))]
}
