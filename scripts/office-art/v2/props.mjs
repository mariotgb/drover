// Office v2 props for both directions. Every sprite: { pix, ax, ay, emit?, lights? }
// pix  — lit artwork (anchor ax,ay = bottom-centre on the floor),
// emit — unlit pixels drawn after lighting (screens, LEDs, neon),
// lights — [{ dx, dy, rx, ry, color, k }] relative to the anchor.
import { Pix, mix, rng } from '../canvas.mjs'
import { print, measure } from './pixfont.mjs'

const OUT = '#2b1d1b'
const sp = (pix, ax, ay, extra = {}) => ({ pix, ax, ay, ...extra })
const neon = (P) => P.id === 'neon'
export function shadowEllipse(c, cx, cy, rx, ry, a = '40') {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
    const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
    if (d <= 1 && !c.alpha(x, y)) c.set(x, y, '#1a1220' + a)
  }
}

// ---------------------------------------------------------------- walls (static, drawn in place)

export function wallCap(P, c, x, y, w, h = 16, emit = null) {
  c.rect(x, y, w, h, P.cap[0])
  for (let i = x; i < x + w; i++) { c.set(i, y, P.cap[1]); c.set(i, y + 1, mix(P.cap[1], P.cap[0], 0.5)); c.set(i, y + h - 1, P.cap[2]) }
  for (let j = y + 4; j < y + h - 2; j += 6) for (let i = x + ((j / 6) % 2 ? 3 : 0); i < x + w; i += 7) c.set(i, j, mix(P.cap[0], P.cap[2], 0.4))
  if (neon(P)) for (let i = x; i < x + w; i++) { c.set(i, y + 1, mix(P.edge, P.cap[0], 0.3)); emit?.set(i, y + 1, mix(P.edge, '#000000', 0.25)) }
}
export function wallSide(P, c, x, y, h, emit = null) {
  c.rect(x, y, 16, h, P.cap[0])
  if (neon(P)) { for (let j = y; j < y + h; j++) { c.set(x + 7, j, '#1d2129'); c.set(x + 8, j, mix(P.edge, P.cap[0], 0.3)); emit?.set(x + 8, j, mix(P.edge, '#000000', 0.25)) } }
  for (let j = y; j < y + h; j++) { c.set(x, j, P.cap[2]); c.set(x + 1, j, P.cap[1]); c.set(x + 15, j, P.cap[2]) }
  for (let j = y + 3; j < y + h; j += 6) c.hline(x + 3, x + 12, j, mix(P.cap[0], P.cap[2], 0.35))
}
/** North wall face (32 px tall) of a room, seen from inside. */
export function wallFace(P, c, x, y, w, emit) {
  if (neon(P)) {
    for (let i = x; i < x + w; i++) {
      const slat = Math.floor((i - x) / 3) % 2
      for (let j = y; j < y + 21; j++) c.set(i, j, slat ? P.wainscot[0] : P.wainscot[2])
      c.set(i, y, P.wainscot[1])
      if ((i - x) % 3 === 0) c.vline(i, y + 1, y + 20, P.wainscot[1])
      c.set(i, y + 21, '#0d1018')
      emit.set(i, y + 22, '#5ef2ff'); c.set(i, y + 22, '#5ef2ff')
      for (let j = y + 23; j < y + 30; j++) c.set(i, j, (i - x) % 24 === 0 ? P.paper[1] : P.paper[0])
      c.set(i, y + 30, P.skirting); c.set(i, y + 31, P.skirting)
    }
    return
  }
  for (let i = x; i < x + w; i++) {
    for (let j = y; j < y + 18; j++) c.set(i, j, (i - x) % 6 === 0 ? P.paper[1] : P.paper[0])
    if ((i - x) % 12 === 6) { c.set(i, y + 6, P.paper[1]); c.set(i, y + 12, P.paper[1]) }
    c.set(i, y, P.paper[2])
    c.set(i, y + 18, P.rail); c.set(i, y + 19, mix(P.rail, OUT, 0.3))
    for (let j = y + 20; j < y + 30; j++) c.set(i, j, P.wainscot[0])
    const lx = (i - x) % 16
    if (lx === 2 || lx === 13) for (let j = y + 21; j < y + 29; j++) c.set(i, j, lx === 2 ? P.wainscot[1] : P.wainscot[2])
    if (lx > 2 && lx < 13) { c.set(i, y + 21, P.wainscot[1]); c.set(i, y + 28, P.wainscot[2]) }
    c.set(i, y + 30, P.skirting); c.set(i, y + 31, P.skirting)
  }
}
/** Bottom wall top (cap.front), 16 px, with door gaps [x, w]. */
export function wallFront(P, c, x, y, w, doors = []) {
  for (let i = x; i < x + w; i++) {
    if (doors.some(([dx, dw]) => i >= dx && i < dx + dw)) continue
    for (let j = y; j < y + 16; j++) c.set(i, j, j - y < 2 ? P.cap[1] : j - y > 13 ? P.cap[2] : P.cap[0])
    if (neon(P)) c.set(i, y + 14, mix(P.edge, P.cap[0], 0.4))
  }
}
/** Outside facade under the corridor (exterior face of the building). */
export function facade(P, c, x, y, w, h, emit) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const row = Math.floor((j - y) / 4), off = row % 2 ? 4 : 0
    let col = P.facade[Math.floor(((i + off) / 8 + row * 3) % 3)]
    if ((j - y) % 4 === 3 || (i + off) % 8 === 0) col = P.mortar
    if (neon(P)) col = (j - y) < 3 ? P.facade[2] : P.facade[(Math.floor((i - x) / 24) % 2)]
    c.set(i, j, col)
  }
  for (let i = x; i < x + w; i++) c.set(i, y + h, '#1a122040')
  // windows of the lower floor
  for (let i = x + 20; i + 18 < x + w - 8; i += 40) {
    const lit = ((i * 7) >> 3) % 3 !== 0
    c.rect(i, y + 4, 18, h - 8, neon(P) ? (lit ? '#c99a4a' : '#1d2440') : '#9fd4f2')
    if (neon(P) && lit) { emit.rect(i, y + 4, 18, h - 8, '#b8893f'); emit.rect(i + 1, y + 5, 6, h - 10, '#e0b860') }
    else { c.rect(i + 1, y + 5, 6, h - 10, '#c7ebff'); c.vline(i + 9, y + 4, y + h - 5, '#6a4d39') }
    c.hline(i - 1, i + 18, y + h - 4, neon(P) ? '#30364a' : '#e8d8b6')
  }
}

// ---------------------------------------------------------------- wall decor (static)

export function windowOnWall(P, c, x, y, w, emit, frame = 0) {
  const h = 22
  if (neon(P)) {
    c.rect(x, y, w, h, '#0e1428')
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((i * 7 + j * 13) % 29 === 0 && j > 8) { c.set(x + i, y + j, '#ffd36b'); emit.set(x + i, y + j, '#ffd36b') }
    for (let i = 0; i < w; i += 5) { const bh = 6 + ((i * 37) % 9); c.rect(x + i, y + h - bh, 4, bh, '#1a2240') }
    for (let i = 0; i < w; i += 5) { const bh = 6 + ((i * 37) % 9); for (let j = 1; j < bh; j += 2) if ((i + j) % 3) { c.set(x + i + 1, y + h - bh + j, '#ffd36b'); emit.set(x + i + 1, y + h - bh + j, '#ffcf6b') } }
    c.set(x + w - 6, y + 4, '#e8eefc'); c.set(x + w - 5, y + 4, '#e8eefc'); emit.set(x + w - 6, y + 4, '#ffffff'); emit.set(x + w - 5, y + 4, '#ffffff')
    for (let i = 0; i < w; i++) { c.set(x + i, y - 1, '#1d2129'); c.set(x + i, y + h, '#1d2129') }
    c.vline(x - 1, y - 1, y + h, '#1d2129'); c.vline(x + w, y - 1, y + h, '#1d2129'); c.vline(x + w / 2, y, y + h - 1, '#1d2129')
    c.line(x + 3, y + h - 3, x + 9, y + 3, '#5ef2ff40')
    return
  }
  for (let j = 0; j < h; j++) c.hline(x, x + w - 1, y + j, mix('#8fd0f5', '#d6f0ff', j / h))
  const cx = x + 6 + ((frame * 3) % (w - 12))
  c.round(cx, y + 5, 9, 4, 2, '#ffffff'); c.round(cx + 3, y + 3, 6, 4, 2, '#ffffff')
  c.ellipse(x + w - 8, y + h - 3, 7, 3, '#7fbf4d'); c.ellipse(x + 6, y + h - 2, 6, 3, '#5f9e3f')
  c.rect(x - 2, y - 2, w + 4, 2, '#7a5236'); c.rect(x - 2, y + h, w + 4, 3, '#9c6c47'); c.hline(x - 2, x + w + 1, y + h, '#c08a5c')
  c.vline(x - 2, y, y + h - 1, '#7a5236'); c.vline(x - 1, y, y + h - 1, '#9c6c47'); c.vline(x + w, y, y + h - 1, '#9c6c47'); c.vline(x + w + 1, y, y + h - 1, '#7a5236')
  c.vline(x + w / 2, y, y + h - 1, '#9c6c47'); c.hline(x, x + w - 1, y + 10, '#9c6c47')
  // curtains
  for (const [cxx, d] of [[x - 4, 1], [x + w + 1, -1]]) for (let j = -3; j < h + 2; j++) { c.set(cxx, y + j, '#d97757'); c.set(cxx + d, y + j, j % 3 ? '#e8957a' : '#b55a3e'); c.set(cxx + 2 * d, y + j, '#c4664a') }
  c.hline(x - 5, x + w + 4, y - 3, '#5b3d2a')
}

export function taskBoard(P, c, x, y, counts, emit) {
  const w = 50, h = 24
  if (neon(P)) {
    c.rect(x - 1, y - 1, w + 2, h + 2, '#0b0e14'); c.rect(x, y, w, h, '#0f1b2e'); emit.rect(x, y, w, h, '#0f1b2e')
    const colsC = ['#60a5fa', '#f5b83d', '#3ecf7a']
    for (let k = 0; k < 3; k++) {
      const cx = x + 2 + k * 16
      emit.hline(cx, cx + 13, y + 2, colsC[k]); c.hline(cx, cx + 13, y + 2, colsC[k])
      for (let n = 0; n < Math.min(counts[k], 5); n++) { emit.rect(cx + 1, y + 5 + n * 4, 12, 3, mix(colsC[k], '#0f1b2e', 0.55)); emit.hline(cx + 2, cx + 7, y + 6 + n * 4, '#dffbff') }
    }
    c.rect(x + 22, y + h + 1, 6, 4, '#1d2129')
    return { lights: [{ x: x + w / 2, y: y + h + 10, rx: 30, ry: 14, color: [0.4, 0.7, 1], k: 0.55 }] }
  }
  c.rect(x - 2, y - 2, w + 4, h + 4, '#7a5236'); c.rect(x - 1, y - 1, w + 2, h + 2, '#9c6c47')
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) c.set(x + i, y + j, (i * 3 + j * 5) % 7 === 0 ? '#b88a58' : '#c99a66')
  const head = ['#7fb3e0', '#f2c230', '#7fcf8a'], notes = ['#fff3a8', '#ffd0dc', '#c9f0d0', '#cfe6ff']
  for (let k = 0; k < 3; k++) {
    const cx = x + 2 + k * 16
    c.rect(cx, y + 1, 14, 3, head[k])
    for (let n = 0; n < Math.min(counts[k], 4); n++) {
      const nx = cx + 1 + (n % 2) * 6, ny = y + 6 + Math.floor(n / 2) * 8
      c.rect(nx, ny, 6, 6, notes[(n + k) % 4]); c.set(nx + 2, ny, '#d94a4a'); c.hline(nx + 1, nx + 4, ny + 3, '#9aa5ad')
    }
    if (counts[k] > 4) print(c, cx + 9, y + 18, '+', '#5b3d2a')
  }
  return {}
}

export function sign(P, c, x, y, text, emit, scale = 1) {
  const tw = measure(text) * scale, w = tw + 8 + 4 * scale, h = 5 * scale + 6
  const left = Math.round(x - w / 2)
  if (neon(P)) {
    c.rect(left, y, w, h, P.sign.fill); c.hline(left, left + w - 1, y, P.sign.edge); c.hline(left, left + w - 1, y + h - 1, P.sign.edge)
    print(c, left + 4 + 2 * scale, y + 3, text, '#ff7ad9', scale); print(emit, left + 4 + 2 * scale, y + 3, text, scale > 1 ? '#ffd6f4' : '#ffc2ee', scale)
    return { glow: { x: left + w / 2, y: y + h / 2, r: Math.max(10, w * 0.55), color: [1, 0.3, 0.75], k: 0.3 } }
  }
  c.line(left + 3, y - 3, left + 6, y, '#5b3d2a'); c.line(left + w - 4, y - 3, left + w - 7, y, '#5b3d2a')
  c.round(left, y, w, h, 2, P.sign.edge); c.round(left + 1, y + 1, w - 2, h - 2, 1, P.sign.fill)
  c.hline(left + 2, left + w - 3, y + 1, mix(P.sign.fill, '#ffffff', 0.25))
  if (scale > 1) print(c, left + 4 + 2 * scale + 1, y + 4, text, P.sign.edge, scale)
  print(c, left + 4 + 2 * scale, y + 3, text, P.sign.text, scale)
  return {}
}

export function clock(P, c, x, y, hour = 3, minute = 0) {
  const face = neon(P) ? '#1d2129' : '#fffaf0', rim = neon(P) ? '#5ef2ff' : '#7a5236'
  c.ellipse(x, y, 5, 5, rim); c.ellipse(x, y, 4, 4, face)
  const hand = neon(P) ? '#dffbff' : '#2b1d1b'
  const a = ((hour % 12) / 12) * Math.PI * 2, b = (minute / 60) * Math.PI * 2
  c.line(x, y, Math.round(x + Math.sin(a) * 2), Math.round(y - Math.cos(a) * 2), hand)
  c.line(x, y, Math.round(x + Math.sin(b) * 3), Math.round(y - Math.cos(b) * 3), hand)
}

export function picture(P, c, x, y, v = 0) {
  const frame = neon(P) ? '#1d2129' : '#7a5236'
  c.rect(x, y, 14, 11, frame)
  const art = neon(P) ? [['#ff7ad9', '#5ef2ff'], ['#ffd36b', '#7c5cff']][v % 2] : [['#9fd4f2', '#7fbf4d'], ['#f2c6a3', '#d97757']][v % 2]
  c.rect(x + 1, y + 1, 12, 9, art[0]); c.ellipse(x + 7, y + 8, 5, 3, art[1]); if (!neon(P)) c.set(x + 10, y + 3, '#fff6c0')
}

export function whiteboard(P, c, x, y) {
  c.rect(x, y, 34, 20, neon(P) ? '#d9e2ee' : '#c9d1d6'); c.rect(x + 1, y + 1, 32, 18, neon(P) ? '#f3f7fb' : '#ffffff')
  c.line(x + 4, y + 13, x + 10, y + 6, '#3a6fb0'); c.line(x + 10, y + 6, x + 16, y + 10, '#3a6fb0'); c.line(x + 16, y + 10, x + 24, y + 4, '#3a6fb0')
  c.rect(x + 22, y + 12, 8, 4, '#f4a3b5'); c.hline(x + 4, x + 14, y + 16, '#d94a4a')
  c.hline(x + 2, x + 31, y + 20, '#9aa5ad')
}

// ---------------------------------------------------------------- desks

export function screenContent(e, c, x, y, w, h, mode, seed) {
  // mode: code | term | off | ask | done
  const r = rng(seed * 97 + 3)
  const bg = mode === 'off' ? '#141a22' : mode === 'term' ? '#0c1410' : '#13243a'
  c.rect(x, y, w, h, bg); if (mode !== 'off') e.rect(x, y, w, h, bg)
  if (mode === 'off') { c.set(x + 1, y + 1, '#2c3644'); c.line(x + 2, y + h - 2, x + 5, y + h - 5, '#232c38'); return }
  const palette = mode === 'term' ? ['#7cf28c', '#4fcf6a', '#c4ffd0'] : ['#8fe3ff', '#c9b6ff', '#7cf28c', '#ffd36b', '#ff9aa8']
  for (let j = 1; j < h - 1; j += 2) {
    let i = x + 1 + Math.floor(r() * 3)
    const end = x + 1 + Math.floor(r() * (w - 3)) + 2
    while (i < Math.min(end, x + w - 1)) { const len = 1 + Math.floor(r() * 4); const col = palette[Math.floor(r() * palette.length)]; for (let k = 0; k < len && i < x + w - 1; k++, i++) { c.set(i, y + j, col); e.set(i, y + j, col) } i++ }
  }
  if (mode === 'ask') { e.rect(x + w - 5, y + 1, 4, 4, '#f5b83d'); e.set(x + w - 3, y + 2, '#2b1d1b') }
}

/**
 * One bench row: `cols` desk columns, north desks (agents face you) back-to-back with
 * south desks (agents show their backs, screens face you).
 * seats[i] = { north: { mode }, south: { mode } } with mode code|term|off|ask|done.
 */
export function bench(P, cols, seats, seed = 0) {
  const W = cols * 48 + 4, H = 50, oy = 14
  const c = new Pix(W, H), e = new Pix(W, H), D = P.desk
  const lights = []
  // north desk surface
  c.rect(2, oy, W - 4, 12, D.top); c.hline(2, W - 3, oy, D.hi); c.hline(2, W - 3, oy + 11, D.lo)
  // divider
  c.rect(1, oy + 12, W - 2, 2, P.divider[2]); c.hline(1, W - 2, oy + 12, P.divider[0])
  // south desk surface + front panel
  c.rect(2, oy + 14, W - 4, 12, D.top); c.hline(2, W - 3, oy + 14, D.hi); c.hline(2, W - 3, oy + 25, D.lo)
  c.rect(2, oy + 26, W - 4, 10, D.front); c.hline(2, W - 3, oy + 26, mix(D.front, '#ffffff', 0.18)); c.hline(2, W - 3, oy + 35, D.frontLo)
  if (neon(P)) { c.hline(2, W - 3, oy + 27, P.desk.trim); e.hline(2, W - 3, oy + 27, '#5ef2ff') }
  for (let k = 0; k < cols; k++) {
    const x0 = 2 + k * 48, s = seats[k] ?? {}
    const nMode = s.north?.mode ?? 'off', sMode = s.south?.mode ?? 'off'
    // grain
    if (!neon(P)) for (let i = x0 + 4; i < x0 + 44; i += 9) { c.hline(i, i + 3, oy + 4 + (i % 5), mix(D.top, D.lo, 0.45)); c.hline(i + 2, i + 5, oy + 18 + (i % 4), mix(D.top, D.lo, 0.45)) }
    // panel legs / drawers per column
    c.vline(x0, oy + 26, oy + 35, D.frontLo)
    if (!neon(P)) { c.rect(x0 + 30, oy + 28, 14, 6, mix(D.front, D.frontLo, 0.5)); c.rect(x0 + 31, oy + 29, 12, 4, D.front); c.rect(x0 + 35, oy + 30, 4, 1, D.trim) }
    else { c.rect(x0 + 3, oy + 29, 3, 6, D.leg); c.rect(x0 + 42, oy + 29, 3, 6, D.leg) }
    // north side: keyboard (faces the north agent), monitor back by the divider
    c.rect(x0 + 18, oy + 2, 14, 3, P.monitor.lo); c.hline(x0 + 18, x0 + 31, oy + 2, P.monitor.hi)
    const mb = { x: x0 + 7, y: oy - 1 }
    c.rect(mb.x, mb.y, 18, 11, P.monitor.case); c.hline(mb.x, mb.x + 17, mb.y, P.monitor.hi); c.vline(mb.x, mb.y, mb.y + 10, P.monitor.hi); c.hline(mb.x, mb.x + 17, mb.y + 10, P.monitor.lo)
    c.rect(mb.x + 7, mb.y + 11, 4, 2, P.monitor.lo)
    if (nMode !== 'off') { c.set(mb.x + 15, mb.y + 8, '#7cf28c'); e.set(mb.x + 15, mb.y + 8, '#7cf28c') }
    if (k % 3 === 1 && !neon(P)) { c.rect(mb.x + 2, mb.y + 3, 5, 5, '#fff3a8'); c.set(mb.x + 3, mb.y + 5, '#c9a43a') }
    if (nMode !== 'off') lights.push({ dx: x0 + 16 - W / 2, dy: oy - 4 - H, rx: 16, ry: 10, color: P.monitor.glow, k: neon(P) ? 0.5 : 0.12 })
    // south monitor (screen faces you)
    const sm = { x: x0 + 22, y: oy - 3 }
    const dual = neon(P)
    if (dual) {
      for (const [mx, mw] of [[sm.x - 3, 14], [sm.x + 12, 14]]) {
        c.rect(mx, sm.y, mw, 13, P.monitor.case); c.hline(mx, mx + mw - 1, sm.y, P.monitor.hi)
        screenContent(e, c, mx + 1, sm.y + 1, mw - 2, 10, sMode, seed * 31 + k * 7 + mx)
      }
      c.rect(sm.x + 9, sm.y + 13, 4, 3, P.monitor.lo)
    } else {
      c.rect(sm.x, sm.y, 22, 15, P.monitor.case); c.hline(sm.x, sm.x + 21, sm.y, P.monitor.hi); c.hline(sm.x, sm.x + 21, sm.y + 14, P.monitor.lo)
      screenContent(e, c, sm.x + 2, sm.y + 2, 18, 11, sMode, seed * 31 + k * 7)
      c.rect(sm.x + 9, sm.y + 15, 4, 2, P.monitor.lo); c.rect(sm.x + 6, sm.y + 17, 10, 1, P.monitor.lo)
    }
    if (sMode !== 'off') lights.push({ dx: x0 + 33 - W / 2, dy: oy + 10 - H, rx: neon(P) ? 22 : 16, ry: neon(P) ? 22 : 12, color: P.monitor.glow, k: neon(P) ? 0.85 : 0.18 })
    // south keyboard, mouse, desk clutter
    c.rect(x0 + 22, oy + 20, 16, 4, P.monitor.lo); c.hline(x0 + 22, x0 + 37, oy + 20, P.monitor.hi)
    for (let i = x0 + 23; i < x0 + 37; i += 2) c.set(i, oy + 22, neon(P) ? ['#ff7ad9', '#5ef2ff', '#7cf28c'][i % 3] : '#9aa5ad')
    if (neon(P) && sMode !== 'off') for (let i = x0 + 23; i < x0 + 37; i += 2) e.set(i, oy + 22, ['#ff7ad9', '#5ef2ff', '#7cf28c'][i % 3])
    c.rect(x0 + 41, oy + 21, 2, 3, '#e8eef2')
    const clutter = (seed + k) % 4
    if (clutter === 0) { c.rect(x0 + 4, oy + 17, 5, 6, '#f6efe3'); c.hline(x0 + 4, x0 + 8, oy + 17, '#7a4a32'); c.set(x0 + 9, oy + 19, '#d8cbb5') }
    if (clutter === 1) { c.rect(x0 + 5, oy + 16, 11, 7, '#fffaf0'); c.rect(x0 + 4, oy + 15, 11, 7, '#ffffff'); c.hline(x0 + 5, x0 + 12, oy + 17, '#a9b3bb'); c.hline(x0 + 5, x0 + 10, oy + 19, '#a9b3bb') }
    if (clutter === 2 && !neon(P)) { c.ellipse(x0 + 8, oy + 15, 4, 3, '#5f9e3f'); c.ellipse(x0 + 7, oy + 14, 2, 2, '#7fbf4d'); c.rect(x0 + 6, oy + 18, 5, 4, '#c46a3d') }
    if (clutter === 2 && neon(P)) { c.rect(x0 + 5, oy + 15, 6, 8, '#2a2f3a'); c.rect(x0 + 6, oy + 16, 4, 2, '#ff7ad9'); e.rect(x0 + 6, oy + 16, 4, 2, '#ff7ad9') }
    if (clutter === 3) { c.rect(x0 + 3, oy + 4, 8, 6, neon(P) ? '#2a2f3a' : '#c9d1d6'); c.rect(x0 + 4, oy + 5, 6, 3, neon(P) ? '#7c5cff' : '#9fd4f2') }
    // divider plant / LED
    if (!neon(P) && k % 2 === 0) { c.ellipse(x0 + 44, oy + 10, 3, 3, '#4f9a3a'); c.ellipse(x0 + 43, oy + 9, 2, 2, '#7fbf4d'); c.rect(x0 + 42, oy + 12, 4, 2, '#c46a3d') }
  }
  c.outline(OUT, 0.5)
  shadowEllipse(c, W / 2, H - 1, W / 2, 2, '30')
  return sp(c, W / 2, H, { emit: e, lights })
}

export function chairBack(P, pal = P.chair) {
  const c = new Pix(22, 24)
  c.round(3, 2, 16, 14, 4, pal.seat); c.round(4, 3, 14, 4, 2, pal.hi); c.hline(5, 16, 14, pal.lo)
  if (neon(P)) for (let j = 6; j < 14; j += 2) c.hline(5, 16, j, pal.lo)
  c.rect(1, 12, 3, 5, pal.lo); c.rect(18, 12, 3, 5, pal.lo)
  c.rect(10, 16, 2, 4, pal.base); c.hline(5, 16, 20, pal.base); c.set(5, 21, pal.base); c.set(16, 21, pal.base); c.set(10, 21, pal.base)
  c.outline(OUT, 0.55)
  shadowEllipse(c, 11, 22, 8, 2)
  return sp(c, 11, 23)
}
export function chairFront(P, pal = P.chair, empty = false) {
  const c = new Pix(22, 26)
  c.round(3, 0, 16, 16, 4, pal.seat); c.round(5, 2, 12, 5, 2, pal.hi)
  if (empty) { c.rect(3, 14, 16, 6, pal.lo); c.hline(4, 17, 14, pal.hi) }
  c.rect(10, 18, 2, 4, pal.base); c.hline(5, 16, 22, pal.base)
  c.outline(OUT, 0.55)
  return sp(c, 11, 25)
}

export function headDesk(P, name, mode = 'code') {
  const W = 76, H = 46, c = new Pix(W, H), e = new Pix(W, H), D = P.desk
  c.rect(2, 12, W - 4, 14, D.top); c.hline(2, W - 3, 12, D.hi); c.hline(2, W - 3, 25, D.lo)
  c.rect(2, 26, W - 4, 16, D.front); c.hline(2, W - 3, 26, mix(D.front, '#ffffff', 0.2)); c.hline(2, W - 3, 41, D.frontLo)
  c.rect(6, 29, 16, 10, mix(D.front, D.frontLo, 0.4)); c.rect(W - 22, 29, 16, 10, mix(D.front, D.frontLo, 0.4))
  // brass name plaque on the front
  const tw = measure(name), pw = Math.min(tw + 8, W - 30)
  c.rect(W / 2 - pw / 2, 30, pw, 9, neon(P) ? '#0f1b2e' : '#c9a24a'); c.hline(W / 2 - pw / 2, W / 2 + pw / 2 - 1, 30, neon(P) ? '#5ef2ff' : '#f2d27a')
  // two monitor backs, lamp, papers, phone
  for (const mx of [16, 40]) { c.rect(mx, 2, 20, 12, P.monitor.case); c.hline(mx, mx + 19, 2, P.monitor.hi); c.rect(mx + 8, 14, 4, 2, P.monitor.lo) }
  if (mode !== 'off') { e.set(33, 10, '#7cf28c'); e.set(57, 10, '#7cf28c'); c.set(33, 10, '#7cf28c'); c.set(57, 10, '#7cf28c') }
  if (!neon(P)) { c.line(66, 22, 68, 8, '#3d4450'); c.round(64, 5, 9, 5, 2, '#2f6b4a'); c.set(66, 9, '#fff6c0'); e.set(67, 10, '#fff6c0') }
  else { c.rect(64, 6, 6, 16, '#2a2f3a'); e.vline(65, 7, 20, '#ff7ad9'); c.vline(65, 7, 20, '#ff7ad9') }
  c.rect(5, 15, 10, 7, '#ffffff'); c.rect(6, 14, 10, 7, '#fffaf0'); c.hline(7, 13, 16, '#a9b3bb'); c.hline(7, 11, 18, '#a9b3bb')
  c.rect(58, 18, 6, 4, '#3d4450')
  c.outline(OUT, 0.5)
  shadowEllipse(c, W / 2, H - 2, W / 2 - 2, 3, '30')
  const lights = neon(P) ? [{ dx: 0, dy: -36, rx: 40, ry: 18, color: [0.45, 0.8, 1], k: 0.55 }, { dx: 28, dy: -30, rx: 14, ry: 14, color: [1, 0.4, 0.85], k: 0.5 }] : [{ dx: 30, dy: -34, rx: 20, ry: 12, color: [1, 0.9, 0.6], k: 0.25 }]
  return sp(c, W / 2, H - 2, { emit: e, lights, plaque: { x: W / 2 - pw / 2, y: 30, w: pw, name } })
}

export function meetingTable(P, seats = 4) {
  const c = new Pix(64, 44)
  const top = P.desk.top
  // chairs around
  const ch = neon(P) ? '#3a2e4a' : '#5a6f9c'
  for (const [x, y, up] of [[10, 0, 1], [44, 0, 1], [10, 30, 0], [44, 30, 0]].slice(0, seats)) {
    // seat + backrest (backrest on the far side from the table)
    c.round(x, y + (up ? 4 : 0), 10, 7, 2, mix(ch, '#000000', 0.2)); c.round(x + 1, y + (up ? 5 : 1), 8, 4, 1, ch)
    c.round(x, y + (up ? 0 : 7), 10, 4, 1, ch); c.hline(x + 1, x + 8, y + (up ? 0 : 7), mix(ch, '#ffffff', 0.3))
  }
  c.ellipse(32, 20, 22, 11, mix(top, '#000000', 0.25)); c.ellipse(32, 18, 22, 11, top); c.ellipse(28, 15, 12, 4, mix(top, '#ffffff', 0.3))
  c.rect(20, 14, 9, 6, '#ffffff'); c.rect(36, 18, 8, 5, '#fff3a8'); c.rect(30, 22, 5, 5, '#f6efe3')
  if (neon(P)) { c.rect(26, 12, 12, 6, '#0f1b2e'); c.hline(27, 36, 14, '#5ef2ff') }
  c.outline(OUT, 0.5)
  shadowEllipse(c, 32, 33, 24, 4, '30')
  return sp(c, 32, 40, neon(P) ? { emit: (() => { const e = new Pix(64, 44); e.hline(27, 36, 14, '#5ef2ff'); return e })(), lights: [{ dx: 0, dy: -22, rx: 34, ry: 18, color: [1, 0.85, 0.6], k: 0.3 }] } : {})
}

// ---------------------------------------------------------------- lounge & decor

export function sofa(P, w = 52) {
  const [base, light, dark] = P.sofa, c = new Pix(w, 30)
  c.round(2, 3, w - 4, 13, 4, dark); c.round(3, 4, w - 6, 10, 3, base); c.hline(5, w - 6, 5, light)
  c.round(0, 11, 8, 15, 3, dark); c.round(w - 8, 11, 8, 15, 3, dark); c.vline(1, 13, 24, base); c.vline(w - 2, 13, 24, base)
  c.round(7, 14, w - 14, 9, 2, base); c.hline(8, w - 9, 14, light); c.vline(w / 2, 14, 22, dark)
  c.rect(6, 23, w - 12, 3, dark); c.rect(4, 26, 3, 2, '#3b2b26'); c.rect(w - 7, 26, 3, 2, '#3b2b26')
  c.round(10, 7, 8, 7, 2, P.armchair[0]); c.hline(11, 16, 8, P.armchair[1])
  c.outline(OUT, 0.55); shadowEllipse(c, w / 2, 28, w / 2 - 2, 2)
  return sp(c, w / 2, 29)
}
export function armchair(P) {
  const [base, light, dark] = P.armchair, c = new Pix(22, 24)
  c.round(2, 1, 18, 12, 4, dark); c.round(3, 2, 16, 9, 3, base); c.hline(5, 16, 3, light)
  c.round(0, 8, 6, 13, 2, dark); c.round(16, 8, 6, 13, 2, dark); c.round(5, 11, 12, 8, 2, base); c.hline(6, 15, 11, light)
  c.rect(4, 20, 2, 2, '#3b2b26'); c.rect(16, 20, 2, 2, '#3b2b26')
  c.outline(OUT, 0.55); shadowEllipse(c, 11, 22, 10, 2)
  return sp(c, 11, 23)
}
export function beanbag(P, color) {
  const c = new Pix(20, 16)
  c.ellipse(10, 9, 9, 6, mix(color, '#000000', 0.3)); c.ellipse(10, 8, 8, 5, color); c.ellipse(8, 6, 4, 2, mix(color, '#ffffff', 0.35)); c.line(10, 5, 12, 9, mix(color, '#000000', 0.2))
  c.outline(OUT, 0.55); shadowEllipse(c, 10, 14, 9, 2)
  return sp(c, 10, 15)
}
export function coffeeTable(P, w = 28) {
  const c = new Pix(w, 16), top = neon(P) ? '#e9edf3' : P.desk.top
  c.round(1, 2, w - 2, 8, 2, mix(top, '#000000', 0.25)); c.round(2, 2, w - 4, 6, 2, top)
  c.rect(3, 10, 2, 4, P.desk.leg); c.rect(w - 5, 10, 2, 4, P.desk.leg)
  c.rect(6, 3, 5, 5, '#f6efe3'); c.hline(6, 10, 3, '#7a4a32'); c.rect(14, 4, 8, 3, neon(P) ? '#7c5cff' : '#d97757')
  c.outline(OUT, 0.55); shadowEllipse(c, w / 2, 14, w / 2 - 1, 2)
  return sp(c, w / 2, 15)
}
export function bookshelf(P, w = 32) {
  const c = new Pix(w, 36), wood = neon(P) ? ['#2a2f3a', '#3a4152', '#1d2129'] : ['#8f5a33', '#a8703f', '#6a4228']
  c.rect(0, 0, w, 35, wood[2]); c.rect(1, 1, w - 2, 33, wood[0]); c.hline(1, w - 2, 1, wood[1])
  const colors = neon(P) ? ['#ff7ad9', '#5ef2ff', '#ffd36b', '#7c5cff', '#7cf28c', '#e9edf3'] : ['#b5543f', '#4f6fa0', '#5d8f55', '#d9a441', '#8a5a9e', '#c46a3d', '#3e5a7a']
  for (let s = 0; s < 3; s++) {
    const y = 2 + s * 11
    c.hline(1, w - 2, y + 10, wood[1])
    let x = 2
    for (let b = 0; x < w - 3; b++) {
      const bw = 2 + ((b + s) % 3 === 0 ? 1 : 0), bh = 8 - ((b * 5 + s) % 3 === 0 ? 2 : 0)
      if ((b + s * 2) % 7 === 5) { c.ellipse(x + 2, y + 7, 2, 3, '#5f9e3f'); x += 5; continue }
      const col = colors[(b + s * 3) % colors.length]
      c.rect(x, y + 10 - bh, bw, bh, col); c.vline(x, y + 11 - bh, y + 9, mix(col, '#ffffff', 0.25))
      x += bw + (b % 4 === 3 ? 1 : 0)
    }
  }
  c.outline(OUT, 0.55); shadowEllipse(c, w / 2, 35, w / 2, 1)
  return sp(c, w / 2, 36)
}
export function plant(P, kind = 'big') {
  if (kind === 'monstera') {
    const c = new Pix(26, 36)
    const pot = neon(P) ? ['#e9edf3', '#ffffff', '#b8c0cc'] : ['#c46a3d', '#df8a58', '#8e4524']
    c.rect(8, 26, 10, 9, pot[0]); c.hline(7, 18, 26, pot[1]); c.vline(17, 27, 34, pot[2])
    for (const [x, y, rx, ry, a] of [[13, 6, 5, 5, 0], [6, 12, 5, 4, 1], [20, 12, 5, 4, 1], [9, 19, 5, 4, 0], [18, 20, 5, 4, 0], [13, 15, 4, 4, 1]]) {
      c.ellipse(x, y, rx, ry, '#2f7a3a'); c.ellipse(x - 1, y - 1, rx - 1, ry - 1, a ? '#4f9a3a' : '#5fae45'); c.line(x - rx + 1, y, x + 1, y, '#2f6b2e'); c.set(x + 2, y + 1, '#2f6b2e')
    }
    c.line(13, 25, 13, 8, '#2f6b2e'); c.line(13, 20, 7, 13, '#2f6b2e'); c.line(13, 20, 19, 13, '#2f6b2e')
    c.outline(OUT, 0.55); shadowEllipse(c, 13, 35, 7, 1)
    return sp(c, 13, 36)
  }
  const big = kind === 'big', c = new Pix(16, big ? 30 : 16)
  const pot = neon(P) ? ['#e9edf3', '#ffffff', '#b8c0cc'] : ['#c46a3d', '#df8a58', '#8e4524']
  const top = big ? 21 : 8
  c.rect(3, top, 10, (big ? 29 : 15) - top, pot[0]); c.hline(2, 13, top, pot[1]); c.vline(12, top + 1, big ? 28 : 14, pot[2])
  const leaves = big ? [[8, 3, 3, 5], [4, 7, 3, 4], [12, 8, 3, 4], [6, 12, 4, 5], [11, 14, 3, 4], [8, 17, 4, 4]] : [[8, 2, 3, 3], [4, 4, 3, 3], [12, 4, 3, 3]]
  for (const [x, y, rx, ry] of leaves) { c.ellipse(x, y, rx, ry, '#4f9a3a'); c.ellipse(x - 1, y - 1, rx - 1, ry - 1, '#7fbf4d') }
  c.outline(OUT, 0.55); shadowEllipse(c, 8, big ? 29 : 15, 6, 1)
  return sp(c, 8, big ? 30 : 16)
}
export function coffeeMachine(P) {
  const c = new Pix(34, 30), e = new Pix(34, 30)
  const counter = neon(P) ? ['#e9edf3', '#c8ced8', '#9aa3b2'] : [P.desk.top, P.desk.front, P.desk.frontLo]
  c.rect(0, 14, 34, 4, counter[0]); c.rect(0, 18, 34, 10, counter[1]); c.hline(0, 33, 27, counter[2]); c.vline(17, 18, 27, counter[2])
  c.rect(3, 2, 12, 13, '#3d4450'); c.rect(4, 3, 10, 4, '#59607a'); c.rect(7, 9, 4, 3, '#1d2129'); c.rect(6, 12, 6, 2, '#f6efe3')
  c.set(12, 4, '#7cf28c'); e.set(12, 4, '#7cf28c')
  c.rect(19, 8, 6, 7, '#f6efe3'); c.rect(26, 9, 5, 6, '#d97757'); c.rect(20, 4, 4, 4, '#c9d1d6')
  c.outline(OUT, 0.5); shadowEllipse(c, 17, 28, 16, 1)
  return sp(c, 17, 29, { emit: e })
}
export function cooler(P) {
  const c = new Pix(14, 30)
  c.round(2, 0, 10, 10, 3, '#9fd4f2'); c.round(3, 1, 8, 7, 2, '#c7ebff'); c.set(5, 4, '#ffffff')
  c.rect(1, 10, 12, 18, '#eef1f3'); c.vline(12, 11, 27, '#c9d1d6'); c.rect(4, 14, 6, 4, '#3d4450'); c.set(5, 15, '#d94a4a'); c.set(8, 15, '#4a8fd9')
  c.outline(OUT, 0.5); shadowEllipse(c, 7, 28, 6, 1)
  return sp(c, 7, 29)
}
export function floorLamp(P) {
  const c = new Pix(14, 36), e = new Pix(14, 36)
  c.vline(7, 8, 33, '#3d4450'); c.rect(4, 33, 7, 2, '#3d4450')
  if (neon(P)) { c.rect(5, 2, 4, 12, '#ff7ad9'); e.rect(5, 2, 4, 12, '#ffc2ee') }
  else { c.round(2, 1, 10, 8, 2, '#f2d27a'); c.hline(3, 10, 8, '#c9a24a'); e.hline(4, 9, 8, '#fff6c0') }
  c.outline(OUT, 0.5)
  return sp(c, 7, 35, { emit: e, lights: [{ dx: 0, dy: -24, rx: 30, ry: 22, color: neon(P) ? [1, 0.4, 0.85] : [1, 0.85, 0.55], k: neon(P) ? 0.8 : 0.22 }] })
}
export function arcade(P) {
  const c = new Pix(20, 38), e = new Pix(20, 38)
  c.rect(1, 2, 18, 34, '#2a2f3a'); c.rect(2, 3, 16, 5, '#7c5cff'); e.rect(3, 4, 14, 3, '#b9a7ff')
  c.rect(3, 10, 14, 11, '#0d1a2b'); e.rect(4, 11, 12, 9, '#0d1a2b'); e.rect(6, 13, 3, 3, '#7cf28c'); e.rect(11, 15, 3, 2, '#ff7ad9'); e.hline(4, 15, 19, '#5ef2ff')
  c.rect(2, 22, 16, 5, '#3a4152'); c.set(6, 24, '#d94a4a'); c.set(12, 24, '#f2c230'); c.set(14, 24, '#4fb3e0')
  c.outline(OUT, 0.5); shadowEllipse(c, 10, 36, 9, 1)
  return sp(c, 10, 37, { emit: e, lights: [{ dx: 0, dy: -20, rx: 18, ry: 16, color: [0.6, 0.45, 1], k: 0.8 }] })
}
export function vending(P) {
  const c = new Pix(20, 38), e = new Pix(20, 38)
  c.rect(1, 1, 18, 35, '#d0465a'); c.rect(3, 3, 11, 26, '#0d1a2b'); e.rect(3, 3, 11, 26, '#1c2f48')
  for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) e.rect(4 + k * 3, 5 + r * 6, 2, 4, ['#ffd36b', '#7cf28c', '#ff7ad9', '#5ef2ff'][(r + k) % 4])
  c.rect(15, 6, 3, 8, '#2a2f3a'); c.rect(4, 31, 10, 3, '#1d2129')
  c.outline(OUT, 0.5); shadowEllipse(c, 10, 36, 9, 1)
  return sp(c, 10, 37, { emit: e, lights: [{ dx: 0, dy: -18, rx: 20, ry: 16, color: [0.5, 0.8, 1], k: 0.75 }] })
}
export function pingpong(P) {
  const c = new Pix(48, 28)
  c.rect(2, 4, 44, 18, '#2f6b9a'); c.hline(2, 45, 4, '#4f8fc0'); c.vline(24, 4, 21, '#ffffff'); c.hline(2, 45, 13, '#ffffffa0')
  c.rect(23, 1, 2, 22, '#1d2129'); c.rect(4, 22, 2, 4, '#2a2f3a'); c.rect(42, 22, 2, 4, '#2a2f3a')
  c.ellipse(10, 9, 2, 2, '#d94a4a'); c.set(35, 15, '#ffffff')
  c.outline(OUT, 0.5); shadowEllipse(c, 24, 26, 22, 2)
  return sp(c, 24, 27)
}
export function pendant(P) {
  // ceiling lamp seen from below: only its light and a tiny shade (drawn as overlay on light map)
  return { lights: [{ dx: 0, dy: 0, rx: 70, ry: 44, color: [1, 0.86, 0.62], k: neon(P) ? 0.9 : 0.12 }] }
}

// ---------------------------------------------------------------- outside

export function tree(P, size = 1) {
  const r = Math.round(14 * size), c = new Pix(r * 2 + 6, r * 2 + 18)
  const cx = r + 3, cy = r + 2
  shadowEllipse(c, cx + 2, r * 2 + 14, r, 4, '50')
  c.rect(cx - 2, cy + r - 4, 5, 16, neon(P) ? '#3a2e2a' : '#7a5136'); c.vline(cx - 2, cy + r - 4, cy + r + 11, neon(P) ? '#4a3b35' : '#9c6c47')
  const leaf = neon(P) ? ['#1f3a3a', '#2a4d4a', '#376560'] : ['#3f7a35', '#559a43', '#7fbf4d']
  c.ellipse(cx, cy + 2, r, r - 1, leaf[0]); c.ellipse(cx - 2, cy, r - 2, r - 3, leaf[1]); c.ellipse(cx - 4, cy - 3, r - 6, r - 7, leaf[2])
  const rr = rng(r * 13)
  for (let i = 0; i < r * 3; i++) { const a = rr() * Math.PI * 2, d = rr() * (r - 2); c.set(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), rr() < 0.5 ? leaf[2] : leaf[0]) }
  const e = new Pix(c.w, c.h)
  if (neon(P)) for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; const x = Math.round(cx + Math.cos(a) * (r - 3)), y = Math.round(cy + 2 + Math.sin(a) * (r - 4)); c.set(x, y, '#ffd36b'); e.set(x, y, '#ffe9a8') }
  c.outline(OUT, 0.5)
  return sp(c, cx, r * 2 + 16, { emit: e, lights: neon(P) ? [{ dx: 0, dy: -r - 8, rx: r + 8, ry: r, color: [1, 0.85, 0.5], k: 0.35 }] : [] })
}
export function bush(P) {
  const c = new Pix(20, 14), leaf = neon(P) ? ['#1f3a3a', '#2a4d4a', '#376560'] : ['#3f7a35', '#559a43', '#7fbf4d']
  c.ellipse(10, 8, 9, 5, leaf[0]); c.ellipse(8, 6, 6, 4, leaf[1]); c.ellipse(7, 5, 3, 2, leaf[2])
  if (!neon(P)) { c.set(5, 7, '#f4a3b5'); c.set(12, 5, '#f4a3b5'); c.set(14, 8, '#ffffff') }
  c.outline(OUT, 0.5); shadowEllipse(c, 11, 13, 9, 1)
  return sp(c, 10, 13)
}
export function parkBench(P) {
  const c = new Pix(34, 18), wood = neon(P) ? ['#6b4f3f', '#86654f'] : ['#a8703f', '#c98a52']
  c.rect(2, 2, 30, 3, wood[0]); c.hline(2, 31, 2, wood[1]); c.rect(2, 7, 30, 4, wood[0]); c.hline(2, 31, 7, wood[1])
  c.rect(4, 11, 2, 5, '#3d4450'); c.rect(28, 11, 2, 5, '#3d4450')
  c.outline(OUT, 0.5); shadowEllipse(c, 17, 16, 15, 2)
  return sp(c, 17, 17)
}
export function lampPost(P) {
  const c = new Pix(12, 44), e = new Pix(12, 44)
  c.vline(6, 8, 41, '#2a2f3a'); c.rect(4, 41, 5, 2, '#2a2f3a'); c.rect(3, 2, 7, 6, '#3d4450')
  c.rect(4, 3, 5, 4, neon(P) ? '#ffe9a8' : '#f6efe3'); if (neon(P)) e.rect(4, 3, 5, 4, '#fff3cc')
  c.outline(OUT, 0.5)
  return sp(c, 6, 43, { emit: e, lights: neon(P) ? [{ dx: 0, dy: -4, rx: 38, ry: 24, color: [1, 0.85, 0.55], k: 1.1 }] : [] })
}
export function flowerBed(P, w = 40) {
  const c = new Pix(w, 12)
  c.rect(0, 3, w, 8, neon(P) ? '#3a4152' : '#8f5a33'); c.rect(1, 4, w - 2, 6, neon(P) ? '#2a3434' : '#6a4228')
  const r = rng(w)
  for (let i = 2; i < w - 2; i += 2) { c.set(i, 4 + Math.floor(r() * 3), '#5f9e3f'); c.set(i, 3 + Math.floor(r() * 2), P.flower[Math.floor(r() * P.flower.length)]) }
  c.outline(OUT, 0.5)
  return sp(c, w / 2, 11)
}
export function bikeRack(P) {
  const c = new Pix(30, 16)
  for (const x of [3, 12, 21]) { c.ellipse(x + 3, 9, 3, 3, '#2a2f3a'); c.ellipse(x + 3, 9, 2, 2, neon(P) ? '#2a3434' : '#6f9f4c') }
  c.line(4, 8, 10, 4, '#d94a4a'); c.line(10, 4, 14, 8, '#d94a4a'); c.line(13, 8, 19, 4, '#3a6fb0'); c.line(19, 4, 23, 8, '#3a6fb0')
  c.outline(OUT, 0.4)
  return sp(c, 15, 14)
}

// ---------------------------------------------------------------- server room & lobby

export function rack(P, phase = 0, hot = false) {
  const c = new Pix(18, 38), e = new Pix(18, 38)
  c.rect(1, 1, 16, 35, '#2f3640'); c.vline(1, 1, 35, '#4a5260'); c.vline(16, 1, 35, '#1d2229'); c.hline(1, 16, 1, '#59607a')
  for (let i = 0; i < 7; i++) {
    const y = 3 + i * 5
    c.rect(3, y, 12, 4, '#3d4450'); c.hline(3, 14, y, '#4f5868')
    const on = (i + phase) % 3 !== 0 || hot
    const a = on ? (hot ? '#ffd36b' : '#7cf28c') : '#2f6b3a', b = (i * 3 + phase) % 4 === 0 ? '#4fb3e0' : '#24425a'
    c.set(4, y + 2, a); c.set(6, y + 2, b); e.set(4, y + 2, a); if (b === '#4fb3e0') e.set(6, y + 2, b)
    c.hline(9, 13, y + 2, '#262c34')
  }
  c.outline(OUT, 0.5); shadowEllipse(c, 9, 36, 8, 1)
  return sp(c, 9, 37, { emit: e, lights: [{ dx: 0, dy: -18, rx: 16, ry: 18, color: hot ? [1, 0.85, 0.4] : [0.4, 1, 0.6], k: neon(P) ? (hot ? 0.9 : 0.45) : (hot ? 0.25 : 0.05) }] })
}
export function machineStation(P, name, mode = 'term') {
  const c = new Pix(40, 34), e = new Pix(40, 34)
  c.rect(2, 16, 36, 4, neon(P) ? '#e9edf3' : P.desk.top); c.rect(2, 20, 36, 10, neon(P) ? '#9aa3b2' : P.desk.front)
  c.rect(4, 2, 20, 14, '#3d4450'); screenContent(e, c, 6, 4, 16, 10, mode, name.length * 13)
  c.rect(26, 4, 9, 12, '#d8dde1'); c.vline(26, 4, 15, '#f2f4f6'); c.set(28, 13, '#7cf28c'); e.set(28, 13, '#7cf28c')
  c.outline(OUT, 0.5); shadowEllipse(c, 20, 31, 18, 2)
  return sp(c, 20, 32, { emit: e, lights: [{ dx: -6, dy: -22, rx: 20, ry: 14, color: [0.4, 1, 0.6], k: neon(P) ? 0.7 : 0.15 }] })
}
export function reception(P) {
  const c = new Pix(64, 30), top = neon(P) ? '#e9edf3' : P.desk.top
  c.round(0, 6, 64, 8, 3, top); c.hline(3, 60, 6, mix(top, '#ffffff', 0.4))
  c.rect(2, 14, 60, 14, neon(P) ? '#2b3245' : P.desk.front); c.hline(2, 61, 14, mix(neon(P) ? '#2b3245' : P.desk.front, '#ffffff', 0.2))
  if (neon(P)) c.hline(2, 61, 26, '#5ef2ff')
  else for (let x = 6; x < 60; x += 8) c.vline(x, 16, 26, P.desk.frontLo)
  c.outline(OUT, 0.5); shadowEllipse(c, 32, 28, 30, 2)
  const e = new Pix(64, 30); if (neon(P)) e.hline(2, 61, 26, '#5ef2ff')
  return sp(c, 32, 29, { emit: e })
}
export function deskBell(P, ringing = 0) {
  const c = new Pix(14, 12)
  c.rect(2, 9, 10, 2, '#3d4450')
  c.ellipse(7, 7, 4, 3, '#f2c230'); c.rect(3, 7, 9, 2, '#f2c230'); c.set(5, 5, '#fff3a8'); c.rect(6, 2, 2, 2, '#c9a24a')
  if (ringing) { c.set(0, 3, '#f5b83d'); c.set(1, 4, '#f5b83d'); c.set(13, 3, '#f5b83d'); c.set(12, 4, '#f5b83d'); c.set(0, 6, '#f5b83d'); c.set(13, 6, '#f5b83d') }
  c.outline(OUT, 0.5)
  return sp(c, 7, 11)
}
export function cat(P, pose = 'sleep') {
  const c = new Pix(16, 10), fur = neon(P) ? '#3a3a44' : '#e3954f', dark = neon(P) ? '#26262e' : '#b56a2e'
  if (pose === 'sleep') { c.ellipse(8, 6, 6, 3, fur); c.ellipse(4, 5, 3, 3, fur); c.set(2, 2, fur); c.set(5, 2, fur); c.hline(3, 5, 5, dark); c.line(12, 7, 15, 5, fur); for (let x = 7; x < 13; x += 2) c.set(x, 4, dark) }
  else { c.rect(4, 4, 9, 4, fur); c.rect(1, 2, 5, 4, fur); c.set(1, 1, fur); c.set(4, 1, fur); c.set(2, 3, '#2b1d1b'); c.rect(4, 8, 1, 2, dark); c.rect(11, 8, 1, 2, dark); c.line(13, 4, 15, 1, fur) }
  c.outline(OUT, 0.55)
  return sp(c, 8, 9)
}
export function robotVac(P) {
  const c = new Pix(14, 8), e = new Pix(14, 8)
  c.ellipse(7, 4, 6, 3, '#e9edf3'); c.ellipse(7, 3, 4, 2, '#c8ced8'); c.set(7, 3, '#5ef2ff'); e.set(7, 3, '#5ef2ff')
  c.outline(OUT, 0.5)
  return sp(c, 7, 7, { emit: e, lights: [{ dx: 0, dy: -3, rx: 10, ry: 6, color: [0.4, 1, 1], k: 0.5 }] })
}
