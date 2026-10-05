export interface CodexIntegrationStatus {
  status: 'ok' | 'warning' | 'unavailable'
  installed: boolean
  outdated: boolean
  reportErrors: number
  integrationVersion: number | null
  herdrVersion: string | null
  message: string
  missingSessions?: number
  noDaemonSupported?: boolean
  daemonRunning?: boolean
  staleDaemonContext?: boolean
  /** Changes when the concrete warning causes change, not on routine polling. */
  warningKey?: string
}

export interface CodexIntegrationInstallResult {
  code: number
  stdout: string
  stderr: string
  status: CodexIntegrationStatus
}

export interface CodexDaemonAgent {
  session: string
  paneId: string
  name: string
  status: import('./types').AgentStatus
  hasSession: boolean
}
export interface CodexDaemonRestartPlan {
  token: string
  expiresAt: number
  agents: CodexDaemonAgent[]
  busy: boolean
  daemonRunning: boolean
  canRestart: boolean
  reason?: string
  otherClientsMayBeAffected: boolean
}
export interface CodexDaemonPlanChangedResult {
  outcome: 'plan_changed'
  plan: CodexDaemonRestartPlan
}
export type CodexDaemonRestartResult = CodexDaemonPlanChangedResult | {
  outcome: 'completed'
  code: number
  stdout: string
  stderr: string
  status: CodexIntegrationStatus
}
