import type { TranscriptMeta, TranscriptTool } from '@shared/types'
import { extractOfficeToolEvidence } from '../office/analyze'
import { ItemStore, type TranscriptParser } from './store'
import { parseTs } from './util'

const COMMANDS = new Set(['Bash', 'exec', 'exec_command', 'unified_exec', 'shell', 'container.exec', 'local_shell', 'shell_command', 'functions.exec', 'functions.exec_command'])
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const injected = /^(?:# AGENTS\.md instructions|<(?:environment_context|user_instructions|INSTRUCTIONS|permissions instructions|collaboration_mode|skills_instructions|turn_aborted|user_shell_command|subagent_notification))/

/** Office-only projection: bounded command correlation, no diffs/images/chat bodies. */
export class OfficeParser implements TranscriptParser {
  store = new ItemStore()
  meta: Partial<TranscriptMeta>
  private sequence = 0
  private turn = ''
  constructor(private kind: 'claude' | 'codex') { this.meta = { agent: kind, coverage: 'tail' } }
  feed(lines: string[]) {
    for (const line of lines) {
      try {
        const o: Json = JSON.parse(line), ts = parseTs(o.timestamp)
        if (this.kind === 'claude') this.claude(o, ts)
        else this.codex(o, ts)
      } catch { /* malformed or unsupported record cannot establish evidence */ }
      this.store.trim(512)
    }
  }
  private user(id: string, text: unknown, ts?: number) {
    if (typeof text !== 'string' || !text.trim() || injected.test(text.trim())) return
    // Retain text only in the main-only observer to match specific UI receipts.
    this.store.upsert({ kind: 'user', id, text, images: [], ts })
  }
  private call(id: string, name: string, input: unknown, ts?: number) {
    if (!COMMANDS.has(name)) return
    const previous = this.store.get(id)
    this.store.upsert({ kind: 'tool', id, name, title: name, category: 'command', ts,
      status: previous?.kind === 'tool' ? previous.status : 'running',
      officeEvidence: extractOfficeToolEvidence(name, input) })
  }
  private result(id: string, output: unknown, error = false) {
    const item = this.store.get(id)
    if (item?.kind !== 'tool') return
    this.store.upsert({ ...item, status: error ? 'error' : 'done',
      officeEvidence: extractOfficeToolEvidence(item.name, item.officeEvidence?.input, output) } as TranscriptTool)
  }
  private claude(o: Json, ts?: number) {
    if (o.isSidechain) return
    const id = typeof o.uuid === 'string' ? o.uuid : `office-${++this.sequence}`
    const content = o.message?.content
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use' && typeof b.id === 'string') this.call(b.id, b.name, b.input, ts)
    } else if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'tool_result') this.result(b.tool_use_id, b.content, b.is_error)
        if (!o.isMeta && !o.isCompactSummary) this.user(id, content.filter(b => b?.type === 'text').map(b => b.text).join('\n\n'), ts)
      } else if (!o.isMeta && !o.isCompactSummary) this.user(id, content, ts)
    } else if (o.type === 'attachment' && o.attachment?.type === 'queued_command') {
      const a = o.attachment
      if ((!a.commandMode || a.commandMode === 'prompt') && (!a.origin?.kind || a.origin.kind === 'human')) {
        this.user(id, Array.isArray(a.prompt) ? a.prompt.filter((b: Json) => b?.type === 'text').map((b: Json) => b.text).join('\n\n') : a.prompt, parseTs(a.timestamp) ?? ts)
      }
    }
  }
  private codex(o: Json, ts?: number) {
    const p = o.payload || {}
    if (o.type === 'turn_context' && typeof p.turn_id === 'string') this.turn = p.turn_id
    if (o.type === 'event_msg') {
      if (p.type === 'task_started' && typeof p.turn_id === 'string') this.turn = p.turn_id
      if (p.type === 'user_message') this.user(this.turn ? `user:${this.turn}` : `office-user-${++this.sequence}`, p.message, ts)
      if (p.type === 'item_completed' && p.item?.type === 'UserMessage') this.user(`user:${p.turn_id || this.turn || ++this.sequence}`, (p.item.content || []).filter((b: Json) => b?.type === 'text').map((b: Json) => b.text).join('\n'), ts)
      return
    }
    if (o.type !== 'response_item') return
    const turn = p.internal_chat_message_metadata_passthrough?.turn_id
    if (typeof turn === 'string') this.turn = turn
    const id = p.call_id || p.id
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      if (typeof id === 'string') this.call(id, p.name, p.type === 'custom_tool_call' ? p.input : p.arguments, ts)
    } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
      this.result(id, p.output)
    } else if (p.type === 'local_shell_call' && typeof id === 'string') {
      this.call(id, 'shell', { command: p.action?.command }, ts)
    } else if (p.type === 'message' && p.role === 'user') {
      const texts = (p.content || []).filter((b: Json) => b?.type === 'input_text' && typeof b.text === 'string' && !injected.test(b.text.trim())).map((b: Json) => b.text)
      this.user(this.turn ? `user:${this.turn}` : `office-user-${++this.sequence}`, texts.join('\n'), ts)
    }
  }
}
