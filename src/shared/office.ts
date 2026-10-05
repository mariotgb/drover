/** Desktop-only office protocol. No transcript text, commands or filesystem paths. */
export const OFFICE_LIMITS = {
  historyMs: 30 * 60_000, decayMs: 5 * 60_000, maxEvents: 1000,
  updateMs: 100, graceMs: 30_000, lookupConcurrency: 4, maxHistoryBytes: 10 * 1024 * 1024,
  pairAnimationMs: 2000, maxAnimations: 12, maxAnimationQueue: 20, animationTtlMs: 5000
} as const
export type OfficeNodeId = string
export type OfficeEventKind = 'prompt' | 'prompt_attempt' | 'user_prompt' | 'input_observed' |
  'task_created' | 'task_assigned' | 'task_status' | 'ssh_attempt' | 'agent_status'
export type OfficeStatus = 'working' | 'blocked' | 'idle' | 'done' | 'unknown' | 'disconnect'
export type OfficeRole = 'lead' | 'backend' | 'frontend' | 'devops' | 'docs' | 'reviewer' | 'designer' | 'general'
export type OfficeRoleSource = 'binding' | 'projectLead' | 'template' | 'name' | 'default'
/** Known kinds use their sprite; future/unknown kinds use the general sprite. */
export type OfficeAgentKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'copilot' | 'amp' | 'droid' | (string & {})
export type OfficeTranscriptCoverage = 'exact' | 'heuristic' | 'unavailable' | 'loading' | 'history_limit'
export interface OfficeEvent {
  from: OfficeNodeId | null
  to: OfficeNodeId | null
  kind: OfficeEventKind
  /** Unix milliseconds; board events use observation time. */
  ts: number
  /** Template only, never a truncated prompt/command/task title. */
  summary: string
}
export interface OfficeUIEvent extends OfficeEvent { id: string }
/** Main-only provenance. Never serialize this envelope to the renderer. */
export interface OfficeEventEnvelope extends OfficeUIEvent {
  source: 'transcript' | 'board' | 'herdr' | 'ui'
  sourceRef: string
  observedAt: number
  confidence: 'confirmed' | 'attempt' | 'observed'
}
/** Main-only parser evidence. Strip from every transcript IPC/remote response. */
export interface OfficeToolEvidence {
  version: 1
  /** Original tool arguments/JS input; never expose to the office renderer. */
  input: unknown
  /** Only explicit agent_prompted receipts; no output text or error messages. */
  results: { paneId: string; name?: string }[]
}
export interface OfficePoint { x: number; y: number }
export interface OfficeRect extends OfficePoint { width: number; height: number }
export interface OfficeDepartment {
  id: OfficeNodeId
  workspaceId: string
  name: string
  number: number
}
/** Stable logical slot; renderer owns persisted world geometry. */
export interface OfficeSeat {
  id: string
  departmentId: OfficeNodeId
  index: number
  paneId: string | null
  agentId: OfficeNodeId | null
  terminal: boolean
}
export interface OfficeAgent {
  id: OfficeNodeId
  paneId: string
  incarnation: string
  kind: OfficeAgentKind
  name: string
  role: OfficeRole
  roleSource: OfficeRoleSource
  departmentId: OfficeNodeId
  seatId: string
  status: OfficeStatus
  lastStatusAt: number
  transcriptCoverage: OfficeTranscriptCoverage
}
export interface OfficeExternalNode {
  id: OfficeNodeId
  kind: 'user' | 'machine'
  name: string
}
export interface OfficeLink {
  id: string
  from: OfficeNodeId
  to: OfficeNodeId
  kind: OfficeEventKind
  count: number
  lastAt: number
  /** Sum(exp(-age / 5min)) over the complete 30min window. */
  weight: number
  style: 'agent' | 'user' | 'board' | 'machine' | 'attempt'
}
export interface OfficeAnimation {
  id: string
  from: OfficeNodeId
  to: OfficeNodeId
  kind: 'prompt' | 'user_prompt'
  count: number
  ts: number
}
export interface OfficeState {
  session: string
  generation: string
  departments: OfficeDepartment[]
  seats: OfficeSeat[]
  agents: OfficeAgent[]
  externalNodes: OfficeExternalNode[]
  links: OfficeLink[]
  recentEvents: OfficeUIEvent[]
}
/** Full compact state at <=10Hz, with only fresh effects. init has no animations. */
export interface OfficeUpdate { state: OfficeState; animations: OfficeAnimation[] }
export interface OfficeInitRequest { visible?: boolean }

export type OfficeSpriteState = Exclude<OfficeStatus, 'disconnect'>
export type OfficeDirection = 'front' | 'back'
export type OfficeAtlasId = 'tiles' | 'agents' | 'roles' | 'effects'
export interface OfficeArtFrame {
  rect: OfficeRect
  anchor: OfficePoint
  /** Relative to frame top-left; click target before camera transformation. */
  hitRect: OfficeRect
}
export interface OfficeArtAnimation {
  frames: OfficeArtFrame[]
  /** Exactly one positive duration per frame. */
  durationsMs: number[]
  loop: boolean
}
export interface OfficeArtSprite {
  atlas: OfficeAtlasId
  layers: string[]
  states: Record<string, OfficeArtAnimation>
}
/** Assets are imported through Vite; atlas filenames are relative, never fs paths. */
export interface OfficeArtManifestV1 {
  version: 1
  tile: { width: 16; height: 16 }
  character: { width: 32; height: 48; anchor: { x: 16; y: 44 } }
  atlases: Record<OfficeAtlasId, { file: string; width: number; height: number }>
  /** Global draw order within an anchor Y; e.g. floor, body, role, furniture, effect. */
  layers: string[]
  sprites: Record<string, OfficeArtSprite>
}
export type OfficeManifestV1 = OfficeArtManifestV1
