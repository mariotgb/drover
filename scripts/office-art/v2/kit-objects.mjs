// v2 objects: desks, monitors, chairs, lounge, lobby, server room, outdoors, wall decor, pets.
// Objects are anchored bottom-centre on the floor. Monitors share the anchor of their bench
// column (frames carry transparent space below), so the engine draws them right after it.
import { Pix, mix, rng } from '../canvas.mjs'
import * as Pr from './props.mjs'
import { rug as rugDraw } from './themes.mjs'
import { S } from './kit-tiles.mjs'

const OUT = '#2b1d1b'
const neon = (P) => P.id === 'neon'
const obj = (id, layers, anchor, states, extra = {}) => ({ id, atlas: 'furniture', layers, anchor, states, ...extra })
const fromSp = (s) => ({ pix: s.pix, emit: s.emit })
/** Re-anchor a props sprite into the item's anchor (they already are bottom-centre). */
const spAnchor = (s) => ({ x: s.ax, y: s.ay })

/** Bench column geometry relative to the column anchor (bottom of the front panel, column centre). */
export const BENCH_SLOTS = {
  agentNorth: { x: 3, y: -28 }, chairNorth: { x: 3, y: -29 },
  agentSouth: { x: -6, y: 8 }, chairSouth: { x: -6, y: 11 }, chairSouthIn: { x: -6, y: 4 },
  plaqueNorth: { x: 3, y: -76 }, plaqueSouth: { x: -6, y: 14 },
  bubbleNorth: { x: 3, y: -77 }, bubbleSouth: { x: -6, y: -32 },
  headNorth: { x: 3, y: -67 }, headSouth: { x: -6, y: -30 },
  handNorth: { x: 15, y: -58 }, handSouth: { x: 4, y: -24 },
  landNorth: { x: 6, y: -32 }, landSouth: { x: 12, y: -18 },
  cableNorth: { x: 14, y: -6 }, cableSouth: { x: 10, y: 4 }
}

function benchCol(P, pos, clutter) {
  const W = 52, H = 52, oy = 14, D = P.desk
  const c = new Pix(W, H), e = new Pix(W, H)
  const x0 = pos === 'left' || pos === 'single' ? 2 : 0, x1 = pos === 'right' || pos === 'single' ? 49 : 51
  const cx0 = 2
  c.rect(x0, oy, x1 - x0 + 1, 12, D.top); c.hline(x0, x1, oy, D.hi); c.hline(x0, x1, oy + 11, D.lo)
  c.rect(Math.max(0, x0 - 1), oy + 12, x1 - x0 + 1 + (x0 ? 2 : 1), 2, P.divider[2]); c.hline(Math.max(0, x0 - 1), Math.min(W - 1, x1 + 1), oy + 12, P.divider[0])
  c.rect(x0, oy + 14, x1 - x0 + 1, 12, D.top); c.hline(x0, x1, oy + 14, D.hi); c.hline(x0, x1, oy + 25, D.lo)
  c.rect(x0, oy + 26, x1 - x0 + 1, 10, D.front); c.hline(x0, x1, oy + 26, mix(D.front, '#ffffff', 0.18)); c.hline(x0, x1, oy + 35, D.frontLo)
  if (neon(P)) { c.hline(x0, x1, oy + 27, D.trim); e.hline(x0, x1, oy + 27, '#5ef2ff') }
  if (!neon(P)) for (let i = cx0 + 4; i < cx0 + 44; i += 9) { c.hline(i, i + 3, oy + 4 + (i % 5), mix(D.top, D.lo, 0.45)); c.hline(i + 2, i + 5, oy + 18 + (i % 4), mix(D.top, D.lo, 0.45)) }
  if (pos === 'left' || pos === 'single') c.vline(x0, oy + 26, oy + 35, D.frontLo)
  c.vline(cx0 + 47, oy + 26, oy + 35, D.frontLo)
  if (!neon(P)) { c.rect(cx0 + 30, oy + 28, 14, 6, mix(D.front, D.frontLo, 0.5)); c.rect(cx0 + 31, oy + 29, 12, 4, D.front); c.rect(cx0 + 35, oy + 30, 4, 1, D.trim) }
  else { c.rect(cx0 + 3, oy + 29, 3, 6, D.leg); c.rect(cx0 + 42, oy + 29, 3, 6, D.leg) }
  // north keyboard (faces the north agent), south keyboard + mouse
  c.rect(cx0 + 18, oy + 2, 14, 3, P.monitor.lo); c.hline(cx0 + 18, cx0 + 31, oy + 2, P.monitor.hi)
  c.rect(cx0 + 22, oy + 20, 16, 4, P.monitor.lo); c.hline(cx0 + 22, cx0 + 37, oy + 20, P.monitor.hi)
  for (let i = cx0 + 23; i < cx0 + 37; i += 2) { const k = neon(P) ? ['#ff7ad9', '#5ef2ff', '#7cf28c'][i % 3] : '#9aa5ad'; c.set(i, oy + 22, k); if (neon(P)) e.set(i, oy + 22, k) }
  c.rect(cx0 + 41, oy + 21, 2, 3, '#e8eef2')
  if (clutter === 0) { c.rect(cx0 + 4, oy + 17, 5, 6, '#f6efe3'); c.hline(cx0 + 4, cx0 + 8, oy + 17, '#7a4a32'); c.set(cx0 + 9, oy + 19, '#d8cbb5') }
  if (clutter === 1) { c.rect(cx0 + 5, oy + 16, 11, 7, '#fffaf0'); c.rect(cx0 + 4, oy + 15, 11, 7, '#ffffff'); c.hline(cx0 + 5, cx0 + 12, oy + 17, '#a9b3bb'); c.hline(cx0 + 5, cx0 + 10, oy + 19, '#a9b3bb') }
  if (clutter === 2 && !neon(P)) { c.ellipse(cx0 + 8, oy + 15, 4, 3, '#5f9e3f'); c.ellipse(cx0 + 7, oy + 14, 2, 2, '#7fbf4d'); c.rect(cx0 + 6, oy + 18, 5, 4, '#c46a3d') }
  if (clutter === 2 && neon(P)) { c.rect(cx0 + 5, oy + 15, 6, 8, '#2a2f3a'); c.rect(cx0 + 6, oy + 16, 4, 2, '#ff7ad9'); e.rect(cx0 + 6, oy + 16, 4, 2, '#ff7ad9') }
  if (clutter === 3) { c.rect(cx0 + 3, oy + 4, 8, 6, neon(P) ? '#2a2f3a' : '#c9d1d6'); c.rect(cx0 + 4, oy + 5, 6, 3, neon(P) ? '#7c5cff' : '#9fd4f2') }
  if (!neon(P) && clutter % 2 === 0) { c.ellipse(cx0 + 44, oy + 10, 3, 3, '#4f9a3a'); c.ellipse(cx0 + 43, oy + 9, 2, 2, '#7fbf4d'); c.rect(cx0 + 42, oy + 12, 4, 2, '#c46a3d') }
  c.outline(OUT, 0.5)
  for (let x = x0; x <= x1; x++) for (const dy of [0, 1]) if (!c.alpha(x, 50 + dy)) c.set(x, 50 + dy, dy ? '#1a122020' : '#1a122038')
  return { pix: c, emit: neon(P) ? e : undefined }
}

function screen(P, c, e, x, y, w, h, mode, frame, seed) {
  const bg = mode === 'off' ? '#141a22' : mode === 'term' ? '#0c1410' : mode === 'done' ? '#0f2a1c' : '#13243a'
  c.rect(x, y, w, h, bg); if (mode !== 'off') e.rect(x, y, w, h, bg)
  if (mode === 'off') { c.set(x + 1, y + 1, '#2c3644'); c.line(x + 2, y + h - 2, x + 5, y + h - 5, '#232c38'); return }
  if (mode === 'done') { const cx = x + (w >> 1), cy = y + (h >> 1); for (const [dx, dy] of [[-3, 0], [-2, 1], [-1, 2], [0, 1], [1, 0], [2, -1], [3, -2]]) { e.set(cx + dx, cy + dy, '#3ecf7a'); c.set(cx + dx, cy + dy, '#3ecf7a') } return }
  const r = rng(seed * 97 + 3)
  const palette = mode === 'term' ? ['#7cf28c', '#4fcf6a', '#c4ffd0'] : ['#8fe3ff', '#c9b6ff', '#7cf28c', '#ffd36b', '#ff9aa8']
  const lines = []
  for (let j = 0; j < h + 8; j += 2) { const segs = []; let i = 1 + Math.floor(r() * 3); const end = 1 + Math.floor(r() * (w - 3)) + 2; while (i < Math.min(end, w - 1)) { const len = 1 + Math.floor(r() * 4); segs.push([i, len, palette[Math.floor(r() * palette.length)]]); i += len + 1 } lines.push(segs) }
  const shift = mode === 'code' ? frame : 0
  for (let j = 1, n = shift; j < h - 1; j += 2, n++) for (const [i, len, col] of lines[n % lines.length]) for (let k = 0; k < len && i + k < w - 1; k++) { c.set(x + i + k, y + j, col); e.set(x + i + k, y + j, col) }
  if (mode === 'term' && frame === 0) { const ly = y + h - 3; e.rect(x + 3, ly, 2, 2, '#c4ffd0'); c.rect(x + 3, ly, 2, 2, '#c4ffd0') }
  if (mode === 'ask' && frame === 0) { e.rect(x + w - 5, y + 1, 4, 4, '#f5b83d'); c.rect(x + w - 5, y + 1, 4, 4, '#f5b83d'); e.set(x + w - 3, y + 2, '#2b1d1b') }
}
function monitorFront(P, mode, frame) {
  const W = neon(P) ? 32 : 26, H = 40
  const c = new Pix(W, H), e = new Pix(W, H), M = P.monitor
  if (neon(P)) {
    for (const mx of [1, 17]) { c.rect(mx, 1, 14, 13, M.case); c.hline(mx, mx + 13, 1, M.hi); screen(P, c, e, mx + 1, 2, 12, 10, mode, frame, mx * 7 + (mode === 'code' ? 0 : 3)) }
    c.rect(14, 14, 4, 3, M.lo)
  } else {
    c.rect(2, 1, 22, 15, M.case); c.hline(2, 23, 1, M.hi); c.hline(2, 23, 15, M.lo)
    screen(P, c, e, 4, 3, 18, 11, mode, frame, 11)
    c.rect(11, 16, 4, 2, M.lo); c.rect(8, 18, 10, 1, M.lo)
  }
  c.outline(OUT, 0.5)
  return { pix: c, emit: e }
}
function monitorBack(P, on) {
  const c = new Pix(20, 38), e = new Pix(20, 38), M = P.monitor
  c.rect(1, 1, 18, 11, M.case); c.hline(1, 18, 1, M.hi); c.vline(1, 1, 11, M.hi); c.hline(1, 18, 11, M.lo)
  c.rect(8, 12, 4, 2, M.lo)
  if (on) { c.set(16, 9, '#7cf28c'); e.set(16, 9, '#7cf28c') }
  c.outline(OUT, 0.5)
  return { pix: c, emit: on ? e : undefined }
}

function sway(s, potTop) {
  const c = new Pix(s.pix.w, s.pix.h)
  for (let y = 0; y < s.pix.h; y++) for (let x = 0; x < s.pix.w; x++) {
    const p = s.pix.get(x, y)
    if (!p[3]) continue
    const dx = y < potTop - 6 ? 1 : 0
    c.set(x + dx, y, p)
  }
  return c
}
function clockFrame(P, hour, minute) { const c = new Pix(13, 13); Pr.clock(P, c, 6, 6, hour, minute); return c }
function windowFrame(P, time) {
  const c = new Pix(38, 30), e = new Pix(38, 30), x = 5, y = 4, w = 28, h = 22
  const sky = neon(P)
    ? { day: ['#6c8fd8', '#a9c3f0'], evening: ['#3a2a6a', '#c46a8a'], night: ['#0e1428', '#1a2240'] }[time]
    : { day: ['#8fd0f5', '#d6f0ff'], evening: ['#f2a65a', '#ffd9a0'], night: ['#1d2a50', '#3a4a7a'] }[time]
  for (let j = 0; j < h; j++) c.hline(x, x + w - 1, y + j, mix(sky[0], sky[1], j / h))
  if (neon(P) || time === 'night') {
    for (let i = 0; i < w; i += 5) { const bh = 6 + ((i * 37) % 9); c.rect(x + i, y + h - bh, 4, bh, time === 'day' ? '#3a4a6a' : '#1a2240'); if (time !== 'day') for (let j = 1; j < bh; j += 2) if ((i + j) % 3) { c.set(x + i + 1, y + h - bh + j, '#ffd36b'); e.set(x + i + 1, y + h - bh + j, '#ffcf6b') } }
    if (time === 'night') { c.set(x + w - 6, y + 4, '#e8eefc'); c.set(x + w - 5, y + 4, '#e8eefc'); e.set(x + w - 6, y + 4, '#ffffff'); e.set(x + w - 5, y + 4, '#ffffff') }
  } else {
    c.round(x + 5, y + 5, 9, 4, 2, '#ffffff'); c.round(x + 8, y + 3, 6, 4, 2, '#ffffff')
    c.ellipse(x + w - 8, y + h - 3, 7, 3, time === 'evening' ? '#5a8a3f' : '#7fbf4d'); c.ellipse(x + 6, y + h - 2, 6, 3, '#5f9e3f')
    if (time === 'evening') c.ellipse(x + w - 7, y + 7, 3, 3, '#fff0b0')
  }
  const frame = neon(P) ? ['#1d2129', '#1d2129'] : ['#7a5236', '#9c6c47']
  c.rect(x - 2, y - 2, w + 4, 2, frame[0]); c.rect(x - 2, y + h, w + 4, 3, frame[1]); c.vline(x - 2, y, y + h - 1, frame[0]); c.vline(x - 1, y, y + h - 1, frame[1]); c.vline(x + w, y, y + h - 1, frame[1]); c.vline(x + w + 1, y, y + h - 1, frame[0])
  c.vline(x + w / 2, y, y + h - 1, frame[1]); if (!neon(P)) c.hline(x, x + w - 1, y + 10, frame[1])
  if (!neon(P)) for (const [cxx, d] of [[x - 4, 1], [x + w + 1, -1]]) for (let j = -3; j < h + 2; j++) { c.set(cxx, y + j, '#d97757'); c.set(cxx + d, y + j, j % 3 ? '#e8957a' : '#b55a3e'); c.set(cxx + 2 * d, y + j, '#c4664a') }
  if (!neon(P)) c.hline(x - 5, x + w + 4, y - 3, '#5b3d2a')
  else c.line(x + 3, y + h - 3, x + 9, y + 3, '#5ef2ff40')
  return { pix: c, emit: neon(P) || time === 'night' ? e : undefined }
}
function boardBase(P) {
  const c = new Pix(56, 30), e = new Pix(56, 30), x = 3, y = 3, w = 50, h = 24
  if (neon(P)) {
    c.rect(x - 1, y - 1, w + 2, h + 2, '#0b0e14'); c.rect(x, y, w, h, '#0f1b2e'); e.rect(x, y, w, h, '#0f1b2e')
    const cols = ['#60a5fa', '#f5b83d', '#3ecf7a']
    for (let k = 0; k < 3; k++) { const cx = x + 2 + k * 16; c.hline(cx, cx + 13, y + 2, cols[k]); e.hline(cx, cx + 13, y + 2, cols[k]) }
    c.rect(x + 22, y + h + 1, 6, 2, '#1d2129')
  } else {
    c.rect(x - 2, y - 2, w + 4, h + 4, '#7a5236'); c.rect(x - 1, y - 1, w + 2, h + 2, '#9c6c47')
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) c.set(x + i, y + j, (i * 3 + j * 5) % 7 === 0 ? '#b88a58' : '#c99a66')
    const head = ['#7fb3e0', '#f2c230', '#7fcf8a']
    for (let k = 0; k < 3; k++) c.rect(x + 2 + k * 16, y + 1, 14, 3, head[k])
  }
  return { pix: c, emit: neon(P) ? e : undefined }
}
function boardNote(P, v) {
  if (neon(P)) { const c = new Pix(12, 3), e = new Pix(12, 3); const col = ['#60a5fa', '#f5b83d', '#3ecf7a', '#c9b6ff'][v]; c.rect(0, 0, 12, 3, mix(col, '#0f1b2e', 0.55)); c.hline(1, 6, 1, '#dffbff'); e.rect(0, 0, 12, 3, mix(col, '#0f1b2e', 0.55)); e.hline(1, 6, 1, '#dffbff'); return { pix: c, emit: e } }
  const c = new Pix(6, 6), col = ['#fff3a8', '#ffd0dc', '#c9f0d0', '#cfe6ff'][v]
  c.rect(0, 0, 6, 6, col); c.set(2, 0, '#d94a4a'); c.hline(1, 4, 3, '#9aa5ad')
  return { pix: c }
}
function signSlice(P, scale) {
  const h = 5 * scale + 6, W = 15, c = new Pix(W, h + 3), y = 3
  if (neon(P)) { c.rect(0, y, W, h, P.sign.fill); c.hline(0, W - 1, y, P.sign.edge); c.hline(0, W - 1, y + h - 1, P.sign.edge); return c }
  c.line(3, 0, 6, y, '#5b3d2a'); c.line(W - 4, 0, W - 7, y, '#5b3d2a')
  c.round(0, y, W, h, 2, P.sign.edge); c.round(1, y + 1, W - 2, h - 2, 1, P.sign.fill); c.hline(2, W - 3, y + 1, mix(P.sign.fill, '#ffffff', 0.25))
  return c
}
function directory(P) {
  const c = new Pix(56, 34), x = 3, y = 3, w = 50, h = 28
  if (neon(P)) { c.rect(x - 1, y - 1, w + 2, h + 2, '#0b0e14'); c.rect(x, y, w, h, '#0f1b2e'); c.hline(x + 2, x + w - 3, y + 6, '#5ef2ff'); for (let k = 0; k < 3; k++) c.hline(x + 2, x + w - 3, y + 13 + k * 6, '#1d2a44'); const e = new Pix(56, 34); e.blit(c, 0, 0, 56, 34, 0, 0); return { pix: c, emit: e } }
  c.rect(x - 2, y - 2, w + 4, h + 4, '#7a5236'); c.rect(x - 1, y - 1, w + 2, h + 2, '#9c6c47'); c.rect(x, y, w, h, '#2f4a3a')
  c.hline(x + 2, x + w - 3, y + 6, '#e8d8b6'); for (let k = 0; k < 3; k++) c.hline(x + 2, x + w - 3, y + 13 + k * 6, '#3f5e4a')
  return { pix: c }
}
function doorway(P, kind) {
  const c = new Pix(36, 32)
  const tone = kind === 'hall' ? P.plank[0] : kind === 'server' ? P.raised[0] : P.parquet[0]
  for (let j = 0; j < 32; j++) for (let i = 2; i < 34; i++) c.set(i, j, mix(tone, '#000000', 0.25 + (j < 4 ? 0.2 : 0)))
  c.rect(0, 0, 2, 32, P.cap[2]); c.rect(34, 0, 2, 32, P.cap[2]); c.hline(0, 35, 0, P.cap[1])
  return c
}
function entrance(P) {
  const c = new Pix(36, 26), e = new Pix(36, 26)
  for (let j = 0; j < 24; j++) for (let i = 2; i < 34; i++) c.set(i, j, j % 6 === 0 ? P.path[3] : P.path[j % 12 < 6 ? 0 : 2])
  if (neon(P)) { for (let i = 2; i < 34; i++) for (const j of [5, 11, 17]) { c.set(i, j, '#5ef2ff'); e.set(i, j, '#3fb8c8') } }
  c.rect(0, 0, 2, 24, P.cap[2]); c.rect(34, 0, 2, 24, P.cap[2])
  for (let i = 0; i < 36; i++) c.set(i, 24, '#1a122040')
  return { pix: c, emit: neon(P) ? e : undefined }
}
function hedge(P) {
  const c = new Pix(16, 14), leaf = neon(P) ? ['#1f3a3a', '#2a4d4a', '#376560'] : ['#3f7a35', '#559a43', '#7fbf4d']
  for (let x = 0; x < 16; x++) for (let y = 2; y < 13; y++) c.set(x, y, leaf[0])
  for (let x = 0; x < 16; x += 4) { c.ellipse(x + 2, 4, 3, 2, leaf[1]); c.set(x + 1, 3, leaf[2]) }
  for (let x = 0; x < 16; x++) c.set(x, 13, '#1a122040')
  return c
}
function bellFrame(P, f) { const s = Pr.deskBell(P, f === 0 ? 1 : 0); if (f === 1) { const c = new Pix(s.pix.w, s.pix.h); c.blit(s.pix, 0, 0, s.pix.w, s.pix.h, 1, 0); return c } return s.pix }
function cat(P, pose, f) {
  const c = new Pix(18, 12), fur = neon(P) ? '#4a4a56' : '#e3954f', dark = neon(P) ? '#2e2e38' : '#b56a2e', light = neon(P) ? '#6a6a78' : '#f2b47a'
  if (pose === 'sleep') {
    c.ellipse(9, 8, 6, 3 + (f ? 0 : 0), fur); c.ellipse(9, 7 - f, 5, 2, light); c.ellipse(4, 7, 3, 3, fur)
    c.set(2, 4, fur); c.set(5, 4, fur); c.hline(3, 5, 7, dark); c.line(13, 9, 16, 7, fur); for (let x = 8; x < 14; x += 2) c.set(x, 6 - f, dark)
  } else if (pose === 'sit') {
    c.ellipse(9, 8, 4, 3, fur); c.rect(7, 2, 5, 5, fur); c.set(7, 1, fur); c.set(11, 1, fur); c.set(8, 4, '#2b1d1b'); c.set(10, 4, '#2b1d1b'); c.set(9, 5, '#d97757'); c.line(13, 10, 16, 7, fur)
  } else {
    const leg = [[0, 2], [1, 1], [2, 0], [1, 1]][f]
    c.rect(4, 4, 9, 4, fur); c.hline(4, 12, 4, light); c.rect(12, 2, 5, 4, fur); c.set(12, 1, fur); c.set(15, 1, fur); c.set(15, 3, '#2b1d1b'); c.set(16, 4, '#d97757')
    c.rect(5 + leg[0], 8, 1, 3, dark); c.rect(7 - leg[0], 8, 1, 3, fur); c.rect(10 + leg[1], 8, 1, 3, dark); c.rect(12 - leg[1], 8, 1, 3, fur)
    c.line(4, 5, 1, 2 + (f % 2), fur)
  }
  c.outline(OUT, 0.55)
  for (let x = 3; x < 15; x++) if (!c.alpha(x, 11)) c.set(x, 11, '#1a122030')
  return c
}
function robot(P, f, moving) {
  const c = new Pix(16, 9), e = new Pix(16, 9)
  c.ellipse(8, 5, 7, 3, neon(P) ? '#e9edf3' : '#d8dde1'); c.ellipse(8, 4, 5, 2, neon(P) ? '#c8ced8' : '#b8c0c8')
  const led = moving ? (f ? '#5ef2ff' : '#3fb8c8') : (f ? '#7cf28c' : '#2f6b3a')
  c.set(8, 4, led); e.set(8, 4, led)
  if (moving) { c.set(1 + f, 7, '#9aa5ad'); c.set(14 - f, 7, '#9aa5ad') }
  c.outline(OUT, 0.5)
  return { pix: c, emit: e }
}
function treeFrames(P, size, f) {
  const s = Pr.tree(P, size)
  if (!neon(P) || !f) return { pix: s.pix, emit: s.emit }
  const e = new Pix(s.emit.w, s.emit.h)
  let n = 0
  for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) if (s.emit.alpha(x, y)) { if (n++ % 2) e.set(x, y, '#ffe9a8'); else e.set(x, y, '#a88a40') }
  return { pix: s.pix, emit: e }
}

// ---- boss office
function bossDesk(P) {
  const W = 100, H = 50, c = new Pix(W, H), e = new Pix(W, H)
  const top = neon(P) ? ['#1d2129', '#3a4152', '#111419'] : ['#6a3424', '#8a4a32', '#4a2418']
  const trim = neon(P) ? '#ffd36b' : '#d9a441'
  c.rect(2, 12, W - 4, 14, top[0]); c.hline(2, W - 3, 12, top[1]); c.hline(2, W - 3, 25, top[2])
  c.rect(2, 26, W - 4, 20, neon(P) ? '#14171d' : '#5a2a1c'); c.hline(2, W - 3, 26, trim); c.hline(2, W - 3, 45, top[2])
  if (neon(P)) { e.hline(2, W - 3, 26, trim); e.hline(2, W - 3, 44, '#5ef2ff'); c.hline(2, W - 3, 44, '#5ef2ff') }
  for (const x of [8, W - 26]) { c.rect(x, 30, 18, 12, neon(P) ? '#1d2129' : '#6a3424'); c.rect(x + 7, 35, 4, 2, trim) }
  c.rect(W / 2 - 20, 30, 40, 10, neon(P) ? '#0f1b2e' : '#c9a24a'); c.hline(W / 2 - 20, W / 2 + 19, 30, neon(P) ? '#ffd36b' : '#f2d27a')
  for (const mx of [30, 52]) { c.rect(mx, 1, 20, 12, P.monitor.case); c.hline(mx, mx + 19, 1, P.monitor.hi); c.rect(mx + 8, 13, 4, 2, P.monitor.lo) }
  c.rect(6, 15, 12, 8, '#ffffff'); c.rect(7, 14, 12, 8, '#fffaf0'); c.hline(9, 15, 16, '#a9b3bb'); c.hline(9, 13, 18, '#a9b3bb')
  c.rect(84, 14, 4, 7, '#2a2f3a'); c.set(85, 13, '#c0392b'); c.set(86, 12, '#3a6fb0')
  c.outline(OUT, 0.5)
  for (let x = 4; x < W - 4; x++) for (const dy of [0, 1]) if (!c.alpha(x, 46 + dy)) c.set(x, 46 + dy, dy ? '#1a122020' : '#1a122038')
  return { pix: c, emit: neon(P) ? e : undefined }
}
function bossChair(P) {
  const c = new Pix(30, 36), col = neon(P) ? ['#3a2e4a', '#5a4874', '#271f33'] : ['#7a2e22', '#a8483a', '#5a2018']
  c.round(3, 0, 24, 26, 6, col[0]); c.round(6, 2, 18, 8, 3, col[1]); for (let y = 8; y < 24; y += 5) for (let x = 8; x < 24; x += 6) c.set(x, y, col[2])
  c.rect(0, 16, 5, 10, col[2]); c.rect(25, 16, 5, 10, col[2]); c.rect(13, 27, 4, 4, '#2a2f3a'); c.hline(6, 23, 31, '#2a2f3a')
  c.outline(OUT, 0.55)
  return { pix: c }
}
function flag(P, f) {
  const c = new Pix(22, 52)
  c.vline(4, 2, 46, '#9aa5ad'); c.vline(5, 2, 46, '#6b7280'); c.ellipse(4.5, 1, 1.5, 1.5, '#f2c230'); c.rect(1, 46, 8, 3, '#3d4450')
  const col = neon(P) ? ['#ff7ad9', '#5ef2ff'] : ['#c96442', '#f2c230']
  for (let y = 0; y < 14; y++) for (let x = 0; x < 15; x++) { const wy = y + Math.round(Math.sin((x + f * 3) / 3) * 1.2); c.set(6 + x, 4 + wy, y < 7 ? col[0] : mix(col[0], '#000000', 0.15)) }
  const cy = 9 + Math.round(Math.sin((7 + f * 3) / 3) * 1.2)
  c.hline(10, 16, cy + 1, col[1]); c.set(10, cy, col[1]); c.set(13, cy - 1, col[1]); c.set(16, cy, col[1])
  c.outline(OUT, 0.5)
  for (let x = 1; x < 9; x++) c.set(x, 49, '#1a122030')
  return neon(P) ? { pix: c, emit: (() => { const e = new Pix(22, 52); e.blit(c, 6, 3, 15, 16, 6, 3); return e })() } : { pix: c }
}
function trophy(P, f) {
  const c = new Pix(20, 36), e = new Pix(20, 36)
  c.rect(2, 22, 16, 13, neon(P) ? '#2a2f3a' : '#8f5a33'); c.hline(2, 17, 22, neon(P) ? '#3a4152' : '#a8703f')
  c.rect(6, 18, 8, 4, '#c9a24a'); c.rect(8, 14, 4, 4, '#d9a441')
  c.ellipse(10, 7, 6, 6, '#f2c230'); c.rect(4, 1, 13, 7, '#f2c230'); c.ellipse(10, 8, 4, 4, '#ffd36b'); c.vline(6, 2, 8, '#fff3a8')
  c.set(2, 4, '#f2c230'); c.set(1, 5, '#f2c230'); c.set(2, 7, '#f2c230'); c.set(18, 4, '#f2c230'); c.set(19, 5, '#f2c230'); c.set(18, 7, '#f2c230')
  if (f) { c.set(14, 2, '#ffffff'); c.set(15, 1, '#fff3a8'); c.set(13, 1, '#fff3a8'); e.set(14, 2, '#ffffff') }
  c.outline(OUT, 0.5)
  return { pix: c, emit: f ? e : undefined }
}
function phone(P, f) {
  const c = new Pix(14, 10), body = neon(P) ? '#2a2f3a' : '#3d4450'
  const dx = f === 1 ? 1 : 0
  c.rect(2 + dx, 4, 10, 5, body); c.rect(1 + dx, 2, 12, 3, neon(P) ? '#ff7ad9' : '#c0392b'); c.set(7 + dx, 6, '#e8eef2'); c.set(5 + dx, 6, '#e8eef2'); c.set(9 + dx, 6, '#e8eef2')
  if (f) { c.set(0, 1, '#f5b83d'); c.set(13, 1, '#f5b83d'); c.set(0, 4, '#f5b83d'); c.set(13, 4, '#f5b83d') }
  c.outline(OUT, 0.5)
  return { pix: c }
}
function bossRug(P) {
  const c = new Pix(128, 72)
  const col = neon(P) ? ['#1f2440', '#151a30', '#ffd36b', '#ff7ad9'] : ['#8a2e22', '#6a2018', '#d9a441', '#b5543f']
  for (let y = 0; y < 72; y++) for (let x = 0; x < 128; x++) {
    const e = Math.min(x, y, 127 - x, 71 - y)
    let k = e === 0 ? col[1] : e <= 3 ? col[2] : e === 4 ? col[1] : col[0]
    if (e > 6 && (Math.abs(x - 64) + Math.abs(y - 36) * 1.8) % 18 < 1.5) k = col[3]
    c.set(x, y, k)
  }
  return c
}

export function buildObjects(P) {
  const out = []
  const add = (it) => out.push(it)
  // ---- desks
  const benchStates = {}
  for (const pos of ['single', 'left', 'mid', 'right']) for (let k = 0; k < 4; k++) benchStates[`${pos}:${k}`] = S([benchCol(P, pos, k)])
  add(obj('object.bench.col', ['furniture'], { x: 26, y: 50 }, benchStates, { slots: BENCH_SLOTS }))
  const mf = (mode, n, d) => S(Array.from({ length: n }, (_, f) => monitorFront(P, mode, f)), Array(n).fill(d), n > 1)
  const glowK = neon(P) ? 0.85 : 0.18
  add(obj('object.monitor.front', ['furniture-top'], { x: neon(P) ? 6 : 4, y: 40 }, { code: mf('code', 3, 300), ask: mf('ask', 2, 500), term: mf('term', 2, 530), done: mf('done', 1, 1000), off: mf('off', 1, 1000) },
    { lights: [{ dx: 9, dy: -32, rx: neon(P) ? 22 : 16, ry: neon(P) ? 22 : 12, color: P.monitor.glow, k: glowK, states: ['code', 'ask', 'term', 'done'] }] }))
  add(obj('object.monitor.back', ['furniture-top'], { x: 18, y: 38 }, { on: S([monitorBack(P, true)]), off: S([monitorBack(P, false)]) },
    { lights: [{ dx: -8, dy: -30, rx: 16, ry: 10, color: P.monitor.glow, k: neon(P) ? 0.5 : 0.12, states: ['on'] }] }))
  const cf = Pr.chairFront(P), cfIn = Pr.chairFront(P, P.chair, true), cb = Pr.chairBack(P), cl = Pr.chairFront(P, P.leadChair)
  add(obj('object.chair.front', ['furniture-back'], spAnchor(cf), { out: S([cf.pix]), in: S([cfIn.pix]) }))
  add(obj('object.chair.back', ['furniture'], spAnchor(cb), { out: S([cb.pix]), in: S([cb.pix]) }))
  add(obj('object.chair.lead', ['furniture-back'], spAnchor(cl), { default: S([cl.pix]) }))
  const hdOn = Pr.headDesk(P, 'XXXXXXXX', 'code'), hdOff = Pr.headDesk(P, 'XXXXXXXX', 'off')
  add(obj('object.desk.head', ['furniture'], spAnchor(hdOn), { on: S([fromSp(hdOn)]), off: S([fromSp(hdOff)]) }, {
    lights: (hdOn.lights ?? []).map((l) => ({ ...l, states: ['on'] })),
    slots: { plaque: { x: hdOn.plaque.x - hdOn.ax, y: hdOn.plaque.y - hdOn.ay, width: hdOn.plaque.w, height: 9 }, agent: { x: 0, y: -24 }, chair: { x: 0, y: -25 }, plaqueAgent: { x: 0, y: -73 }, bubble: { x: 0, y: -74 }, head: { x: 0, y: -64 }, hand: { x: 12, y: -54 }, land: { x: 0, y: -26 } }
  }))
  const mt = Pr.meetingTable(P)
  add(obj('object.table.meeting', ['furniture'], spAnchor(mt), { default: S([fromSp(mt)]) }, { lights: mt.lights }))
  // ---- lounge
  const simple = (id, s, layers = ['furniture']) => add(obj(id, layers, spAnchor(s), { default: S([fromSp(s)]) }, s.lights?.length ? { lights: s.lights } : {}))
  simple('object.sofa', Pr.sofa(P, 52)); simple('object.sofa.small', Pr.sofa(P, 44)); simple('object.armchair', Pr.armchair(P))
  simple('object.table.coffee', Pr.coffeeTable(P, 26)); simple('object.bookshelf', Pr.bookshelf(P))
  for (const [k, pot] of [['big', 21], ['small', 8], ['monstera', 26]]) { const s = Pr.plant(P, k); add(obj(`object.plant.${k}`, ['furniture'], spAnchor(s), { default: S([s.pix, sway(s, pot)], [1200, 1200], true) })) }
  simple('object.coffee', Pr.coffeeMachine(P))
  { const s = Pr.cooler(P), b = new Pix(s.pix.w, s.pix.h); b.blit(s.pix, 0, 0, s.pix.w, s.pix.h, 0, 0); b.set(6, 3, '#ffffff'); b.set(7, 6, '#ffffff'); add(obj('object.cooler', ['furniture'], spAnchor(s), { default: S([s.pix, b], [1400, 1400], true) })) }
  simple('object.lamp.floor', Pr.floorLamp(P))
  { const cols = neon(P) ? [P.sofa[0], P.armchair[0], '#7c5cff'] : ['#d9a441', '#6f9a6a', '#b5543f']; const st = {}; ['a', 'b', 'c'].forEach((n, i) => { st[n] = S([Pr.beanbag(P, cols[i]).pix]) }); add(obj('object.beanbag', ['furniture'], { x: 10, y: 15 }, st)) }
  { const frames = [0, 1, 2].map((f) => { const s = Pr.arcade(P); if (f) { s.emit.rect(4, 11, 12, 9, '#0d1a2b'); s.emit.rect(6 + f * 3, 13, 3, 3, '#7cf28c'); s.emit.rect(13 - f * 2, 15, 3, 2, '#ff7ad9'); s.emit.hline(4, 15, 19, f === 1 ? '#ffd36b' : '#5ef2ff') } return fromSp(s) }); const a = Pr.arcade(P); add(obj('object.arcade', ['furniture'], spAnchor(a), { default: S(frames, [400, 400, 400], true) }, { lights: a.lights })) }
  simple('object.vending', Pr.vending(P)); simple('object.pingpong', Pr.pingpong(P))
  { const c = new Pix(112, 64); rugDraw(P, c, 0, 0, 112, 64, true); add(obj('object.rug.round', ['rug'], { x: 56, y: 64 }, { default: S([c]) })) }
  // ---- lobby
  simple('object.reception', Pr.reception(P))
  add(obj('object.bell', ['furniture'], { x: 7, y: 11 }, { idle: S([Pr.deskBell(P, 0).pix]), ring: S([bellFrame(P, 0), bellFrame(P, 1)], [150, 150], true) }))
  add(obj('object.directory', ['wall-decor'], { x: 28, y: 34 }, { default: S([directory(P)]) }, { slots: { title: { x: -23, y: -29, width: 46, height: 5 }, row0: { x: -23, y: -20, width: 46, height: 5 }, row1: { x: -23, y: -14, width: 46, height: 5 }, row2: { x: -23, y: -8, width: 46, height: 5 } } }))
  // ---- server room
  { const rk = (hot) => S([0, 1, 2].map((f) => fromSp(Pr.rack(P, f, hot))), [500, 500, 500], true); const r0 = Pr.rack(P, 0, false), r1 = Pr.rack(P, 0, true)
    add(obj('object.rack', ['furniture'], spAnchor(r0), { idle: rk(false), hot: rk(true) }, { lights: [{ ...r0.lights[0], states: ['idle'] }, { ...r1.lights[0], states: ['hot'] }] })) }
  { const m = Pr.machineStation(P, 'pc', 'code'); add(obj('object.machine', ['furniture'], spAnchor(m), { idle: S([0, 1, 2].map((f) => fromSp(Pr.machineStation(P, 'machine' + f, 'code'))), [600, 600, 600], true), active: S([0, 1].map((f) => fromSp(Pr.machineStation(P, 'term' + f, 'term'))), [300, 300], true) }, { lights: m.lights, slots: { label: { x: 0, y: 4 }, activity: { x: 0, y: -30 } } })) }
  // ---- outdoors
  for (const [k, size] of [['big', 1.15], ['small', 0.8]]) { const t0 = Pr.tree(P, size); add(obj(`object.tree.${k}`, ['furniture'], spAnchor(t0), { default: S([treeFrames(P, size, 0), treeFrames(P, size, 1)], [900, 900], true) }, t0.lights?.length ? { lights: t0.lights } : {})) }
  simple('object.bush', Pr.bush(P)); simple('object.flowerbed', Pr.flowerBed(P, 40)); simple('object.bench.park', Pr.parkBench(P)); simple('object.lamp.post', Pr.lampPost(P)); simple('object.bikes', Pr.bikeRack(P))
  add(obj('object.hedge', ['furniture'], { x: 8, y: 14 }, { default: S([hedge(P)]) }))
  // ---- wall decor
  add(obj('object.window', ['wall-decor'], { x: 19, y: 30 }, { day: S([windowFrame(P, 'day')]), evening: S([windowFrame(P, 'evening')]), night: S([windowFrame(P, 'night')]) }))
  add(obj('object.board', ['wall-decor'], { x: 28, y: 30 }, { default: S([boardBase(P)]) }, { slots: neon(P)
    ? { col0: { x: -24, y: -22 }, col1: { x: -8, y: -22 }, col2: { x: 8, y: -22 }, noteStepX: { x: 0, y: 0 }, noteStepY: { x: 0, y: 4 }, perColumn: { x: 5, y: 0 } }
    : { col0: { x: -24, y: -21 }, col1: { x: -8, y: -21 }, col2: { x: 8, y: -21 }, noteStepX: { x: 6, y: 0 }, noteStepY: { x: 0, y: 8 }, perColumn: { x: 4, y: 0 } } }))
  { const st = {}; for (let v = 0; v < 4; v++) st[String(v)] = S([boardNote(P, v)]); add(obj('object.board.note', ['wall-decor'], { x: 0, y: 0 }, st)) }
  add(obj('object.sign', ['wall-decor'], { x: 7, y: 0 }, { x1: S([signSlice(P, 1)]), x2: S([signSlice(P, 2)]) }))
  { const st = {}; for (let h = 0; h < 12; h++) for (const m of [0, 30]) st[`${h}:${m === 0 ? '00' : '30'}`] = S([clockFrame(P, h, m)]); add(obj('object.clock', ['wall-decor'], { x: 6, y: 13 }, st)) }
  { const st = {}; for (let v = 0; v < 2; v++) { const c = new Pix(14, 11); Pr.picture(P, c, 0, 0, v); st[String(v)] = S([c]) } add(obj('object.picture', ['wall-decor'], { x: 7, y: 11 }, st)) }
  { const c = new Pix(35, 22); Pr.whiteboard(P, c, 0, 0); add(obj('object.whiteboard', ['wall-decor'], { x: 17, y: 22 }, { default: S([c]) })) }
  add(obj('object.doorway', ['wall'], { x: 18, y: 32 }, { hall: S([doorway(P, 'hall')]), lobby: S([doorway(P, 'lobby')]), server: S([doorway(P, 'server')]) }))
  add(obj('object.entrance', ['wall'], { x: 18, y: 24 }, { default: S([entrance(P)]) }))
  // ---- boss office
  add(obj('object.desk.boss', ['furniture'], { x: 50, y: 46 }, { default: S([bossDesk(P)]) }, { slots: { plaque: { x: -20, y: -16, width: 40, height: 10 }, agent: { x: 0, y: -32 }, chair: { x: 0, y: -33 }, phone: { x: 28, y: -22 } }, lights: neon(P) ? [{ dx: 0, dy: -40, rx: 46, ry: 20, color: [0.45, 0.8, 1], k: 0.55 }] : [] }))
  add(obj('object.chair.boss', ['furniture-back'], { x: 15, y: 35 }, { default: S([bossChair(P)]) }))
  add(obj('object.flag', ['furniture'], { x: 5, y: 49 }, { default: S([flag(P, 0), flag(P, 1), flag(P, 2)], [400, 400, 400], true) }))
  add(obj('object.trophy', ['furniture'], { x: 10, y: 35 }, { default: S([trophy(P, 0), trophy(P, 1)], [1600, 300], true) }))
  add(obj('object.phone', ['furniture-top'], { x: 7, y: 9 }, { idle: S([phone(P, 0)]), ring: S([phone(P, 1), phone(P, 2)], [90, 90], true) }))
  add(obj('object.rug.boss', ['rug'], { x: 64, y: 72 }, { default: S([bossRug(P)]) }))
  // ---- pets (decorative only)
  add(obj('object.cat', ['furniture'], { x: 9, y: 11 }, { sleep: S([cat(P, 'sleep', 0), cat(P, 'sleep', 1)], [1000, 1000], true), sit: S([cat(P, 'sit', 0)]), 'walk:side': S([0, 1, 2, 3].map((f) => cat(P, 'walk', f)), [150, 150, 150, 150], true) }))
  add(obj('object.robot', ['furniture'], { x: 8, y: 8 }, { move: S([robot(P, 0, true), robot(P, 1, true)], [200, 200], true), charge: S([robot(P, 0, false), robot(P, 1, false)], [1000, 1000], true) }, { lights: [{ dx: 0, dy: -4, rx: 10, ry: 6, color: [0.4, 1, 1], k: neon(P) ? 0.5 : 0.1 }] }))
  return out
}
