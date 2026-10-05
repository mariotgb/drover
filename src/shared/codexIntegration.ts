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
export interface CodexDaemonRestartResult {
  code: number
  stdout: string
  stderr: string
  status: CodexIntegrationStatus
}
