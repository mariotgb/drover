import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WorkerBatch, WorkerMessage, WorkerRequest } from './worker'

interface Subscription { batch: (batch: WorkerBatch) => void; error: (error: string, fatal?: boolean) => void; ready: () => void }
/** At most two workers: office and full chat, independent of pane count. */
export class TranscriptWorkers {
  private workers = new Map<boolean, Worker>()
  private subscriptions = new Map<string, Subscription>()
  private syncing = new Map<string, { id: string; resolve(): void; reject(error: Error): void }>()
  constructor(private path = join(__dirname, 'transcriptWorker.js')) {}
  open(path: string, kind: 'claude' | 'codex', office: boolean, batch: Subscription['batch'], error: Subscription['error']) {
    let worker = this.workers.get(office)
    if (!worker) {
      worker = new Worker(this.path)
      const owned = worker
      worker.on('message', (message: WorkerMessage) => {
        const sub = this.subscriptions.get(message.id)
        if (message.type === 'batch') {
          try { sub?.batch(message) }
          finally { owned.postMessage({ type: 'ack', id: message.id, sequence: message.sequence } satisfies WorkerRequest) }
        } else if (message.type === 'synced') { this.syncing.get(message.token)?.resolve(); this.syncing.delete(message.token) }
        else if (message.type === 'ready') sub?.ready()
        else { sub?.error(message.error); sub?.ready() }
      })
      const failed = (error: Error) => {
        if (this.workers.get(office) !== owned) return
        this.workers.delete(office)
        for (const [token, sync] of this.syncing) if (sync.id.startsWith(`${office}:`)) {
          sync.reject(error); this.syncing.delete(token)
        }
        for (const [id, sub] of this.subscriptions) if (id.startsWith(`${office}:`)) {
          this.subscriptions.delete(id); sub.error(error.message, true); sub.ready()
        }
      }
      worker.on('error', failed)
      worker.on('exit', code => failed(new Error(`Transcript worker exited (${code})`)))
      this.workers.set(office, worker)
    }
    const id = `${office}:${randomUUID()}`, owned = worker
    let ready!: () => void
    const loaded = new Promise<void>(resolve => { ready = resolve })
    this.subscriptions.set(id, { batch, error, ready })
    owned.postMessage({ type: 'open', id, path, kind, office } satisfies WorkerRequest)
    return { loaded, sync: () => new Promise<void>((resolve, reject) => {
      if (!this.subscriptions.has(id)) { resolve(); return }
      const token = randomUUID(); this.syncing.set(token, { id, resolve, reject })
      owned.postMessage({ type: 'sync', id, token } satisfies WorkerRequest)
    }), stop: () => {
      ready(); this.subscriptions.delete(id)
      for (const [token, sync] of this.syncing) if (sync.id === id) { sync.resolve(); this.syncing.delete(token) }
      if (this.workers.get(office) === owned) owned.postMessage({ type: 'close', id } satisfies WorkerRequest)
    } }
  }
  dispose() {
    for (const sub of this.subscriptions.values()) sub.ready()
    this.subscriptions.clear()
    for (const sync of this.syncing.values()) sync.resolve()
    this.syncing.clear()
    for (const worker of this.workers.values()) void worker.terminate()
    this.workers.clear()
  }
}
