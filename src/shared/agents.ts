// Catalogue of agent kinds herdr knows how to launch (`herdr agent start --kind`).

export interface AgentKindDef {
  kind: string
  label: string
  /** Binary looked up in PATH to decide whether the agent is installed. */
  binaries: string[]
  /** Short glyph for avatars. */
  glyph: string
  /** Avatar hue (HSL degrees). */
  hue: number
  /** Chat view from native transcripts is supported. */
  transcript: boolean
}

export const AGENT_KINDS: AgentKindDef[] = [
  { kind: 'claude', label: 'Claude Code', binaries: ['claude'], glyph: '✳', hue: 18, transcript: true },
  { kind: 'codex', label: 'Codex', binaries: ['codex'], glyph: '◎', hue: 210, transcript: true },
  { kind: 'gemini', label: 'Gemini CLI', binaries: ['gemini'], glyph: '✦', hue: 225, transcript: false },
  { kind: 'opencode', label: 'OpenCode', binaries: ['opencode'], glyph: '⌬', hue: 160, transcript: false },
  { kind: 'cursor', label: 'Cursor Agent', binaries: ['cursor-agent', 'agent'], glyph: '▲', hue: 0, transcript: false },
  { kind: 'copilot', label: 'GitHub Copilot CLI', binaries: ['copilot'], glyph: '⬡', hue: 265, transcript: false },
  { kind: 'amp', label: 'Amp', binaries: ['amp'], glyph: '⚡', hue: 45, transcript: false },
  { kind: 'droid', label: 'Droid', binaries: ['droid'], glyph: '◆', hue: 30, transcript: false },
  { kind: 'grok', label: 'Grok CLI', binaries: ['grok'], glyph: '✕', hue: 0, transcript: false },
  { kind: 'qwen', label: 'Qwen Code', binaries: ['qwen'], glyph: '◈', hue: 250, transcript: false },
  { kind: 'kimi', label: 'Kimi Code', binaries: ['kimi'], glyph: '☾', hue: 200, transcript: false },
  { kind: 'kiro', label: 'Kiro', binaries: ['kiro-cli', 'kiro'], glyph: '◐', hue: 280, transcript: false },
  { kind: 'devin', label: 'Devin CLI', binaries: ['devin'], glyph: '◇', hue: 190, transcript: false },
  { kind: 'cline', label: 'Cline', binaries: ['cline'], glyph: '◉', hue: 140, transcript: false },
  { kind: 'kilo', label: 'Kilo Code', binaries: ['kilo', 'kilocode'], glyph: '⬢', hue: 55, transcript: false },
  { kind: 'agy', label: 'Antigravity CLI', binaries: ['agy', 'antigravity'], glyph: '◭', hue: 215, transcript: false },
  { kind: 'hermes', label: 'Hermes Agent', binaries: ['hermes'], glyph: '☿', hue: 300, transcript: false },
  { kind: 'qodercli', label: 'Qoder CLI', binaries: ['qodercli'], glyph: 'Q', hue: 170, transcript: false },
  { kind: 'letta', label: 'Letta Code', binaries: ['letta'], glyph: 'L', hue: 120, transcript: false },
  { kind: 'mastracode', label: 'MastraCode', binaries: ['mastracode'], glyph: 'M', hue: 330, transcript: false },
  { kind: 'pi', label: 'Pi', binaries: ['pi'], glyph: 'π', hue: 95, transcript: false },
  { kind: 'omp', label: 'OMP', binaries: ['omp'], glyph: 'O', hue: 75, transcript: false },
  { kind: 'maki', label: 'Maki', binaries: ['maki'], glyph: 'K', hue: 350, transcript: false },
  { kind: 'muse', label: 'Muse', binaries: ['muse'], glyph: '♪', hue: 310, transcript: false }
]

export function agentKindDef(kind: string | null | undefined): AgentKindDef | undefined {
  if (!kind) return undefined
  const k = kind.toLowerCase()
  return AGENT_KINDS.find((d) => d.kind === k || d.label.toLowerCase() === k)
}

export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** Normalize arbitrary text into a valid herdr agent name. */
export function toAgentName(raw: string): string {
  let s = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(s)) s = 'a' + s
  return s.slice(0, 32)
}
