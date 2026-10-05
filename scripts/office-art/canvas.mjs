// A tiny pixel canvas: exact integer pixels only, no anti-aliasing anywhere.

const cache = new Map()
/** '#rrggbb' or '#rrggbbaa' → [r,g,b,a]; arrays pass through. */
export function rgba(c) {
  if (Array.isArray(c)) return c
  let v = cache.get(c)
  if (!v) {
    const n = c.replace('#', '')
    v = [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), n.length > 6 ? parseInt(n.slice(6, 8), 16) : 255]
    cache.set(c, v)
  }
  return v
}
export function hex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
}
export function mix(a, b, t) {
  const x = rgba(a), y = rgba(b)
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
/** Deterministic PRNG (mulberry32) for reproducible texture noise. */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Pix {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.d = new Uint8ClampedArray(w * h * 4)
  }
  in(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h }
  get(x, y) {
    if (!this.in(x, y)) return [0, 0, 0, 0]
    const i = (y * this.w + x) * 4
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]]
  }
  alpha(x, y) { return this.in(x, y) ? this.d[(y * this.w + x) * 4 + 3] : 0 }
  /** Opaque write; colors with alpha < 255 are blended over what is there. */
  set(x, y, c) {
    x = Math.round(x); y = Math.round(y)
    if (!this.in(x, y) || c == null) return
    const [r, g, b, a] = rgba(c), i = (y * this.w + x) * 4
    if (a >= 255 || this.d[i + 3] === 0) { this.d[i] = r; this.d[i + 1] = g; this.d[i + 2] = b; this.d[i + 3] = a; return }
    const t = a / 255
    this.d[i] = this.d[i] + (r - this.d[i]) * t
    this.d[i + 1] = this.d[i + 1] + (g - this.d[i + 1]) * t
    this.d[i + 2] = this.d[i + 2] + (b - this.d[i + 2]) * t
    this.d[i + 3] = Math.max(this.d[i + 3], a)
  }
  clear(x, y) { if (this.in(x, y)) this.d.fill(0, (y * this.w + x) * 4, (y * this.w + x) * 4 + 4) }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c) }
  hline(x0, x1, y, c) { for (let x = x0; x <= x1; x++) this.set(x, y, c) }
  vline(x, y0, y1, c) { for (let y = y0; y <= y1; y++) this.set(x, y, c) }
  /** Rounded rectangle (corner radius in pixels, cut as a staircase). */
  round(x, y, w, h, r, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const dx = i < r ? r - i : i >= w - r ? i - (w - r - 1) : 0, dy = j < r ? r - j : j >= h - r ? j - (h - r - 1) : 0
      if (dx && dy && dx + dy > r + (r > 2 ? 1 : 0)) continue
      this.set(x + i, y + j, c)
    }
  }
  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / (rx + 0.5), ny = (y - cy) / (ry + 0.5)
      if (nx * nx + ny * ny <= 1) this.set(x, y, c)
    }
  }
  line(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      this.set(x0, y0, c)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  /** Rows of a pixel map: each character looks up a color in `keys`; '.' or ' ' is transparent. */
  stamp(x, y, rows, keys, flip = false) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      const c = keys[ch]
      if (c) this.set(flip ? x + row.length - 1 - i : x + i, y + j, c)
    }))
  }
  blit(src, sx, sy, sw, sh, dx, dy, flip = false) {
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
      const p = src.get(sx + i, sy + j)
      if (p[3]) this.set(dx + (flip ? sw - 1 - i : i), dy + j, p)
    }
  }
  /** Selective outline: every empty pixel touching artwork gets a darkened copy of its neighbour. */
  outline(dark = '#2b1d1b', strength = 0.62, skip = () => false) {
    const add = []
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.alpha(x, y) > 0) continue
      for (const [ox, oy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const p = this.get(x + ox, y + oy)
        if (p[3] === 255 && !skip(x + ox, y + oy, p)) { add.push([x, y, mix(hex(p), dark, strength)]); break }
      }
    }
    for (const [x, y, c] of add) this.set(x, y, c)
  }
  /** Mix every opaque pixel toward grey (unknown/offline look). */
  desaturate(t) {
    for (let i = 0; i < this.d.length; i += 4) {
      if (!this.d[i + 3]) continue
      const l = this.d[i] * 0.3 + this.d[i + 1] * 0.59 + this.d[i + 2] * 0.11
      for (let k = 0; k < 3; k++) this.d[i + k] = this.d[i + k] + (l - this.d[i + k]) * t
    }
  }
  scaled(k) {
    const out = new Pix(this.w * k, this.h * k)
    for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
      const s = ((Math.floor(y / k) * this.w) + Math.floor(x / k)) * 4, o = (y * out.w + x) * 4
      out.d[o] = this.d[s]; out.d[o + 1] = this.d[s + 1]; out.d[o + 2] = this.d[s + 2]; out.d[o + 3] = this.d[s + 3]
    }
    return out
  }
}
