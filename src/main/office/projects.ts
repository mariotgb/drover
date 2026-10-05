import { basename, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { HerdrSnapshot } from '@shared/types'
import type { OfficeDepartment } from '@shared/office'
import { boardTaskTitle } from './hud'

export interface OfficeProject { department: OfficeDepartment; root: string | null }

/** Same folder selection as buildModel/group.cwd in the Projects sidebar:
 * first pane.cwd in tab/layout order. foreground_cwd is deliberately not a project key.
 * No git guessing: distinct checkout folders remain distinct sidebar projects.
 */
export function officeProjects(snapshot: HerdrSnapshot, session: string): OfficeProject[] {
  const projects = new Map<string, OfficeProject>()
  for (const ws of [...snapshot.workspaces].sort((a, b) => a.number - b.number || a.workspace_id.localeCompare(b.workspace_id))) {
    const tabs = snapshot.tabs.filter(t => t.workspace_id === ws.workspace_id).sort((a, b) => a.number - b.number)
    const panes = tabs.length ? tabs.flatMap(tab => {
      const layout = snapshot.layouts.find(l => l.tab_id === tab.tab_id)
      const order = new Map([...(layout?.panes || [])].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((p, i) => [p.pane_id, i]))
      return snapshot.panes.filter(p => p.tab_id === tab.tab_id).sort((a, b) => (order.get(a.pane_id) ?? 99) - (order.get(b.pane_id) ?? 99))
    }) : snapshot.panes.filter(p => p.workspace_id === ws.workspace_id)
    const cwd = panes.find(p => p.cwd)?.cwd
    const root = cwd ? resolve(cwd) : null
    const key = root ? `project:${root}` : `workspace:${ws.workspace_id}`
    const existing = projects.get(key)
    if (existing) { existing.department.workspaceIds.push(ws.workspace_id); continue }
    const hash = createHash('sha256').update(key).digest('hex')
    projects.set(key, { root, department: {
      id: `${session}:department:${hash}`, workspaceId: ws.workspace_id, workspaceIds: [ws.workspace_id],
      name: boardTaskTitle(root ? basename(root) : ws.label) || 'Проект', number: ws.number
    } })
  }
  return [...projects.values()]
}
