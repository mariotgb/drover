import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
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
  return (
    <button
      type="button"
      className="copy-btn"
      title="Copy"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {label && <span>{done ? 'Copied' : label}</span>}
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
