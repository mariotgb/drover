// Unlit overlays: nameplates, status bubbles, interaction carriers (paper planes /
// light packets), links, confetti. Drawn after lighting so they stay readable.
import { Pix, mix } from '../canvas.mjs'
import { print, measure, fit } from './pixfont.mjs'
import { glow } from './light.mjs'

const OUT = '#2b1d1b'
const neon = (P) => P.id === 'neon'

/** Status mark 5×5 drawn into c at (x,y). phase animates working/blocked. */
export function statusMark(P, c, x, y, status, phase = 0) {
  const col = P.status[status] ?? P.status.unknown
  if (status === 'working') {
    const ring = [[1, 0], [2, 0], [3, 0], [4, 1], [4, 2], [4, 3], [3, 4], [2, 4], [1, 4], [0, 3], [0, 2], [0, 1]]
    ring.forEach(([i, j], n) => c.set(x + i, y + j, (n + phase * 3) % 12 < 5 ? col : mix(col, neon(P) ? '#121826' : '#fbf0d6', 0.65)))
  } else if (status === 'blocked') {
    c.rect(x, y, 5, 5, col); c.vline(x + 2, y + 1, y + 2, '#ffffff'); c.set(x + 2, y + 4 - 0, '#ffffff')
  } else if (status === 'done') {
    c.rect(x, y, 5, 5, col); c.set(x + 1, y + 2, '#ffffff'); c.set(x + 2, y + 3, '#ffffff'); c.set(x + 3, y + 2, '#ffffff'); c.set(x + 3, y + 1, '#ffffff')
  } else if (status === 'idle') {
    for (const [i, j] of [[1, 0], [2, 0], [3, 0], [4, 1], [4, 2], [4, 3], [3, 4], [2, 4], [1, 4], [0, 3], [0, 2], [0, 1]]) c.set(x + i, y + j, col)
  } else c.hline(x, x + 4, y + 2, col)
}

/** Nameplate: status mark + name. pointer: 'down' (above a head) or 'up' (under feet). */
export function plaque(P, c, cx, y, name, status, { pointer = 'down', phase = 0, max = 46, lead = false } = {}) {
  const label = fit(name, max - 8)
  const w = measure(label) + 11, h = 9, x = Math.round(cx - w / 2)
  const S = P.plaque
  const edge = status === 'blocked' ? P.status.blocked : lead && !neon(P) ? '#c9a24a' : S.edge
  if (neon(P)) {
    c.rect(x, y, w, h, '#0b0f18e6'); c.hline(x, x + w - 1, y, edge); c.hline(x + 1, x + w - 2, y + h - 1, mix(edge, '#000000', 0.5))
    c.set(x, y + 1, edge); c.set(x + w - 1, y + 1, edge)
  } else {
    c.rect(x + 1, y, w - 2, h, edge); c.rect(x, y + 1, w, h - 2, edge)
    c.rect(x + 1, y + 1, w - 2, h - 2, S.fill); c.hline(x + 1, x + w - 2, y + h - 2, S.shade)
  }
  if (pointer === 'down') { c.set(cx, y + h, edge); c.set(cx - 1, y + h, edge); c.set(cx + 1, y + h, edge); c.set(cx, y + h + 1, edge) }
  else { c.set(cx, y - 1, edge); c.set(cx - 1, y - 1, edge); c.set(cx + 1, y - 1, edge); c.set(cx, y - 2, edge) }
  statusMark(P, c, x + 2, y + 2, status, phase)
  print(c, x + 9, y + 2, label, neon(P) ? (status === 'unknown' ? '#7f8aa0' : S.text) : (status === 'unknown' ? '#9a8a74' : S.text))
  if (lead) { const sx = x + w - 1; c.set(sx, y - 1, '#f2c230'); c.set(sx - 1, y - 2, '#f2c230'); c.set(sx + 1, y - 2, '#f2c230'); c.set(sx, y - 2, '#fff3a8') }
  return { x, y, w, h }
}

/** Speech bubble above a head: '?', '!', 'ok', 'zz'. */
export function bubble(P, c, cx, bottom, kind, frame = 0) {
  const w = 13, h = 11, x = Math.round(cx - w / 2), y = bottom - h - 3 - (frame % 2)
  const fill = kind === 'ok' ? P.status.done : neon(P) ? '#0b0f18' : '#fffaf0'
  const line = kind === '?' ? P.status.blocked : kind === '!' ? '#e2574c' : kind === 'ok' ? mix(P.status.done, '#000000', 0.35) : neon(P) ? '#5ef2ff' : OUT
  c.round(x, y, w, h, 3, line); c.round(x + 1, y + 1, w - 2, h - 2, 2, fill)
  c.set(cx - 1, y + h, line); c.set(cx, y + h, fill); c.set(cx, y + h + 1, line); c.set(cx - 1, y + h - 1, fill)
  const ink = kind === 'ok' ? '#ffffff' : kind === '?' ? (neon(P) ? P.status.blocked : '#c0392b') : kind === '!' ? '#e2574c' : '#7a8aa0'
  if (kind === '?') c.stamp(x + 4, y + 2, ['.##.', '#..#', '..#.', '.#..', '....', '.#..'].map((r) => r.slice(0, 4)), { '#': ink })
  if (kind === '!') c.stamp(x + 5, y + 2, ['##', '##', '##', '..', '##'].map((r) => r), { '#': ink })
  if (kind === 'ok') c.stamp(x + 3, y + 3, ['......#', '.....#.', '#...#..', '.#.#...', '..#....'], { '#': ink })
  if (neon(P)) glow(c, cx, y + h / 2, 10, kind === 'ok' ? [0.25, 0.8, 0.5] : kind === '?' ? [1, 0.7, 0.2] : [1, 0.3, 0.3], 0.35)
}

// ---------------------------------------------------------------- carriers

const bez = (a, b, cpt, t) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cpt.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cpt.y + t * t * b.y })
export function arc(a, b, lift = 40) {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  const cpt = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift * 0.6 - d * 0.1 }
  return { at: (t) => bez(a, b, cpt, t), len: d * 1.15 }
}

/** Paper plane at `p` heading `ang` (radians); size 1 = 13×10 px with an outline. */
export function paperPlane(P, c, p, ang, paper = '#fffaf0', fold = '#c9b48a', size = 1) {
  const R = (dx, dy) => [p.x + (dx * Math.cos(ang) - dy * Math.sin(ang)) * size, p.y + (dx * Math.sin(ang) + dy * Math.cos(ang)) * size]
  const tri = (pts, col) => {
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      const s = (a, b) => (b[0] - a[0]) * (y + 0.5 - a[1]) - (b[1] - a[1]) * (x + 0.5 - a[0])
      const d1 = s(pts[0], pts[1]), d2 = s(pts[1], pts[2]), d3 = s(pts[2], pts[0])
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) c.set(x, y, col)
    }
  }
  const [shx, shy] = R(0, 0); c.ellipse(shx + 2, shy + 9, 4, 1, '#1a122030')
  const nose = R(8, 0), l = R(-6, -6), r = R(-6, 6), mid = R(-3, 0)
  const o = (q, k = 1.25) => [mid[0] + (q[0] - mid[0]) * k, mid[1] + (q[1] - mid[1]) * k]
  tri([o(nose), o(l), o(mid)], OUT); tri([o(nose), o(mid), o(r)], OUT)
  tri([nose, l, mid], paper); tri([nose, mid, r], mix(paper, fold, 0.5))
  c.line(Math.round(nose[0]), Math.round(nose[1]), Math.round(mid[0]), Math.round(mid[1]), fold)
}

/** Ring burst when a carrier arrives (k 0..1). */
export function arrival(P, c, p, k) {
  const r = 4 + k * 14, col = neon(P) ? '#5ef2ff' : '#fff3c0'
  for (let a = 0; a < 40; a++) {
    const ang = (a / 40) * Math.PI * 2
    if (!neon(P) && a % 2) continue
    c.set(Math.round(p.x + Math.cos(ang) * r), Math.round(p.y + Math.sin(ang) * r * 0.6), col)
  }
  if (neon(P)) glow(c, p.x, p.y, r + 4, [0.37, 0.95, 1], 0.6 * (1 - k))
  else for (const [dx, dy] of [[-r, -4], [r, -4], [0, -r * 0.6 - 4]]) { c.set(Math.round(p.x + dx), Math.round(p.y + dy), '#ffffff'); c.set(Math.round(p.x + dx) + 1, Math.round(p.y + dy), '#fff3c0') }
}

/** Note resting on a desk after delivery. */
export function deskNote(P, c, p, user = false) {
  if (neon(P)) { c.rect(p.x - 4, p.y - 3, 9, 6, user ? '#ff9a6b' : '#5ef2ff'); c.rect(p.x - 3, p.y - 2, 7, 4, '#0f1b2e'); c.hline(p.x - 2, p.x + 2, p.y - 1, '#dffbff'); glow(c, p.x, p.y, 7, [0.37, 0.95, 1], 0.4); return }
  c.rect(p.x - 4, p.y - 3, 10, 7, OUT); c.rect(p.x - 3, p.y - 2, 8, 5, user ? '#cfe6ff' : '#fffaf0'); c.hline(p.x - 2, p.x + 3, p.y - 1, '#9aa5ad'); c.hline(p.x - 2, p.x + 1, p.y + 1, '#9aa5ad'); c.set(p.x + 4, p.y - 2, '#d94a4a')
}

/** A delivered prompt in flight. t: 0..1 flight. Returns head point. */
export function promptFlight(P, c, a, b, t, { color, user = false } = {}) {
  const path = arc(a, b)
  const head = path.at(Math.min(1, t))
  const ahead = path.at(Math.min(1, t + 0.02)), back = path.at(Math.max(0, t - 0.02))
  const ang = Math.atan2(ahead.y - back.y, ahead.x - back.x)
  if (neon(P)) {
    const col = color ?? (user ? P.user : P.link)
    for (let s = 0; s <= t; s += 0.5 / path.len) { const q = path.at(s); c.set(Math.round(q.x), Math.round(q.y), mix(col, '#000000', 0.45)) }
    for (let s = Math.max(0, t - 0.3); s <= t; s += 0.5 / path.len) {
      const q = path.at(s), f = 1 - (t - s) / 0.3
      c.set(Math.round(q.x), Math.round(q.y), mix(col, '#ffffff', f * 0.6)); if (f > 0.5) c.set(Math.round(q.x), Math.round(q.y) + 1, col)
    }
    glow(c, head.x, head.y, 14, user ? [1, 0.6, 0.4] : [0.37, 0.95, 1], 1)
    const hx = Math.round(head.x), hy = Math.round(head.y)
    c.round(hx - 4, hy - 3, 9, 7, 2, '#ffffff'); c.rect(hx - 3, hy - 2, 7, 5, col)
    c.line(hx - 3, hy - 2, hx, hy, '#ffffff'); c.line(hx + 3, hy - 2, hx, hy, '#ffffff')
    return head
  }
  for (let k = 1; k <= 9; k++) {
    const s = t - k * 0.03
    if (s <= 0) break
    const q = path.at(s)
    if (k % 2) { c.set(Math.round(q.x), Math.round(q.y), k < 5 ? '#ffffff' : '#fffaf0b0'); c.set(Math.round(q.x), Math.round(q.y) + 1, '#2b1d1b30') }
  }
  // speed lines
  for (const off of [-4, 0, 4]) {
    const bx = head.x - Math.cos(ang) * 11 - Math.sin(ang) * off, by = head.y - Math.sin(ang) * 11 + Math.cos(ang) * off
    c.line(Math.round(bx), Math.round(by), Math.round(bx - Math.cos(ang) * (off ? 4 : 7)), Math.round(by - Math.sin(ang) * (off ? 4 : 7)), '#ffffffc0')
  }
  paperPlane(P, c, head, ang, user ? '#cfe6ff' : '#fffaf0', user ? '#5a8fd0' : '#c9b48a')
  return head
}

/** Unconfirmed attempt: flies, stalls at ~55% and drops; ends as a crumpled ball / dead sparks. */
export function attemptFlight(P, c, a, b, t) {
  const path = arc(a, b)
  const stall = 0.7
  if (neon(P)) {
    for (let s = 0; s <= Math.min(t, stall); s += 0.5 / path.len) { const q = path.at(s); if (Math.floor(s * path.len / 3) % 2 === 0) c.set(Math.round(q.x), Math.round(q.y), P.attempt) }
    const q = path.at(Math.min(t, stall))
    if (t >= stall) {
      const f = Math.min(1, (t - stall) / (1 - stall))
      for (let i = 0; i < 8; i++) { const a2 = i * 0.8; c.set(Math.round(q.x + Math.cos(a2) * (3 + f * 8)), Math.round(q.y + Math.sin(a2) * (3 + f * 8) + f * 6), f > 0.7 ? '#8a6a7a' : '#ffb3b3') }
      c.stamp(Math.round(q.x) - 3, Math.round(q.y) - 3, ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'], { '#': '#ff6b6b' })
      glow(c, q.x, q.y, 9, [1, 0.3, 0.3], 0.7 * (1 - f * 0.6))
    } else { glow(c, q.x, q.y, 10, [0.6, 0.6, 0.7], 0.8); c.round(Math.round(q.x) - 3, Math.round(q.y) - 2, 7, 5, 1, '#c8d0e0') }
    return
  }
  for (let s = 0.04; s <= Math.min(t, stall); s += 0.04) { const q = path.at(s); c.set(Math.round(q.x), Math.round(q.y), P.attempt); c.set(Math.round(q.x) + 1, Math.round(q.y), P.attempt) }
  if (t < stall) { const q = path.at(t), n = path.at(t + 0.02); paperPlane(P, c, q, Math.atan2(n.y - q.y, n.x - q.x), '#efe6d2', '#a99a7c'); return }
  const q = path.at(stall), fall = Math.min(1, (t - stall) / (1 - stall))
  const p = { x: Math.round(q.x + fall * 12), y: Math.round(q.y + fall * fall * 52) }
  if (fall < 1) {
    paperPlane(P, c, p, 1.2 + fall * 1.8, '#efe6d2', '#a99a7c')
    for (let k = 1; k < 5; k++) c.set(p.x - k * 3, p.y - k * 5, '#efe6d2c0')
    if (fall < 0.4) { c.ellipse(q.x, q.y, 4, 3, '#ffffffa0'); c.ellipse(q.x + 4, q.y - 2, 3, 2, '#ffffffa0') }
  } else {
    c.ellipse(p.x, p.y + 2, 5, 1, '#2b1d1b40')
    c.ellipse(p.x, p.y, 4, 3, OUT); c.ellipse(p.x, p.y, 3, 2, '#efe6d2'); c.set(p.x - 1, p.y, '#a99a7c'); c.set(p.x + 1, p.y - 1, '#a99a7c'); c.set(p.x + 2, p.y + 1, '#a99a7c')
    c.round(p.x + 4, p.y - 12, 9, 9, 2, '#8a8a84'); c.round(p.x + 5, p.y - 11, 7, 7, 2, '#efe6d2'); c.stamp(p.x + 7, p.y - 10, ['##.', '..#', '.#.', '...', '.#.'], { '#': '#8a8a84' })
  }
}

export function confetti(P, c, cx, cy, t, seed = 1) {
  const cols = neon(P) ? ['#5ef2ff', '#ff7ad9', '#ffd36b', '#7cf28c'] : ['#e2574c', '#f2c230', '#3b82f6', '#1f9d55', '#ff9ac0']
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + seed, sp = 12 + ((i * 7) % 11)
    const x = cx + Math.cos(a) * sp * t * 1.4, y = cy + Math.sin(a) * sp * t - 8 * t + 30 * t * t
    const col = cols[i % cols.length]
    c.rect(Math.round(x), Math.round(y), 2, i % 3 === 0 ? 1 : 2, col)
  }
  if (neon(P)) glow(c, cx, cy, 16, [0.3, 1, 0.6], 0.5 * (1 - t))
  else for (const [dx, dy] of [[0, -14], [-12, -6], [12, -8]]) { const x = cx + dx, y = cy + dy; c.set(x, y - 1, '#fff3a8'); c.set(x, y + 1, '#fff3a8'); c.set(x - 1, y, '#fff3a8'); c.set(x + 1, y, '#fff3a8'); c.set(x, y, '#ffffff') }
}

/** Persistent link between two points: weight 1..3, recent 0..1 (brightness), phase for running dots. */
export function link(P, c, a, b, { weight = 1, recent = 0.5, phase = 0, kind = 'agent' } = {}) {
  const path = arc(a, b, 22)
  const base = kind === 'user' ? P.user : kind === 'machine' ? P.cable[0] : P.link
  const n = Math.max(8, Math.round(path.len))
  if (neon(P)) {
    const core = mix(base, '#000000', 0.55 - recent * 0.35)
    for (let i = 0; i <= n; i++) {
      const q = path.at(i / n), x = Math.round(q.x), y = Math.round(q.y)
      c.set(x, y, core); if (weight > 1) c.set(x, y + 1, mix(core, '#000000', 0.3)); if (weight > 2) c.set(x, y - 1, mix(core, '#000000', 0.3))
    }
    for (let k = 0; k < 3; k++) { const q = path.at(((phase + k / 3) % 1)); c.rect(Math.round(q.x) - 1, Math.round(q.y) - 1, 2 + (weight > 1), 2 + (weight > 1), '#ffffff'); glow(c, q.x, q.y, 5, kind === 'user' ? [1, 0.6, 0.4] : [0.37, 0.95, 1], 0.6) }
    return
  }
  const col = mix(base, P.linkShade, 0.5 - recent * 0.5)
  for (let i = 0; i <= n; i += 3) {
    const q = path.at(i / n), x = Math.round(q.x), y = Math.round(q.y)
    c.set(x, y, col); c.set(x, y + 1, '#2b1d1b28'); if (weight > 1) c.set(x + 1, y, col); if (weight > 2) c.set(x, y - 1, col)
  }
  for (let k = 0; k < 2 + weight; k++) { const q = path.at((phase + k / (2 + weight)) % 1); c.rect(Math.round(q.x) - 1, Math.round(q.y) - 1, 3, 3, mix(base, '#ffffff', 0.5)); c.set(Math.round(q.x), Math.round(q.y), '#ffffff') }
}

/** Sticky note / holo card flying to the task board. */
export function boardCard(P, c, a, b, t) {
  const path = arc(a, b, 16), q = path.at(t)
  if (neon(P)) { glow(c, q.x, q.y, 7, [1, 0.85, 0.3], 0.7); c.rect(Math.round(q.x) - 3, Math.round(q.y) - 2, 7, 5, '#ffd36b'); c.hline(Math.round(q.x) - 2, Math.round(q.x) + 2, Math.round(q.y), '#0f1b2e'); return }
  c.rect(Math.round(q.x) - 3, Math.round(q.y) - 3, 7, 7, '#fff3a8'); c.set(Math.round(q.x), Math.round(q.y) - 3, '#d94a4a'); c.hline(Math.round(q.x) - 2, Math.round(q.x) + 1, Math.round(q.y), '#9aa5ad')
  for (let k = 1; k < 4; k++) { const p = path.at(Math.max(0, t - k * 0.05)); c.set(Math.round(p.x), Math.round(p.y), '#fff3a8a0') }
}

/** Small text label on a plate (machines, rooms). */
export function label(P, c, cx, y, text, tone = 'dark') {
  const w = measure(text) + 6, x = Math.round(cx - w / 2)
  c.rect(x, y, w, 9, tone === 'dark' ? (neon(P) ? '#0b0f18d0' : '#2b1d1bc0') : P.plaque.fill)
  print(c, x + 3, y + 2, text, tone === 'dark' ? '#fffaf0' : P.plaque.text)
  return w
}

/** Selection brackets around an agent (hover / chosen in the list). */
export function selection(P, c, x, y, w, h) {
  const col = neon(P) ? '#5ef2ff' : '#c96442'
  for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
    for (let k = 0; k < 5; k++) { c.set(cx + dx * k, cy, col); c.set(cx, cy + dy * k, col); c.set(cx + dx * k, cy + dy, col); c.set(cx + dx, cy + dy * k, col) }
  }
  if (neon(P)) glow(c, x + w / 2, y + h, w * 0.6, [0.37, 0.95, 1], 0.12)
}
