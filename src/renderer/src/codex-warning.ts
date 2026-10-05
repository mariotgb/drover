import type { CodexIntegrationStatus } from '@shared/codexIntegration'

/** Counts alone cannot distinguish a replaced missing-session agent or a new error. */
export function codexWarningKey(status: CodexIntegrationStatus | null): string | null {
  if (status?.status !== 'warning') return null
  return status.warningKey ?? JSON.stringify([status.installed, status.outdated, status.reportErrors,
    status.missingSessions, status.staleDaemonContext])
}
