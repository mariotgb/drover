import type { DiffFile, ImageRef, TodoItem, ToolCategory, TranscriptMeta, TranscriptTool } from '@shared/types'
import { parseApplyPatch } from './diff'
import { ItemStore, type TranscriptParser } from './store'
import {
  T,
  dataUrl,
  displayPath,
  fileUrl,
  firstLine,
  parseTs,
  prettyInput,
  safeJson,
  stripImagePlaceholders,
  str,
  truncate
} from './util'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

interface ToolDescription {
  category: ToolCategory
  title: string
  titleKey?: string
  titleParams?: Record<string, string | number>
  titleOne?: string
  detail?: string
  input?: string
  diff?: DiffFile[]
  todos?: TodoItem[]
  commands?: string[]
}

/** Context blocks Codex injects into user messages. */
const INJECTED = [
  /^# AGENTS\.md instructions/,
  /^<environment_context>/,
  /^<user_instructions>/,
  /^<INSTRUCTIONS>/,
  /^<permissions instructions>/,
  /^<collaboration_mode>/,
  /^<skills_instructions>/,
  /^<turn_aborted>/,
  /^<user_shell_command>/,
  /^<subagent_notification>/
]

function shellCommand(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd
  if (Array.isArray(cmd)) {
    const parts = cmd.map(String)
    const i = parts.findIndex((p) => p === '-lc' || p === '-c')
    if (i >= 0 && i + 1 < parts.length) return parts[i + 1]
    return parts.join(' ')
  }
  return ''
}

/** Codex's `exec` tool runs a JS program calling tools.exec_command({cmd}). */
function commandsFromScript(code: string): string[] {
  const out: string[] = []
  const re = /\b(?:cmd|command)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) && out.length < 40) {
    const lit = m[1]
    let val = lit.slice(1, -1)
    if (lit[0] === '"') {
      try {
        val = JSON.parse(lit)
      } catch {
        /* keep raw */
      }
    } else {
      val = val.replace(/\\n/g, '\n').replace(/\\(['`\\])/g, '$1')
    }
    if (val.trim()) out.push(val)
  }
  return out
}

export function describeCodexTool(name: string, rawArgs: unknown, cwd?: string): ToolDescription {
  const args = safeJson(rawArgs) ?? {}
  const text = typeof rawArgs === 'string' ? rawArgs : ''
  switch (name) {
    case 'shell':
    case 'container.exec':
    case 'local_shell':
    case 'shell_command': {
      const cmd = shellCommand(args.command ?? args.cmd)
      return { category: 'command', ...(firstLine(cmd) ? { title: firstLine(cmd) } : T('Ran command')), commands: [cmd], detail: args.workdir ? displayPath(str(args.workdir), cwd) : undefined }
    }
    case 'exec_command':
    case 'unified_exec': {
      const cmd = shellCommand(args.cmd ?? args.command)
      return { category: 'command', ...(firstLine(cmd) ? { title: firstLine(cmd) } : T('Ran command')), commands: [cmd] }
    }
    case 'write_stdin':
      return { category: 'command', ...T('Sent input to a running command'), detail: firstLine(str(args.chars)) || undefined }
    case 'exec': {
      const code = text || str(args.code ?? args.input)
      if (/apply_patch\s*\(/.test(code) && /\*\*\* Begin Patch/.test(code)) {
        const files = parseApplyPatch(code.slice(code.indexOf('*** Begin Patch')))
        if (files.length) return patchDescription(files, cwd)
      }
      const commands = commandsFromScript(code)
      if (commands.length === 1) return { category: 'command', title: firstLine(commands[0]), commands, input: truncate(code, 8000) }
      if (commands.length > 1) return { category: 'command', ...T('Ran {n} commands', { n: commands.length }, 'Ran {n} command'), detail: firstLine(commands[0]), commands, input: truncate(code, 8000) }
      return { category: 'command', ...T('Ran a script'), input: truncate(code, 8000) }
    }
    case 'apply_patch': {
      const patch = text && !args.input ? text : str(args.input ?? args.patch ?? text)
      const files = parseApplyPatch(patch)
      if (files.length) return patchDescription(files, cwd)
      return { category: 'edit', ...T('Applied a patch'), input: truncate(patch, 8000) }
    }
    case 'update_plan': {
      const plan = Array.isArray(args.plan) ? args.plan : []
      const todos: TodoItem[] = plan.map((s: Json) => ({
        text: str(s?.step),
        status: s?.status === 'completed' || s?.status === 'in_progress' ? s.status : 'pending'
      }))
      const done = todos.filter((t) => t.status === 'completed').length
      return { category: 'todo', ...T('Updated plan · {done}/{total} done', { done, total: todos.length }), todos, detail: args.explanation ? firstLine(str(args.explanation)) : undefined }
    }
    case 'view_image':
      return { category: 'image', ...T('Viewed {path}', { path: displayPath(str(args.path), cwd) }), input: str(args.path) }
    case 'web_search':
    case 'web.run':
      return { category: 'web', ...(args.query ? T('Searched the web: {query}', { query: str(args.query) }) : T('Searched the web')) }
    case 'spawn_agent':
    case 'send_message':
    case 'send_input':
    case 'wait':
    case 'wait_agent':
    case 'close_agent':
    case 'resume_agent':
      return { category: 'agent', ...agentToolTitle(name, args), input: prettyInput(args, 6000) }
    default: {
      if (name.includes('__') || name.startsWith('mcp')) {
        const parts = name.split('__').filter(Boolean)
        return { category: 'mcp', title: parts.length > 1 ? `${parts[parts.length - 2]} · ${parts[parts.length - 1]}` : name, input: prettyInput(args, 6000) }
      }
      return { category: 'other', title: name, input: text ? truncate(text, 6000) : prettyInput(args, 6000) }
    }
  }
}

function agentToolTitle(name: string, args: Json) {
  switch (name) {
    case 'spawn_agent':
      return args.agent_type ? T('Started agent · {type}', { type: str(args.agent_type) }) : T('Started agent')
    case 'send_message':
    case 'send_input':
      return args.target || args.id ? T('Messaged agent · {target}', { target: str(args.target ?? args.id) }) : T('Messaged agent')
    case 'wait':
    case 'wait_agent':
      return T('Waited for agents')
    case 'close_agent':
      return T('Closed agent')
    default:
      return T('Resumed agent')
  }
}

function patchDescription(files: DiffFile[], cwd?: string): ToolDescription {
  const shown = files.map((f) => ({ ...f, path: displayPath(f.path, cwd) }))
  const title =
    shown.length === 1
      ? T(shown[0].kind === 'add' ? 'Created {path}' : shown[0].kind === 'delete' ? 'Deleted {path}' : 'Edited {path}', { path: shown[0].path })
      : T('Edited {n} files', { n: shown.length }, 'Edited {n} file')
  return { category: 'edit', ...title, diff: shown }
}

function outputFrom(v: unknown): { text: string; images: ImageRef[]; failed: boolean } {
  const images: ImageRef[] = []
  let failed = false
  const collect = (x: unknown): string => {
    if (typeof x === 'string') {
      const j = x.trim().startsWith('{') ? safeJson(x) : null
      if (j && typeof j.output === 'string') {
        const meta = j.metadata as Json | undefined
        if (meta && typeof meta.exit_code === 'number' && meta.exit_code !== 0) failed = true
        return j.output
      }
      return x
    }
    if (Array.isArray(x)) return x.map(collect).filter(Boolean).join('\n')
    if (x && typeof x === 'object') {
      const o = x as Json
      if (o.type === 'input_image' || o.type === 'image') {
        const url = str(o.image_url ?? o.url)
        if (url.startsWith('data:')) {
          const m = url.match(/^data:([^;]+);base64,(.*)$/)
          const img = m ? dataUrl(m[1], m[2]) : null
          if (img) images.push(img)
        }
        return ''
      }
      if (typeof o.text === 'string') return o.text
      if (o.content !== undefined) return collect(o.content)
      if (typeof o.output === 'string') return o.output
      if (o.success === false) failed = true
    }
    return ''
  }
  const text = collect(v)
  return { text, images, failed }
}

export class CodexParser implements TranscriptParser {
  store = new ItemStore()
  meta: Partial<TranscriptMeta> = { agent: 'codex' }
  private seq = 0
  private turn = ''

  feed(lines: string[]) {
    for (const line of lines) {
      let o: Json
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      try {
        this.line(o)
      } catch {
        /* ignore malformed records */
      }
    }
  }

  private nextId(prefix: string) {
    return `${prefix}-${++this.seq}`
  }

  private line(o: Json) {
    const ts = parseTs(o.timestamp)
    const p: Json = o.payload && typeof o.payload === 'object' ? o.payload : {}
    switch (o.type) {
      case 'session_meta':
        if (typeof p.cwd === 'string') this.meta.cwd = p.cwd
        if (typeof p.id === 'string') this.meta.sessionId = p.id
        return
      case 'turn_context':
        if (typeof p.model === 'string') this.meta.model = p.model
        if (typeof p.effort === 'string') this.meta.effort = p.effort
        if (typeof p.cwd === 'string') this.meta.cwd = p.cwd
        if (typeof p.turn_id === 'string') this.turn = p.turn_id
        return
      case 'compacted':
        this.store.event(this.nextId('compact'), 'compacted', 'Context compacted', ts)
        return
      case 'event_msg':
        return this.eventMsg(p, ts)
      case 'response_item':
        return this.responseItem(p, ts)
    }
  }

  private eventMsg(p: Json, ts?: number) {
    switch (p.type) {
      case 'task_started':
        if (typeof p.turn_id === 'string') this.turn = p.turn_id
        if (typeof p.model_context_window === 'number') this.meta.contextWindow = p.model_context_window
        return
      case 'token_count': {
        const info = p.info as Json | undefined
        const last = info?.last_token_usage as Json | undefined
        if (last) {
          const total = Number(last.input_tokens ?? 0) + Number(last.output_tokens ?? 0)
          if (total > 0) this.meta.contextTokens = total
        }
        if (info?.model_context_window) this.meta.contextWindow = Number(info.model_context_window)
        const primary = (p.rate_limits as Json | undefined)?.primary as Json | undefined
        if (primary && typeof primary.used_percent === 'number') this.meta.rateLimitPercent = primary.used_percent
        return
      }
      case 'task_complete': {
        this.store.settleRunning('done')
        const ms =
          typeof p.duration_ms === 'number'
            ? p.duration_ms
            : typeof p.completed_at === 'number' && typeof p.started_at === 'number'
              ? (p.completed_at - p.started_at) * 1000
              : undefined
        this.store.event(`turn-end:${str(p.turn_id) || this.nextId('t')}`, 'turn-end', '', ts, ms)
        return
      }
      case 'turn_aborted':
        this.store.settleRunning('error')
        this.store.event(`aborted:${str(p.turn_id) || this.nextId('a')}`, 'interrupted', p.reason === 'interrupted' ? 'Interrupted by user' : `Turn aborted (${str(p.reason)})`, ts)
        return
      case 'error':
        this.store.event(this.nextId('err'), 'error', str(p.message) || 'Error', ts)
        return
      case 'thread_name_updated':
        if (typeof p.thread_name === 'string') this.meta.title = p.thread_name
        else if (typeof p.name === 'string') this.meta.title = p.name
        return
      case 'user_message': {
        // Older Codex versions: the event carries the clean user text.
        const text = stripImagePlaceholders(str(p.message))
        const images: ImageRef[] = []
        for (const url of Array.isArray(p.images) ? p.images : []) {
          const m = str(url).match(/^data:([^;]+);base64,(.*)$/)
          const img = m ? dataUrl(m[1], m[2]) : null
          if (img) images.push(img)
        }
        for (const path of Array.isArray(p.local_images) ? p.local_images : []) images.push({ src: fileUrl(str(path)), path: str(path) })
        this.userItem(text, images, ts, 'event')
        return
      }
      case 'item_completed': {
        const item = p.item as Json | undefined
        if (item?.type === 'UserMessage') {
          const content: Json[] = Array.isArray(item.content) ? item.content : []
          const texts: string[] = []
          const images: ImageRef[] = []
          for (const c of content) {
            if (c?.type === 'text') texts.push(str(c.text))
            else if (c?.type === 'local_image' && c.path) images.push({ src: fileUrl(str(c.path)), path: str(c.path) })
            else if (c?.type === 'image' && typeof c.image_url === 'string') {
              const m = c.image_url.match(/^data:([^;]+);base64,(.*)$/)
              const img = m ? dataUrl(m[1], m[2]) : { src: c.image_url }
              if (img) images.push(img)
            }
          }
          this.userItem(stripImagePlaceholders(texts.join('\n')), images, ts, 'item', str(p.turn_id))
        }
        return
      }
    }
  }

  /** Dedupe the same user turn reported by response_item and event records. */
  private userItem(text: string, images: ImageRef[], ts: number | undefined, source: string, turnId?: string) {
    if (!text.trim() && !images.length) return
    const turn = turnId || this.turn
    const id = turn ? `user:${turn}` : this.nextId('user')
    const existing = this.store.get(id)
    if (existing?.kind === 'user') {
      // Prefer the cleaner item/event representation, keep images if missing.
      this.store.upsert({ ...existing, text: text || existing.text, images: images.length ? images : existing.images })
      return
    }
    if (!turn) {
      const last = [...this.store.items].reverse().find((i) => i.kind === 'user')
      if (last?.kind === 'user' && last.text.trim() === text.trim()) return
    }
    this.store.upsert({ kind: 'user', id, ts, text, images })
    void source
  }

  private responseItem(p: Json, ts?: number) {
    const turnId = str((p.internal_chat_message_metadata_passthrough as Json | undefined)?.turn_id)
    if (turnId) this.turn = turnId
    switch (p.type) {
      case 'message': {
        const content: Json[] = Array.isArray(p.content) ? p.content : []
        if (p.role === 'assistant') {
          const text = content.map((c) => (c?.type === 'output_text' || c?.type === 'text' ? str(c.text) : '')).join('')
          if (text.trim()) {
            this.store.upsert({
              kind: 'assistant',
              id: str(p.id) || this.nextId('msg'),
              ts,
              text,
              phase: p.phase === 'commentary' ? 'commentary' : p.phase === 'final_answer' ? 'final' : undefined
            })
          }
        } else if (p.role === 'user') {
          const texts: string[] = []
          const images: ImageRef[] = []
          for (const c of content) {
            if (c?.type === 'input_text') {
              const t = str(c.text)
              const trimmed = t.trim()
              if (trimmed.startsWith('<image') || trimmed === '</image>') continue
              if (INJECTED.some((re) => re.test(trimmed))) continue
              texts.push(t)
            } else if (c?.type === 'input_image' && typeof c.image_url === 'string') {
              const m = c.image_url.match(/^data:([^;]+);base64,(.*)$/)
              const img = m ? dataUrl(m[1], m[2]) : { src: c.image_url }
              if (img) images.push(img)
            }
          }
          this.userItem(stripImagePlaceholders(texts.join('\n')), images, ts, 'response', turnId)
        }
        return
      }
      case 'reasoning': {
        const summary: Json[] = Array.isArray(p.summary) ? p.summary : []
        const text = summary.map((s) => str(s?.text)).filter(Boolean).join('\n\n')
        if (text.trim()) this.store.upsert({ kind: 'thinking', id: str(p.id) || this.nextId('rs'), ts, text })
        return
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = str(p.call_id) || str(p.id) || this.nextId('call')
        const name = str(p.name)
        const d = describeCodexTool(name, p.type === 'custom_tool_call' ? p.input : p.arguments, this.meta.cwd)
        const existing = this.store.get(callId)
        this.store.upsert({
          kind: 'tool',
          id: callId,
          ts,
          name,
          status: existing?.kind === 'tool' ? existing.status : 'running',
          output: existing?.kind === 'tool' ? existing.output : undefined,
          ...d
        })
        return
      }
      case 'local_shell_call': {
        const callId = str(p.call_id) || str(p.id) || this.nextId('call')
        const action = (p.action as Json | undefined) ?? {}
        const cmd = shellCommand(action.command)
        this.store.upsert({
          kind: 'tool',
          id: callId,
          ts,
          name: 'shell',
          category: 'command',
          ...(firstLine(cmd) ? { title: firstLine(cmd) } : T('Ran command')),
          commands: [cmd],
          status: p.status === 'completed' ? 'done' : 'running'
        })
        return
      }
      case 'web_search_call': {
        const action = (p.action as Json | undefined) ?? {}
        this.store.upsert({
          kind: 'tool',
          id: str(p.id) || this.nextId('ws'),
          ts,
          name: 'web_search',
          category: 'web',
          ...(action.query ? T('Searched the web: {query}', { query: str(action.query) }) : T('Searched the web')),
          status: 'done'
        })
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const callId = str(p.call_id)
        const item = this.store.get(callId)
        if (!item || item.kind !== 'tool') return
        const out = outputFrom(p.output)
        const next: TranscriptTool = {
          ...item,
          output: truncate(out.text.replace(/\x1b\[[0-9;]*m/g, '')),
          outputImages: out.images.length ? out.images : item.outputImages,
          status: out.failed ? 'error' : 'done'
        }
        if (item.name === 'view_image' && !next.outputImages?.length && item.input?.startsWith('/')) {
          next.outputImages = [{ src: fileUrl(item.input), path: item.input }]
        }
        this.store.upsert(next)
        return
      }
    }
  }
}
