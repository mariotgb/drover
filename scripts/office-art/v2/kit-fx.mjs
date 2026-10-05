// v2 effects atlas (carriers, bubbles, plaques, confetti, cables, glows, pets aside)
// and the pix5 font atlas. Unlit overlays carry their pixels in `emit` for the neon set
// so the engine can draw them after lighting.
import { Pix, mix, rgba } from '../canvas.mjs'
import * as O from './overlay.mjs'
import { GLYPHS, SAME, FOLD } from './pixfont.mjs'
import { S } from './kit-tiles.mjs'

const OUT = '#2b1d1b'
const neon = (P) => P.id === 'neon'
const fx = (id, anchor, states, extra = {}) => ({ id, atlas: 'effects', layers: ['effect'], anchor, states, ...extra })
/** Unlit overlay: same pixels in pix and emit so both lighting paths show them. */
const unlit = (pix) => ({ pix, emit: pix })

function bossEnvelope(P, ang) {
  const c = new Pix(24, 24)
  const R = (dx, dy) => [Math.round(12 + dx * Math.cos(ang) - dy * Math.sin(ang)), Math.round(12 + dx * Math.sin(ang) + dy * Math.cos(ang))]
  for (let k = 1; k <= 4; k++) { const [x, y] = R(-6 - k * 2, 0); c.set(x, y, neon(P) ? '#ffd36b' : '#fff3c0') }
  c.rect(7, 9, 11, 8, OUT); c.rect(8, 10, 9, 6, neon(P) ? '#ffd36b' : '#f6e3a0'); c.line(8, 10, 12, 13, '#c9a24a'); c.line(16, 10, 12, 13, '#c9a24a'); c.set(12, 14, '#c0392b')
  return neon(P) ? unlit(c) : { pix: c }
}
function carrier(P, ang, user) {
  const c = new Pix(24, 24), p = { x: 12, y: 12 }
  if (neon(P)) {
    const col = user ? P.user : P.link
    for (let k = 1; k <= 7; k++) { const x = Math.round(12 - Math.cos(ang) * (3 + k)), y = Math.round(12 - Math.sin(ang) * (3 + k)); c.set(x, y, mix(col, '#000000', k / 9)); if (k < 4) c.set(x, y + 1, mix(col, '#000000', 0.5)) }
    c.round(8, 9, 9, 7, 2, '#ffffff'); c.rect(9, 10, 7, 5, col); c.line(9, 10, 12, 12, '#ffffff'); c.line(15, 10, 12, 12, '#ffffff')
    return unlit(c)
  }
  for (const off of [-4, 0, 4]) {
    const bx = p.x - Math.cos(ang) * 9 - Math.sin(ang) * off, by = p.y - Math.sin(ang) * 9 + Math.cos(ang) * off
    c.line(Math.round(bx), Math.round(by), Math.round(bx - Math.cos(ang) * (off ? 2 : 3)), Math.round(by - Math.sin(ang) * (off ? 2 : 3)), '#ffffffc0')
  }
  O.paperPlane(P, c, p, ang, user ? '#cfe6ff' : '#fffaf0', user ? '#5a8fd0' : '#c9b48a', 0.85)
  return { pix: c }
}
function dot(col, size = 3, ring = null) {
  const c = new Pix(5, 5)
  if (ring) { c.rect(0, 1, 5, 3, ring); c.rect(1, 0, 3, 5, ring) }
  c.rect(1, 1, 3, 3, col); if (size === 3) c.set(2, 2, '#ffffff')
  return c
}
function arrivalFrame(P, k) {
  const c = new Pix(40, 28), r = 4 + k * 14, col = neon(P) ? '#5ef2ff' : '#fff3c0'
  for (let a = 0; a < 48; a++) { if (!neon(P) && a % 2) continue; const ang = (a / 48) * Math.PI * 2; c.set(Math.round(20 + Math.cos(ang) * r), Math.round(14 + Math.sin(ang) * r * 0.6), k > 0.7 ? mix(col, '#ffffff', 0.3) + 'b0' : col) }
  if (!neon(P)) for (const [dx, dy] of [[-r, -4], [r, -4], [0, -r * 0.6 - 4]]) { const x = Math.round(20 + dx), y = Math.round(14 + dy); if (c.in(x, y)) { c.set(x, y, '#ffffff'); c.set(x + 1, y, '#fff3c0') } }
  return neon(P) ? unlit(c) : { pix: c }
}
function noteFrame(P, user) { const c = new Pix(12, 10); O.deskNote(P, c, { x: 5, y: 5 }, user); return neon(P) ? unlit(c) : { pix: c } }
function fallFrame(P, k) {
  const c = new Pix(24, 24)
  if (neon(P)) { const a = k < 2 ? 'ff' : k < 3 ? 'a0' : '60'; c.round(9, 10, 7, 5, 1, '#c8d0e0' + a); for (let i = 0; i < k + 2; i++) c.set(12 + ((i * 5) % 7) - 3, 8 + ((i * 3) % 5), '#ffb3b3'); return unlit(c) }
  O.paperPlane(P, c, { x: 12, y: 12 }, 1.2 + k * 0.6, '#efe6d2', '#a99a7c', 0.85)
  for (let i = 1; i < 3; i++) c.set(12 - i * 2, 12 - i * 4, '#efe6d2c0')
  return { pix: c }
}
function crumple(P) {
  const c = new Pix(22, 20)
  if (neon(P)) { c.stamp(7, 8, ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'], { '#': '#ff6b6b' }); for (const [x, y] of [[3, 5], [18, 6], [5, 17], [17, 16], [11, 3]]) c.set(x, y, '#8a6a7a'); return unlit(c) }
  c.ellipse(8, 18, 5, 1, '#2b1d1b40'); c.ellipse(8, 15, 4, 3, OUT); c.ellipse(8, 15, 3, 2, '#efe6d2'); c.set(7, 15, '#a99a7c'); c.set(9, 14, '#a99a7c'); c.set(10, 16, '#a99a7c')
  c.round(12, 3, 9, 9, 2, '#8a8a84'); c.round(13, 4, 7, 7, 2, '#efe6d2'); c.stamp(15, 5, ['##.', '..#', '.#.', '...', '.#.'], { '#': '#8a8a84' })
  return { pix: c }
}
function sparkFrame(P, k) {
  const c = new Pix(16, 16)
  if (neon(P)) { for (let i = 0; i < 8; i++) { const a = i * 0.8, d = 2 + k * 3; c.set(Math.round(8 + Math.cos(a) * d), Math.round(8 + Math.sin(a) * d + k), k > 1 ? '#8a6a7a' : '#ffb3b3') } return unlit(c) }
  for (let i = 0; i < 6; i++) { const a = i * 1.05, d = 2 + k * 2; c.ellipse(8 + Math.cos(a) * d, 8 + Math.sin(a) * d * 0.7, 2 - k * 0.6, 1.5 - k * 0.4, '#ffffff' + (k > 1 ? '80' : 'c0')) }
  return { pix: c }
}
function confettiFrame(P, t) { const c = new Pix(56, 48); O.confetti(P, c, 28, 24, t, 1); return neon(P) ? unlit(c) : { pix: c } }
function bubbleFrame(P, kind, f) { const c = new Pix(15, 18); O.bubble(P, c, 7, 17, kind, f); return { pix: c } }
function statusFrame(P, status, phase) { const c = new Pix(5, 5); O.statusMark(P, c, 0, 0, status, phase); return unlit(c) }
function plaqueSlice(P, v) {
  const c = new Pix(7, 9), S2 = P.plaque
  const edge = v === 'blocked' ? P.status.blocked : v === 'lead' && !neon(P) ? '#c9a24a' : v === 'you' ? (neon(P) ? '#ff9a6b' : '#5a8fd0') : S2.edge
  if (neon(P)) { c.rect(0, 0, 7, 9, '#0b0f18e6'); c.hline(0, 6, 0, edge); c.hline(1, 5, 8, mix(edge, '#000000', 0.5)); c.set(0, 1, edge); c.set(6, 1, edge) }
  else { c.rect(1, 0, 5, 9, edge); c.rect(0, 1, 7, 7, edge); c.rect(1, 1, 5, 7, S2.fill); c.hline(1, 5, 7, S2.shade) }
  return unlit(c)
}
function pointer(P, v, dir) {
  const edge = v === 'blocked' ? P.status.blocked : v === 'lead' && !neon(P) ? '#c9a24a' : v === 'you' ? (neon(P) ? '#ff9a6b' : '#5a8fd0') : P.plaque.edge
  const c = new Pix(3, 2)
  if (dir === 'down') { c.hline(0, 2, 0, edge); c.set(1, 1, edge) } else { c.set(1, 0, edge); c.hline(0, 2, 1, edge) }
  return unlit(c)
}
function labelSlice(P, tone) {
  const c = new Pix(7, 9)
  const fill = tone === 'dark' ? (neon(P) ? '#0b0f18d0' : '#2b1d1bc0') : tone === 'warn' ? P.plaque.fill : P.plaque.fill
  c.rect(0, 0, 7, 9, fill); if (tone === 'warn') c.hline(0, 6, 0, P.status.blocked)
  if (tone === 'light' && !neon(P)) { c.hline(0, 6, 8, P.plaque.shade) }
  return unlit(c)
}
function selectFrame(P, f) { const c = new Pix(36, 56); O.selection(P, c, 3 - f, 3 - f, 30 + 2 * f, 50 + 2 * f); return unlit(c) }
function steamFrame(f) {
  const c = new Pix(8, 12)
  const pts = [[[4, 10], [3, 8], [3, 6], [4, 4]], [[3, 10], [4, 8], [4, 6], [3, 3]], [[4, 9], [4, 7], [3, 5], [3, 2]]][f]
  pts.forEach(([x, y], i) => c.set(x, y, i < 2 ? '#ffffffc8' : '#ffffff80'))
  return { pix: c }
}
function packetFrame(P, f) {
  const c = new Pix(7, 7)
  c.rect(1, 1, 5, 5, neon(P) ? '#0b0f18' : OUT); c.rect(2, 2, 3, 3, f ? mix(P.packet, '#ffffff', 0.5) : P.packet)
  if (neon(P)) { c.set(3, 0, '#7cf28c80'); c.set(3, 6, '#7cf28c80'); c.set(0, 3, '#7cf28c80'); c.set(6, 3, '#7cf28c80') }
  return neon(P) ? unlit(c) : { pix: c }
}
function cablePiece(P, kind) {
  const c = new Pix(8, 8), [c0, c1, c2] = P.cable
  const h = (x0, x1) => { for (let x = x0; x <= x1; x++) { c.set(x, 2, c1); c.set(x, 3, c0); c.set(x, 4, c2) } }
  const v = (y0, y1) => { for (let y = y0; y <= y1; y++) { c.set(2, y, c1); c.set(3, y, c0); c.set(4, y, c2) } }
  if (kind === 'h') h(0, 7); if (kind === 'v') v(0, 7)
  if (kind === 'ne') { v(0, 3); h(3, 7) } if (kind === 'nw') { v(0, 3); h(0, 3) } if (kind === 'se') { v(3, 7); h(3, 7) } if (kind === 'sw') { v(3, 7); h(0, 3) }
  if (kind === 'end') { h(0, 3); c.rect(4, 1, 3, 5, '#9aa5ad'); c.vline(4, 1, 5, '#c9d1d6'); c.set(7, 2, '#d0b44a'); c.set(7, 4, '#d0b44a') }
  return neon(P) ? { pix: c, emit: c } : { pix: c }
}
function activityFrame(P, f) {
  const c = new Pix(24, 14), col = neon(P) ? '#7cf28c' : '#3a6fb0'
  for (const [i, r] of [[0, 4], [1, 7], [2, 10]]) { if (i > f) continue; for (let a = -0.9; a <= 0.9; a += 0.12) c.set(Math.round(12 + Math.sin(a) * r), Math.round(13 - Math.cos(a) * r), col) }
  return unlit(c)
}
function cardFrame(P) {
  const c = new Pix(9, 9)
  if (neon(P)) { c.rect(1, 2, 7, 5, '#ffd36b'); c.hline(2, 6, 4, '#0f1b2e'); return unlit(c) }
  c.rect(1, 1, 7, 7, '#fff3a8'); c.set(4, 1, '#d94a4a'); c.hline(2, 5, 4, '#9aa5ad'); c.set(8, 3, '#fff3a8a0'); c.set(0, 5, '#fff3a8a0')
  return { pix: c }
}
function flashFrame(P, k) {
  const c = new Pix(16, 16), col = neon(P) ? '#5ef2ff' : '#ffffff'
  const r = 2 + k * 2.5
  for (let a = 0; a < 24; a++) { const ang = (a / 24) * Math.PI * 2; c.set(Math.round(8 + Math.cos(ang) * r), Math.round(8 + Math.sin(ang) * r), k === 2 ? col + '80' : col) }
  return unlit(c)
}
function sparkle(f) {
  const c = new Pix(9, 9), col = '#fff3a8'
  if (f === 0) { c.vline(4, 1, 7, col); c.hline(1, 7, 4, col); c.set(4, 4, '#ffffff') } else { c.vline(4, 2, 6, col); c.hline(2, 6, 4, col); c.set(3, 3, col); c.set(5, 5, col); c.set(3, 5, col); c.set(5, 3, col); c.set(4, 4, '#ffffff') }
  return unlit(c)
}
const GLOW_COLORS = { cyan: [0.37, 0.95, 1], magenta: [1, 0.35, 0.8], amber: [1, 0.75, 0.25], green: [0.45, 1, 0.55], white: [1, 1, 1], warm: [1, 0.85, 0.55], red: [1, 0.35, 0.35] }
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)
/** Dithered radial glow with alpha, for additive ('lighter') drawing. */
function glowFrame(color, size) {
  const c = new Pix(size, size), [r, g, b] = GLOW_COLORS[color], R = size / 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = ((x + 0.5 - R) ** 2 + (y + 0.5 - R) ** 2) / (R * R)
    if (d >= 1) continue
    const f = (1 - d) ** 2, q = Math.floor(f * 6 + BAYER[(y & 3) * 4 + (x & 3)]) / 6
    if (q <= 0) continue
    c.d.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(q * 200)], (y * size + x) * 4)
  }
  return { pix: c }
}

export function buildEffects(P) {
  const out = []
  const states = {}
  for (const who of ['agent', 'user']) for (let i = 0; i < 16; i++) states[`${who}:${i}`] = S([carrier(P, (i / 16) * Math.PI * 2, who === 'user')])
  for (let i = 0; i < 16; i++) states[`boss:${i}`] = S([bossEnvelope(P, (i / 16) * Math.PI * 2)])
  out.push(fx('effect.carrier', { x: 12, y: 12 }, states))
  out.push(fx('effect.trail', { x: 2, y: 2 }, { agent: S([unlit(dot(neon(P) ? P.link : '#fffaf0', 2))]), user: S([unlit(dot(P.user, 2))]), attempt: S([unlit(dot(P.attempt, 2))]) }))
  out.push(fx('effect.link.dot', { x: 2, y: 2 }, { agent: S([unlit(dot('#ffffff', 3, neon(P) ? P.link : mix(P.link, '#ffffff', 0.5)))]), user: S([unlit(dot('#ffffff', 3, P.user))]), machine: S([unlit(dot('#ffffff', 3, P.cable[0]))]) }))
  out.push(fx('effect.arrival', { x: 20, y: 14 }, { default: S([0, 0.33, 0.66, 1].map((k) => arrivalFrame(P, k)), [60, 60, 60, 60], false) }))
  out.push(fx('effect.note', { x: 5, y: 5 }, { agent: S([noteFrame(P, false)]), user: S([noteFrame(P, true)]) }))
  out.push(fx('effect.attempt', { x: 12, y: 12 }, { fall: S([0, 1, 2, 3].map((k) => fallFrame(P, k)), [125, 125, 125, 125], false) }))
  out.push(fx('effect.crumple', { x: 8, y: 18 }, { default: S([crumple(P)]) }))
  out.push(fx('effect.spark', { x: 8, y: 8 }, { default: S([0, 1, 2].map((k) => sparkFrame(P, k)), [120, 120, 160], false) }))
  out.push(fx('effect.confetti', { x: 28, y: 24 }, { default: S([0.1, 0.25, 0.4, 0.55, 0.72, 0.9].map((t) => confettiFrame(P, t)), [150, 150, 150, 150, 150, 150], false) }))
  out.push(fx('effect.bubble', { x: 7, y: 17 }, { '?': S([bubbleFrame(P, '?', 0), bubbleFrame(P, '?', 1)], [440, 440], true), '!': S([bubbleFrame(P, '!', 0), bubbleFrame(P, '!', 1)], [150, 150], true), ok: S([bubbleFrame(P, 'ok', 0), bubbleFrame(P, 'ok', 1)], [600, 600], true) }))
  out.push(fx('effect.status', { x: 0, y: 0 }, {
    working: S([0, 1, 2, 3].map((k) => statusFrame(P, 'working', k)), [120, 120, 120, 120], true),
    blocked: S([statusFrame(P, 'blocked', 0), (() => { const c = new Pix(5, 5); O.statusMark(P, c, 0, 0, 'blocked', 0); for (let i = 0; i < c.d.length; i += 4) c.d[i + 3] = c.d[i + 3] ? 140 : 0; return unlit(c) })()], [500, 500], true),
    idle: S([statusFrame(P, 'idle', 0)]), done: S([statusFrame(P, 'done', 0)]), unknown: S([statusFrame(P, 'unknown', 0)])
  }))
  out.push(fx('effect.plaque', { x: 0, y: 0 }, Object.fromEntries(['default', 'blocked', 'lead', 'you'].map((v) => [v, S([plaqueSlice(P, v)])]))))
  out.push(fx('effect.plaque.pointer', { x: 1, y: 0 }, Object.fromEntries(['default', 'blocked', 'lead', 'you'].flatMap((v) => [[`down:${v}`, S([pointer(P, v, 'down')])], [`up:${v}`, S([pointer(P, v, 'up')])]]))))
  { const c = new Pix(3, 2); c.set(1, 1, '#f2c230'); c.set(0, 0, '#f2c230'); c.set(2, 0, '#f2c230'); c.set(1, 0, '#fff3a8'); out.push(fx('effect.star', { x: 1, y: 2 }, { default: S([unlit(c)]) })) }
  out.push(fx('effect.label', { x: 0, y: 0 }, { dark: S([labelSlice(P, 'dark')]), light: S([labelSlice(P, 'light')]), warn: S([labelSlice(P, 'warn')]) }))
  out.push(fx('effect.select', { x: 18, y: 54 }, { default: S([selectFrame(P, 0), selectFrame(P, 1)], [500, 500], true) }))
  out.push(fx('effect.steam', { x: 4, y: 12 }, { default: S([0, 1, 2].map(steamFrame), [300, 300, 300], true) }))
  out.push(fx('effect.packet', { x: 3, y: 3 }, { default: S([packetFrame(P, 0), packetFrame(P, 1)], [200, 200], true) }))
  out.push(fx('effect.cable', { x: 0, y: 0 }, Object.fromEntries(['h', 'v', 'ne', 'nw', 'se', 'sw', 'end'].map((k) => [k, S([cablePiece(P, k)])])), { layers: ['floor-shade'] }))
  out.push(fx('effect.activity', { x: 12, y: 14 }, { default: S([0, 1, 2].map((f) => activityFrame(P, f)), [200, 200, 200], true) }))
  out.push(fx('effect.card', { x: 4, y: 4 }, { default: S([cardFrame(P)]) }))
  out.push(fx('effect.flash', { x: 8, y: 8 }, { default: S([0, 1, 2].map((k) => flashFrame(P, k)), [130, 130, 140], false) }))
  out.push(fx('effect.sparkle', { x: 4, y: 4 }, { default: S([sparkle(0), sparkle(1)], [300, 300], true) }))
  { const st = {}; for (const col of Object.keys(GLOW_COLORS)) for (const [n, size] of [['s', 16], ['m', 32], ['l', 64]]) st[`${col}:${n}`] = S([glowFrame(col, size)]); out.push(fx('effect.glow', { x: 0, y: 0 }, st)) }
  for (const it of out) if (it.id === 'effect.glow') for (const [k, s] of Object.entries(it.states)) { const sz = s.frames[0].pix.w; it.states[k].anchor = { x: sz / 2, y: sz / 2 } }
  for (const it of out) if (it.id === 'effect.cable') it.layers = ['floor-shade']
  return out
}

/** Font atlas: one row per colour; manifest gets glyph rects. */
export function buildFont(P) {
  const chars = Object.keys(GLYPHS)
  const colors = { ink: P.plaque.text, light: '#fffaf0', sign: P.sign.text, warn: P.status.blocked, dim: neon(P) ? '#7f8aa0' : '#9a8a74' }
  const widths = chars.map((ch) => GLYPHS[ch][0].length)
  const W = widths.reduce((a, w) => a + w + 1, 1), H = Object.keys(colors).length * 7 + 1
  const pix = new Pix(W, H)
  const glyphs = {}
  let x = 1
  chars.forEach((ch, i) => { glyphs[ch] = { x, y: 1, w: widths[i] }; x += widths[i] + 1 })
  Object.values(colors).forEach((col, row) => chars.forEach((ch) => { const g = glyphs[ch]; GLYPHS[ch].forEach((r, j) => [...r].forEach((p, k) => { if (p === '#') pix.set(g.x + k, 1 + row * 7 + j, col) })) }))
  for (const [cyr, lat] of Object.entries(SAME)) glyphs[cyr] = glyphs[lat]
  for (const [ch, base] of Object.entries(FOLD)) glyphs[ch] = glyphs[base]
  const rows = Object.fromEntries(Object.keys(colors).map((k, i) => [k, i * 7]))
  return { pix, meta: { atlas: 'font', height: 5, spacing: 1, space: 2, colors: rows, glyphs, fallback: '?' } }
}
