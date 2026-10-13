import type { ModelChoice } from './models'

export interface AgentLaunch extends ModelChoice {
  kind: 'claude' | 'codex'
  terminalId: string
  args: string[]
  bypass: boolean
  sessionId?: string | null
  name?: string | null
  cwd?: string | null
  processId?: number
  /** Only explicit model-menu changes override the original argv. */
  choice?: ModelChoice
  /** An inline/private option was omitted; do not invent a replacement launch. */
  restoreUnavailable?: boolean
}

export interface RestartSelection { paneId?: string; workspaceId?: string; bypass: boolean }
export interface RestartCandidate {
  paneId: string
  name: string
  kind: 'claude' | 'codex'
  sessionId: string | null
  bypass: boolean
}
export interface RestartPlan {
  token: string
  bypass: boolean
  agents: RestartCandidate[]
  skipped: { paneId: string; name: string; reason: string }[]
}
export interface RestartResult {
  paneId: string
  name: string
  ok: boolean
  code?: string
  error?: string
}
