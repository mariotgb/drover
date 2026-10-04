import type { AppSettings } from '@shared/types'
import { resolveTheme, terminalColors, themeVars, type TerminalColors, type ThemeDef } from '@shared/themes'

// Applies the appearance settings to the document: theme tokens as CSS
// variables, fonts, radius, density. Keeps xterm instances in sync.

const RADII = {
  sharp: { sm: '3px', md: '5px', lg: '8px', xl: '10px', bubble: '8px' },
  default: { sm: '6px', md: '10px', lg: '16px', xl: '22px', bubble: '18px' },
  round: { sm: '8px', md: '14px', lg: '20px', xl: '28px', bubble: '22px' }
} as const

export const UI_FONTS = {
  system: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  serif: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Monaco, monospace"
} as const

let current: AppSettings | null = null
let resolved: ThemeDef | null = null
const listeners = new Set<() => void>()
const media = window.matchMedia('(prefers-color-scheme: dark)')

media.addEventListener('change', () => {
  if (current) applyAppearance(current)
})

export function monoFontFamily(name?: string): string {
  const f = name || current?.appearance.monoFont || 'SF Mono'
  return `'${f}', ui-monospace, 'SF Mono', Menlo, Monaco, monospace`
}

export function activeTheme(): ThemeDef | null {
  return resolved
}

export function isDarkTheme(): boolean {
  return (resolved?.palette.base ?? (media.matches ? 'dark' : 'light')) === 'dark'
}

export function terminalTheme(): TerminalColors | null {
  return resolved ? terminalColors(resolved.palette) : null
}

export function onAppearanceChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function applyAppearance(s: AppSettings) {
  current = s
  const a = s.appearance
  const theme = resolveTheme(a, media.matches)
  resolved = theme
  const root = document.documentElement
  const vars = themeVars(theme.palette, a.accent)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.setAttribute('data-theme', theme.palette.base)
  root.removeAttribute('data-accent')
  root.setAttribute('data-density', a.density)
  const r = RADII[a.radius] ?? RADII.default
  root.style.setProperty('--radius-sm', r.sm)
  root.style.setProperty('--radius', r.md)
  root.style.setProperty('--radius-lg', r.lg)
  root.style.setProperty('--radius-xl', r.xl)
  root.style.setProperty('--radius-bubble', r.bubble)
  root.style.setProperty('--font-ui', UI_FONTS[a.uiFont] ?? UI_FONTS.system)
  root.style.setProperty('--font-mono', monoFontFamily(a.monoFont))
  root.style.setProperty('--glass', String(Math.max(0.3, Math.min(1, a.glass))))
  const dim = Math.max(0, Math.min(90, a.background.dim)) / 100
  root.style.setProperty('--bg-dim', theme.palette.base === 'dark' ? `rgba(0, 0, 0, ${dim})` : `rgba(255, 255, 255, ${dim})`)
  root.style.setProperty('--bg-blur', `${Math.max(0, Math.min(40, a.background.blur))}px`)
  root.style.setProperty('--chat-font', `${s.chatFontSize}px`)
  root.style.setProperty('--sidebar-width', `${s.sidebarWidth}px`)
  for (const fn of listeners) fn()
}
