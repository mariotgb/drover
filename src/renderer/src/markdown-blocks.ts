// Phone chat: Markdown is rendered per top-level block, so a streaming message
// re-parses only its last block and finished blocks come from a cache.

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST = /^\s*([-*+]|\d{1,9}[.)])\s/

/** Splits at blank lines outside code fences; a loose list (or its indented continuation) stays one block. */
export function splitMarkdown(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line)
    if (m) {
      if (!fence) fence = m[1]
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null
    }
    if (!fence && !m && !line.trim()) {
      if (current.length) { blocks.push(current.join('\n')); current = [] }
      continue
    }
    current.push(line)
  }
  if (current.length) blocks.push(current.join('\n'))
  const merged: string[] = []
  for (const block of blocks) {
    const prev = merged[merged.length - 1]
    const continues = prev !== undefined && LIST.test(prev) && (LIST.test(block) || /^( {2,}|\t)/.test(block))
    if (continues) merged[merged.length - 1] = `${prev}\n\n${block}`
    else merged.push(block)
  }
  return merged
}

/** Small LRU for prepared (parsed + highlighted) blocks. */
export class LruCache<V> {
  private map = new Map<string, V>()
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value !== undefined) { this.map.delete(key); this.map.set(key, value) }
    return value
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
  }
  get size() { return this.map.size }
}
