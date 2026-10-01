import type { ImageRef, TodoItem, ToolCategory, TranscriptMeta, TranscriptTool, DiffFile } from '@shared/types'
import { editDiff, structuredPatchDiff, writeDiff } from './diff'
import { ItemStore, type TranscriptParser } from './store'
import {
  T,
  dataUrl,
  displayPath,
  firstLine,
  parseTs,
  prettyInput,
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

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function describeClaudeTool(name: string, input: Json, cwd?: string): ToolDescription {
  const p = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Read': {
      const range = input?.offset || input?.limit ? ` · lines ${input.offset ?? 1}${input.limit ? `–${(input.offset ?? 1) + input.limit}` : '+'}` : ''
      return { category: 'read', ...T('Read {path}', { path: displayPath(p('file_path'), cwd) }), detail: range.replace(' · ', '') || undefined }
    }
    case 'Write':
      return {
        category: 'write',
        ...T('Wrote {path}', { path: displayPath(p('file_path'), cwd) }),
        diff: [writeDiff(displayPath(p('file_path'), cwd), p('content'))]
      }
    case 'Edit':
      return {
        category: 'edit',
        ...T('Edited {path}', { path: displayPath(p('file_path'), cwd) }),
        diff: [editDiff(displayPath(p('file_path'), cwd), p('old_string'), p('new_string'))]
      }
    case 'MultiEdit': {
      const path = displayPath(p('file_path'), cwd)
      const edits = Array.isArray(input?.edits) ? input.edits : []
      const merged: DiffFile = { path, lines: [], added: 0, removed: 0, kind: 'edit' }
      for (const e of edits) {
        const d = editDiff(path, str(e?.old_string), str(e?.new_string))
        merged.lines.push(...d.lines, '@ ···')
        merged.added += d.added
        merged.removed += d.removed
      }
      return { category: 'edit', ...T('Edited {path}', { path }), detail: `${edits.length} edits`, diff: [merged] }
    }
    case 'NotebookEdit':
      return { category: 'edit', ...T('Edited notebook {path}', { path: displayPath(p('notebook_path'), cwd) }), input: prettyInput(input) }
    case 'Bash': {
      const cmd = p('command')
      return {
        category: 'command',
        title: p('description') || firstLine(cmd),
        detail: p('description') ? firstLine(cmd) : undefined,
        commands: [cmd]
      }
    }
    case 'BashOutput':
    case 'TaskOutput':
      return { category: 'command', ...T('Read background output'), detail: p('bash_id') || p('task_id') || undefined }
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return { category: 'command', ...T('Stopped background task'), detail: p('shell_id') || p('task_id') || undefined }
    case 'Monitor':
      return { category: 'command', ...(p('description') ? { title: p('description') } : T('Monitoring')), commands: p('command') ? [p('command')] : undefined }
    case 'Grep':
      return {
        category: 'search',
        ...T('Searched for “{pattern}”', { pattern: p('pattern') }),
        detail: [p('path') && displayPath(p('path'), cwd), p('glob'), p('type')].filter(Boolean).join(' · ') || undefined
      }
    case 'Glob':
      return { category: 'search', ...T('Found files {pattern}', { pattern: p('pattern') }), detail: p('path') ? displayPath(p('path'), cwd) : undefined }
    case 'LS':
      return { category: 'read', ...T('Listed {path}', { path: displayPath(p('path'), cwd) }) }
    case 'WebFetch':
      return { category: 'web', ...T('Fetched {url}', { url: p('url') }), detail: firstLine(p('prompt')) || undefined }
    case 'WebSearch':
      return { category: 'web', ...T('Searched the web: {query}', { query: p('query') }) }
    case 'Task':
    case 'Agent':
      return {
        category: 'agent',
        ...T('Agent · {name}', { name: p('description') || p('subagent_type') || 'task' }),
        detail: p('subagent_type') || undefined,
        input: truncate(p('prompt'), 6000)
      }
    case 'TodoWrite': {
      const todos: TodoItem[] = (Array.isArray(input?.todos) ? input.todos : []).map((t: Json) => ({
        text: str(t?.content ?? t?.text),
        status: t?.status === 'completed' || t?.status === 'in_progress' ? t.status : 'pending'
      }))
      const done = todos.filter((t) => t.status === 'completed').length
      return { category: 'todo', ...T('Updated plan · {done}/{total} done', { done, total: todos.length }), todos }
    }
    case 'TaskCreate':
      return { category: 'todo', ...T('Added task: {name}', { name: p('subject') || p('title') || p('description') }) }
    case 'TaskUpdate':
      return { category: 'todo', ...(p('status') ? T('Updated task → {status}', { status: p('status') }) : T('Updated task')), detail: p('taskId') || undefined }
    case 'TaskList':
    case 'TaskGet':
      return { category: 'todo', ...T('Checked tasks') }
    case 'Skill':
      return { category: 'other', ...T('Skill · {name}', { name: p('skill') || p('command') || p('name') }), detail: p('args') || undefined }
    case 'ExitPlanMode':
      return { category: 'other', ...T('Proposed a plan'), input: p('plan') }
    case 'EnterPlanMode':
      return { category: 'other', ...T('Entered plan mode') }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input?.questions) ? input.questions : []
      return {
        category: 'other',
        ...(qs.length ? T('Asked: {question}', { question: firstLine(str(qs[0]?.question)) }) : T('Asked a question')),
        input: qs.map((q: Json) => `• ${str(q?.question)}\n${(q?.options ?? []).map((o: Json) => `   – ${str(o?.label)}`).join('\n')}`).join('\n\n')
      }
    }
    case 'ToolSearch':
      return { category: 'other', ...T('Loaded tools'), detail: p('query') || undefined }
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__')
        return { category: 'mcp', title: `${server.replace(/[-_]/g, ' ')} · ${rest.join('__')}`, input: prettyInput(input) }
      }
      return { category: 'other', title: name, input: prettyInput(input) }
    }
  }
}

function blocksToOutput(content: unknown): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const texts: string[] = []
  const images: ImageRef[] = []
  if (Array.isArray(content)) {
    for (const b of content as Json[]) {
      if (b?.type === 'text') texts.push(str(b.text))
      else if (b?.type === 'image' && b.source?.type === 'base64') {
        const img = dataUrl(b.source.media_type, b.source.data)
        if (img) images.push(img)
      }
    }
  }
  return { text: texts.join('\n'), images }
}

const tag = (t: string, name: string) => {
  const m = t.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : ''
}

export class ClaudeParser implements TranscriptParser {
  store = new ItemStore()
  meta: Partial<TranscriptMeta> = { agent: 'claude' }
  private seq = 0

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
        /* never let one odd record break the view */
      }
    }
  }

  private id(o: Json): string {
    return typeof o.uuid === 'string' ? o.uuid : `line-${++this.seq}`
  }

  private line(o: Json) {
    const ts = parseTs(o.timestamp)
    if (typeof o.cwd === 'string') this.meta.cwd = o.cwd
    switch (o.type) {
      case 'user':
        return this.user(o, ts)
      case 'assistant':
        return this.assistant(o, ts)
      case 'system':
        return this.system(o, ts)
      case 'ai-title':
        if (typeof o.aiTitle === 'string') this.meta.title = o.aiTitle
        return
      case 'custom-title':
        if (typeof o.customTitle === 'string') this.meta.title = o.customTitle
        return
      case 'summary':
        if (!this.meta.title && typeof o.summary === 'string') this.meta.title = o.summary
        return
    }
  }

  private user(o: Json, ts?: number) {
    if (o.isSidechain) return
    const msg = o.message
    if (!msg) return
    const id = this.id(o)
    if (o.isCompactSummary) {
      this.store.event(id, 'compacted', 'Conversation compacted', ts)
      return
    }
    const content = msg.content
    if (typeof content === 'string') {
      if (!o.isMeta) this.userText(id, content, [], ts)
      return
    }
    if (!Array.isArray(content)) return
    const texts: string[] = []
    const images: ImageRef[] = []
    for (const b of content as Json[]) {
      if (b?.type === 'tool_result') this.toolResult(b, o.toolUseResult)
      else if (b?.type === 'text') texts.push(str(b.text))
      else if (b?.type === 'image') {
        const img =
          b.source?.type === 'base64'
            ? dataUrl(b.source.media_type, b.source.data)
            : b.source?.type === 'url'
              ? { src: str(b.source.url) }
              : null
        if (img) images.push(img)
      }
    }
    if (o.isMeta) return
    if (texts.length || images.length) this.userText(id, texts.join('\n\n'), images, ts)
  }

  private userText(id: string, text: string, images: ImageRef[], ts?: number) {
    const t = text.trim()
    if (!t && !images.length) return
    if (/^\[Request interrupted by user/.test(t)) {
      this.store.settleRunning('error')
      this.store.event(id, 'interrupted', 'Interrupted by user', ts)
      return
    }
    if (t.startsWith('Caveat: The messages below')) return
    if (t.includes('<command-name>')) {
      const name = tag(t, 'command-name')
      const args = tag(t, 'command-args')
      if (name) this.store.upsert({ kind: 'user', id, ts, text: '', images: [], command: `${name}${args ? ' ' + args : ''}` })
      return
    }
    if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) {
      const out = (tag(t, 'local-command-stdout') || tag(t, 'local-command-stderr')).replace(/\x1b\[[0-9;]*m/g, '')
      if (out) this.store.event(id, 'info', truncate(out, 4000), ts)
      return
    }
    if (t.startsWith('<bash-input>')) {
      this.store.upsert({ kind: 'user', id, ts, text: '', images: [], command: `! ${tag(t, 'bash-input')}` })
      return
    }
    if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) {
      const out = [tag(t, 'bash-stdout'), tag(t, 'bash-stderr')].filter(Boolean).join('\n')
      if (out) this.store.event(id, 'info', truncate(out, 4000), ts)
      return
    }
    if (t.startsWith('<task-notification>')) {
      const summary = tag(t, 'summary') || tag(t, 'status') || 'Background task update'
      this.store.event(id, 'info', summary, ts)
      return
    }
    const clean = stripImagePlaceholders(
      t
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        // Claude Code wraps long pastes: <pasted_content id="x">…</pasted_content id="x">
        .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    )
    if (!clean && !images.length) return
    this.store.upsert({ kind: 'user', id, ts, text: clean, images })
  }

  private assistant(o: Json, ts?: number) {
    if (o.isSidechain) return
    const msg = o.message
    if (!msg) return
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') this.meta.model = msg.model
    const u = msg.usage
    if (u && typeof u === 'object') {
      const total =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
      if (total > 0) this.meta.contextTokens = total
    }
    const id = this.id(o)
    const content: Json[] = Array.isArray(msg.content) ? msg.content : []
    if (o.isApiErrorMessage) {
      const text = content.map((b) => (b?.type === 'text' ? str(b.text) : '')).join('\n').trim()
      this.store.event(id, 'error', text || 'API error', ts)
      return
    }
    content.forEach((b, i) => {
      const bid = `${id}:${i}`
      if (b?.type === 'text') {
        const text = str(b.text)
        if (text.trim() && text.trim() !== '(no content)') this.store.upsert({ kind: 'assistant', id: bid, ts, text })
      } else if (b?.type === 'thinking') {
        const text = str(b.thinking)
        if (text.trim()) this.store.upsert({ kind: 'thinking', id: bid, ts, text })
      } else if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && typeof b.id === 'string') {
        const d = describeClaudeTool(str(b.name), (b.input ?? {}) as Json, this.meta.cwd)
        const existing = this.store.get(b.id)
        this.store.upsert({
          kind: 'tool',
          id: b.id,
          ts,
          name: str(b.name),
          status: existing?.kind === 'tool' ? existing.status : 'running',
          output: existing?.kind === 'tool' ? existing.output : undefined,
          ...d
        })
      }
    })
  }

  private toolResult(b: Json, toolUseResult: Json | undefined) {
    const toolId = str(b.tool_use_id)
    const item = this.store.get(toolId)
    if (!item || item.kind !== 'tool') return
    const { text, images } = blocksToOutput(b.content)
    let diff = item.diff
    if (
      EDIT_TOOLS.has(item.name) &&
      toolUseResult &&
      typeof toolUseResult === 'object' &&
      Array.isArray(toolUseResult.structuredPatch) &&
      toolUseResult.structuredPatch.length &&
      typeof toolUseResult.filePath === 'string'
    ) {
      diff = [structuredPatchDiff(displayPath(toolUseResult.filePath, this.meta.cwd), toolUseResult.structuredPatch)]
    }
    const next: TranscriptTool = {
      ...item,
      output: truncate(text.replace(/\x1b\[[0-9;]*m/g, '')),
      outputImages: images.length ? images : undefined,
      status: b.is_error ? 'error' : 'done',
      diff
    }
    this.store.upsert(next)
  }

  private system(o: Json, ts?: number) {
    const id = this.id(o)
    switch (o.subtype) {
      case 'turn_duration':
        this.store.settleRunning('done')
        this.store.event(id, 'turn-end', '', ts, typeof o.durationMs === 'number' ? o.durationMs : undefined)
        return
      case 'compact_boundary':
        this.store.event(id, 'compacted', 'Conversation compacted', ts)
        return
      case 'api_error':
        this.store.event(id, 'error', typeof o.content === 'string' && o.content ? o.content : 'API error — retrying', ts)
        return
      case 'local_command':
        if (typeof o.content === 'string') this.userText(id, o.content, [], ts)
        return
      default:
        if (o.level === 'error' && typeof o.content === 'string' && o.content.trim()) {
          this.store.event(id, 'error', truncate(o.content, 2000), ts)
        }
    }
  }
}
