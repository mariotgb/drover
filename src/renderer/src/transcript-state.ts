import type { TranscriptMeta, TranscriptItem, TranscriptUpdate } from '@shared/types'

export interface TranscriptState {
  meta: TranscriptMeta | null
  items: TranscriptItem[]
  error?: string
  loaded: boolean
  stream?: string
  revision?: number
}

export function mergeTranscript(prev: TranscriptState | undefined, u: TranscriptUpdate): { next: TranscriptState; newUsers: string[] } {
  if (prev && u.stream === prev.stream && u.revision !== undefined && prev.revision !== undefined && u.revision <= prev.revision) return { next: prev, newUsers: [] }
  if (prev && u.stream && prev.stream && u.stream !== prev.stream && !u.reset) return { next: prev, newUsers: [] }
  const version = { stream: u.stream ?? prev?.stream, revision: u.revision ?? prev?.revision }
  if (u.reset || !prev) {
    // A brand-new conversation arrives as a reset: still settle pending bubbles.
    const users = u.items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))
    return { next: { ...version, meta: u.meta, items: u.items, error: u.error, loaded: u.reset || !u.error }, newUsers: users }
  }
  if (!u.items.length) return { next: { ...prev, ...version, meta: u.meta ?? prev.meta, error: u.error }, newUsers: [] }
  const items = prev.items.slice()
  const index = new Map<string, number>()
  items.forEach((it, i) => index.set(it.id, i))
  const newUsers: string[] = []
  for (const it of u.items) {
    const i = index.get(it.id)
    if (i === undefined) {
      index.set(it.id, items.length)
      items.push(it)
      if (it.kind === 'user') newUsers.push(it.text)
    } else items[i] = it
  }
  return { next: { ...version, meta: u.meta ?? prev.meta, items, error: u.error, loaded: true }, newUsers }
}

