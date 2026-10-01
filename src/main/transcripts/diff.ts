import type { DiffFile } from '@shared/types'

const MAX_LINES = 1200

function splitLines(s: string): string[] {
  if (!s) return []
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Line diff between two snippets (LCS). Produces lines prefixed with ' ', '-'
 * or '+'. Large inputs fall back to "all removed, all added".
 */
export function lineDiff(oldText: string, newText: string): { lines: string[]; added: number; removed: number } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length * b.length > 250_000) {
    const lines = [...a.map((l) => '-' + l), ...b.map((l) => '+' + l)]
    return { lines: lines.slice(0, MAX_LINES), added: b.length, removed: a.length }
  }
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: string[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push('-' + a[i++])
      removed++
    } else {
      out.push('+' + b[j++])
      added++
    }
  }
  while (i < n) {
    out.push('-' + a[i++])
    removed++
  }
  while (j < m) {
    out.push('+' + b[j++])
    added++
  }
  return { lines: collapseContext(out).slice(0, MAX_LINES), added, removed }
}

/** Keep at most 3 lines of unchanged context around changes. */
function collapseContext(lines: string[], ctx = 3): string[] {
  const keep = new Array(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l[0] === '+' || l[0] === '-') {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(lines.length - 1, idx + ctx); k++) keep[k] = true
    }
  })
  const out: string[] = []
  let skipped = 0
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) out.push(`@ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)
      skipped = 0
      out.push(l)
    } else skipped++
  })
  if (skipped && out.length) out.push(`@ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)
  return out
}

export function writeDiff(path: string, content: string): DiffFile {
  const lines = splitLines(content)
  return {
    path,
    lines: lines.slice(0, MAX_LINES).map((l) => '+' + l),
    added: lines.length,
    removed: 0,
    kind: 'write'
  }
}

export function editDiff(path: string, oldText: string, newText: string): DiffFile {
  const d = lineDiff(oldText, newText)
  return { path, lines: d.lines, added: d.added, removed: d.removed, kind: 'edit' }
}

/** Claude's toolUseResult.structuredPatch hunks. */
export function structuredPatchDiff(
  path: string,
  hunks: { oldStart?: number; newStart?: number; lines?: string[] }[]
): DiffFile {
  const lines: string[] = []
  let added = 0
  let removed = 0
  for (const h of hunks) {
    lines.push(`@ line ${h.newStart ?? h.oldStart ?? '?'}`)
    for (const l of h.lines ?? []) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
      lines.push(l.length && '+- '.includes(l[0]) ? l : ' ' + l)
    }
  }
  return { path, lines: lines.slice(0, MAX_LINES), added, removed, kind: 'edit' }
}

/** Parses the `*** Begin Patch` format used by Codex's apply_patch tool. */
export function parseApplyPatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const m = raw.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (m) {
      cur = {
        path: m[2].trim(),
        lines: [],
        added: 0,
        removed: 0,
        kind: m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'edit'
      }
      files.push(cur)
      continue
    }
    if (!cur) continue
    const mv = raw.match(/^\*\*\* Move to: (.+)$/)
    if (mv) {
      cur.path = `${cur.path} → ${mv[1].trim()}`
      continue
    }
    if (raw.startsWith('*** ')) continue
    if (raw.startsWith('@@')) {
      cur.lines.push('@ ' + raw.slice(2).trim())
      continue
    }
    if (raw.startsWith('+')) {
      cur.added++
      cur.lines.push(raw)
    } else if (raw.startsWith('-')) {
      cur.removed++
      cur.lines.push(raw)
    } else if (raw.startsWith(' ')) {
      cur.lines.push(raw)
    }
  }
  for (const f of files) f.lines = f.lines.slice(0, MAX_LINES)
  return files
}
