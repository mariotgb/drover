import type { OfficeToolEvidence } from '@shared/office'
import type { TranscriptTool } from '@shared/types'
import { commandsFromExecScript } from './script'
import { parseShellCommandChain, parseShellCommands, recognizeOfficeCommands } from './shell'
import type { OfficeAnalyzeContext, OfficeEventCandidate, OfficeToolCall } from './types'

const INHERITED_SESSION = '\0caller-session'
type Json = Record<string, unknown>
const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null
const parse = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function commands(name: string, input: unknown): (string | string[])[] {
  if (!['Bash', 'exec', 'exec_command', 'unified_exec', 'shell', 'container.exec',
    'local_shell', 'shell_command', 'functions.exec', 'functions.exec_command'].includes(name)) return []
  const tool = name.split('.').at(-1)!
  const args = object(parse(input))
  if (tool === 'exec' && name !== 'container.exec') {
    const code = typeof input === 'string' ? input : args?.code ?? args?.input
    return typeof code === 'string' ? commandsFromExecScript(code) : []
  }
  const value = tool === 'Bash' ? args?.command : args?.cmd ?? args?.command
  if (!['Bash', 'exec_command', 'unified_exec', 'shell', 'container.exec', 'local_shell', 'shell_command'].includes(tool)
    && name !== 'container.exec') return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [value]
  return []
}

/** Array commands are argv, not shell source: preserve literal quoting and spacing. */
function shellSource(command: string | string[]): string {
  if (typeof command === 'string') return command
  return command.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ')
}

/** Extract receipts only through known tool-output containers, never a substring search. */
function receipts(output: unknown): OfficeToolEvidence['results'] {
  const found: OfficeToolEvidence['results'] = []
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || found.length >= 256) return
    if (typeof value === 'string') {
      const clean = value.replace(/\x1b\[[0-9;]*m/g, '').trim()
      const parsed = parse(clean)
      if (parsed !== null && typeof parsed === 'object') { visit(parsed, depth + 1); return }
      // Codex's plain-text exec wrapper has a final Output: section.
      const marker = clean.match(/^(?:Chunk ID:|Wall time:)[\s\S]*?\n(?:Final output:|Output:)\n([\s\S]*)$/)
      if (marker) { visit(marker[1], depth + 1); return }
      // JSONL CLI responses may follow a warning; only complete standalone objects.
      for (const line of clean.split('\n')) {
        if (!line.trim().startsWith('{')) continue
        const o = parse(line)
        if (o && typeof o === 'object') visit(o, depth + 1)
      }
      return
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    const o = object(value)
    if (!o) return
    const result = object(o.result), agent = object(result?.agent)
    if (o.id === 'cli:agent:prompt' && result?.type === 'agent_prompted' && typeof agent?.pane_id === 'string') {
      found.push({ paneId: agent.pane_id, ...(typeof agent.name === 'string' ? { name: agent.name } : {}) })
      return
    }
    if (['text', 'input_text', 'output_text'].includes(String(o.type)) && typeof o.text === 'string') visit(o.text, depth + 1)
    else if (Object.hasOwn(o, 'output')) visit(o.output, depth + 1)
    else if (Object.hasOwn(o, 'content')) visit(o.content, depth + 1)
    // exec's orchestration tools can emit their return object as {output,exit_code}.
  }
  visit(output, 0)
  return found
}

function purePromptSources(sources: string[]): boolean {
  // A chain that can print fabricated JSON cannot establish a herdr receipt's origin.
  // Mixed commands still produce attempts, but only pure prompt chains confirm delivery.
  return sources.length > 0 && sources.every((source) => {
    const parsed = parseShellCommandChain(source)
    const recognized = recognizeOfficeCommands(source, { session: INHERITED_SESSION })
    return parsed.complete && parsed.commands.length > 0 && parsed.commands.length === recognized.length && recognized.every((c) => c.kind === 'prompt')
  })
}

/** Called by transcript parsers before they truncate input/output for chat display. */
export function extractOfficeToolEvidence(name: string, input: unknown, output?: unknown): OfficeToolEvidence {
  const sources = commands(name, input).map(shellSource)
  return { version: 1, input, results: purePromptSources(sources) ? receipts(output) : [] }
}

export function analyzeToolCall(call: OfficeToolCall, context: OfficeAnalyzeContext): OfficeEventCandidate[] {
  const resultBlock = object(call.output)
  const wrongCall = (typeof resultBlock?.tool_use_id === 'string' && resultBlock.tool_use_id !== call.id) ||
    (typeof resultBlock?.call_id === 'string' && resultBlock.call_id !== call.id)
  const evidence = call.evidence ?? extractOfficeToolEvidence(call.name, call.input, wrongCall ? undefined : call.output)
  const sources = commands(call.name, evidence.input).map(shellSource)
  // Revalidate stored evidence too: cached receipts must never bypass chain safety.
  const results = purePromptSources(sources) ? evidence.results : []
  const events: OfficeEventCandidate[] = []
  const used = new Set<number>()
  let offset = 0
  const allCommands = sources.flatMap((source) => {
    const recognized = recognizeOfficeCommands(source, context).map((c) => ({ ...c, commandIndex: c.commandIndex + offset }))
    offset += parseShellCommands(source).length
    return recognized
  })
  // Herdr's CLI receipt has no session field. Equal pane IDs in different
  // sessions make combined results ambiguous even if one name is known locally.
  const singleSession = new Set(allCommands.filter((c) => c.kind === 'prompt').map((c) => c.session)).size === 1
  const parsedCommands = sources.flatMap(source => parseShellCommands(source))
  for (const command of allCommands) {
    const ts = call.ts ?? context.observedAt
    const commandIndex = command.commandIndex
    if (command.kind === 'ssh_attempt') {
      events.push({ from: context.from, to: context.resolveMachine?.(command.alias) ?? null,
        kind: 'ssh_attempt', ts, summary: 'Запущена SSH-команда', commandIndex, confidence: 'attempt' })
      continue
    }
    const target = context.resolveAgent(command.session, command.target)
    // Keep receipts tied to this session and target. Repeated targets with fewer
    // receipts are ambiguous, so don't assign a receipt to an arbitrary command.
    const sameTarget = allCommands.filter((c) => c.kind === 'prompt' && c.session === command.session &&
      target && context.resolveAgent(c.session, c.target)?.id === target.id).length
    const matching = results.map((r, index) => ({ r, index })).filter(({ r }) =>
      singleSession && target && command.session === context.session && r.paneId === target.paneId &&
      (command.target === r.paneId || (r.name === command.target && (!target.name || target.name === r.name))))
    const receipt = matching.length === sameTarget ? matching.find(({ index }) => !used.has(index)) : undefined
    if (receipt) used.add(receipt.index)
    const confirmed = !!receipt
    if (confirmed && target && context.onConfirmedPrompt) {
      const argv = parsedCommands[commandIndex]?.argv ?? []
      const agentIndex = argv.indexOf('agent')
      if (agentIndex >= 0 && argv[agentIndex + 1] === 'prompt') context.onConfirmedPrompt(target.paneId, argv[agentIndex + 3])
    }
    events.push({ from: context.from, to: target?.id ?? null, kind: confirmed ? 'prompt' : 'prompt_attempt',
      ts, summary: confirmed ? 'Сообщение доставлено' : 'Попытка отправки', commandIndex,
      confidence: confirmed ? 'confirmed' : 'attempt' })
  }
  return events
}

export function analyzeTranscriptTool(tool: TranscriptTool, context: OfficeAnalyzeContext): OfficeEventCandidate[] {
  // Display commands were extracted with permissive regexes and aren't execution evidence.
  if (!tool.officeEvidence) return []
  return analyzeToolCall({ id: tool.id, name: tool.name, ts: tool.ts, evidence: tool.officeEvidence }, context)
}
