import type { TranscriptUpdate } from '@shared/types'
import { api } from './api'

/** Retained mobile screens share one subscription; apply its initial value once. */
const previews = new Map<string, { refs: number }>()
export function watchMobileTranscript(paneId: string, update: (value: TranscriptUpdate) => void): () => void {
  let entry = previews.get(paneId)
  if (!entry) {
    entry = { refs: 0 }
    previews.set(paneId, entry)
    const current = entry
    void api.transcriptSubscribe(paneId).then(value => {
      if (current.refs > 0 && previews.get(paneId) === current) update(value)
    }).catch(() => undefined)
  }
  entry.refs++
  let alive = true
  return () => {
    if (!alive) return
    alive = false
    if (--entry.refs === 0) { previews.delete(paneId); api.transcriptUnsubscribe(paneId) }
  }
}
