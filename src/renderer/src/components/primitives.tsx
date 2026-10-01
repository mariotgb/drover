import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { SquareTerminal } from 'lucide-react'
import type { AgentStatus } from '@shared/types'
import { agentKindDef } from '@shared/agents'
import { statusLabel } from '../model'

export function StatusDot({ status, size = 8, title }: { status: AgentStatus; size?: number; title?: string }) {
  if (status === 'working') {
    return (
      <span className="status-spinner" style={{ width: size + 4, height: size + 4 }} title={title ?? statusLabel(status)}>
        <svg viewBox="0 0 16 16" width={size + 4} height={size + 4}>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="track" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" strokeWidth="2" strokeLinecap="round" className="arc" />
        </svg>
      </span>
    )
  }
  return (
    <span
      className={clsx('status-dot', `status-${status}`)}
      style={{ width: size, height: size }}
      title={title ?? statusLabel(status)}
    />
  )
}

export function AgentAvatar({ kind, size = 22 }: { kind: string | null; size?: number }) {
  const def = agentKindDef(kind)
  if (!def) {
    return (
      <span className="avatar avatar-shell" style={{ width: size, height: size }}>
        <SquareTerminal size={Math.round(size * 0.62)} strokeWidth={1.8} />
      </span>
    )
  }
  return (
    <span
      className={clsx('avatar', `avatar-${def.kind}`)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58), ['--hue' as string]: String(def.hue) }}
      title={def.label}
    >
      {def.glyph}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function IconButton({
  children,
  title,
  onClick,
  active,
  disabled,
  className,
  size = 'md'
}: {
  children: ReactNode
  title?: string
  onClick?: (e: React.MouseEvent) => void
  active?: boolean
  disabled?: boolean
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      className={clsx('icon-btn', size === 'sm' && 'icon-btn-sm', active && 'active', className)}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span className="spinner" style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size} height={size}>
        <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="track" />
        <path d="M8 2a6 6 0 0 1 6 6" fill="none" strokeWidth="2" strokeLinecap="round" className="arc" />
      </svg>
    </span>
  )
}

/** Re-renders every `ms` while mounted (for elapsed timers). */
export function useTicker(ms: number, enabled = true) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms, enabled])
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void, enabled = true) {
  const cb = useRef(onOutside)
  cb.current = onOutside
  useEffect(() => {
    if (!enabled) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current()
    }
    window.addEventListener('mousedown', h, true)
    window.addEventListener('keydown', k, true)
    return () => {
      window.removeEventListener('mousedown', h, true)
      window.removeEventListener('keydown', k, true)
    }
  }, [ref, enabled])
}
