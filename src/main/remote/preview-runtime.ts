export const PREVIEW_ROUTE = String.raw`function(prefix, port, value, base) {
  const raw = String(value)
  try {
    const url = new URL(raw, base ? new URL(base, location.href) : location.href)
    const local = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) || url.hostname.endsWith('.localhost')
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
        !(url.host === location.host || (local && Number(url.port || 80) === port))) return raw
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname
    const websocket = url.protocol === 'ws:' || url.protocol === 'wss:'
    url.protocol = websocket ? location.protocol === 'https:' ? 'wss:' : 'ws:' : location.protocol
    url.host = location.host
    return url.href
  } catch { return raw }
}`

/** Early script for the opaque preview iframe; exercised in browser/VM tests.
 * A literal avoids server-side DOM types and bundler-generated function helpers. */
export const PREVIEW_RUNTIME = String.raw`function(prefix, port) {
  const route = (value) => (${PREVIEW_ROUTE})(prefix, port, value)
  const originalFetch = window.fetch
  window.fetch = (input, init) => originalFetch(input instanceof Request ? new Request(route(input.url), input) : route(input), init)
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    return Reflect.apply(open, this, [method, route(url), ...args])
  }
  for (const name of ['WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
    const original = window[name]
    if (!original) continue
    Object.defineProperty(window, name, { configurable: true, writable: true, value: new Proxy(original, {
      construct(target, args) { args[0] = route(args[0]); return Reflect.construct(target, args) }
    }) })
  }
  const css = (text) => String(text).replace(/(url\(\s*)(["']?)([^\s"')]+)\2(\s*\))/gi,
    (_match, before, quote, path, end) => before + quote + route(path) + quote + end)
  if (typeof Node !== 'undefined') {
    const content = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')
    if (content?.set) Object.defineProperty(Node.prototype, 'textContent', { ...content, set(value) {
      content.set.call(this, this instanceof HTMLStyleElement ? css(value) : value)
    } })
  }
  if (typeof CSSStyleSheet !== 'undefined') {
    for (const name of ['insertRule', 'replace', 'replaceSync']) {
      const original = CSSStyleSheet.prototype[name]
      if (original) CSSStyleSheet.prototype[name] = function(text, ...args) { return original.call(this, css(text), ...args) }
    }
  }
  const attrs = new Set(['src', 'href', 'action', 'poster', 'data'])
  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function(name, value) {
    return setAttribute.call(this, name, attrs.has(name.toLowerCase()) ? route(value) : value)
  }
  for (const [ctor, names] of [
    [HTMLScriptElement, ['src']], [HTMLImageElement, ['src']], [HTMLLinkElement, ['href']],
    [HTMLAnchorElement, ['href']], [HTMLFormElement, ['action']], [HTMLMediaElement, ['src']],
    [HTMLSourceElement, ['src']], [HTMLIFrameElement, ['src']], [HTMLVideoElement, ['poster']]
  ]) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name)
      if (descriptor?.set) Object.defineProperty(ctor.prototype, name, { ...descriptor, set(value) { descriptor.set.call(this, route(value)) } })
    }
  }
}`
