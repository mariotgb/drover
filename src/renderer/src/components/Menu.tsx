import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import clsx from 'clsx'
import { useClickOutside } from './primitives'

export type MenuItem =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | 'separator'
  | { header: string }

interface MenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
}

const useMenu = create<MenuState>(() => ({ open: false, x: 0, y: 0, items: [] }))

export function openMenu(pos: { clientX: number; clientY: number } | { x: number; y: number }, items: MenuItem[]) {
  const x = 'clientX' in pos ? pos.clientX : pos.x
  const y = 'clientY' in pos ? pos.clientY : pos.y
  useMenu.setState({ open: true, x, y, items })
}

export function openMenuAt(el: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') {
  const r = el.getBoundingClientRect()
  openMenu({ x: align === 'left' ? r.left : r.right - 220, y: r.bottom + 4 }, items)
}

export function closeMenu() {
  useMenu.setState({ open: false })
}

export function MenuHost() {
  const { open, x, y, items } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useClickOutside(ref, closeMenu, open)
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - r.width - 8)
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y
    setPos({ x: Math.max(8, nx), y: ny })
  }, [open, x, y, items])
  if (!open) return null
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => {
        if (it === 'separator') return <div key={i} className="menu-sep" />
        if ('header' in it) return <div key={i} className="menu-header">{it.header}</div>
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={clsx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            onClick={() => {
              closeMenu()
              it.onClick()
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}
