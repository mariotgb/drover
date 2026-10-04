import type { TranscriptCursor, TranscriptUpdate } from '@shared/types'

/** One revision per item, no copies of historical chat contents. */
export class TranscriptRevisions {
  private known = new Set<number>()
  private items = new Map<string, number>()
  constructor(private limit = 1024) {}
  clear() { this.known.clear(); this.items.clear() }
  record(update: TranscriptUpdate) {
    if (update.reset) this.clear()
    if (update.revision === undefined) return
    this.known.add(update.revision)
    if (this.known.size > this.limit) this.known.delete(this.known.values().next().value!)
    for (const item of update.items) this.items.set(item.id, update.revision)
  }
  resume(full: TranscriptUpdate, cursor?: TranscriptCursor): TranscriptUpdate {
    if (!cursor || cursor.stream !== full.stream || !this.known.has(cursor.revision)) return full
    return { ...full, reset: false, baseRevision: cursor.revision,
      items: full.items.filter(item => (this.items.get(item.id) ?? Infinity) > cursor.revision) }
  }
}
