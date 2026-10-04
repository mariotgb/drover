import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { LruCache, splitMarkdown } from '../markdown-blocks'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { t } from '../i18n'
import { useMobileWeb } from '../mobile'
import { api, isRemote } from '../api'

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  const mobileWeb = useMobileWeb()
  return (
    <button
      type="button"
      className="copy-btn"
      title={mobileWeb ? t('Copy') : 'Copy'}
      aria-label={mobileWeb ? t(done ? 'Copied' : 'Copy') : undefined}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{mobileWeb ? t(done ? 'Copied' : label) : done ? 'Copied' : label}</span>}
    </button>
  )
}

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        target={isRemote ? '_blank' : undefined}
        rel={isRemote ? 'noopener noreferrer' : undefined}
        onClick={(e) => {
          if (isRemote && href && /^https?:|^mailto:/i.test(href)) return
          e.preventDefault()
          if (href && /^https?:|^mailto:/i.test(href)) void api.openExternal(href)
        }}
        title={href}
      >
        {children}
      </a>
    )
  },
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const className = (child as { props?: { className?: string } })?.props?.className ?? ''
    const lang = /language-([\w+-]+)/.exec(className)?.[1] ?? ''
    const code = textOf(children).replace(/\n$/, '')
    return (
      <div className="code-block">
        <div className="code-head">
          <span>{lang || 'text'}</span>
          <CopyButton text={code} label="Copy" />
        </div>
        <pre>{children}</pre>
      </div>
    )
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  img({ src, alt }) {
    return <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="md-img" />
  }
}

const remarkPlugins = [remarkGfm]
const rehypePlugins: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]
const prepared = new LruCache<ReactElement>(600)

/** Parsed and highlighted once per distinct block text; reused across messages, chats and remounts. */
function prepare(text: string): ReactElement {
  let element = prepared.get(text)
  if (!element) {
    // react-markdown's sync renderer is a plain function without hooks.
    element = ReactMarkdown({ children: text, remarkPlugins, rehypePlugins, components }) as ReactElement
    prepared.set(text, element)
  }
  return element
}
const Block = memo(function Block({ text }: { text: string }) {
  return prepare(text)
})

/** At most one re-render per ~120 ms (aligned to a frame) while the text keeps changing. */
function useBatchedText(text: string): string {
  const [shown, setShown] = useState(text)
  const latest = useRef(text)
  const last = useRef(0)
  latest.current = text
  useEffect(() => {
    if (shown === text) return
    let frame = 0
    const timer = setTimeout(() => {
      frame = requestAnimationFrame(() => { last.current = performance.now(); setShown(latest.current) })
    }, Math.max(0, 120 - (performance.now() - last.current)))
    return () => { clearTimeout(timer); cancelAnimationFrame(frame) }
  }, [text, shown])
  return shown
}

/** Phone chat: one cached element per top-level block; only a changed (last) block is parsed again. */
const BlockMarkdown = memo(function BlockMarkdown({ text }: { text: string }) {
  const shown = useBatchedText(text)
  return <div className="md">{splitMarkdown(shown).map((block, i) => <Block key={i} text={block} />)}</div>
})

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (useMobileWeb()) return <BlockMarkdown text={text} />
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
