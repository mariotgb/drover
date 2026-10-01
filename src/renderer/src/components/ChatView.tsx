import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import clsx from 'clsx'
import { ArrowDown, MessageSquareDashed, SquareTerminal, TriangleAlert } from 'lucide-react'
import type {
  TranscriptAssistant,
  TranscriptEvent,
  TranscriptItem,
  TranscriptThinking,
  TranscriptTool,
  TranscriptUser
} from '@shared/types'
import { agentKindDef } from '@shared/agents'
import { api } from '../api'
import { sendKeys } from '../actions'
import { formatDuration, type Thread } from '../model'
import { applyTranscript, toggleDrawer, useStore } from '../store'
import { AssistantMessage, EventRow, ToolGroup, UserMessage } from './Messages'
import { Spinner, useTicker } from './primitives'

type Block =
  | { type: 'user'; id: string; item: TranscriptUser }
  | { type: 'assistant'; id: string; item: TranscriptAssistant }
  | { type: 'event'; id: string; item: TranscriptEvent }
  | { type: 'tools'; id: string; items: (TranscriptTool | TranscriptThinking)[] }

function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = []
  let group: Extract<Block, { type: 'tools' }> | null = null
  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'thinking') {
      if (!group) {
        group = { type: 'tools', id: `g:${it.id}`, items: [] }
        blocks.push(group)
      }
      group.items.push(it)
      continue
    }
    group = null
    if (it.kind === 'user') blocks.push({ type: 'user', id: it.id, item: it })
    else if (it.kind === 'assistant') blocks.push({ type: 'assistant', id: it.id, item: it })
    else blocks.push({ type: 'event', id: it.id, item: it })
  }
  return blocks
}

const PAGE = 120

export function ChatView({ thread }: { thread: Thread }) {
  const paneId = thread.paneId
  const ts = useStore((s) => s.transcripts[paneId])
  const pending = useStore((s) => s.pending[paneId])
  const [limit, setLimit] = useState(PAGE)
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const prepend = useRef<{ height: number; top: number } | null>(null)

  useEffect(() => {
    let alive = true
    setLimit(PAGE)
    atBottomRef.current = true
    void api.transcriptSubscribe(paneId).then((u) => {
      if (alive) applyTranscript(u)
    })
    return () => {
      alive = false
      api.transcriptUnsubscribe(paneId)
    }
  }, [paneId])

  const blocks = useMemo(() => toBlocks(ts?.items ?? []), [ts?.items])
  const hidden = Math.max(0, blocks.length - limit)
  const visible = hidden ? blocks.slice(hidden) : blocks

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prepend.current) {
      el.scrollTop = el.scrollHeight - prepend.current.height + prepend.current.top
      prepend.current = null
      return
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [visible, pending, thread.status])

  useEffect(() => {
    const col = columnRef.current
    if (!col) return
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom()
    })
    ro.observe(col)
    return () => ro.disconnect()
  }, [paneId])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const ab = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = ab
    if (ab !== atBottom) setAtBottom(ab)
    if (el.scrollTop < 200 && hidden > 0 && !prepend.current) {
      prepend.current = { height: el.scrollHeight, top: el.scrollTop }
      setLimit((l) => l + PAGE)
    }
  }

  const live = thread.status === 'working'
  const lastToolsIdx = visible.length - 1 - [...visible].reverse().findIndex((b) => b.type === 'tools')
  const def = agentKindDef(thread.kind)
  const empty = ts?.loaded && !ts.items.length && !(pending?.length)

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column" ref={columnRef}>
          {hidden > 0 && (
            <button
              type="button"
              className="load-earlier"
              onClick={() => {
                const el = scrollRef.current
                if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop }
                setLimit((l) => l + PAGE)
              }}
            >
              {t('Show earlier messages ({n})', { n: hidden })}
            </button>
          )}
          {!ts?.loaded && (
            <div className="chat-loading">
              <Spinner /> {t('Loading conversation…')}
            </div>
          )}
          {ts?.meta?.located === 'heuristic' && ts.items.length > 0 && (
            <div className="chat-note">{t('Conversation matched by start time — herdr did not report this {agent} session id.', { agent: def?.label ?? 'agent' })}</div>
          )}
          {empty && (
            <div className="chat-empty">
              <MessageSquareDashed size={28} strokeWidth={1.5} />
              <div className="chat-empty-title">{thread.name}</div>
              <div className="chat-empty-sub">
                {ts?.error === 'not-found'
                  ? t('No messages yet. Write to {agent} below — paste screenshots with ⌘V.', { agent: def?.label ?? t('the agent') })
                  : t('Nothing here yet.')}
              </div>
            </div>
          )}
          {visible.map((b, i) => {
            switch (b.type) {
              case 'user':
                return <UserMessage key={b.id} item={b.item} />
              case 'assistant':
                return <AssistantMessage key={b.id} item={b.item} />
              case 'event':
                return <EventRow key={b.id} item={b.item} />
              case 'tools':
                return <ToolGroup key={b.id} items={b.items} live={live && i === lastToolsIdx} />
            }
          })}
          {pending?.map((p) => (
            <UserMessage
              key={p.id}
              item={{ kind: 'user', id: p.id, text: p.text, images: p.images.map((src) => ({ src })) }}
              pending={p.state === 'error' ? 'error' : p.state === 'sending' ? 'sending' : thread.status === 'working' ? 'queued' : undefined}
            />
          ))}
          {thread.status === 'working' && <WorkingIndicator thread={thread} />}
          {thread.status === 'blocked' && <BlockedBanner thread={thread} />}
          <div className="chat-end" />
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          className="jump-bottom"
          onClick={() => {
            atBottomRef.current = true
            setAtBottom(true)
            scrollToBottom()
          }}
          title={t('Jump to latest')}
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}

function WorkingIndicator({ thread }: { thread: Thread }) {
  const since = useStore((s) => s.workingSince[thread.paneId])
  useTicker(1000)
  const title = thread.pane.terminal_title_stripped || thread.pane.title || ''
  const elapsed = since ? formatDuration(Date.now() - since) : ''
  return (
    <div className="working">
      <span className="working-dot" />
      <span className="shimmer">{t('Working')}</span>
      {elapsed && <span className="working-meta">{elapsed}</span>}
      {title && title !== thread.name && <span className="working-title">· {title}</span>}
    </div>
  )
}

function BlockedBanner({ thread }: { thread: Thread }) {
  const drawerOpen = useStore((s) => !!s.drawer[thread.paneId])
  const keys: { label: string; keys: string[] }[] = [
    { label: '1', keys: ['1'] },
    { label: '2', keys: ['2'] },
    { label: '3', keys: ['3'] },
    { label: '↑', keys: ['up'] },
    { label: '↓', keys: ['down'] },
    { label: 'Enter', keys: ['enter'] },
    { label: 'Esc', keys: ['esc'] }
  ]
  return (
    <div className="blocked">
      <div className="blocked-head">
        <TriangleAlert size={16} />
        <div>
          <div className="blocked-title">{t('{name} is waiting for your answer', { name: thread.name })}</div>
          <div className="blocked-sub">{t('An approval or question is open in the agent’s terminal.')}</div>
        </div>
      </div>
      <div className="blocked-actions">
        {keys.map((k) => (
          <button key={k.label} type="button" className="key-btn" onClick={() => void sendKeys(thread, k.keys)}>
            {k.label}
          </button>
        ))}
        <button type="button" className={clsx('btn btn-sm', !drawerOpen && 'btn-primary')} onClick={() => toggleDrawer(thread.paneId)}>
          <SquareTerminal size={14} /> {drawerOpen ? t('Hide terminal') : t('Show terminal')}
        </button>
      </div>
    </div>
  )
}
