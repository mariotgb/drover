import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { RemoteFailure } from './security'

const compressBrotli = promisify(brotliCompress)
const compressGzip = promisify(gzip)
const MAX_FILE = 8 * 1024 * 1024
const MAX_CACHE = 32 * 1024 * 1024
interface Asset { key: string; bytes: Buffer; encodings: Map<string, Promise<Buffer>> }

function encoding(header: string | undefined): 'br' | 'gzip' | undefined {
  const qualities = new Map<string, number>()
  for (const part of (header ?? '').toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';')
    const q = parameters.find(p => p.trim().startsWith('q='))
    const quality = q ? Number(q.trim().slice(2)) : 1
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0)
  }
  const quality = (name: string) => qualities.get(name) ?? qualities.get('*') ?? 0
  if (quality('br') > 0 && quality('br') >= quality('gzip')) return 'br'
  if (quality('gzip') > 0) return 'gzip'
  return undefined
}

/** Static build assets only. Authorization is checked by RemoteServer first. */
export class RemoteStaticFiles {
  private cache = new Map<string, Asset>()
  private cacheBytes = 0
  clear(): void { this.cache.clear(); this.cacheBytes = 0 }

  async serve(rootPath: string, relative: string, mime: Record<string, string>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let root: string, actual: string
    try { root = await realpath(rootPath) }
    catch { throw new RemoteFailure('web_build_missing', 'Web entry not built; build the web renderer', 404) }
    const file = resolve(root, relative)
    if (!file.startsWith(root + sep)) throw new RemoteFailure('not_found', 'Not found', 404)
    try { actual = await realpath(file) }
    catch { throw new RemoteFailure('web_build_missing', 'Web entry not built; build the web renderer', 404) }
    const info = await stat(actual)
    const extension = extname(actual)
    if (!actual.startsWith(root + sep) || !info.isFile() || !mime[extension]) throw new RemoteFailure('not_found', 'Not found', 404)
    const hashed = /^(?:auth\/)?assets\//.test(relative) && /-[\w-]{8}\.[\w]+$/.test(basename(relative))
    res.setHeader('Content-Type', mime[extension])
    const textual = ['.js', '.css', '.html', '.json', '.webmanifest', '.svg'].includes(extension)
    if (textual && info.size >= 1024 && info.size <= MAX_FILE) res.setHeader('Vary', 'Accept-Encoding')
    // Only build-hashed assets are immutable; HTML, SW, sessions and user data stay no-store.
    if (hashed) {
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
      res.setHeader('ETag', etag)
      if (req.headers['if-none-match']?.split(',').some(v => v.trim() === etag || v.trim() === '*')) {
        res.writeHead(304); res.end(); return
      }
    }
    const compressed = textual && info.size >= 1024 && info.size <= MAX_FILE ? encoding(req.headers['accept-encoding']) : undefined
    if (!compressed) {
      res.setHeader('Content-Length', info.size)
      res.writeHead(200)
      if (req.method === 'HEAD') { res.end(); return }
      pipeline(createReadStream(actual), res, () => {})
      return
    }
    const key = `${info.size}:${info.mtimeMs}`
    let asset = this.cache.get(actual)
    if (!asset || asset.key !== key) {
      const bytes = await readFile(actual)
      // Bound retained raw + compressed buffers, even for many distinct asset requests.
      const previous = this.cache.get(actual)
      if (previous) { this.cacheBytes -= previous.bytes.length; this.cache.delete(actual) }
      while (this.cache.size >= 64 || (this.cacheBytes + bytes.length) * 3 > MAX_CACHE) {
        const oldest = this.cache.keys().next().value
        if (!oldest) break
        this.cacheBytes -= this.cache.get(oldest)!.bytes.length
        this.cache.delete(oldest)
      }
      asset = { key, bytes, encodings: new Map() }
      this.cache.set(actual, asset)
      this.cacheBytes += bytes.length
    }
    let result = asset.encodings.get(compressed)
    if (!result) {
      result = compressed === 'br' ? compressBrotli(asset.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : compressGzip(asset.bytes)
      asset.encodings.set(compressed, result)
    }
    const bytes = await result
    res.setHeader('Content-Encoding', compressed)
    res.setHeader('Content-Length', bytes.length)
    res.writeHead(200)
    res.end(req.method === 'HEAD' ? undefined : bytes)
  }
}
