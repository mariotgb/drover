// Theme engine: a theme is a small palette; every UI token and the terminal
// ANSI palette are derived from it. Shared by main (native appearance) and
// renderer (CSS variables, xterm theme).

export interface ThemePalette {
  base: 'light' | 'dark'
  bg: string
  surface: string
  sidebar: string
  text: string
  muted: string
  accent: string
  green: string
  red: string
  yellow: string
  blue: string
  purple: string
  cyan: string
  termBg?: string
}

export interface ThemeDef {
  id: string
  name: string
  palette: ThemePalette
  custom?: boolean
}

export type BackgroundKind = 'none' | 'gradient' | 'image' | 'video'

export interface BackgroundSetting {
  kind: BackgroundKind
  /** gradient preset id */
  gradient?: string
  /** local file for image/video (copied into the app's data folder) */
  path?: string
  blur: number
  /** 0–90 % darkening (lightening on light themes) */
  dim: number
  fit: 'cover' | 'contain'
}

export interface AppearanceSettings {
  /** 'system' follows macOS light/dark with the default themes */
  theme: string
  customThemes: ThemeDef[]
  /** Accent override (hex), null = theme accent */
  accent: string | null
  background: BackgroundSetting
  /** Panel opacity over a background, 0.3–1 */
  glass: number
  radius: 'sharp' | 'default' | 'round'
  density: 'comfortable' | 'compact'
  uiFont: 'system' | 'rounded' | 'serif' | 'mono'
  monoFont: string
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  customThemes: [],
  accent: null,
  background: { kind: 'none', blur: 0, dim: 30, fit: 'cover' },
  glass: 0.82,
  radius: 'default',
  density: 'comfortable',
  uiFont: 'system',
  monoFont: 'SF Mono'
}

const P = (p: ThemePalette) => p

export const THEMES: ThemeDef[] = [
  { id: 'light', name: 'Drover Light', palette: P({ base: 'light', bg: '#ffffff', surface: '#f7f7f5', sidebar: '#f3f3f0', text: '#1d1d1b', muted: '#8b8b84', accent: '#c96442', green: '#1f9d55', red: '#d9443c', yellow: '#b7790a', blue: '#2f6fdf', purple: '#a626a4', cyan: '#0184bc' }) },
  { id: 'dark', name: 'Drover Dark', palette: P({ base: 'dark', bg: '#1c1c1b', surface: '#252524', sidebar: '#181817', text: '#ecece8', muted: '#87877f', accent: '#d97757', green: '#3ecf7a', red: '#f06b63', yellow: '#f5b83d', blue: '#60a5fa', purple: '#c678dd', cyan: '#56b6c2' }) },
  { id: 'paper', name: 'Paper', palette: P({ base: 'light', bg: '#fbf8f1', surface: '#f4efe4', sidebar: '#efe9dc', text: '#2b2721', muted: '#8a8274', accent: '#b4532a', green: '#4b7f2a', red: '#b8382f', yellow: '#a8740c', blue: '#2c62a8', purple: '#8a4baf', cyan: '#2b7f86' }) },
  { id: 'midnight', name: 'Midnight', palette: P({ base: 'dark', bg: '#000000', surface: '#0d0d0d', sidebar: '#050505', text: '#e9e9e9', muted: '#858585', accent: '#e07a55', green: '#45d483', red: '#ff6b6b', yellow: '#ffc857', blue: '#6aa8ff', purple: '#c792ea', cyan: '#5ad1d1' }) },
  { id: 'dracula', name: 'Dracula', palette: P({ base: 'dark', bg: '#282a36', surface: '#303341', sidebar: '#21222c', text: '#f8f8f2', muted: '#8b93bf', accent: '#bd93f9', green: '#50fa7b', red: '#ff5555', yellow: '#f1fa8c', blue: '#8be9fd', purple: '#ff79c6', cyan: '#8be9fd' }) },
  { id: 'nord', name: 'Nord', palette: P({ base: 'dark', bg: '#2e3440', surface: '#3b4252', sidebar: '#272c36', text: '#eceff4', muted: '#9aa5b8', accent: '#88c0d0', green: '#a3be8c', red: '#bf616a', yellow: '#ebcb8b', blue: '#81a1c1', purple: '#b48ead', cyan: '#8fbcbb' }) },
  { id: 'tokyo-night', name: 'Tokyo Night', palette: P({ base: 'dark', bg: '#1a1b26', surface: '#222436', sidebar: '#16161e', text: '#c0caf5', muted: '#7a83ad', accent: '#7aa2f7', green: '#9ece6a', red: '#f7768e', yellow: '#e0af68', blue: '#7aa2f7', purple: '#bb9af7', cyan: '#7dcfff' }) },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', palette: P({ base: 'dark', bg: '#1e1e2e', surface: '#262637', sidebar: '#181825', text: '#cdd6f4', muted: '#8a8fa8', accent: '#cba6f7', green: '#a6e3a1', red: '#f38ba8', yellow: '#f9e2af', blue: '#89b4fa', purple: '#cba6f7', cyan: '#94e2d5' }) },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', palette: P({ base: 'light', bg: '#eff1f5', surface: '#e6e9ef', sidebar: '#e3e6ed', text: '#4c4f69', muted: '#8c8fa1', accent: '#8839ef', green: '#40a02b', red: '#d20f39', yellow: '#df8e1d', blue: '#1e66f5', purple: '#8839ef', cyan: '#179299' }) },
  { id: 'rose-pine', name: 'Rosé Pine', palette: P({ base: 'dark', bg: '#191724', surface: '#1f1d2e', sidebar: '#16141f', text: '#e0def4', muted: '#908caa', accent: '#ebbcba', green: '#9ccfd8', red: '#eb6f92', yellow: '#f6c177', blue: '#9ccfd8', purple: '#c4a7e7', cyan: '#9ccfd8' }) },
  { id: 'gruvbox', name: 'Gruvbox', palette: P({ base: 'dark', bg: '#282828', surface: '#32302f', sidebar: '#1d2021', text: '#ebdbb2', muted: '#a89984', accent: '#fe8019', green: '#b8bb26', red: '#fb4934', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', cyan: '#8ec07c' }) },
  { id: 'one-dark', name: 'One Dark', palette: P({ base: 'dark', bg: '#282c34', surface: '#2f343e', sidebar: '#21252b', text: '#abb2bf', muted: '#7f848e', accent: '#61afef', green: '#98c379', red: '#e06c75', yellow: '#e5c07b', blue: '#61afef', purple: '#c678dd', cyan: '#56b6c2' }) },
  { id: 'github-light', name: 'GitHub Light', palette: P({ base: 'light', bg: '#ffffff', surface: '#f6f8fa', sidebar: '#f6f8fa', text: '#1f2328', muted: '#656d76', accent: '#0969da', green: '#1a7f37', red: '#cf222e', yellow: '#9a6700', blue: '#0969da', purple: '#8250df', cyan: '#1b7c83' }) },
  { id: 'github-dark', name: 'GitHub Dark', palette: P({ base: 'dark', bg: '#0d1117', surface: '#161b22', sidebar: '#010409', text: '#e6edf3', muted: '#7d8590', accent: '#2f81f7', green: '#3fb950', red: '#f85149', yellow: '#d29922', blue: '#58a6ff', purple: '#bc8cff', cyan: '#39c5cf' }) },
  { id: 'solarized-light', name: 'Solarized Light', palette: P({ base: 'light', bg: '#fdf6e3', surface: '#f5eedb', sidebar: '#eee8d5', text: '#586e75', muted: '#93a1a1', accent: '#268bd2', green: '#859900', red: '#dc322f', yellow: '#b58900', blue: '#268bd2', purple: '#6c71c4', cyan: '#2aa198' }) },
  { id: 'solarized-dark', name: 'Solarized Dark', palette: P({ base: 'dark', bg: '#002b36', surface: '#073642', sidebar: '#00232c', text: '#93a1a1', muted: '#657b83', accent: '#268bd2', green: '#859900', red: '#dc322f', yellow: '#b58900', blue: '#268bd2', purple: '#6c71c4', cyan: '#2aa198' }) }
]

export const GRADIENTS: { id: string; name: string; css: string; base: 'light' | 'dark' }[] = [
  { id: 'aurora', name: 'Aurora', base: 'dark', css: 'radial-gradient(at 18% 22%, #6d5dfc88 0, transparent 52%), radial-gradient(at 82% 8%, #00c2ff66 0, transparent 48%), radial-gradient(at 55% 100%, #ff5fb277 0, transparent 55%), #0b0d17' },
  { id: 'sunset', name: 'Sunset', base: 'light', css: 'linear-gradient(135deg, #ffb199 0%, #ff6a88 48%, #ff99ac 100%)' },
  { id: 'ocean', name: 'Ocean', base: 'dark', css: 'linear-gradient(160deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { id: 'forest', name: 'Forest', base: 'dark', css: 'linear-gradient(135deg, #0f3d3e 0%, #1d5c4c 45%, #71b280 100%)' },
  { id: 'peach', name: 'Peach', base: 'light', css: 'linear-gradient(120deg, #f6d365 0%, #fda085 100%)' },
  { id: 'lavender', name: 'Lavender', base: 'light', css: 'radial-gradient(at 0% 0%, #e0c3fc 0, transparent 60%), radial-gradient(at 100% 100%, #8ec5fc 0, transparent 60%), #f4f1ff' },
  { id: 'mesh', name: 'Mesh', base: 'light', css: 'radial-gradient(at 12% 18%, #ffd6a5 0, transparent 50%), radial-gradient(at 88% 12%, #caffbf 0, transparent 45%), radial-gradient(at 70% 88%, #9bf6ff 0, transparent 50%), radial-gradient(at 18% 92%, #ffc6ff 0, transparent 50%), #fffdf7' },
  { id: 'noir', name: 'Noir', base: 'dark', css: 'radial-gradient(circle at 30% 20%, #2b2b30 0, #0a0a0c 70%)' },
  { id: 'synthwave', name: 'Synthwave', base: 'dark', css: 'linear-gradient(180deg, #120458 0%, #3b0a5a 45%, #ff2e88 100%)' }
]

export const MONO_FONTS = ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono', 'Source Code Pro']

export function findTheme(id: string, custom: ThemeDef[] = []): ThemeDef | undefined {
  return custom.find((t) => t.id === id) ?? THEMES.find((t) => t.id === id)
}

/** The theme in effect for a setting; 'system' resolves with the OS mode. */
export function resolveTheme(a: AppearanceSettings, systemDark: boolean): ThemeDef {
  if (a.theme === 'system') return findTheme(systemDark ? 'dark' : 'light')!
  return findTheme(a.theme, a.customThemes) ?? findTheme(systemDark ? 'dark' : 'light')!
}

// --------------------------------------------------------------------------- color math

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  return Number.isNaN(n) ? [128, 128, 128] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function readableOn(hex: string): string {
  return luminance(hex) > 0.45 ? '#141413' : '#ffffff'
}

export function isHexColor(s: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim())
}

/** All CSS custom properties for a palette. */
export function themeVars(p: ThemePalette, accentOverride?: string | null): Record<string, string> {
  const dark = p.base === 'dark'
  const accent = accentOverride && isHexColor(accentOverride) ? accentOverride : p.accent
  const black = '#000000'
  return {
    '--bg': p.bg,
    '--bg-elev': p.surface,
    '--bg-elev-2': mix(p.surface, p.text, dark ? 0.06 : 0.04),
    '--bg-sunken': dark ? mix(p.bg, black, 0.18) : mix(p.bg, p.text, 0.03),
    '--bg-hover': alpha(p.text, dark ? 0.06 : 0.05),
    '--bg-active': alpha(p.text, dark ? 0.1 : 0.085),
    '--bg-selected': alpha(p.text, dark ? 0.08 : 0.07),
    '--sidebar-bg': alpha(p.sidebar, 0.9),
    '--sidebar-solid': p.sidebar,
    '--border': alpha(p.text, dark ? 0.09 : 0.09),
    '--border-strong': alpha(p.text, dark ? 0.16 : 0.16),
    '--text': p.text,
    '--text-2': mix(p.text, p.bg, 0.28),
    '--text-3': p.muted,
    '--text-4': mix(p.muted, p.bg, 0.4),
    '--bubble': mix(p.bg, p.text, dark ? 0.09 : 0.055),
    '--code-bg': dark ? mix(p.bg, black, 0.2) : mix(p.bg, p.text, 0.03),
    '--code-border': alpha(p.text, 0.07),
    '--accent': accent,
    '--accent-hover': mix(accent, dark ? '#ffffff' : '#000000', 0.12),
    '--accent-soft': alpha(accent, dark ? 0.18 : 0.13),
    '--accent-text': readableOn(accent),
    '--working': p.blue,
    '--blocked': p.yellow,
    '--done': p.green,
    '--idle': p.muted,
    '--danger': p.red,
    '--danger-soft': alpha(p.red, 0.12),
    '--success': p.green,
    '--diff-add-bg': alpha(p.green, 0.12),
    '--diff-add-text': dark ? mix(p.green, '#ffffff', 0.25) : mix(p.green, '#000000', 0.2),
    '--diff-del-bg': alpha(p.red, 0.12),
    '--diff-del-text': dark ? mix(p.red, '#ffffff', 0.25) : mix(p.red, '#000000', 0.15),
    '--hl-keyword': p.purple,
    '--hl-string': p.green,
    '--hl-number': p.yellow,
    '--hl-comment': p.muted,
    '--hl-title': p.blue,
    '--hl-attr': p.yellow,
    '--hl-type': p.cyan,
    '--hl-meta': p.cyan,
    '--term-bg': p.termBg ?? p.bg,
    '--term-fg': p.text,
    '--overlay': dark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(20, 20, 18, 0.28)',
    '--shadow-md': dark ? '0 4px 16px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.3)' : '0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)',
    '--shadow-lg': dark ? '0 18px 50px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)' : '0 18px 50px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)'
  }
}

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export function terminalColors(p: ThemePalette): TerminalColors {
  const dark = p.base === 'dark'
  const bright = (c: string) => mix(c, dark ? '#ffffff' : '#000000', 0.18)
  const bg = p.termBg ?? p.bg
  return {
    background: bg,
    foreground: p.text,
    cursor: p.text,
    cursorAccent: bg,
    selectionBackground: alpha(p.blue, dark ? 0.35 : 0.22),
    black: dark ? mix(bg, p.text, 0.12) : p.text,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.purple,
    cyan: p.cyan,
    white: dark ? mix(p.text, bg, 0.12) : p.muted,
    brightBlack: p.muted,
    brightRed: bright(p.red),
    brightGreen: bright(p.green),
    brightYellow: bright(p.yellow),
    brightBlue: bright(p.blue),
    brightMagenta: bright(p.purple),
    brightCyan: bright(p.cyan),
    brightWhite: dark ? '#ffffff' : mix(p.muted, '#ffffff', 0.4)
  }
}
