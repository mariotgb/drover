import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp, ChevronDown, Crosshair, FileText, FolderOpen, Paperclip, Square, X } from 'lucide-react'
import { agentKindDef } from '@shared/agents'
import { supportsModels } from '@shared/models'
import { t } from '../i18n'
import { api, humanizeError } from '../api'
import { interrupt } from '../actions'
import { formatTokens, shortPath, type Thread } from '../model'
import {
  addPending,
  removePending,
  setDraft,
  toast,
  updatePending,
  useStore,
  type Attachment
} from '../store'
import { LimitChip } from './Usage'
import { ModelMenu, shownModel } from './ModelPicker'
import { Spinner } from './primitives'
import { elementBlock } from '../preview/elementContext'
import { removeElement } from '../store'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i
const history = new Map<string, string[]>()

const SLASH: Record<string, { cmd: string; desc: string }[]> = {
  claude: [
    { cmd: '/clear', desc: 'Start a new conversation' },
    { cmd: '/compact', desc: 'Summarize the conversation to free context' },
    { cmd: '/context', desc: 'Show context usage' },
    { cmd: '/model', desc: 'Switch model' },
    { cmd: '/resume', desc: 'Resume a previous conversation' },
    { cmd: '/review', desc: 'Review a pull request' },
    { cmd: '/init', desc: 'Create CLAUDE.md for this project' },
    { cmd: '/memory', desc: 'Edit memory files' },
    { cmd: '/permissions', desc: 'Manage tool permissions' },
    { cmd: '/agents', desc: 'Manage subagents' },
    { cmd: '/mcp', desc: 'Manage MCP servers' },
    { cmd: '/cost', desc: 'Show token usage and cost' },
    { cmd: '/status', desc: 'Show status' },
    { cmd: '/rewind', desc: 'Rewind the conversation' },
    { cmd: '/export', desc: 'Export the conversation' }
  ],
  codex: [
    { cmd: '/new', desc: 'Start a new conversation' },
    { cmd: '/compact', desc: 'Summarize the conversation to free context' },
    { cmd: '/model', desc: 'Choose model and reasoning effort' },
    { cmd: '/approvals', desc: 'Choose what Codex may do without asking' },
    { cmd: '/review', desc: 'Review current changes' },
    { cmd: '/diff', desc: 'Show git diff' },
    { cmd: '/status', desc: 'Show session status' },
    { cmd: '/mention', desc: 'Mention a file' },
    { cmd: '/init', desc: 'Create AGENTS.md' },
    { cmd: '/resume', desc: 'Resume a previous session' },
    { cmd: '/mcp', desc: 'List MCP tools' }
  ]
}

let attSeq = 0

function fileUrl(path: string) {
  return `hdfile://local/?p=${encodeURIComponent(path)}`
}

export function Composer({ thread, compact }: { thread: Thread; compact?: boolean }) {
  const paneId = thread.paneId
  const draft = useStore((s) => s.drafts[paneId])
  const sendWithEnter = useStore((s) => s.settings.sendWithEnter)
  const meta = useStore((s) => s.transcripts[paneId]?.meta)
  const home = useStore((s) => s.home)
  const text = draft?.text ?? ''
  const attachments = draft?.attachments ?? []
  const elements = draft?.elements ?? []
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)
  const [histPos, setHistPos] = useState(-1)
  const [sending, setSending] = useState(false)
  const def = agentKindDef(thread.kind)
  const [modelOpen, setModelOpen] = useState(false)
  const catalog = useStore((s) => s.models)
  const picked = useStore((s) => s.modelShown[paneId])
  const switchingModel = useStore((s) => !!s.modelSwitching[paneId])
  const modelText = shownModel(thread, meta, picked, catalog)
  const working = thread.status === 'working'

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text, paneId])

  useEffect(() => {
    setHistPos(-1)
    // In terminal mode the terminal itself takes the keyboard.
    if (compact) return
    const t = setTimeout(() => taRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [paneId, compact])

  const addAttachments = useCallback(
    (list: Attachment[]) => {
      const cur = useStore.getState().drafts[paneId]?.attachments ?? []
      setDraft(paneId, { attachments: [...cur, ...list] })
    },
    [paneId]
  )

  const insertText = useCallback(
    (s: string) => {
      const ta = taRef.current
      const cur = useStore.getState().drafts[paneId]?.text ?? ''
      if (!ta) {
        setDraft(paneId, { text: cur + s })
        return
      }
      const start = ta.selectionStart ?? cur.length
      const end = ta.selectionEnd ?? cur.length
      const next = cur.slice(0, start) + s + cur.slice(end)
      setDraft(paneId, { text: next })
      requestAnimationFrame(() => {
        ta.focus()
        ta.selectionStart = ta.selectionEnd = start + s.length
      })
    },
    [paneId]
  )

  const addFiles = useCallback(
    async (files: File[]) => {
      const atts: Attachment[] = []
      const paths: string[] = []
      for (const f of files) {
        const p = api.pathForFile(f)
        const isImage = f.type.startsWith('image/') || IMAGE_RE.test(f.name)
        if (isImage) {
          const path = p ? await api.stageFile(p) : await api.saveImage(new Uint8Array(await f.arrayBuffer()), f.type || 'image/png', f.name)
          atts.push({ id: `a${++attSeq}`, path, name: f.name || 'screenshot.png', isImage: true, previewUrl: fileUrl(path) })
        } else if (p) {
          paths.push(/\s/.test(p) ? `"${p}"` : p)
        }
      }
      if (atts.length) addAttachments(atts)
      if (paths.length) insertText(paths.join(' ') + ' ')
    },
    [addAttachments, insertText]
  )

  const pickFiles = useCallback(async () => {
    const paths = await api.pickFiles()
    const atts: Attachment[] = []
    const others: string[] = []
    for (const p of paths) {
      if (IMAGE_RE.test(p)) {
        const staged = await api.stageFile(p)
        atts.push({ id: `a${++attSeq}`, path: staged, name: p.split('/').pop() ?? p, isImage: true, previewUrl: fileUrl(staged) })
      } else others.push(/\s/.test(p) ? `"${p}"` : p)
    }
    if (atts.length) addAttachments(atts)
    if (others.length) insertText(others.join(' ') + ' ')
  }, [addAttachments, insertText])

  useEffect(() => {
    const onAttach = () => void pickFiles()
    const onFocus = () => taRef.current?.focus()
    window.addEventListener('composer:attach', onAttach)
    window.addEventListener('composer:focus', onFocus)
    return () => {
      window.removeEventListener('composer:attach', onAttach)
      window.removeEventListener('composer:focus', onFocus)
    }
  }, [pickFiles])

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData
    const files = Array.from(dt.files ?? [])
    const imageItems = Array.from(dt.items ?? []).filter((i) => i.kind === 'file')
    if (files.length || imageItems.length) {
      e.preventDefault()
      const list = files.length ? files : (imageItems.map((i) => i.getAsFile()).filter(Boolean) as File[])
      await addFiles(list)
    }
  }

  const slashItems = useMemo(() => {
    if (!thread.kind || !text.startsWith('/') || text.includes(' ') || text.includes('\n')) return []
    const q = text.toLowerCase()
    return (SLASH[thread.kind] ?? []).filter((c) => c.cmd.startsWith(q))
  }, [text, thread.kind])

  useEffect(() => setSlashIdx(0), [slashItems.length])

  const send = async () => {
    const body = text.trim()
    if (!body && !attachments.length && !elements.length) return
    if (sending || switchingModel) return
    setSending(true)
    const images = attachments.filter((a) => a.isImage)
    // Picked preview elements: their screenshots go first, then other images,
    // so "attached image N" in each element block matches the paste order.
    let shot = 0
    const blocks = elements.map((el) => elementBlock(el, el.screenshot ? ++shot : undefined))
    const imagePaths = [...elements.filter((el) => el.screenshot).map((el) => el.screenshot!), ...images.map((a) => a.path)]
    const fullText = [blocks.join('\n\n'), body].filter(Boolean).join('\n\n')
    const pendingId = `p${Date.now()}`
    const showPending = !!def?.transcript && !thread.isShell
    if (showPending) {
      addPending(paneId, { id: pendingId, text: fullText, images: imagePaths.map(fileUrl), at: Date.now(), state: 'sending' })
    }
    const h = history.get(paneId) ?? []
    if (body) history.set(paneId, [...h.filter((x) => x !== body), body].slice(-50))
    setDraft(paneId, { text: '', attachments: [], elements: [] })
    setHistPos(-1)
    const res = await api.sendPrompt({
      paneId,
      target: paneId,
      agentKind: thread.kind,
      text: fullText,
      imagePaths,
      isShell: thread.isShell
    })
    setSending(false)
    if (!res.ok) {
      if (showPending) removePending(paneId, pendingId)
      setDraft(paneId, { text: body, attachments, elements })
      toast('error', res.code ? humanizeError(res.code, res.error) : res.error || t('Could not send the message'))
      return
    }
    if (showPending) {
      updatePending(paneId, pendingId, { state: 'sent' })
      setTimeout(() => removePending(paneId, pendingId), 120_000)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (slashItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && slashItems[slashIdx].cmd !== text)) {
        e.preventDefault()
        setDraft(paneId, { text: slashItems[slashIdx].cmd })
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && (sendWithEnter || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
      return
    }
    const ta = e.currentTarget
    if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const h = history.get(paneId) ?? []
      if (!h.length) return
      const pos = histPos < 0 ? h.length - 1 : Math.max(0, histPos - 1)
      e.preventDefault()
      setHistPos(pos)
      setDraft(paneId, { text: h[pos] })
      return
    }
    if (e.key === 'ArrowDown' && histPos >= 0 && ta.selectionStart === ta.value.length) {
      const h = history.get(paneId) ?? []
      const pos = histPos + 1
      e.preventDefault()
      if (pos >= h.length) {
        setHistPos(-1)
        setDraft(paneId, { text: '' })
      } else {
        setHistPos(pos)
        setDraft(paneId, { text: h[pos] })
      }
    }
  }

  // While Drover drives the agent's /model menu, typed text would land in that menu.
  const canSend = !switchingModel && (!!text.trim() || attachments.length > 0 || elements.length > 0)
  const pct = meta?.contextTokens && meta.contextWindow ? Math.min(100, Math.round((meta.contextTokens / meta.contextWindow) * 100)) : null
  const placeholder = thread.isShell
    ? t('Run a command in this terminal…')
    : thread.status === 'blocked'
      ? t('Agent is waiting for an answer — use the buttons above or the terminal')
      : working
        ? t('Message {name} (it will read this next)…', { name: thread.name })
        : t('Message {name}…', { name: thread.name })

  return (
    <div
      className={clsx('composer-wrap', compact && 'compact')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <div className={clsx('composer', dragging && 'dragging')}>
        {slashItems.length > 0 && (
          <div className="slash-menu">
            {slashItems.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                className={clsx('slash-item', i === slashIdx && 'active')}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  setDraft(paneId, { text: c.cmd })
                  taRef.current?.focus()
                }}
              >
                <span className="slash-cmd">{c.cmd}</span>
                <span className="slash-desc">{t(c.desc)}</span>
              </button>
            ))}
          </div>
        )}
        {elements.length > 0 && (
          <div className="attachments">
            {elements.map((el) => (
              <div key={el.id} className="attachment element-chip" title={[el.selector, el.component, el.source, el.url].filter(Boolean).join('\n')}>
                {el.screenshot ? <img src={fileUrl(el.screenshot)} alt="" /> : <Crosshair size={16} />}
                <span className="element-chip-text">
                  <span className="element-chip-tag">
                    &lt;{el.tag}&gt;{el.text ? ` “${el.text.length > 28 ? el.text.slice(0, 27) + '…' : el.text}”` : ''}
                  </span>
                  <span className="element-chip-sub">{el.component?.split(' ‹ ')[0] ?? el.source ?? el.selector}</span>
                </span>
                <button type="button" className="attachment-remove" title={t('Remove')} onClick={() => removeElement(paneId, el.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a) => (
              <div key={a.id} className="attachment" title={a.path}>
                {a.isImage && a.previewUrl ? <img src={a.previewUrl} alt="" /> : <FileText size={16} />}
                <span className="attachment-name">{a.name}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  title={t('Remove')}
                  onClick={() => setDraft(paneId, { attachments: attachments.filter((x) => x.id !== a.id) })}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          spellCheck
          onChange={(e) => {
            setDraft(paneId, { text: e.target.value })
            if (histPos >= 0) setHistPos(-1)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
        />
        <div className="composer-bar">
          <div className="composer-left">
            <button type="button" className="composer-tool" title={t('Attach images or files (⌘⇧A)')} onClick={() => void pickFiles()}>
              <Paperclip size={16} />
            </button>
            {supportsModels(thread.kind) && !thread.isShell ? (
              <span className="model-chip-wrap">
                <button
                  type="button"
                  className={clsx('composer-chip', 'model-chip', modelOpen && 'open')}
                  title={t('Choose the model for this chat')}
                  onClick={() => setModelOpen((v) => !v)}
                >
                  {def?.label}
                  {modelText ? <span className="chip-dim"> · {modelText}</span> : null}
                  {switchingModel ? <Spinner size={10} /> : <ChevronDown size={11} className="chip-chev" />}
                </button>
                {modelOpen && <ModelMenu thread={thread} onClose={() => setModelOpen(false)} />}
              </span>
            ) : (
              <span className="composer-chip" title={def?.label ?? t('Terminal')}>
                {def?.label ?? t('Terminal')}
                {meta?.model ? <span className="chip-dim"> · {meta.model.replace(/^claude-/, '')}</span> : null}
              </span>
            )}
            {thread.cwd && (
              <button type="button" className="composer-chip link" title={t('Reveal in Finder')} onClick={() => void api.openPath(thread.cwd!)}>
                <FolderOpen size={12} /> {shortPath(thread.cwd, home).split('/').slice(-2).join('/')}
              </button>
            )}
          </div>
          <div className="composer-right">
            <LimitChip kind={thread.kind} />
            {pct !== null ? (
              <span className="context-meter" title={t('Context: {used} of {total} tokens', { used: formatTokens(meta?.contextTokens), total: formatTokens(meta?.contextWindow) })}>
                <svg viewBox="0 0 20 20" width="16" height="16">
                  <circle cx="10" cy="10" r="8" className="ring-bg" />
                  <circle cx="10" cy="10" r="8" className="ring-fg" strokeDasharray={`${(pct / 100) * 50.27} 50.27`} transform="rotate(-90 10 10)" />
                </svg>
                {pct}%
              </span>
            ) : meta?.contextTokens ? (
              <span className="context-meter" title={t('Tokens in context')}>
                {t('{n} ctx', { n: formatTokens(meta.contextTokens) })}
              </span>
            ) : null}
            {working && !thread.isShell && (
              <button type="button" className="stop-btn" title={t('Stop (Esc to the agent · ⌘.)')} onClick={() => void interrupt(thread)}>
                <Square size={11} fill="currentColor" />
              </button>
            )}
            <button type="button" className={clsx('send-btn', canSend && 'ready')} disabled={!canSend || sending} title={t('Send (Enter)')} onClick={() => void send()}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
        {dragging && <div className="drop-hint">{t('Drop images or files to attach')}</div>}
      </div>
    </div>
  )
}
