// Types shared between the Electron main process, preload and renderer.

import type { ModelChoice } from './models'
import { DEFAULT_APPEARANCE, type AppearanceSettings } from './themes'

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface AgentSessionRef {
  source: string
  agent: string
  kind: string
  value: string
}

export interface WorktreeInfo {
  [key: string]: unknown
}

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  number: number
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: AgentStatus
  tokens?: Record<string, string>
  worktree?: WorktreeInfo | null
}

export interface TabInfo {
  tab_id: string
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  agent_status: AgentStatus
}

export interface PaneScrollInfo {
  offset_from_bottom: number
  max_offset_from_bottom: number
  viewport_rows: number
}

export interface PaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  agent_status: AgentStatus
  revision: number
  agent?: string | null
  agent_session?: AgentSessionRef | null
  cwd?: string | null
  foreground_cwd?: string | null
  label?: string | null
  title?: string | null
  display_agent?: string | null
  terminal_title?: string | null
  terminal_title_stripped?: string | null
  scroll?: PaneScrollInfo | null
  state_labels?: Record<string, string>
  tokens?: Record<string, string>
}

export interface AgentInfo extends PaneInfo {
  agent: string
  name?: string | null
  interactive_ready?: boolean
  launch_pending?: boolean
  state_change_seq?: number
}

export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneLayoutSnapshot {
  workspace_id: string
  tab_id: string
  zoomed: boolean
  area: LayoutRect
  focused_pane_id: string
  panes: { pane_id: string; focused: boolean; rect: LayoutRect }[]
  splits: { id: string; direction: 'right' | 'down'; ratio: number; rect: LayoutRect }[]
}

export interface HerdrSnapshot {
  version: string
  protocol: number
  focused_workspace_id?: string | null
  focused_tab_id?: string | null
  focused_pane_id?: string | null
  workspaces: WorkspaceInfo[]
  tabs: TabInfo[]
  panes: PaneInfo[]
  layouts: PaneLayoutSnapshot[]
  agents: AgentInfo[]
}

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'server-stopped'
  | 'starting-server'
  | 'no-herdr'

export interface ConnectionState {
  status: ConnectionStatus
  session: string
  socketPath?: string
  herdrPath?: string
  version?: string
  error?: string
}

export interface HerdrSessionInfo {
  name: string
  default: boolean
  running: boolean
  session_dir?: string
  socket_path?: string
}

export interface AgentKindInfo {
  kind: string
  label: string
  binary: string
  installed: boolean
  transcript: boolean
}

// ---------------------------------------------------------------------------
// Transcript (chat view) model. Both Claude Code and Codex transcripts are
// normalized into this shape by the main process.

export interface ImageRef {
  src: string
  path?: string
  mediaType?: string
}

export interface DiffFile {
  path: string
  /** unified-ish lines prefixed with ' ', '+', '-' or '@' */
  lines: string[]
  added: number
  removed: number
  kind?: 'edit' | 'add' | 'delete' | 'write'
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ToolCategory =
  | 'read'
  | 'edit'
  | 'write'
  | 'command'
  | 'search'
  | 'web'
  | 'agent'
  | 'todo'
  | 'mcp'
  | 'image'
  | 'other'

export interface TranscriptUser {
  kind: 'user'
  id: string
  ts?: number
  text: string
  images: ImageRef[]
  command?: string
}

export interface TranscriptAssistant {
  kind: 'assistant'
  id: string
  ts?: number
  text: string
  phase?: 'commentary' | 'final'
}

export interface TranscriptThinking {
  kind: 'thinking'
  id: string
  ts?: number
  text: string
}

export interface TranscriptTool {
  kind: 'tool'
  id: string
  ts?: number
  name: string
  category: ToolCategory
  title: string
  /** Translatable title: English key with {placeholders}; titleOne is the singular form for counts. */
  titleKey?: string
  titleParams?: Record<string, string | number>
  titleOne?: string
  detail?: string
  input?: string
  output?: string
  outputImages?: ImageRef[]
  status: 'running' | 'done' | 'error'
  diff?: DiffFile[]
  todos?: TodoItem[]
  commands?: string[]
}

export interface TranscriptEvent {
  kind: 'event'
  id: string
  ts?: number
  variant: 'turn-end' | 'interrupted' | 'compacted' | 'error' | 'info'
  text: string
  durationMs?: number
}

export type TranscriptItem =
  | TranscriptUser
  | TranscriptAssistant
  | TranscriptThinking
  | TranscriptTool
  | TranscriptEvent

export interface TranscriptMeta {
  agent: 'claude' | 'codex'
  sessionId: string
  path: string
  title?: string
  model?: string
  /** Reasoning level of the last turn (Codex records it). */
  effort?: string
  cwd?: string
  contextTokens?: number
  contextWindow?: number
  rateLimitPercent?: number
  located: 'exact' | 'heuristic'
}

export interface TranscriptUpdate {
  paneId: string
  reset: boolean
  meta: TranscriptMeta | null
  items: TranscriptItem[]
  error?: string
}

// ---------------------------------------------------------------------------
// Terminal bridge

export interface TerminalFrame {
  seq: number
  full: boolean
  width: number
  height: number
  data: Uint8Array
}

// ---------------------------------------------------------------------------
// Plan usage limits (Claude Code and Codex)

export interface LimitWindow {
  /** e.g. "5-hour", "Weekly", "Weekly · Opus" */
  label: string
  usedPercent: number
  windowMinutes?: number
  /** epoch ms */
  resetsAt?: number
}

export interface ProviderLimits {
  provider: 'claude' | 'codex'
  windows: LimitWindow[]
  plan?: string
  /** epoch ms when this snapshot was observed */
  observedAt: number
  reached?: boolean
  error?: string
}

export interface LimitsState {
  claude: ProviderLimits | null
  codex: ProviderLimits | null
}

/** Claude Code status-line bridge (the local source of Claude plan limits). */
export interface ClaudeStatuslineState {
  installed: boolean
  /** Status-line command the user already had (kept and chained). */
  otherCommand: string | null
  /** epoch ms of the newest snapshot Claude Code wrote */
  lastUpdate: number | null
  settingsFile: string
  error?: string
}

// ---------------------------------------------------------------------------
// Preview panel

export interface LocalServer {
  port: number
  pid: number
  command: string
  cwd: string | null
  url: string
  http: boolean
}

/** An element the user picked in the preview to send to an agent. */
export interface PickedElement {
  id: string
  url: string
  title?: string
  selector: string
  tag: string
  html: string
  text: string
  /** Nearest framework components, innermost first, e.g. "PricingCard ‹ Pricing". */
  component?: string
  /** Source location from framework dev metadata, e.g. "src/components/Card.tsx:42". */
  source?: string
  styles: string
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  screenshot?: string
}

// ---------------------------------------------------------------------------
// Roles (agent templates)

export interface RoleTemplate {
  /** 'project:<relative file>' or 'custom:<id>' */
  id: string
  /** herdr agent name, a-z0-9-_ */
  name: string
  /** Display and tab label */
  label: string
  kind: string
  args: string
  /** First message the agent receives after it starts. Empty = default for the role. */
  instructions: string
  source: 'project' | 'custom'
  /** Role file relative to the project, for project roles. */
  file?: string
  orchestrator?: boolean
  /** Model and reasoning level to start the agent with; empty = the agent's default. */
  model?: string
  effort?: string
}

// ---------------------------------------------------------------------------
// Settings

export type ThemeSetting = 'system' | 'light' | 'dark'

export interface AppSettings {
  session: string
  theme: ThemeSetting
  accent: 'orange' | 'blue' | 'green' | 'violet' | 'graphite'
  notifications: boolean
  notificationSound: boolean
  autoStartServer: boolean
  syncFocus: boolean
  defaultAgentKind: string
  terminalFontSize: number
  chatFontSize: number
  sendWithEnter: boolean
  recentFolders: string[]
  sidebarWidth: number
  sidebarMode: 'workspaces' | 'status'
  agentArgs: Record<string, string>
  showLimits: boolean
  /** Preview URL per project directory. */
  previewUrls: Record<string, string>
  language: 'system' | 'en' | 'ru' | 'es' | 'de' | 'zh'
  /** Global role templates the user defined. */
  roles: RoleTemplate[]
  /** Per project+role tweaks (kind, args, instructions, model), key "<cwd>::<role name>". */
  roleOverrides: Record<string, Partial<Pick<RoleTemplate, 'kind' | 'args' | 'instructions' | 'model' | 'effort'>>>
  /** Last model picked per agent kind in the New agent dialog. */
  agentModels: Record<string, ModelChoice>
  /** Tell agents started with a role how to open the preview panel. */
  agentPreviewHint: boolean
  appearance: AppearanceSettings
}

export const DEFAULT_SETTINGS: AppSettings = {
  session: 'default',
  theme: 'system',
  accent: 'orange',
  notifications: true,
  notificationSound: true,
  autoStartServer: true,
  syncFocus: true,
  defaultAgentKind: 'claude',
  terminalFontSize: 13,
  chatFontSize: 14,
  sendWithEnter: true,
  recentFolders: [],
  sidebarWidth: 272,
  sidebarMode: 'workspaces',
  agentArgs: {},
  showLimits: true,
  previewUrls: {},
  language: 'system',
  roles: [],
  roleOverrides: {},
  agentModels: {},
  agentPreviewHint: true,
  appearance: DEFAULT_APPEARANCE
}

export interface SendPromptRequest {
  paneId: string
  target: string
  agentKind: string | null
  text: string
  imagePaths: string[]
  isShell: boolean
}

export interface SendPromptResult {
  ok: boolean
  error?: string
  code?: string
}

// Task board (<project>/.drover/tasks.json)

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface BoardTask {
  id: string
  title: string
  status: TaskStatus
  /** herdr agent name */
  assignee?: string
  notes?: string
  /** When the task got its current status (as far as Drover saw). */
  since?: number
}

export interface TaskBoard {
  cwd: string
  exists: boolean
  tasks: BoardTask[]
  /** The file is not valid right now; tasks are the last good copy. */
  error?: string
}

export interface NewAgentRequest {
  workspaceId: string | null
  folder: string | null
  workspaceLabel?: string
  kind: string | null
  name: string | null
  placement: 'tab' | 'split-right' | 'split-down' | 'workspace-root' | 'existing'
  splitTarget?: string | null
  tabLabel?: string | null
  args: string[]
  prompt?: string
  worktreeBranch?: string | null
}

export interface NewAgentResult {
  ok: boolean
  paneId?: string
  error?: string
  code?: string
  needsAttention?: boolean
}

export class HerdrApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'HerdrApiError'
  }
}
