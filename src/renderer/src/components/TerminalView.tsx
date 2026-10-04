import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { RotateCw } from 'lucide-react'
import type { TerminalFrame } from '@shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { useStore } from '../store'
import { monoFontFamily, onAppearanceChange, terminalTheme } from '../appearance'
import { Spinner } from './primitives'

// One global dispatcher routes bridge frames to the xterm instance that
// opened the bridge.
const terminals = new Map<string, (frames: TerminalFrame[]) => void>()
const closers = new Map<string, (reason: string) => void>()
let wired = false
function wire() {
  if (wired) return
  wired = true
  api.on.termFrames((id, frames) => terminals.get(id)?.(frames))
  api.on.termClosed((id, reason) => closers.get(id)?.(reason))
}

let seq = 0

function xtermTheme(): ITheme {
  return (terminalTheme() as ITheme | null) ?? {}
}

export interface TerminalHandle {
  focus(): void
  paste(text: string): void
  key(data: string): void
  control(active: boolean, consumed?: () => void): void
}

export function TerminalView({
  paneId,
  autoFocus,
  className,
  onReady
}: {
  paneId: string
  autoFocus?: boolean
  className?: string
  onReady?: (h: TerminalHandle | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const fontSize = useStore((s) => s.settings.terminalFontSize)
  const [state, setState] = useState<{ phase: 'connecting' | 'live' | 'closed'; reason?: string }>({ phase: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  const termRef = useRef<{ term: Terminal; fit: FitAddon; id: string } | null>(null)

  useEffect(() => {
    wire()
    const el = ref.current
    if (!el) return
    const term = new Terminal({
      fontFamily: monoFontFamily(),
      fontSize: useStore.getState().settings.terminalFontSize,
      lineHeight: 1.12,
      scrollback: 0,
      allowProposedApi: true,
      macOptionIsMeta: true,
      cursorBlink: false,
      theme: xtermTheme(),
      rescaleOverlappingGlyphs: true,
      customGlyphs: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.open(el)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* DOM renderer fallback */
    }
    try {
      fit.fit()
    } catch {
      /* not laid out yet */
    }

    const id = `${paneId}#${++seq}`
    termRef.current = { term, fit, id }
    let live = false
    let closed = false
    let lastCols = term.cols
    let lastRows = term.rows

    terminals.set(id, (frames) => {
      if (!live) {
        live = true
        setState({ phase: 'live' })
      }
      if (frames.length === 1) term.write(frames[0].data)
      else {
        let total = 0
        for (const f of frames) total += f.data.length
        const buf = new Uint8Array(total)
        let off = 0
        for (const f of frames) {
          buf.set(f.data, off)
          off += f.data.length
        }
        term.write(buf)
      }
    })
    closers.set(id, (reason) => {
      closed = true
      setState({ phase: 'closed', reason })
    })

    void api.termOpen(id, paneId, Math.max(20, term.cols), Math.max(5, term.rows)).then((res) => {
      if (!res.ok) setState({ phase: 'closed', reason: res.error })
    })

    let controlArmed = false
    let controlConsumed: (() => void) | undefined
    const dataSub = term.onData((d) => {
      if (closed) return
      if (controlArmed) {
        controlArmed = false
        controlConsumed?.()
        if (/^[a-z@\[\]\\^_]$/i.test(d)) d = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31)
      }
      api.termInput(id, d)
    })
    const binSub = term.onBinary((d) => {
      if (closed) return
      let bin = ''
      for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d.charCodeAt(i) & 0xff)
      api.termInputBytes(id, btoa(bin))
    })

    let wheelAcc = 0
    term.attachCustomWheelEventHandler((ev) => {
      const lineH = (term.options.fontSize ?? 13) * 1.25
      const delta = ev.deltaMode === 1 ? ev.deltaY * lineH : ev.deltaMode === 2 ? ev.deltaY * lineH * term.rows : ev.deltaY
      wheelAcc += delta
      const lines = Math.trunc(wheelAcc / lineH)
      if (lines !== 0) {
        wheelAcc -= lines * lineH
        api.termScroll(id, lines < 0 ? 'up' : 'down', Math.abs(lines))
      }
      ev.preventDefault()
      return false
    })

    // Keep Cmd shortcuts for the app menu; let xterm handle everything else.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const k = ev.key.toLowerCase()
        if (k === 'c' && term.hasSelection()) return false
        if (k === 'v' || k === 'a' || k === 'k' || k === 'n' || k === 'j' || k === 'b' || k === 't' || k === ',' || k === '.' || /^[0-9[\]]$/.test(k)) return false
      }
      return true
    })

    const pasteText = (text: string) => {
      if (!closed && text) api.termInput(id, `\x1b[200~${text.replace(/\r\n/g, '\n')}\x1b[201~`)
    }

    const onPaste = async (e: ClipboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const dt = e.clipboardData
      if (!dt) return
      const files = Array.from(dt.files ?? [])
      if (files.length) {
        for (const f of files) {
          let path = api.pathForFile(f)
          if (path) path = await api.stageFile(path)
          else if (f.type.startsWith('image/')) path = await api.saveImage(new Uint8Array(await f.arrayBuffer()), f.type, f.name)
          if (path) pasteText(path)
        }
        return
      }
      const items = Array.from(dt.items ?? [])
      const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (img) {
        const f = img.getAsFile()
        if (f) {
          const path = await api.saveImage(new Uint8Array(await f.arrayBuffer()), f.type || 'image/png')
          pasteText(path)
          return
        }
      }
      pasteText(dt.getData('text/plain'))
    }
    el.addEventListener('paste', onPaste, true)

    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      e.stopPropagation()
      for (const f of Array.from(e.dataTransfer.files)) {
        let path = api.pathForFile(f)
        if (path) path = await api.stageFile(path)
        if (path) pasteText(path)
      }
      term.focus()
    }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
    }
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragover', onDragOver)

    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!el.clientWidth || !el.clientHeight) return
        try {
          fit.fit()
        } catch {
          return
        }
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols
          lastRows = term.rows
          api.termResize(id, term.cols, term.rows)
        }
      })
    })
    ro.observe(el)

    const offAppearance = onAppearanceChange(() => {
      term.options.theme = xtermTheme()
      const family = monoFontFamily()
      if (term.options.fontFamily !== family) {
        term.options.fontFamily = family
        try {
          fit.fit()
          api.termResize(id, term.cols, term.rows)
        } catch {
          /* ignore */
        }
      }
    })

    if (autoFocus) setTimeout(() => !useStore.getState().dialog && !useStore.getState().paletteOpen && term.focus(), 30)
    onReady?.({ focus: () => term.focus(), paste: pasteText,
      key: (data) => { if (!closed) api.termInput(id, data) },
      control: (active, consumed) => { controlArmed = active; controlConsumed = consumed } })

    return () => {
      onReady?.(null)
      offAppearance()
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragover', onDragOver)
      dataSub.dispose()
      binSub.dispose()
      terminals.delete(id)
      closers.delete(id)
      api.termClose(id)
      termRef.current = null
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, attempt])

  useEffect(() => {
    const t = termRef.current
    if (!t) return
    t.term.options.fontSize = fontSize
    try {
      t.fit.fit()
      api.termResize(t.id, t.term.cols, t.term.rows)
    } catch {
      /* ignore */
    }
  }, [fontSize])



  return (
    <div className={`terminal-wrap ${className ?? ''}`}>
      <div ref={ref} className="terminal-host" onMouseDown={() => termRef.current?.term.focus()} />
      {state.phase === 'connecting' && (
        <div className="terminal-overlay subtle">
          <Spinner /> <span>{t('Attaching…')}</span>
        </div>
      )}
      {state.phase === 'closed' && (
        <div className="terminal-overlay">
          <span>{t('Terminal detached')}{state.reason ? `: ${state.reason}` : ''}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setState({ phase: 'connecting' })
              setAttempt((a) => a + 1)
            }}
          >
            <RotateCw size={13} /> {t('Reattach')}
          </button>
        </div>
      )}
    </div>
  )
}
