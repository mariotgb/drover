// Effects: envelope, badges, attempt marker, cable pieces, sparkle, selection ring.
import { Pix, mix } from './canvas.mjs'

const OUT = '#2b1d1b'

function envelope(frame) {
  const c = new Pix(16, 16)
  const tilt = [0, -1, 0, 1][frame], y = 4 + [0, -1, 0, 1][(frame + 1) % 4]
  // Body with a slight wobble: rows shift by the tilt at the edges.
  for (let j = 0; j < 8; j++) for (let i = 0; i < 12; i++) {
    const dy = Math.round((i - 5.5) / 6 * tilt)
    c.set(2 + i, y + j + dy, j === 0 ? '#ffffff' : '#fdf6e6')
  }
  for (let i = 0; i < 6; i++) { const dy = Math.round((i - 5.5) / 6 * tilt); c.set(2 + i, y + 1 + Math.floor(i * 0.8) + dy, '#e2cfa6'); c.set(13 - i, y + 1 + Math.floor(i * 0.8) + Math.round((6.5 - i) / 6 * tilt), '#e2cfa6') }
  c.rect(7, y + 4 + Math.round(tilt * 0.1), 2, 2, '#c0392b')
  c.outline(OUT, 0.6)
  return c
}

function badge(kind, frame) {
  const c = new Pix(16, 16)
  const y = frame ? 0 : 1
  const fill = { question: '#fffaf0', alert: '#f7d24a', error: '#e2574c' }[kind]
  c.round(2, y, 12, 11, 3, fill)
  c.set(6, y + 11, fill); c.set(5, y + 12, fill); c.set(7, y + 11, fill)
  const glyph = {
    question: [['.xxx.', 'x...x', '...x.', '..x..', '.....', '..x..'], '#c0392b'],
    alert: [['.x.', '.x.', '.x.', '.x.', '...', '.x.'], '#5a3a10'],
    error: [['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'], '#ffffff']
  }[kind]
  c.stamp(kind === 'alert' ? 6 : 5, y + (kind === 'error' ? 3 : 2), glyph[0], { x: glyph[1] })
  if (kind === 'alert') c.stamp(7, y + 2, ['x', 'x', 'x', 'x', '.', 'x'], { x: glyph[1] })
  c.outline(OUT, 0.6)
  return c
}

function attempt(frame) {
  const c = new Pix(16, 16)
  const col = frame ? '#e8dcc4' : '#c9b48a'
  for (let i = 2; i <= 13; i++) if ((i + frame) % 3 !== 0) { c.set(i, 4, col); c.set(i, 11, col) }
  for (let j = 4; j <= 11; j++) if ((j + frame) % 3 !== 0) { c.set(2, j, col); c.set(13, j, col) }
  c.line(3, 5, 7, 8, col); c.line(12, 5, 8, 8, col)
  for (const x of [5, 8, 11]) c.set(x, 14, frame && x === 8 ? '#ffffff' : '#c9b48a')
  return c
}

function dash() {
  const c = new Pix(4, 4)
  c.rect(1, 1, 2, 2, '#e8dcc4'); c.set(1, 1, '#ffffff')
  return c
}

function cable(kind) {
  const c = new Pix(8, 8)
  const col = '#3a6fb0', hi = '#5a8fd0', lo = '#2a4f80'
  if (kind === 'h') { c.hline(0, 7, 3, hi); c.hline(0, 7, 4, col); c.hline(0, 7, 5, lo) }
  else if (kind === 'v') { c.vline(3, 0, 7, hi); c.vline(4, 0, 7, col); c.vline(5, 0, 7, lo) }
  else { c.hline(0, 2, 3, hi); c.hline(0, 2, 4, col); c.rect(3, 2, 3, 5, '#9aa5ad'); c.vline(3, 2, 6, '#c9d1d6'); c.set(6, 3, '#d0b44a'); c.set(6, 5, '#d0b44a') }
  return c
}

function sparkle(frame) {
  const c = new Pix(16, 16)
  const stars = [[[8, 8, 3]], [[5, 6, 2], [11, 9, 3]], [[8, 4, 2], [4, 11, 1], [12, 12, 2]]][frame]
  for (const [x, y, r] of stars) {
    c.hline(x - r, x + r, y, '#ffe27a'); c.vline(x, y - r, y + r, '#ffe27a'); c.set(x, y, '#ffffff')
    if (r > 1) { c.set(x - 1, y - 1, '#fff3b0'); c.set(x + 1, y + 1, '#fff3b0'); c.set(x + 1, y - 1, '#fff3b0'); c.set(x - 1, y + 1, '#fff3b0') }
  }
  return c
}

function selection(frame) {
  const c = new Pix(32, 12)
  const col = frame ? '#ffe27a' : '#f2c230'
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * Math.PI * 2
    const x = Math.round(16 + Math.cos(t) * (13 + frame)), y = Math.round(6 + Math.sin(t) * (4 + (frame ? 0.5 : 0)))
    c.set(x, y, col)
  }
  for (let a = 0; a < 64; a += 8) c.set(Math.round(16 + Math.cos((a / 64) * Math.PI * 2) * 13), Math.round(6 + Math.sin((a / 64) * Math.PI * 2) * 4), mix(col, '#ffffff', 0.6))
  return c
}

export function buildEffects() {
  const e = (id, frames, durations, anchor, loop = true) => ({ id, frames, durations, loop, anchor, layers: ['effect'] })
  return [
    e('effect.envelope', [0, 1, 2, 3].map(envelope), [110, 110, 110, 110], { x: 8, y: 8 }),
    e('effect.question', [badge('question', 0), badge('question', 1)], [420, 420], { x: 8, y: 16 }),
    e('effect.alert', [badge('alert', 0), badge('alert', 1)], [420, 420], { x: 8, y: 16 }),
    e('effect.error', [badge('error', 0), badge('error', 1)], [420, 420], { x: 8, y: 16 }),
    e('effect.attempt', [attempt(0), attempt(1)], [500, 500], { x: 8, y: 8 }),
    e('effect.dash', [dash()], [1000], { x: 2, y: 2 }, false),
    e('effect.cable.h', [cable('h')], [1000], { x: 0, y: 4 }, false),
    e('effect.cable.v', [cable('v')], [1000], { x: 4, y: 0 }, false),
    e('effect.cable.plug', [cable('plug')], [1000], { x: 0, y: 4 }, false),
    e('effect.sparkle', [0, 1, 2].map(sparkle), [160, 160, 220], { x: 8, y: 8 }),
    e('effect.select', [selection(0), selection(1)], [500, 500], { x: 16, y: 6 })
  ]
}
