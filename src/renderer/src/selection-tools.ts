// Selection tools in chat: turn a text selection inside messages into a draft for the composer.
// Pure helpers (no React); the DOM part only reads a Range. Nothing is ever sent automatically.

export type SelectionAction = 'clarify' | 'quote' | 'explain' | 'copy'
export interface Fragment {
  text: string
  /** The whole selection lies inside one code block. */
  code: boolean
  lang?: string
}
export interface Draft { text: string; caret: number }
export interface Phrases {
  /** «Уточни, пожалуйста: «{text}»» — used for short single-line fragments. */
  clarifyInline: string
  /** «Уточни, пожалуйста:» — heading before a quoted block. */
  clarifyBlock: string
  explainInline: string
  explainBlock: string
}

/** Message content that may be quoted, and chrome inside it that must not be. */
export const MESSAGE_CONTENT = '.msg-user .bubble-text, .msg-assistant .md'
const CHROME = '.code-head, .msg-actions, .copy-btn, button, .pending-state, time, .msg-elements, .mobile-message-time'
const INLINE_MAX = 160

export function normalizeFragment(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

const fenceFor = (text: string) => { let f = '```'; while (text.includes(f)) f += '`'; return f }

/** Markdown block for a fragment: `> ` lines; code keeps its fence inside the quote. */
export function quoteBlock(f: Fragment): string {
  const body = f.code ? `${fenceFor(f.text)}${f.lang ?? ''}\n${f.text}\n${fenceFor(f.text)}` : f.text
  return body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
}

const isShort = (f: Fragment) => !f.code && !f.text.includes('\n') && f.text.length <= INLINE_MAX
const append = (current: string, insert: string): Draft => {
  const head = current.replace(/\s+$/, '')
  const text = head ? `${head}\n\n${insert}` : insert
  return { text, caret: text.length }
}

/** The new composer text and where the caret goes. `current` is the existing draft (kept). */
export function draftFor(action: Exclude<SelectionAction, 'copy'>, f: Fragment, current: string, p: Phrases): Draft {
  if (action === 'quote') {
    const quote = `${quoteBlock(f)}\n\n`
    const rest = current.replace(/^\s+/, '')
    return { text: quote + rest, caret: quote.length }
  }
  const inline = action === 'clarify' ? p.clarifyInline : p.explainInline
  const block = action === 'clarify' ? p.clarifyBlock : p.explainBlock
  const insert = isShort(f) ? `${inline.replace('{text}', f.text)} ` : `${block}\n${quoteBlock(f)}\n\n`
  return append(current, insert)
}

/** Text a fragment contributes to the clipboard (code keeps its exact lines). */
export const copyText = (f: Fragment) => f.text

// ---------------------------------------------------------------- DOM (browser only)

function rangeText(range: Range): string {
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;left:-99999px;top:0;width:640px;white-space:normal;pointer-events:none;opacity:0'
  box.appendChild(range.cloneContents())
  box.querySelectorAll(CHROME).forEach((n) => n.remove())
  document.body.appendChild(box)
  const text = box.innerText
  box.remove()
  return text
}

/** The selected text inside chat messages under `root`, or null when the selection is elsewhere / empty. */
export function extractSelection(range: Range, root: Element): Fragment | null {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null
  const parts: string[] = []
  for (const el of root.querySelectorAll(MESSAGE_CONTENT)) {
    if (!range.intersectsNode(el)) continue
    const r = document.createRange()
    r.selectNodeContents(el)
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset)
    const text = normalizeFragment(rangeText(r))
    if (text) parts.push(text)
  }
  if (!parts.length) return null
  const elementOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)
  const preA = elementOf(range.startContainer)?.closest('pre'), preB = elementOf(range.endContainer)?.closest('pre')
  const code = parts.length === 1 && !!preA && preA === preB
  const lang = code ? (preA!.querySelector('code')?.className.match(/language-(\S+)/)?.[1] || preA!.closest('.code-block')?.querySelector('.code-head')?.firstElementChild?.textContent?.trim()) : undefined
  return { text: code ? normalizeFragment(preA!.contains(range.commonAncestorContainer) ? range.toString() : parts[0]) : parts.join('\n\n'), code, ...(lang && lang !== 'text' ? { lang: lang.toLowerCase() } : {}) }
}
