import { homedir } from 'node:os'
import { relative, isAbsolute } from 'node:path'
import type { ImageRef } from '@shared/types'

export const MAX_OUTPUT = 24_000
export const MAX_IMAGE_B64 = 12 * 1024 * 1024

export function truncate(s: string | undefined | null, n = MAX_OUTPUT): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s
}

export function firstLine(s: string, max = 160): string {
  const line = (s || '').split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

export function displayPath(p: string | undefined | null, cwd?: string | null): string {
  if (!p) return ''
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p)
    if (r && !r.startsWith('..') && !isAbsolute(r)) return r
  }
  const home = homedir()
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

export function fileUrl(path: string): string {
  return `hdfile://local/?p=${encodeURIComponent(path)}`
}

export function dataUrl(mediaType: string | undefined, data: string | undefined): ImageRef | null {
  if (!data || data.length > MAX_IMAGE_B64) return null
  return { src: `data:${mediaType || 'image/png'};base64,${data}`, mediaType }
}

export function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

export function safeJson(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string') return (s && typeof s === 'object' ? (s as Record<string, unknown>) : null)
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v, null, 2)
}

export function stripImagePlaceholders(text: string): string {
  return text.replace(/\[Image #\d+\]\s*/g, '').trim()
}

/** Pretty JSON for tool inputs, trimmed. */
export function prettyInput(v: unknown, n = 8000): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return truncate(v, n)
  try {
    return truncate(JSON.stringify(v, null, 2), n)
  } catch {
    return ''
  }
}

/** Tool title that the UI can translate: English text plus its key and parameters. */
export function T(
  key: string,
  params?: Record<string, string | number>,
  one?: string
): { title: string; titleKey: string; titleParams?: Record<string, string | number>; titleOne?: string } {
  const n = params?.n
  const src = one && n === 1 ? one : key
  const title = src.replace(/\{(\w+)\}/g, (m, k: string) => (params && params[k] !== undefined ? String(params[k]) : m))
  return { title, titleKey: key, titleParams: params, titleOne: one }
}
