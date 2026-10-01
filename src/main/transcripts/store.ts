import type { TranscriptItem, TranscriptMeta, TranscriptTool, TranscriptEvent } from '@shared/types'

/** Ordered item list with in-place upserts and change tracking. */
export class ItemStore {
  items: TranscriptItem[] = []
  private index = new Map<string, number>()
  private changed = new Set<string>()

  upsert(item: TranscriptItem) {
    const i = this.index.get(item.id)
    if (i === undefined) {
      this.index.set(item.id, this.items.length)
      this.items.push(item)
    } else {
      this.items[i] = item
    }
    this.changed.add(item.id)
  }

  get(id: string): TranscriptItem | undefined {
    const i = this.index.get(id)
    return i === undefined ? undefined : this.items[i]
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  last(): TranscriptItem | undefined {
    return this.items[this.items.length - 1]
  }

  takeChanges(): TranscriptItem[] {
    const out: TranscriptItem[] = []
    for (const id of this.changed) {
      const i = this.index.get(id)
      if (i !== undefined) out.push(this.items[i])
    }
    this.changed.clear()
    return out
  }

  clearChanges() {
    this.changed.clear()
  }

  /** Resolve tools that never received a result (interrupted turns, crashes). */
  settleRunning(status: 'done' | 'error') {
    for (const item of this.items) {
      if (item.kind === 'tool' && item.status === 'running') {
        this.upsert({ ...item, status } as TranscriptTool)
      }
    }
  }

  event(id: string, variant: TranscriptEvent['variant'], text: string, ts?: number, durationMs?: number) {
    this.upsert({ kind: 'event', id, variant, text, ts, durationMs })
  }
}

export interface TranscriptParser {
  store: ItemStore
  meta: Partial<TranscriptMeta>
  feed(lines: string[]): void
}
