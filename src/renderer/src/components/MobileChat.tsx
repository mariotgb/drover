import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, MessageSquareDashed } from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import { t } from '../i18n'
import type { Thread } from '../model'
import { LruCache } from '../markdown-blocks'
import { watchMobileTranscript } from '../mobile-transcripts'
import { applyTranscript, useStore } from '../store'
import { toBlocks, WorkingIndicator, type Block } from './ChatView'
import { AssistantMessage, EventRow, ToolGroup, UserMessage } from './Messages'
import { Spinner } from './primitives'

// Phone chat history, virtualized: only the blocks near the viewport are in the
// DOM. Heights are measured once and cached per chat; when blocks above the
// reading position change size, the top spacer absorbs the difference so iOS
// momentum scrolling is never interrupted, and the drift is settled once
// scrolling stops.

const OVERSCAN = 1000
const SETTLE_MS = 180
interface Position { atBottom: boolean; anchor: { id: string; top: number } | null }
const positions = new LruCache<Position>(40)
const measured = new LruCache<{ width: number; heights: Map<string, number> }>(12)

/** First guess before a block was ever measured (phone width, chat font). */
function estimate(b: Block): number {
  switch (b.type) {
    case 'user': return 57 + Math.ceil(b.item.text.length / 34) * 24
    case 'assistant': {
      // Prose wraps at ~40 characters; code lines scroll sideways; table rows are taller.
      let h = 40, code = false
      for (const line of b.item.text.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) { code = !code; h += code ? 52 : 12 }
        else if (code) h += 19
        else if (/^\s*\|/.test(line)) h += /^\s*\|[\s:|-]+\|?\s*$/.test(line) ? 0 : 38
        else if (!line.trim()) h += 10
        else h += Math.ceil(line.length / 40) * 25 + (/^#{1,6}\s/.test(line) ? 12 : 0)
      }
      return h
    }
    case 'tools': return 58
    default: return 44
  }
}

/** Index of the first block whose bottom is below y. */
function firstEndingAfter(offsets: number[], y: number): number {
  let lo = 1, hi = offsets.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] > y) hi = mid; else lo = mid + 1 }
  return Math.max(0, lo - 1)
}
/** Index of the first block that starts at or below y (exclusive end of the window). */
function firstStartingAt(offsets: number[], y: number): number {
  let lo = 0, hi = offsets.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid] >= y) hi = mid; else lo = mid + 1 }
  return lo
}

function sameThread(a: { thread: Thread; active: boolean }, b: { thread: Thread; active: boolean }) {
  const x = a.thread, y = b.thread
  return a.active === b.active && x.paneId === y.paneId && x.status === y.status && x.name === y.name && x.kind === y.kind &&
    (x.pane.terminal_title_stripped || x.pane.title) === (y.pane.terminal_title_stripped || y.pane.title)
}

export const MobileChatView = memo(function MobileChatView({ thread, active }: { thread: Thread; active: boolean }) {
  const paneId = thread.paneId
  const ts = useStore((s) => s.transcripts[paneId])
  const pending = useStore((s) => s.pending[paneId])
  useEffect(() => watchMobileTranscript(paneId, applyTranscript), [paneId])
  const blocks = useMemo(() => toBlocks(ts?.items ?? []), [ts?.items])

  const scrollRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const rows = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const cache = useMemo(() => {
    let c = measured.get(paneId)
    if (!c) { c = { width: 0, heights: new Map() }; measured.set(paneId, c) }
    return c
  }, [paneId])
  const saved = useMemo(() => positions.get(paneId), [paneId])
  const atBottom = useRef(saved?.atBottom ?? true)
  const anchor = useRef(saved?.anchor ?? null)
  const restoring = useRef(!!saved && !saved.atBottom)
  const drift = useRef(0)
  const seenTop = useRef(-1)
  const [jump, setJump] = useState(!atBottom.current)

  const n = blocks.length
  const offsets = new Array<number>(n + 1)
  offsets[0] = 0
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + (cache.heights.get(blocks[i].id) ?? estimate(blocks[i]))
  const [range, setRange] = useState<[number, number]>(() => {
    const at = saved?.anchor ? blocks.findIndex((b) => b.id === saved.anchor!.id) : -1
    return at >= 0 ? [Math.max(0, at - 8), Math.min(n, at + 24)] : [Math.max(0, n - 24), n]
  })
  const start = Math.min(range[0], n)
  const end = Math.min(Math.max(range[1], start), n)
  const live = useRef({ offsets, blocks, start, end })
  live.current = { offsets, blocks, start, end }

  const rowTop = (row: HTMLElement) => row.getBoundingClientRect().top - scrollRef.current!.getBoundingClientRect().top

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current
    if (!el || atBottom.current) return
    const { blocks: list, start: s, end: e } = live.current
    for (let i = s; i < e; i++) {
      const row = rows.current.get(list[i].id)
      if (!row) continue
      const top = rowTop(row)
      if (top + row.offsetHeight > 0) { anchor.current = { id: list[i].id, top }; return }
    }
  }, [])

  const updateRange = useCallback(() => {
    const el = scrollRef.current, top = topRef.current
    if (!el || !top) return
    const { offsets: offs, start: s0, end: e0 } = live.current
    const base = top.offsetTop + drift.current
    // Hysteresis: keep the window while it still covers the screen with a margin.
    const total = offs[offs.length - 1]
    const need0 = Math.max(0, el.scrollTop - base - OVERSCAN / 3)
    const need1 = Math.min(total, el.scrollTop + el.clientHeight - base + OVERSCAN / 3)
    if (e0 > s0 && offs[s0] <= need0 && offs[e0] >= need1) return
    const s = firstEndingAfter(offs, el.scrollTop - base - OVERSCAN)
    let e = firstStartingAt(offs, el.scrollTop + el.clientHeight - base + OVERSCAN)
    if (e <= s) e = Math.min(offs.length - 1, s + 1)
    setRange((prev) => (prev[0] === s && prev[1] === e ? prev : [s, e]))
  }, [])

  /** A scroll that happened before its scroll event (same frame) decides first. */
  const syncScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || Math.abs(el.scrollTop - seenTop.current) < 1 || seenTop.current < 0) return
    seenTop.current = el.scrollTop
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    captureAnchor()
  }, [captureAnchor])

  /** Keeps the reading position: the anchor block stays where it was on screen. */
  const settle = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    syncScroll()
    if (atBottom.current) { el.scrollTop = el.scrollHeight; seenTop.current = el.scrollTop; return }
    const a = anchor.current
    const row = a && rows.current.get(a.id)
    if (!a || !row) return
    const delta = rowTop(row) - a.top
    if (Math.abs(delta) < 1) { restoring.current = false; return }
    const spacer = topRef.current
    const height = spacer ? parseFloat(spacer.style.height) || 0 : 0
    // At the first block there is nothing left to absorb into: the spacer must be exact.
    if (!restoring.current && spacer && height - delta >= 0 && live.current.start > 0) {
      drift.current -= delta
      spacer.style.height = `${height - delta}px`
    } else {
      el.scrollTop += delta
      seenTop.current = el.scrollTop
    }
    restoring.current = false
  }, [syncScroll])

  // One observer for the rendered blocks (never for containers the spacer resizes).
  const [observer] = useState(() => new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const target = entry.target as HTMLElement
      const id = target.dataset.vid
      if (!id) continue
      const height = entry.borderBoxSize?.[0]?.blockSize ?? target.offsetHeight
      if (!height) continue
      if (cache.heights.get(id) !== height) { cache.heights.set(id, height); changed = true }
    }
    settle()
    if (changed) scheduleRange()
  }))
  useEffect(() => {
    const el = scrollRef.current
    if (el && cache.width && Math.abs(cache.width - el.clientWidth) > 1) cache.heights.clear()
    if (el) cache.width = el.clientWidth
    return () => {
      observer.disconnect()
      positions.set(paneId, { atBottom: atBottom.current, anchor: anchor.current })
    }
  }, [observer, cache, paneId])

  const refFor = (id: string) => {
    let fn = refs.current.get(id)
    if (!fn) {
      fn = (el) => {
        const old = rows.current.get(id)
        if (old && old !== el) { observer.unobserve(old); rows.current.delete(id) }
        if (el) { rows.current.set(id, el); observer.observe(el) }
        else refs.current.delete(id)
      }
      refs.current.set(id, fn)
    }
    return fn
  }

  // At most one window update per frame: the window and the scroll position can never chase each other.
  const scheduled = useRef(0)
  const scheduleRange = useCallback(() => {
    if (!scheduled.current) scheduled.current = requestAnimationFrame(() => { scheduled.current = 0; updateRange() })
  }, [updateRange])
  useEffect(() => () => cancelAnimationFrame(scheduled.current), [])

  // After every render: keep the anchor (or the bottom); the first rows of a chat appear in the same frame.
  useLayoutEffect(() => {
    if (start === 0 && drift.current) reconcile()
    settle()
    if (end === start && n > 0) updateRange()
    else scheduleRange()
  })

  // Once scrolling stops, fold the spacer drift back into the scroll position.
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const frame = useRef(0)
  useEffect(() => () => { clearTimeout(idle.current); cancelAnimationFrame(frame.current) }, [])
  function reconcile() {
    const el = scrollRef.current, spacer = topRef.current
    if (!el || !spacer || !drift.current) return
    const d = drift.current
    drift.current = 0
    spacer.style.height = `${live.current.offsets[live.current.start]}px`
    if (!atBottom.current) el.scrollTop -= d
    seenTop.current = el.scrollTop
    captureAnchor()
    scheduleRange()
  }
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    seenTop.current = el.scrollTop
    atBottom.current = bottom
    setJump(!bottom)
    captureAnchor()
    clearTimeout(idle.current)
    idle.current = setTimeout(reconcile, SETTLE_MS)
    scheduleRange()
  }

  const working = thread.status === 'working'
  let lastTools = -1
  for (let i = n - 1; i >= 0; i--) if (blocks[i].type === 'tools') { lastTools = i; break }
  const def = agentKindDef(thread.kind)
  const empty = ts?.loaded && !ts.items.length && !pending?.length
  const render = (b: Block, i: number) => {
    switch (b.type) {
      case 'user': return <UserMessage item={b.item} />
      case 'assistant': return <AssistantMessage item={b.item} />
      case 'event': return <EventRow item={b.item} />
      case 'tools': return <ToolGroup items={b.items} live={working && i === lastTools} />
    }
  }

  return (
    <div className="chat mw-chat-view" aria-hidden={!active} inert={!active}>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column mw-chat-column" ref={columnRef}>
          {!ts?.loaded && <div className="chat-loading"><Spinner /> {t('Loading conversation…')}</div>}
          {ts?.meta?.located === 'heuristic' && ts.items.length > 0 && (
            <div className="chat-note">{t('Conversation matched by start time — herdr did not report this {agent} session id.', { agent: def?.label ?? 'agent' })}</div>
          )}
          {empty && (
            <div className="chat-empty">
              <MessageSquareDashed size={28} strokeWidth={1.5} />
              <div className="chat-empty-title">{thread.name}</div>
              <div className="chat-empty-sub">{t('Nothing here yet.')}</div>
            </div>
          )}
          <div ref={topRef} style={{ height: `${Math.max(0, offsets[start] + drift.current)}px` }} aria-hidden />
          {blocks.slice(start, end).map((b, k) => (
            <div key={b.id} data-vid={b.id} className="mw-vrow" ref={refFor(b.id)}>{render(b, start + k)}</div>
          ))}
          <div style={{ height: `${offsets[n] - offsets[end]}px` }} aria-hidden />
          {pending?.map((p) => (
            <UserMessage key={p.id} item={{ kind: 'user', id: p.id, text: p.text, images: p.images.map((src) => ({ src })) }}
              pending={p.state === 'error' ? 'error' : p.state === 'sending' ? 'sending' : working ? 'queued' : undefined} />
          ))}
          {working && <WorkingIndicator thread={thread} />}
          <div className="chat-end" />
        </div>
      </div>
      {jump && active && (
        <button type="button" className="jump-bottom" title={t('Jump to latest')} aria-label={t('Jump to latest')} onClick={() => {
          atBottom.current = true
          setJump(false)
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
        }}><ArrowDown size={16} /></button>
      )}
    </div>
  )
}, sameThread)
