import { memo, useMemo, useState } from 'react'
import { t, tp } from '../i18n'
import clsx from 'clsx'
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Crosshair,
  FileText,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type {
  DiffFile,
  ImageRef,
  ToolCategory,
  TranscriptAssistant,
  TranscriptEvent,
  TranscriptThinking,
  TranscriptTool,
  TranscriptUser
} from '@shared/types'
import { formatDuration } from '../model'
import { elementTitle, splitElementBlocks, type ParsedElement } from '../preview/elementContext'
import { CopyButton, Markdown } from './Markdown'
import { Spinner } from './primitives'
import { isRemote } from '../api'
import { remoteAttachmentUrl } from '../attachments'

/** Tool titles come from the main process with a translatable key. */
export function toolTitle(tool: TranscriptTool): string {
  if (!tool.titleKey) return tool.title
  if (tool.titleOne && typeof tool.titleParams?.n === 'number') return tp({ one: tool.titleOne, other: tool.titleKey }, tool.titleParams.n, tool.titleParams)
  return t(tool.titleKey, tool.titleParams)
}

export function openLightbox(src: string) {
  window.dispatchEvent(new CustomEvent('lightbox', { detail: src }))
}

export function Thumbs({ images, size = 'md' }: { images: ImageRef[]; size?: 'sm' | 'md' }) {
  if (!images.length) return null
  return (
    <div className={clsx('thumbs', size === 'sm' && 'thumbs-sm')}>
      {images.map((img, i) => {
        // Transcript parsers produce Mac-only hdfile URLs. Resolve uploaded images
        // through the authenticated preview endpoint after the pending item settles.
        const path = img.path ?? (img.src.startsWith('hdfile:') ? new URL(img.src).searchParams.get('p') : null)
        const src = isRemote && path && /^remote-[0-9a-f-]+\.[a-z]+$/.test(path.split('/').pop() ?? '') ? remoteAttachmentUrl(path) : img.src
        return <button key={i} type="button" className="thumb" onClick={() => openLightbox(src)} title={img.path ?? t('Image')}>
          <img src={src} alt="" loading="lazy" />
        </button>
      })}
    </div>
  )
}

function ElementChips({ elements }: { elements: ParsedElement[] }) {
  return (
    <div className="msg-elements">
      {elements.map((el, i) => (
        <div
          key={i}
          className="msg-element"
          title={[el.fields.selector, el.fields.component, el.fields.source, el.page].filter(Boolean).join('\n')}
        >
          <Crosshair size={13} />
          <span className="msg-element-tag">{elementTitle(el.fields)}</span>
          {(el.fields.component || el.fields.source) && (
            <span className="msg-element-sub">{el.fields.component?.split(' ‹ ')[0] ?? el.fields.source}</span>
          )}
        </div>
      ))}
    </div>
  )
}

export const UserMessage = memo(function UserMessage({ item, pending }: { item: TranscriptUser; pending?: 'sending' | 'queued' | 'error' }) {
  const { elements, rest } = useMemo(() => splitElementBlocks(item.text), [item.text])
  if (item.command) {
    return (
      <div className="msg-user command">
        <span className="command-chip">{item.command}</span>
      </div>
    )
  }
  return (
    <div className={clsx('msg-user', pending && `pending pending-${pending}`)}>
      <div className="bubble">
        <Thumbs images={item.images} />
        {elements.length > 0 && <ElementChips elements={elements} />}
        {rest && <div className="bubble-text">{rest}</div>}
      </div>
      {pending && (
        <div className="pending-state">
          {pending === 'sending' ? t('Sending…') : pending === 'queued' ? t('Queued — the agent will read it next') : t('Not delivered')}
        </div>
      )}
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({ item }: { item: TranscriptAssistant }) {
  return (
    <div className={clsx('msg-assistant', item.phase === 'commentary' && 'commentary')}>
      <Markdown text={item.text} />
      <div className="msg-actions">
        <CopyButton text={item.text} />
      </div>
    </div>
  )
})

export function EventRow({ item }: { item: TranscriptEvent }) {
  if (item.variant === 'turn-end') {
    if (!item.durationMs) return null
    return (
      <div className="event-divider">
        <span>{t('Worked for {time}', { time: formatDuration(item.durationMs) })}</span>
      </div>
    )
  }
  if (item.variant === 'compacted') {
    return (
      <div className="event-divider accent">
        <span>{t(item.text || 'Context compacted')}</span>
      </div>
    )
  }
  return (
    <div className={clsx('event-row', `event-${item.variant}`)}>
      {item.variant === 'error' ? <AlertTriangle size={13} /> : item.variant === 'interrupted' ? <X size={13} /> : <CircleDot size={12} />}
      <span className="event-text">{t(item.text)}</span>
    </div>
  )
}

const CATEGORY_ICON: Record<ToolCategory, typeof FileText> = {
  read: FileText,
  edit: Pencil,
  write: Pencil,
  command: SquareTerminal,
  search: Search,
  web: Globe,
  agent: Bot,
  todo: ListChecks,
  mcp: Plug,
  image: ImageIcon,
  other: Wrench
}

function summarize(items: (TranscriptTool | TranscriptThinking)[]): string {
  const tools = items.filter((i): i is TranscriptTool => i.kind === 'tool')
  const counts = new Map<string, number>()
  const add = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n)
  let added = 0
  let removed = 0
  for (const t of tools) {
    if (t.category === 'command') add('command', Math.max(1, t.commands?.length ?? 1))
    else if (t.category === 'edit' || t.category === 'write') {
      add('edit', Math.max(1, t.diff?.length ?? 1))
      for (const d of t.diff ?? []) {
        added += d.added
        removed += d.removed
      }
    } else add(t.category)
  }
  const parts: string[] = []
  const c = (k: string) => counts.get(k) ?? 0
  if (c('command')) parts.push(tp({ one: 'ran {n} command', other: 'ran {n} commands' }, c('command')))
  if (c('edit')) parts.push(tp({ one: 'edited {n} file', other: 'edited {n} files' }, c('edit')) + (added || removed ? ` (+${added} −${removed})` : ''))
  if (c('read')) parts.push(tp({ one: 'read {n} file', other: 'read {n} files' }, c('read')))
  if (c('search')) parts.push(tp({ one: '{n} search', other: '{n} searches' }, c('search')))
  if (c('web')) parts.push(tp({ one: '{n} web lookup', other: '{n} web lookups' }, c('web')))
  if (c('agent')) parts.push(tp({ one: '{n} agent call', other: '{n} agent calls' }, c('agent')))
  if (c('todo')) parts.push(t('updated plan'))
  const other = c('mcp') + c('other') + c('image')
  if (other) parts.push(tp({ one: '{n} tool call', other: '{n} tool calls' }, other))
  const thinking = items.length - tools.length
  if (!parts.length && thinking) return t('Thought')
  const s = parts.join(', ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const ToolGroup = memo(function ToolGroup({ items, live }: { items: (TranscriptTool | TranscriptThinking)[]; live: boolean }) {
  const running = items.some((i) => i.kind === 'tool' && i.status === 'running')
  const failed = items.filter((i) => i.kind === 'tool' && i.status === 'error').length
  const small = items.length <= 2
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => summarize(items), [items])
  const lastTool = [...items].reverse().find((i): i is TranscriptTool => i.kind === 'tool')
  if (small) {
    return (
      <div className="tool-group flat">
        {items.map((it) => (it.kind === 'tool' ? <ToolRow key={it.id} tool={it} /> : <ThinkingRow key={it.id} item={it} />))}
      </div>
    )
  }
  return (
    <div className={clsx('tool-group', open && 'open')}>
      <button type="button" className="tool-group-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={clsx('chev', open && 'open')} />
        <span className="tool-group-summary">{summary}</span>
        {running && live && lastTool && <span className="tool-group-live">· {toolTitle(lastTool)}</span>}
        {failed > 0 && <span className="tool-group-failed">{t('{n} failed', { n: failed })}</span>}
        <span className="tool-group-count">{tp({ one: '{n} step', other: '{n} steps' }, items.length)}</span>
        {running && live ? <Spinner size={12} /> : null}
      </button>
      {open && (
        <div className="tool-group-body">
          {items.map((it) => (it.kind === 'tool' ? <ToolRow key={it.id} tool={it} /> : <ThinkingRow key={it.id} item={it} />))}
        </div>
      )}
    </div>
  )
})

function ThinkingRow({ item }: { item: TranscriptThinking }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={clsx('tool-row', open && 'open')}>
      <button type="button" className="tool-row-head" onClick={() => setOpen(!open)}>
        <Brain size={14} className="tool-icon" />
        <span className="tool-title thinking">{t('Thinking')}</span>
        <ChevronRight size={13} className={clsx('chev', open && 'open')} />
      </button>
      {open && (
        <div className="tool-detail">
          <div className="thinking-text">
            <Markdown text={item.text} />
          </div>
        </div>
      )}
    </div>
  )
}

export const ToolRow = memo(function ToolRow({ tool }: { tool: TranscriptTool }) {
  const [open, setOpen] = useState(false)
  const Icon = CATEGORY_ICON[tool.category] ?? Wrench
  const isCmd = tool.category === 'command'
  const diffStat = tool.diff?.reduce((acc, d) => ({ a: acc.a + d.added, r: acc.r + d.removed }), { a: 0, r: 0 })
  const hasDetail = !!(tool.output || tool.input || tool.diff?.length || tool.todos?.length || tool.commands?.length || tool.outputImages?.length || tool.detail)
  return (
    <div className={clsx('tool-row', open && 'open', `tool-${tool.status}`)}>
      <button type="button" className="tool-row-head" onClick={() => hasDetail && setOpen(!open)} disabled={!hasDetail}>
        <Icon size={14} className="tool-icon" />
        <span className={clsx('tool-title', isCmd && 'mono')}>{toolTitle(tool)}</span>
        {diffStat && (diffStat.a > 0 || diffStat.r > 0) && (
          <span className="diffstat">
            <span className="add">+{diffStat.a}</span> <span className="del">−{diffStat.r}</span>
          </span>
        )}
        <span className="tool-state">
          {tool.status === 'running' ? <Spinner size={12} /> : tool.status === 'error' ? <X size={13} className="err" /> : <Check size={13} className="ok" />}
        </span>
        {hasDetail && <ChevronRight size={13} className={clsx('chev', open && 'open')} />}
      </button>
      {open && <ToolDetail tool={tool} />}
    </div>
  )
})

function ToolDetail({ tool }: { tool: TranscriptTool }) {
  return (
    <div className="tool-detail">
      {tool.detail && !tool.commands?.length && <div className="tool-detail-line">{tool.detail}</div>}
      {tool.commands?.map((c, i) => (
        <div key={i} className="cmd-block">
          <div className="cmd-head">
            <span>$</span>
            <CopyButton text={c} />
          </div>
          <pre className="cmd-text">{c}</pre>
        </div>
      ))}
      {tool.todos && <TodoList todos={tool.todos} />}
      {tool.diff?.map((d, i) => <DiffView key={i} file={d} />)}
      {tool.input && !tool.commands?.length && !tool.diff?.length && (
        <pre className="tool-io input">{tool.input}</pre>
      )}
      {tool.output && (
        <div className="tool-output">
          <div className="tool-output-head">
            <span>{tool.status === 'error' ? t('Error') : t('Output')}</span>
            <CopyButton text={tool.output} />
          </div>
          <pre className={clsx('tool-io', tool.status === 'error' && 'error')}>{tool.output}</pre>
        </div>
      )}
      {tool.outputImages && <Thumbs images={tool.outputImages} size="sm" />}
    </div>
  )
}

function TodoList({ todos }: { todos: { text: string; status: string }[] }) {
  return (
    <ul className="todos">
      {todos.map((t, i) => (
        <li key={i} className={`todo todo-${t.status}`}>
          {t.status === 'completed' ? <Check size={13} /> : t.status === 'in_progress' ? <CircleDot size={13} /> : <Circle size={13} />}
          <span>{t.text}</span>
        </li>
      ))}
    </ul>
  )
}

export function DiffView({ file }: { file: DiffFile }) {
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path">{file.path}</span>
        <span className="diffstat">
          {file.kind === 'add' || file.kind === 'write' ? <span className="tag">{file.kind === 'add' ? 'new' : 'write'}</span> : null}
          {file.kind === 'delete' ? <span className="tag del">deleted</span> : null}
          <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
        </span>
      </div>
      <div className="diff-body">
        {file.lines.map((l, i) => {
          const c = l[0]
          const cls = c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : 'ctx'
          return (
            <div key={i} className={`diff-line ${cls}`}>
              <span className="diff-sign">{c === '@' ? '' : c === ' ' ? '' : c}</span>
              <span className="diff-text">{c === '@' ? l.slice(1).trim() : l.slice(1)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
