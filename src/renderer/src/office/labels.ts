import { agentKindDef } from '@shared/agents'
import type { OfficeAgent, OfficeStatus, OfficeTranscriptCoverage } from '@shared/office'
import { t } from '../i18n'
export function statusLabel(status: OfficeStatus): string {
  const labels = { working: t('Working'), blocked: t('Waiting for input'), idle: t('Available'), done: t('Done'), unknown: t('Unknown status'), disconnect: t('Stale data') }
  return Object.hasOwn(labels, status) ? labels[status] : labels.unknown
}
export function roleLabel(agent: Pick<OfficeAgent, 'role' | 'roleSource'>): string {
  const roles = { lead: t('Team lead'), backend: t('Backend'), frontend: t('Frontend'), devops: t('Infrastructure'), docs: t('Documentation'), reviewer: t('Review'), designer: t('Design'), general: t('General role') }
  const role = Object.hasOwn(roles, agent.role) ? roles[agent.role] : roles.general
  return agent.roleSource === 'name' ? t('{role} (inferred from name)', { role }) : role
}
export const kindLabel = (kind: string) => agentKindDef(kind)?.label ?? kind
export const opensChat = (agent: OfficeAgent) => !!agentKindDef(agent.kind)?.transcript
export function coverageLabel(coverage: OfficeTranscriptCoverage): string {
  switch (coverage) {
    case 'heuristic': return t('Interaction history is not matched exactly')
    case 'unavailable': return t('Interaction history is unavailable')
    case 'loading': return t('Loading interaction history')
    case 'history_limit': return t('Interaction history was not loaded: size limit exceeded')
    default: return ''
  }
}
