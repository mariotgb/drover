// Models an agent can run with and how to ask for one at launch.

export interface ModelOption {
  /** Value the agent understands: a Claude Code alias or a Codex model slug. */
  id: string
  label: string
  description?: string
  /** Reasoning levels this model supports, in menu order. */
  efforts: string[]
  defaultEffort?: string
}

export interface ModelCatalog {
  claude: ModelOption[]
  codex: ModelOption[]
}

/** null/empty = leave it to the agent's own settings. */
export interface ModelChoice {
  model?: string | null
  effort?: string | null
}

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude Code aliases always point at the newest model of each family. */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus', description: 'For complex work and everyday tasks', efforts: CLAUDE_EFFORTS },
  { id: 'fable', label: 'Fable', description: 'For the toughest challenges', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', label: 'Sonnet', description: 'Efficient for simpler tasks', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', label: 'Haiku', description: 'Fastest, for quick answers', efforts: [] }
]

export function supportsModels(kind: string | null | undefined): kind is 'claude' | 'codex' {
  return kind === 'claude' || kind === 'codex'
}

export function modelsFor(catalog: ModelCatalog | null, kind: string | null | undefined): ModelOption[] {
  if (!catalog || !supportsModels(kind)) return []
  return catalog[kind]
}

/** Keeps a choice only if it can belong to this agent (a role may name a Claude model for Codex). */
export function choiceFor(kind: string | null | undefined, choice: ModelChoice | null | undefined, catalog: ModelCatalog | null): ModelChoice {
  if (!supportsModels(kind) || !choice) return {}
  let model = choice.model?.trim() || null
  if (model) {
    const listed = catalog?.[kind].some((m) => m.id === model)
    const looks = kind === 'claude' ? /^(claude-|opus|sonnet|haiku|fable|opusplan|default|best)/i.test(model) : !/^(claude-|opus|sonnet|haiku|fable)/i.test(model)
    if (!listed && !looks) model = null
  }
  return { model, effort: choice.effort?.trim() || null }
}

/** Command-line flags that start the agent with this model and reasoning level. */
export function modelArgs(kind: string | null | undefined, choice: ModelChoice | null | undefined): string[] {
  const model = choice?.model?.trim()
  const effort = choice?.effort?.trim()
  if (kind === 'claude') return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
  if (kind === 'codex') return [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])]
  return []
}

/** Agents that can be started without permission prompts. */
export function supportsBypass(kind: string | null | undefined): boolean {
  return kind === 'claude' || kind === 'codex'
}

/** Flags that let the agent run commands and edit files without asking. */
export function bypassArgs(kind: string | null | undefined, on: boolean | undefined): string[] {
  if (!on) return []
  if (kind === 'claude') return ['--dangerously-skip-permissions']
  if (kind === 'codex') return ['--dangerously-bypass-approvals-and-sandbox']
  return []
}

/** Short name for a model id as agents report it, e.g. claude-sonnet-5-5 → Sonnet 5.5. */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return ''
  const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/)
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`
  const alias = CLAUDE_MODELS.find((m) => m.id === id)
  if (alias) return alias.label
  if (/^gpt-/i.test(id)) return id.replace(/^gpt-/i, 'GPT-').replace(/-([a-z])/g, (_, c: string) => '-' + c.toUpperCase())
  return id
}
