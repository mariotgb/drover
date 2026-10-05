// Pixel-art lighting: a float light map multiplied into the base image, quantised to
// bands with a 4×4 Bayer dither so pools of light stay crisp instead of smooth gradients.
import { rgba } from '../canvas.mjs'

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)
const col = (c) => (Array.isArray(c) && c.length === 3 && c.every((v) => v <= 4) ? c : rgba(c).slice(0, 3).map((v) => v / 255))

export class LightMap {
  constructor(w, h, ambient) {
    this.w = w; this.h = h
    const [r, g, b] = col(ambient)
    this.m = new Float32Array(w * h * 3)
    for (let i = 0; i < w * h; i++) { this.m[i * 3] = r; this.m[i * 3 + 1] = g; this.m[i * 3 + 2] = b }
  }
  _add(x, y, c, k) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.m[i] += c[0] * k; this.m[i + 1] += c[1] * k; this.m[i + 2] += c[2] * k
  }
  /** Elliptic pool with a soft (1-d²)² falloff. */
  pool(cx, cy, rx, ry, color, k) {
    const c = col(color)
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
      if (d < 1) this._add(x, y, c, (1 - d) ** 2 * k)
    }
  }
  /** Convex polygon (window sun patches), flat with a 2 px soft edge. */
  poly(points, color, k) {
    const c = col(color)
    const ys = points.map((p) => p[1]), y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys))
    for (let y = y0; y <= y1; y++) {
      const xs = []
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length]
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
      }
      if (xs.length < 2) continue
      const [l, r] = [Math.min(...xs), Math.max(...xs)]
      for (let x = Math.ceil(l); x <= Math.floor(r); x++) {
        const edge = Math.min(x - l, r - x, y - y0, y1 - y)
        this._add(x, y, c, k * Math.min(1, (edge + 1) / 3))
      }
    }
  }
  rect(x, y, w, h, color, k) { const c = col(color); for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this._add(i, j, c, k) }
  /** Multiply into pix (RGBA), quantised to 1/steps bands with ordered dither. */
  apply(pix, steps = 10) {
    const d = pix.d
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = (y * this.w + x), p = i * 4
      if (!d[p + 3]) continue
      const t = BAYER[(y & 3) * 4 + (x & 3)]
      for (let k = 0; k < 3; k++) {
        const q = Math.floor(this.m[i * 3 + k] * steps + t) / steps
        d[p + k] = Math.min(255, d[p + k] * q)
      }
    }
  }
}

/** Additive glow straight into pix (after lighting): neon halos, screen bloom, packets. */
export function glow(pix, cx, cy, r, color, k) {
  const c = col(color)
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    if (!pix.in(x, y)) continue
    const dd = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r)
    if (dd >= 1) continue
    const f = (1 - dd) ** 2 * k
    const t = BAYER[(y & 3) * 4 + (x & 3)]
    const q = Math.floor(f * 6 + t) / 6
    if (q <= 0) continue
    const i = (y * pix.w + x) * 4
    pix.d[i] = Math.min(255, pix.d[i] + c[0] * 255 * q)
    pix.d[i + 1] = Math.min(255, pix.d[i + 1] + c[1] * 255 * q)
    pix.d[i + 2] = Math.min(255, pix.d[i + 2] + c[2] * 255 * q)
  }
}
