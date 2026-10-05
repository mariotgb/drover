import { parentPort } from 'node:worker_threads'
import { OFFICE_LIMITS } from '@shared/office'
import type { TranscriptItem, TranscriptMeta } from '@shared/types'
import { ClaudeParser } from './claude'
import { CodexParser } from './codex'
import { OfficeParser } from './officeParser'
import { FileTailer } from './tail'
import type { TranscriptParser } from './store'

export interface WorkerBatch { type: 'batch'; id: string; sequence: number; reset: boolean; baseline: boolean; initial: boolean; meta: Partial<TranscriptMeta>; items: TranscriptItem[] }
export type WorkerMessage = WorkerBatch | { type: 'ready'; id: string } | { type: 'error'; id: string; error: string } | { type: 'synced'; id: string; token: string }
export type WorkerRequest = { type: 'open'; id: string; path: string; kind: 'claude' | 'codex'; office: boolean } | { type: 'close'; id: string } | { type: 'ack'; id: string; sequence: number } | { type: 'sync'; id: string; token: string }

const streams = new Map<string, { tailer: FileTailer; acknowledge: (() => void) | null }>()
parentPort!.on('message', (message: WorkerRequest) => {
  if (message.type === 'sync') {
    void streams.get(message.id)?.tailer.sync().finally(() => parentPort!.postMessage({ type: 'synced', id: message.id, token: message.token }))
    return
  }
  if (message.type === 'ack') { streams.get(message.id)?.acknowledge?.(); return }
  if (message.type === 'close') {
    const stream = streams.get(message.id)
    stream?.tailer.stop(); stream?.acknowledge?.(); streams.delete(message.id)
    return
  }
  const makeParser = (): TranscriptParser => message.office ? new OfficeParser(message.kind) : message.kind === 'claude' ? new ClaudeParser() : new CodexParser()
  let parser = makeParser(), initial = true, sequence = 0
  const stream = { tailer: null as unknown as FileTailer, acknowledge: null as (() => void) | null }
  const tailer = new FileTailer(message.path, async (lines, reset, baseline) => {
    if (streams.get(message.id) !== stream) return
    if (reset) parser = makeParser()
    // JSON decoding, display diff generation and correlation stay in this thread.
    parser.feed(lines)
    const batch: WorkerBatch = { type: 'batch', id: message.id, sequence: ++sequence, reset, baseline, initial,
      meta: parser.meta, items: parser.store.takeChanges() }
    // One outstanding batch per stream. The main loop never drains an unbounded queue.
    await new Promise<void>(resolve => {
      stream.acknowledge = () => { stream.acknowledge = null; resolve() }
      parentPort!.postMessage(batch)
    })
  }, error => parentPort!.postMessage({ type: 'error', id: message.id, error: error.message }),
  () => Infinity, message.office ? { initialBytes: OFFICE_LIMITS.tailBytes, maxLineBytes: OFFICE_LIMITS.maxOfficeRecordBytes } : {})
  stream.tailer = tailer; streams.set(message.id, stream)
  void tailer.start().then(() => {
    initial = false
    if (streams.get(message.id) === stream) parentPort!.postMessage({ type: 'ready', id: message.id })
  }).catch(error => parentPort!.postMessage({ type: 'error', id: message.id, error: String(error) }))
})
