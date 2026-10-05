import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'

const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve))
// Each worker permits one initial read; the manager owns at most two workers.
let initialReads = 0
const waiting: Array<() => void> = []
async function acquire() {
  if (initialReads) await new Promise<void>(resolve => waiting.push(resolve))
  else initialReads++
}
function release() { const next = waiting.shift(); if (next) next(); else initialReads-- }

/** Chunked append-only JSONL reader. Async callbacks provide worker backpressure. */
export class FileTailer {
  private offset = 0
  private partial: Buffer = Buffer.alloc(0)
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private reading = false
  private again = false
  private stopped = false
  private identity: string | null = null
  private skipping = false
  private idle: Array<() => void> = []

  constructor(
    readonly path: string,
    private onLines: (lines: string[], reset: boolean, baseline: boolean) => void | Promise<void>,
    private onError?: (err: Error) => void,
    private maxBytes: () => number = () => Infinity,
    private options: { initialBytes?: number; maxLineBytes?: number } = {}
  ) {}

  async start(): Promise<void> {
    await acquire()
    try { await this.read(true) } finally { release() }
    if (this.stopped) return
    try {
      this.watcher = watch(this.path, { persistent: false }, () => void this.read(false))
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null })
    } catch { /* polling only */ }
    this.poll = setInterval(() => void this.read(false), 1200)
    this.poll.unref?.()
  }
  stop() {
    this.stopped = true
    this.watcher?.close(); this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }
  /** Subscription responses must include appends already observed by fs.watch. */
  async sync(): Promise<void> {
    while (this.reading) await new Promise<void>(resolve => this.idle.push(resolve))
    await this.read(false)
    while (this.reading) await new Promise<void>(resolve => this.idle.push(resolve))
  }

  private async read(initial: boolean): Promise<void> {
    if (this.stopped) return
    if (this.reading) { this.again = true; return }
    this.reading = true
    try {
      let reset = initial || this.identity === null
      const st = await stat(this.path)
      if (st.size > this.maxBytes()) throw new Error('office-history-limit')
      const identity = `${st.dev}:${st.ino}`
      if ((this.identity !== null && this.identity !== identity) || st.size < this.offset) reset = true
      if (reset) {
        this.offset = Math.max(0, st.size - (this.options.initialBytes ?? Infinity))
        this.partial = Buffer.alloc(0)
        // The tail may begin in the middle of UTF-8 or a JSON record.
        this.skipping = this.offset > 0
      }
      const baseline = reset
      if (st.size > this.offset || reset) {
        const fh = await open(this.path, 'r')
        this.identity = identity
        try {
          let budget = performance.now()
          while (!this.stopped && this.offset < st.size) {
            const buf = Buffer.allocUnsafe(Math.min(64 * 1024, st.size - this.offset))
            const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
            if (!bytesRead) break
            this.offset += bytesRead
            let chunk = buf.subarray(0, bytesRead)
            if (this.skipping) {
              const nl = chunk.indexOf(10)
              if (nl < 0) continue
              chunk = chunk.subarray(nl + 1); this.skipping = false
            }
            const data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk
            const lines: string[] = []
            let from = 0, nl: number
            while ((nl = data.indexOf(10, from)) >= 0) {
              if (nl - from <= (this.options.maxLineBytes ?? Infinity)) {
                const line = data.subarray(from, nl).toString('utf8')
                if (line.trim()) lines.push(line)
              }
              from = nl + 1
            }
            this.partial = Buffer.from(data.subarray(from))
            if (this.partial.length > (this.options.maxLineBytes ?? Infinity)) {
              this.partial = Buffer.alloc(0); this.skipping = true
            }
            if (lines.length || reset) { await this.onLines(lines, reset, baseline); reset = false }
            if (performance.now() - budget >= 3) { await yieldLoop(); budget = performance.now() }
          }
          if (!this.stopped && reset) await this.onLines([], true, true)
        } finally { await fh.close() }
      }
    } catch (err) { if (!this.stopped) this.onError?.(err as Error) }
    finally {
      this.reading = false
      if (this.again && !this.stopped) { this.again = false; void this.read(false) }
      for (const resolve of this.idle.splice(0)) resolve()
    }
  }
}
