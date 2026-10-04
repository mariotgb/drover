import { t } from './i18n'
import type {
  AgentInfo,
  AgentStatus,
  HerdrSnapshot,
  PaneInfo,
  TabInfo,
  WorkspaceInfo
} from '@shared/types'
import { agentKindDef } from '@shared/agents'
import { structuralShare } from './structural-share'

export interface Thread {
  paneId: string
  tabId: string
  workspaceId: string
  pane: PaneInfo
  agent: AgentInfo | null
  tab: TabInfo
  workspace: WorkspaceInfo
  kind: string | null
  name: string
  subtitle: string
  status: AgentStatus
  isShell: boolean
  tabPaneCount: number
  paneIndex: number
  cwd: string | null
}

export interface TabGroup {
  tab: TabInfo
  threads: Thread[]
  customLabel: string | null
}

export interface WorkspaceGroup {
  workspace: WorkspaceInfo
  tabs: TabGroup[]
  threads: Thread[]
  cwd: string | null
}

export function tabCustomLabel(tab: TabInfo): string | null {
  const l = (tab.label ?? '').trim()
  if (!l || l === String(tab.number)) return null
  return l
}

export function cleanTitle(title: string | null | undefined, workspaceLabel?: string, cwd?: string | null): string {
  if (!title) return ''
  let t = title.trim()
  // Codex appends " | <project>" to its terminal title.
  const base = cwd ? cwd.split('/').filter(Boolean).pop() : undefined
  for (const suffix of [base, workspaceLabel].filter(Boolean) as string[]) {
    const s = ` | ${suffix}`
    if (t.endsWith(s)) t = t.slice(0, -s.length)
  }
  if (/^(zsh|bash|fish|sh|-zsh|login)$/i.test(t)) return ''
  return t
}

export function shortPath(p: string | null | undefined, home: string): string {
  if (!p) return ''
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

export function basename(p: string | null | undefined): string {
  if (!p) return ''
  return p.split('/').filter(Boolean).pop() ?? p
}

export function paneOrder(snapshot: HerdrSnapshot, tabId: string): Map<string, number> {
  const layout = snapshot.layouts.find((l) => l.tab_id === tabId)
  const order = new Map<string, number>()
  if (!layout) return order
  const sorted = [...layout.panes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  sorted.forEach((p, i) => order.set(p.pane_id, i))
  return order
}

export interface ThreadModel { groups: WorkspaceGroup[]; threads: Thread[]; byPane: Map<string, Thread> }
function shareList<T>(before: T[] | undefined, after: T[]): T[] {
  return before?.length === after.length && after.every((item, i) => item === before[i]) ? before : after
}
export function buildModel(snapshot: HerdrSnapshot | null, previous?: ThreadModel): ThreadModel {
  const groups: WorkspaceGroup[] = []
  const threads: Thread[] = []
  const byPane = new Map<string, Thread>()
  if (!snapshot) return { groups, threads, byPane }
  const agentsByPane = new Map(snapshot.agents.map((a) => [a.pane_id, a]))
  const oldGroups = new Map(previous?.groups.map(g => [g.workspace.workspace_id, g]))
  const workspaces = [...snapshot.workspaces].sort((a, b) => a.number - b.number)
  for (const ws of workspaces) {
    const oldGroup = oldGroups.get(ws.workspace_id)
    const oldTabs = new Map(oldGroup?.tabs.map(t => [t.tab.tab_id, t]))
    const tabs = snapshot.tabs.filter((t) => t.workspace_id === ws.workspace_id).sort((a, b) => a.number - b.number)
    const group: WorkspaceGroup = { workspace: ws, tabs: [], threads: [], cwd: null }
    for (const tab of tabs) {
      const order = paneOrder(snapshot, tab.tab_id)
      const panes = snapshot.panes
        .filter((p) => p.tab_id === tab.tab_id)
        .sort((a, b) => (order.get(a.pane_id) ?? 99) - (order.get(b.pane_id) ?? 99))
      const custom = tabCustomLabel(tab)
      const tg: TabGroup = { tab, threads: [], customLabel: custom }
      panes.forEach((pane, idx) => {
        const agent = agentsByPane.get(pane.pane_id) ?? null
        const kind = (pane.agent ?? agent?.agent ?? null)?.toLowerCase() ?? null
        const def = agentKindDef(kind)
        const agentName = agent?.name ?? null
        let name: string
        if (panes.length === 1) {
          name = custom || agentName || pane.label || pane.display_agent || def?.label || t('Terminal')
        } else {
          name = pane.label || agentName || pane.display_agent || def?.label || t('Terminal {n}', { n: idx + 1 })
        }
        const cwd = pane.foreground_cwd || pane.cwd || null
        const title = cleanTitle(pane.title || pane.terminal_title_stripped, ws.label, cwd)
        let subtitle = title
        if (!subtitle || subtitle === name) subtitle = kind ? def?.label ?? kind : basename(cwd)
        if (panes.length === 1 && custom && agentName && agentName !== custom && !title) subtitle = agentName
        const th = structuralShare(previous?.byPane.get(pane.pane_id), {
          paneId: pane.pane_id,
          tabId: tab.tab_id,
          workspaceId: ws.workspace_id,
          pane,
          agent,
          tab,
          workspace: ws,
          kind,
          name,
          subtitle,
          status: pane.agent_status,
          isShell: !kind,
          tabPaneCount: panes.length,
          paneIndex: idx,
          cwd
        } satisfies Thread)
        tg.threads.push(th)
        group.threads.push(th)
        threads.push(th)
        byPane.set(pane.pane_id, th)
        if (!group.cwd && pane.cwd) group.cwd = pane.cwd
      })
      const oldTab = oldTabs.get(tab.tab_id)
      tg.tab = structuralShare(oldTab?.tab, tg.tab)
      tg.threads = shareList(oldTab?.threads, tg.threads)
      group.tabs.push(oldTab && oldTab.tab === tg.tab && oldTab.threads === tg.threads && oldTab.customLabel === tg.customLabel ? oldTab : tg)
    }
    group.workspace = structuralShare(oldGroup?.workspace, group.workspace)
    group.tabs = shareList(oldGroup?.tabs, group.tabs)
    group.threads = shareList(oldGroup?.threads, group.threads)
    groups.push(oldGroup && oldGroup.workspace === group.workspace && oldGroup.tabs === group.tabs && oldGroup.threads === group.threads && oldGroup.cwd === group.cwd ? oldGroup : group)
  }
  const sharedGroups = shareList(previous?.groups, groups)
  const sharedThreads = shareList(previous?.threads, threads)
  if (previous && sharedGroups === previous.groups && sharedThreads === previous.threads) return previous
  return { groups: sharedGroups, threads: sharedThreads, byPane }
}

const ATTENTION: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 }

export function attentionSort(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) =>
      ATTENTION[a.status] - ATTENTION[b.status] ||
      (b.agent?.state_change_seq ?? 0) - (a.agent?.state_change_seq ?? 0) ||
      a.workspace.number - b.workspace.number ||
      a.tab.number - b.tab.number
  )
}

export function statusLabel(s: AgentStatus): string {
  switch (s) {
    case 'working':
      return t('Working')
    case 'blocked':
      return t('Needs input')
    case 'done':
      return t('Done')
    case 'idle':
      return t('Idle')
    default:
      return ''
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('{s}s', { s })
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? t('{m}m {s}s', { m, s: rs }) : t('{m}m', { m })
  const h = Math.floor(m / 60)
  return t('{h}h {m}m', { h, m: m % 60 })
}

export function formatTokens(n: number | undefined): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 1
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx >= 0) return 100 - idx
  let ti = 0
  let score = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    score += found === ti ? 3 : 1
    ti = found + 1
  }
  return score
}
