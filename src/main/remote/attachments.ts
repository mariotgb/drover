import { constants } from 'node:fs'
import { chmod, mkdir, open, rm, writeFile, lstat, readdir, rename } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage } from 'node:http'
import { ATTACHMENTS_DIR, convertToJpeg } from '../attachments'
import { REMOTE_ATTACHMENT_MAX_BYTES, REMOTE_ATTACHMENT_ROUTES, type RemoteAttachment } from '@shared/remote'
import { RemoteFailure } from './security'

const images: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif'
}
const textExtensions = new Set('txt md log csv json yaml yml xml ts tsx js jsx css py sh toml ini'.split(' '))
const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/xml', 'text/javascript', 'text/css', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript'])
const unsupported = () => new RemoteFailure('unsupported_attachment', 'Choose an image or a UTF-8 text file.', 415)

export function attachmentType(name: string, contentType: string): { ext: string; isImage: boolean; mime: string } {
  const ext = extname(name).slice(1).toLowerCase()
  const mime = contentType.split(';')[0].trim().toLowerCase()
  const infer = !mime || mime === 'application/octet-stream'
  if (images[ext] && (infer || mime === images[ext] || (ext === 'jpg' && mime === 'image/jpg'))) return { ext, isImage: true, mime: images[ext] }
  if (textExtensions.has(ext) && (infer || textTypes.has(mime) || (mime.startsWith('text/') && mime !== 'text/html'))) return { ext, isImage: false, mime: 'text/plain; charset=utf-8' }
  throw unsupported()
}

/** Paths, shell metacharacters and Unicode never become part of the stored filename. */
export function safeAttachmentName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? ''
  return leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'attachment'
}

export function validateAttachment(bytes: Buffer, name: string, mime: string) {
  if (bytes.length > REMOTE_ATTACHMENT_MAX_BYTES) throw new RemoteFailure('attachment_too_large', 'Files must be 20 MB or smaller.', 413)
  if (!bytes.length) throw new RemoteFailure('empty_attachment', 'The file is empty.')
  const type = attachmentType(name, mime)
  if (!type.isImage) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw unsupported() }
    if (bytes.includes(0)) throw unsupported()
    return type
  }
  const ascii = (start: number, end: number) => bytes.toString('ascii', start, end)
  const valid = type.ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : ['jpg', 'jpeg'].includes(type.ext) ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type.ext === 'gif' ? ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    : type.ext === 'webp' ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    : type.ext === 'bmp' ? ascii(0, 2) === 'BM'
    : ['tif', 'tiff'].includes(type.ext) ? ['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))
    : ascii(4, 8) === 'ftyp' && (type.ext === 'avif' ? ['avif', 'avis'] : ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']).includes(ascii(8, 12))
  if (!valid) throw unsupported()
  return type
}

export async function readAttachmentBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length']) > REMOTE_ATTACHMENT_MAX_BYTES) throw new RemoteFailure('attachment_too_large', 'Files must be 20 MB or smaller.', 413)
  const chunks: Buffer[] = []
  let size = 0
  // Keep the connection alive long enough to return an explicit 413 on chunked uploads.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > REMOTE_ATTACHMENT_MAX_BYTES) {
      req.resume()
      throw new RemoteFailure('attachment_too_large', 'Files must be 20 MB or smaller.', 413)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export const ATTACHMENT_QUOTA_BYTES = 512 * 1024 * 1024
export const ATTACHMENT_MAX_PIXELS = 50_000_000
export const ATTACHMENT_MAX_SIDE = 16384
const run = promisify(execFile)
async function imageDimensions(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { timeout: 10_000 })
  return { width: Number(stdout.match(/pixelWidth: (\d+)/)?.[1]), height: Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) }
}
export function validateImageDimensions({ width, height }: { width: number; height: number }): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw unsupported()
  if (width > ATTACHMENT_MAX_SIDE || height > ATTACHMENT_MAX_SIDE || width * height > ATTACHMENT_MAX_PIXELS) {
    throw new RemoteFailure('attachment_dimensions', 'The image is too large. Choose a smaller image.', 413)
  }
}
interface StorageOptions {
  quotaBytes?: number
  now?: () => number
  cleanupIntervalMs?: number
  inspectImage?: typeof imageDimensions
  convertImage?: typeof convertToJpeg
}
/** One shared pool per directory: reservations include both source and maximum
 * conversion output, and are acquired before any upload writes to disk. */
export class AttachmentStorage {
  private queue = Promise.resolve()
  private reserved = new Map<string, number>()
  private active = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  constructor(readonly dir = ATTACHMENTS_DIR, private options: StorageOptions = {}) {}
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const st = await lstat(this.dir)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Invalid attachment directory')
    await chmod(this.dir, 0o700)
  }
  private async size(path: string): Promise<number> {
    const st = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!st) return 0
    if (!st.isDirectory()) return st.size // Never follow symlinks.
    let total = 0
    for (const name of await readdir(path)) total += await this.size(join(path, name))
    return total
  }
  private async cleanupLocked(): Promise<void> {
    await this.prepare()
    const now = (this.options.now ?? Date.now)()
    for (const name of await readdir(this.dir)) {
      if (this.active.has(name)) continue
      const path = join(this.dir, name), st = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!st) continue
      if ((st.isFile() && st.mtimeMs < now - 30 * 864e5) ||
          (st.isDirectory() && /^\.upload-[0-9a-f-]{36}$/.test(name) && st.mtimeMs < now - 864e5)) {
        await rm(path, { force: true, recursive: st.isDirectory() })
      }
    }
  }
  cleanup(): Promise<void> { return this.lock(() => this.cleanupLocked()) }
  startCleanup(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.cleanup().catch(error => console.error('Attachment cleanup failed:', error)) }, this.options.cleanupIntervalMs ?? 3600_000)
    this.timer.unref()
  }
  stopCleanup(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
  async save(bytes: Buffer, name: string, mime: string): Promise<RemoteAttachment> {
    const type = validateAttachment(bytes, name, mime)
    const convert = ['heic', 'heif', 'tif', 'tiff'].includes(type.ext)
    const uuid = randomUUID(), workName = `.upload-${uuid}`, work = join(this.dir, workName)
    const id = `remote-${uuid}.${convert ? 'jpg' : type.ext}`, path = join(this.dir, id)
    const reservation = bytes.length + (convert ? REMOTE_ATTACHMENT_MAX_BYTES : 0)
    await this.lock(async () => {
      await this.cleanupLocked()
      let used = [...this.reserved.values()].reduce((a, b) => a + b, 0)
      for (const entry of await readdir(this.dir)) if (!this.active.has(entry)) used += await this.size(join(this.dir, entry))
      if (used + reservation > (this.options.quotaBytes ?? ATTACHMENT_QUOTA_BYTES)) {
        throw new RemoteFailure('attachment_quota', 'Attachment storage is full. Remove old files on your Mac and try again.', 507)
      }
      this.reserved.set(workName, reservation)
      this.active.add(workName)
    })
    try {
      await mkdir(work, { mode: 0o700 })
      const raw = join(work, `source.${type.ext}`), output = convert ? join(work, 'output.jpg') : raw
      await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 })
      if (convert) {
        try { validateImageDimensions(await (this.options.inspectImage ?? imageDimensions)(raw)) }
        catch (error) { if (error instanceof RemoteFailure) throw error; throw unsupported() }
        // Even if sips replaces this file with 0644, both enclosing directories
        // stay 0700 throughout conversion; publishing happens only after chmod.
        await writeFile(output, '', { flag: 'wx', mode: 0o600 })
        try { await (this.options.convertImage ?? convertToJpeg)(raw, output) }
        catch { throw unsupported() }
        const st = await lstat(output)
        if (st.size > REMOTE_ATTACHMENT_MAX_BYTES) throw new RemoteFailure('attachment_too_large', 'Files must be 20 MB or smaller.', 413)
        if (!st.isFile() || !st.size) throw unsupported()
        await chmod(output, 0o600)
        await rm(raw)
      }
      await this.lock(async () => { await rename(output, path); this.reserved.delete(workName) })
      return { id, name: safeAttachmentName(name), path, isImage: type.isImage, previewUrl: REMOTE_ATTACHMENT_ROUTES.previewPrefix + id }
    } finally {
      try { await rm(work, { recursive: true, force: true }) }
      finally { await this.lock(async () => { this.reserved.delete(workName); this.active.delete(workName) }) }
    }
  }
}
const pools = new Map<string, AttachmentStorage>()
export function attachmentStorage(dir = ATTACHMENTS_DIR): AttachmentStorage {
  const key = resolve(dir)
  let storage = pools.get(key)
  if (!storage) { storage = new AttachmentStorage(key); pools.set(key, storage) }
  return storage
}
export async function saveAttachment(bytes: Buffer, name: string, mime: string, dir = ATTACHMENTS_DIR): Promise<RemoteAttachment> {
  return attachmentStorage(dir).save(bytes, name, mime)
}

export async function readAttachment(id: string, dir = ATTACHMENTS_DIR) {
  if (!/^remote-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.[a-z]+$/.test(id)) throw new RemoteFailure('not_found', 'Not found', 404)
  const ext = extname(id).slice(1)
  if (!images[ext] && !textExtensions.has(ext)) throw new RemoteFailure('not_found', 'Not found', 404)
  let file
  try {
    file = await open(join(dir, id), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > REMOTE_ATTACHMENT_MAX_BYTES) throw new Error('Invalid attachment')
    return { bytes: await file.readFile(), mime: images[ext] ?? 'text/plain; charset=utf-8' }
  } catch { throw new RemoteFailure('not_found', 'Not found', 404) }
  finally { await file?.close() }
}
