import type { Thread, WorkspaceGroup } from './model'
import { isLeadName, leadProjectKey, selectProjectLead } from '@shared/boss'

// "Show only the project lead": each project shows its lead agent; the others
// fold into one row. Agents waiting for an answer always stay in sight.

export function isLead(th: Thread): boolean {
  return isLeadName(agentName(th))
}

export function agentName(th: Thread): string {
  return th.agent?.name ?? th.name
}

/** Lead choices are stored per project folder, so they survive herdr restarts. */
export function projectKey(group: WorkspaceGroup): string {
  return leadProjectKey(group.cwd, group.workspace.label, group.workspace.workspace_id)
}

/** The agent picked by hand, else the orchestrator/team lead by name, else the first agent. */
export function projectLead(group: WorkspaceGroup, leads: Record<string, string>): Thread | null {
  const agents = group.threads.filter((th) => !!th.kind)
  const chosen = leads[projectKey(group)]
  return selectProjectLead(agents, chosen, agentName)
}

/** Rows to show (lead first, then waiting agents and `keep`) and rows folded away, in project order. */
export function splitByLead(group: WorkspaceGroup, leads: Record<string, string>, keep: (th: Thread) => boolean = () => false): { lead: Thread | null; shown: Thread[]; hidden: Thread[] } {
  const lead = projectLead(group, leads)
  if (!lead) return { lead, shown: group.threads, hidden: [] }
  const rest = group.threads.filter((th) => th !== lead)
  const shown = [lead, ...rest.filter((th) => th.status === 'blocked' || keep(th))]
  return { lead, shown, hidden: rest.filter((th) => !shown.includes(th)) }
}
