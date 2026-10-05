// Floating actions for a text selection in chat messages: clarify, quote, explain, copy.
// Mac: a small toolbar above the selection (keyboard: ⌥R ⌥Q ⌥E, Esc closes). Phone: a bar docked
// above the composer, so it never fights the iOS selection menu. Only drafts — nothing is sent.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Check, Copy, Lightbulb, MessageCircleQuestion, Quote } from 'lucide-react'
import { t } from '../i18n'
import { useMobileWeb } from '../mobile'
import { setDraft, useStore } from '../store'
import { draftFor, extractSelection, type Fragment, type Phrases, type SelectionAction } from '../selection-tools'
import '../styles/selection.css'

const KEYS: Record<string, Exclude<SelectionAction, 'copy'>> = { KeyR: 'clarify', KeyQ: 'quote', KeyE: 'explain' }
const phrases = (): Phrases => ({
  clarifyInline: t('Clarify, please: “{text}”'), clarifyBlock: t('Clarify, please:'),
  explainInline: t('Explain in more detail: “{text}”'), explainBlock: t('Explain in more detail:')
})
interface Shown { fragment: Fragment; x: number; y: number; below: boolean; minX: number; maxX: number }

export function SelectionTools({ paneId }: { paneId: string }) {
  const mobileWeb = useMobileWeb()
  const anchor = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [copied, setCopied] = useState(false)
  const [bottom, setBottom] = useState(0)
  const last = useRef<Fragment | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  const view = useCallback(() => anchor.current?.closest('.thread-view') ?? null, [])
  const update = useCallback(() => {
    const root = view(), sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) { setShown(null); return }
    const range = sel.getRangeAt(0)
    // The chat that holds the selection (the phone keeps a few cached chats side by side).
    const scroller = [...root.querySelectorAll('.chat-scroll')].find((s) => s.contains(range.commonAncestorContainer))
    const fragment = scroller ? extractSelection(range, scroller) : null
    if (!scroller) { setShown(null); return }
    if (!fragment) { setShown(null); return }
    const rects = [...range.getClientRects()].filter((r) => r.width || r.height), box = scroller.getBoundingClientRect()
    const first = rects[0] ?? range.getBoundingClientRect(), lastRect = rects[rects.length - 1] ?? first
    if (first.bottom < box.top || lastRect.top > box.bottom) { setShown(null); return }
    const below = first.top - 48 < box.top
    const x = (below ? lastRect.left + lastRect.right : first.left + first.right) / 2
    last.current = fragment
    setCopied(false)
    setShown({ fragment, x, y: below ? Math.min(lastRect.bottom, box.bottom - 44) + 8 : Math.max(first.top, box.top + 44) - 8, below, minX: box.left, maxX: box.right })
  }, [view])

  useEffect(() => {
    let frame = 0
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('selectionchange', schedule); document.removeEventListener('scroll', schedule, { capture: true }); window.removeEventListener('resize', schedule) }
  }, [update])

  // Mac: keep the whole toolbar inside the chat, whatever the selection's edge.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el || !shown || mobileWeb) return
    const half = el.offsetWidth / 2
    const left = Math.min(Math.max(shown.x, shown.minX + half + 8), shown.maxX - half - 8)
    el.style.left = `${left}px`
    el.style.setProperty('--sel-arrow', `${Math.min(Math.max(shown.x - left + half, 14), el.offsetWidth - 14)}px`)
  }, [shown, mobileWeb, copied])

  // Phone: dock above the composer (it moves with the keyboard).
  useLayoutEffect(() => {
    if (!mobileWeb || !shown) return
    const place = () => { const c = view()?.querySelector('.composer-wrap'); setBottom(c ? window.innerHeight - c.getBoundingClientRect().top + 8 : 16) }
    place()
    window.visualViewport?.addEventListener('resize', place)
    return () => window.visualViewport?.removeEventListener('resize', place)
  }, [mobileWeb, shown, view])

  const run = useCallback((action: SelectionAction) => {
    const fragment = last.current
    if (!fragment) return
    if (action === 'copy') { void navigator.clipboard.writeText(fragment.text); setCopied(true); return }
    const current = useStore.getState().drafts[paneId]?.text ?? ''
    const next = draftFor(action, fragment, current, phrases())
    setDraft(paneId, { text: next.text })
    window.getSelection()?.removeAllRanges()
    setShown(null)
    const focus = () => { const ta = view()?.querySelector<HTMLTextAreaElement>('textarea.composer-input'); if (!ta) return; ta.focus(); ta.setSelectionRange(next.caret, next.caret); ta.scrollTop = ta.scrollHeight }
    requestAnimationFrame(() => requestAnimationFrame(focus))
  }, [paneId, view])

  useEffect(() => {
    if (!shown || mobileWeb) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { window.getSelection()?.removeAllRanges(); setShown(null); return }
      const action = e.altKey && !e.metaKey && !e.ctrlKey ? KEYS[e.code] : undefined
      if (action) { e.preventDefault(); run(action) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, mobileWeb, run])

  const buttons: { action: SelectionAction; label: string; icon: ReactElement; key?: string }[] = [
    { action: 'clarify', label: t('Clarify'), icon: <MessageCircleQuestion size={mobileWeb ? 20 : 14} />, key: '⌥R' },
    { action: 'quote', label: t('Quote'), icon: <Quote size={mobileWeb ? 20 : 14} />, key: '⌥Q' },
    { action: 'explain', label: t('Explain'), icon: <Lightbulb size={mobileWeb ? 20 : 14} />, key: '⌥E' },
    { action: 'copy', label: copied ? t('Copied') : t('Copy'), icon: copied ? <Check size={mobileWeb ? 20 : 14} /> : <Copy size={mobileWeb ? 20 : 14} /> }
  ]
  return (
    <span ref={anchor} className="sel-anchor" aria-hidden={!shown}>
      {shown && (
        <div
          ref={panel}
          className={mobileWeb ? 'sel-tools sel-tools-bar' : `sel-tools${shown.below ? ' below' : ''}`}
          role="toolbar"
          aria-label={t('Selected text')}
          style={mobileWeb ? { bottom } : { left: shown.x, top: shown.y }}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          {buttons.map((b) => (
            <button key={b.action} type="button" className="sel-tool" title={b.key && !mobileWeb ? `${b.label} · ${b.key}` : b.label} onClick={() => run(b.action)}>
              {b.icon}<span>{b.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
