import type { AgentStatus, HerdrSnapshot, NewAgentResult } from './types'

export interface BossLead { paneId: string; name: string; kind: string; status: AgentStatus }
export interface BossProject {
  key: string
  name: string
  cwd: string | null
  workspaceIds: string[]
  enabled: boolean
  lead: BossLead | null
}
export interface BossSettings { excludedProjects: string[]; hqFolder: string }
export interface BossRoster { session: string; hqFolder: string; projects: BossProject[]; boss: BossLead | null; needsSessionSwitch?: boolean }
export interface BossOpenRequest { kind: string; args?: string[]; folder?: string; prompt: string }
export type BossOpenResult = NewAgentResult & { folder: string; workspaceId?: string; existing?: boolean; session?: string; needsSessionSwitch?: boolean }
export interface BossBroadcastRequest { text: string; projectKeys?: string[] }
export interface BossDelivery {
  id: string
  projectKey: string
  projectName: string
  lead: BossLead | null
  status: 'delivered' | 'queued' | 'blocked' | 'no_lead' | 'error' | 'excluded'
  code?: string
  error?: string
}
/** HQ helper protocol; local files/socket only, never office or remote IPC. */
export interface BossAssignment {
  id: string
  createdAt: number
  session: string
  boss: BossLead
  /** Bound at dispatch; replacing an agent in the same pane invalidates it. */
  bossIdentity: string
  /** Idempotency digest; never the assignment text. */
  requestHash: string
  projects: (BossDelivery & { leadIdentity?: string; awaitingReply: boolean; repliedAt?: number; lastReplyReceiptId?: string;
    replyUnconfirmed?: { receiptId: string; receivedAt: number } })[]
}

/** Shared with renderer leads.ts: match the agent name, not its role or cwd. */
export function isLeadName(name: string): boolean {
  return /orchestr|lead|boss|manager|coordinator|оркестр|тимлид/i.test(name)
}
export function leadProjectKey(cwd: string | null, label: string, workspaceId: string): string {
  return cwd ?? `workspace:${label || workspaceId}`
}
/** Input order is the project's stable workspace/tab/layout order. */
export function selectProjectLead<T>(agents: readonly T[], chosen: string | undefined, name: (agent: T) => string): T | null {
  return (chosen ? agents.find(a => name(a) === chosen) : undefined) ?? agents.find(a => isLeadName(name(a))) ?? agents[0] ?? null
}

/** Same project keys and pane order as buildModel/projectKey in the sidebar.
 * Multiple workspaces with the same key form one project. foreground_cwd is
 * deliberately ignored: an agent changing directories cannot change projects.
 */
export function projectLeadRoster(snapshot: HerdrSnapshot | null, leads: Record<string, string>, excluded: readonly string[] = [], hqFolder?: string): BossProject[] {
  if (!snapshot) return []
  const projects = new Map<string, { project: BossProject; agents: BossLead[] }>()
  const liveAgents = new Map(snapshot.agents.map(a => [a.pane_id, a]))
  for (const ws of [...snapshot.workspaces].sort((a, b) => a.number - b.number)) {
    const tabs = snapshot.tabs.filter(t => t.workspace_id === ws.workspace_id).sort((a, b) => a.number - b.number)
    const panes = tabs.flatMap(tab => {
      const layout = snapshot.layouts.find(l => l.tab_id === tab.tab_id)
      const order = new Map([...(layout?.panes ?? [])].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((p, i) => [p.pane_id, i]))
      return snapshot.panes.filter(p => p.tab_id === tab.tab_id).sort((a, b) => (order.get(a.pane_id) ?? 99) - (order.get(b.pane_id) ?? 99))
    })
    const cwd = panes.find(p => p.cwd)?.cwd ?? null
    if (hqFolder && cwd === hqFolder) continue
    const key = leadProjectKey(cwd, ws.label, ws.workspace_id)
    let entry = projects.get(key)
    if (!entry) {
      entry = { project: { key, name: cwd ? cwd.split('/').filter(Boolean).pop() || ws.label : ws.label,
        cwd, workspaceIds: [], enabled: !excluded.includes(key), lead: null }, agents: [] }
      projects.set(key, entry)
    }
    entry.project.workspaceIds.push(ws.workspace_id)
    for (const pane of panes) {
      const agent = liveAgents.get(pane.pane_id)
      const kind = (pane.agent ?? agent?.agent)?.toLowerCase()
      if (!kind) continue
      const tab = tabs.find(t => t.tab_id === pane.tab_id)!
      const tabPanes = panes.filter(p => p.tab_id === tab.tab_id)
      const custom = tab.label?.trim() && tab.label !== String(tab.number) ? tab.label : null
      const display = tabPanes.length === 1 ? custom || agent?.name || pane.label || pane.display_agent || kind : pane.label || agent?.name || pane.display_agent || kind
      entry.agents.push({ paneId: pane.pane_id, name: agent?.name ?? display, kind, status: pane.agent_status })
    }
  }
  return [...projects.values()].map(({ project, agents }) => ({ ...project, lead: selectProjectLead(agents, leads[project.key], a => a.name) }))
}
