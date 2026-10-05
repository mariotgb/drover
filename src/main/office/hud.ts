import type { OfficeAgent, OfficeEvent, OfficeState, OfficeStatus } from '@shared/office'

export function statusCounts(agents: readonly OfficeAgent[]): Record<OfficeStatus, number> {
  const counts = { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0, disconnect: 0 }
  for (const agent of agents) counts[agent.status]++
  return counts
}

/** Board titles are opt-in task labels, never extracted from a prompt/tool call.
 * Reject path/command/credential-shaped titles as a whole, before truncation.
 */
export function boardTaskTitle(title: string): string | null {
  const label = title.trim()
  if (!label || /[\u0000-\u001f\u007f/\\`$|<>;]/u.test(label) ||
    /^(?:sudo|env|cd|pwd|ls|cat|echo|printf|rm|mv|cp|chmod|curl|wget|ssh|scp|git|npm|npx|pnpm|yarn|bun|node|python\d*|bash|zsh|sh|herdr|make)\b/i.test(label) ||
    /\b(?:[A-Z_][A-Z0-9_]*_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/i.test(label) ||
    /\bBearer\s+\S+/i.test(label) ||
    /\b[0-9a-f]{32,}\b/i.test(label) ||
    /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9_=-])/u.test(label)) return null
  return label.slice(0, 160)
}

/** Only node display names and fixed phrases. No task titles or parser evidence. */
export function journalSummary(event: OfficeEvent, state: Pick<OfficeState, 'agents' | 'departments' | 'externalNodes'>): string {
  const name = (id: string | null) => id === 'user' ? 'Вы' :
    state.agents.find(a => a.id === id)?.name || state.departments.find(d => d.id === id)?.name ||
    state.externalNodes.find(n => n.id === id)?.name || 'Агент'
  const pair = () => `${name(event.from)} → ${name(event.to)}`
  switch (event.kind) {
    case 'prompt': case 'user_prompt': return `${pair()} · задача`
    case 'prompt_attempt': return `${pair()} · не подтверждено`
    case 'input_observed': return `${name(event.to)} · входящее сообщение · не подтверждено`
    case 'task_created': return `${name(event.from)} · новая задача`
    case 'task_assigned': return event.to ? `${pair()} · задача назначена` : `${name(event.from)} · задача назначена`
    case 'task_status': return `${name(event.to || event.from)} · статус задачи изменён`
    case 'ssh_attempt': return `${pair()} · SSH · не подтверждено`
    case 'agent_status': {
      const labels: Record<OfficeStatus, string> = { working: 'работает', blocked: 'ждёт ответа', idle: 'свободен',
        done: 'готово', unknown: 'статус неизвестен', disconnect: 'данные устарели' }
      return `${name(event.from)} · ${labels[event.status || 'unknown']}`
    }
  }
}
