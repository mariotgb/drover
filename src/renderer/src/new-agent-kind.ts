import type { AgentKindInfo } from '@shared/types'

export function installedDefaultAgent(preferred: string | null, kinds: AgentKindInfo[]): string | null {
  if (preferred === null) return null
  return kinds.find(k => k.kind === preferred && k.installed)?.kind ?? kinds.find(k => k.installed)?.kind ?? null
}

/** Official setup pages; no installer is downloaded or executed by Drover. */
export function agentInstallationGuide(kind: string): string | undefined {
  const guides: Record<string, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    codex: 'https://developers.openai.com/codex/cli/',
    gemini: 'https://geminicli.com/docs/get-started/installation/',
    opencode: 'https://opencode.ai/docs/',
    cursor: 'https://cursor.com/docs/cli/installation'
  }
  return Object.hasOwn(guides, kind) ? guides[kind] : undefined
}
