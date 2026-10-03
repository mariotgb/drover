// What the preview can load: http(s) addresses and local files, from what the
// user types in the address bar or an agent hands over.

const PAGE_EXT = /\.(html?|xhtml|svg)$/i

/** file:// URL for an absolute path (each segment escaped, slashes kept). */
export function fileUrl(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/')
}

function joinPath(base: string, rel: string): string {
  const out: string[] = []
  for (const part of `${base}/${rel}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function safeUrl(s: string, protocols: string[]): string | null {
  try {
    const u = new URL(s)
    return protocols.includes(u.protocol) ? u.toString() : null
  } catch {
    return null
  }
}

/**
 * Accepts localhost:5173, a bare port, http(s) URLs, file:// URLs, absolute
 * paths, ~/paths and paths of HTML files relative to the project folder.
 */
export function previewTarget(raw: string, opts: { cwd?: string | null; home?: string } = {}): string | null {
  let s = raw.trim()
  if (s.length > 1 && /^(["']).*\1$/.test(s)) s = s.slice(1, -1).trim()
  if (!s) return null
  if (/^file:\/\//i.test(s)) return safeUrl(s, ['file:'])
  if (s === '~' || s.startsWith('~/')) {
    if (!opts.home) return null
    s = opts.home + s.slice(1)
  }
  if (s.startsWith('/')) return fileUrl(s)
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
  if (!hasScheme && opts.cwd) {
    const first = s.split('/')[0]
    const relative = s.startsWith('./') || s.startsWith('../') || (PAGE_EXT.test(s) && (!s.includes('/') || !first.includes('.')))
    if (relative) return fileUrl(joinPath(opts.cwd, s))
  }
  if (/^\d{2,5}$/.test(s)) s = `localhost:${s}`
  if (!hasScheme) s = `http://${s}`
  return safeUrl(s, ['http:', 'https:'])
}

/** Local dev servers and files open on their own; anything on the internet waits for a click. */
export function isLocalTarget(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return true
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** The address bar shows local files as plain paths. */
export function displayTarget(url: string): string {
  if (/^file:\/\//i.test(url)) {
    try {
      return decodeURIComponent(new URL(url).pathname)
    } catch {
      /* fall through */
    }
  }
  return url
}
