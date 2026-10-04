import type { IncomingMessage, ServerResponse } from 'node:http'
import { Transform, type Duplex } from 'node:stream'

/** A bounded transfer owns every stream/socket until the downstream finishes or
 * disconnects. A wall-clock deadline also covers slow peers that never go idle. */
export class RemoteTransfers {
  private active = new Set<Transfer>()
  constructor(readonly limit = 32, readonly timeoutMs = 60_000) {}
  open(req: IncomingMessage, downstream: ServerResponse | Duplex, onClose?: () => void): Transfer | null {
    if (this.active.size >= this.limit || downstream.destroyed || req.aborted) return null
    const transfer = new Transfer(req, downstream, this.timeoutMs, () => { this.active.delete(transfer); onClose?.() })
    this.active.add(transfer)
    return transfer
  }
  clear(): void { for (const transfer of this.active) transfer.close() }
}

export class Transfer {
  private resources = new Set<{ destroy: () => unknown }>()
  private timers = new Set<NodeJS.Timeout>()
  private deadline: NodeJS.Timeout
  closed = false
  constructor(private req: IncomingMessage, private downstream: ServerResponse | Duplex, timeoutMs: number, private release: () => void) {
    this.deadline = this.after(timeoutMs)
    req.once('aborted', this.close)
    downstream.once('close', this.close)
    downstream.once('finish', this.close)
  }
  own<T extends { destroy: () => unknown }>(resource: T): T {
    if (this.closed) resource.destroy()
    else this.resources.add(resource)
    return resource
  }
  after(ms: number): NodeJS.Timeout {
    const timer = setTimeout(this.close, Math.min(2_147_483_647, Math.max(0, ms)))
    timer.unref()
    this.timers.add(timer)
    return timer
  }
  connected(): void { clearTimeout(this.deadline); this.timers.delete(this.deadline) }
  close = (): void => {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.req.off('aborted', this.close)
    this.downstream.off('close', this.close)
    this.downstream.off('finish', this.close)
    for (const resource of this.resources) resource.destroy()
    this.resources.clear()
    this.downstream.destroy()
    this.release()
  }
}

export const REMOTE_PREVIEW_BODY_LIMIT = 1024 * 1024
export function bodyLimit(limit = REMOTE_PREVIEW_BODY_LIMIT): Transform {
  let bytes = 0
  return new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length
    done(bytes > limit ? new Error('Preview body too large') : null, bytes > limit ? undefined : chunk)
  } })
}
