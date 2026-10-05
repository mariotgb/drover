import type { TranscriptUpdate } from '@shared/types'

/** Evidence is main-only, including on the existing chat/remote transcript channels. */
export function publicTranscript(update: TranscriptUpdate): TranscriptUpdate {
  return { ...update, items: update.items.map(item => {
    if (item.kind !== 'tool') return item
    const { officeEvidence: _private, ...safe } = item
    return safe
  }) }
}
