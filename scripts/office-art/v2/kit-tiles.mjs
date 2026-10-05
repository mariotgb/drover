// v2 tiles: floors, ground, rugs, runner, walls, facade. Every tile repeats with a
// 16 px period so the engine can lay them on the grid in any order.
import { Pix, mix } from '../canvas.mjs'

export const S = (frames, durations, loop) => {
  const fr = frames.map((f) => (f instanceof Pix ? { pix: f } : f))
  return { frames: fr, durations: durations ?? fr.map(() => 1000), loop: loop ?? fr.length > 1 }
}
export const hash = (x, y, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const neon = (P) => P.id === 'neon'
const T16 = () => new Pix(16, 16)
const each = (c, f) => { for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const v = f(x, y); if (v) c.set(x, y, v) } }

function hall(P, v) {
  const c = T16()
  if (!neon(P)) {
    const seams = [[0, 6, 12, 3], [8, 14, 4, 11], [2, 9, 15, 6], [5, 12, 1, 9]][v]
    const tone = [P.plank[0], P.plank[2], P.plank[1], P.plank[3]]
    each(c, (x, y) => {
      const row = y >> 2, ly = y & 3
      let col = tone[row]
      if (ly === 3) return P.gap
      if (x === seams[row]) return P.gap
      if (ly === 0) col = mix(col, '#ffffff', 0.08)
      if (hash(x, y, v + 11) > 0.93) col = P.grain
      if (v === 3 && row === 1 && (x === 9 || x === 10) && ly === 1) col = mix(P.grain, '#000000', 0.2)
      return col
    })
    return c
  }
  const tone = P.plank[v % 4], across = v % 2
  each(c, (x, y) => {
    if (x === 0 || y === 0) return P.gap
    let col = tone
    if ((across ? x : y) % 3 === 0) col = mix(col, '#000000', 0.08)
    if (hash(x, y, v + 3) > 0.96) col = mix(col, '#ffffff', 0.06)
    return col
  })
  return c
}
function corridor(P, v) {
  const c = T16(), tone = P.stone[v % P.stone.length]
  each(c, (x, y) => (x === 0 || y === 0 ? P.grout : x === 1 || y === 1 ? mix(tone, '#ffffff', 0.12) : x === 15 || y === 15 ? mix(tone, '#000000', 0.06) : hash(x, y, v + 21) > 0.95 ? mix(tone, '#000000', 0.05) : tone))
  return c
}
function lobby(P, v) {
  const c = T16()
  each(c, (x, y) => {
    const u = Math.floor((x + y) / 8), w = Math.floor((x - y + 64) / 8), a = (u + w) % 2
    let col = P.parquet[a ? 1 : 0]
    if (((a ? x + y : x - y + 64) % 8) === 0) col = mix(col, '#000000', 0.18)
    else if (hash(x, y, v + 31) > 0.94) col = P.parquet[2]
    return col
  })
  return c
}
function server(P) {
  const c = T16()
  each(c, (x, y) => (x === 0 || y === 0 ? P.raised[1] : x === 1 || y === 1 ? P.raised[2] : x % 4 === 2 && y % 4 === 2 ? P.raised[1] : P.raised[0]))
  return c
}
function ground(P, v) {
  const c = T16()
  if (!neon(P)) {
    each(c, (x, y) => {
      const n = hash(x >> 1, y >> 1, v * 7 + 3)
      let col = n < 0.18 ? P.grass[2] : n > 0.86 ? P.grass[1] : P.grass[0]
      if (hash(x, y, v + 9) > 0.985) col = P.grass[3]
      return col
    })
    return c
  }
  const tone = P.path[v % 3]
  each(c, (x, y) => (x === 0 || y === 0 ? P.path[3] : x === 1 || y === 1 ? mix(tone, '#ffffff', 0.06) : hash(x, y, v + 7) > 0.97 ? mix(tone, '#000000', 0.12) : tone))
  return c
}
function path(P, v) {
  const c = T16()
  if (!neon(P)) { each(c, (x, y) => (x === 0 || y === 0 ? P.path[3] : (x === 8 && y > 8) || (y === 8 && x < 8) ? P.path[3] : P.path[(v + (x > 8 ? 1 : 0) + (y > 8 ? 1 : 0)) % 3])); return c }
  each(c, (x, y) => (x === 0 || y === 0 ? '#2a3044' : (x + y + v * 4) % 16 === 0 ? '#5ef2ff30' : mix(P.path[2], '#ffffff', 0.04)))
  return c
}
function decal(P, v) {
  const c = T16()
  if (!neon(P)) {
    if (v === 0) { c.set(4, 9, P.tuft); c.set(5, 8, P.tuft); c.set(6, 9, P.tuft); c.set(10, 5, P.tuft); c.set(11, 4, P.tuft); c.set(12, 5, P.tuft) }
    if (v === 1) { c.set(6, 7, P.flower[0]); c.set(7, 7, mix(P.flower[0], '#000000', 0.2)); c.set(6, 8, P.tuft); c.set(11, 11, P.flower[2]); c.set(11, 12, P.tuft) }
    if (v === 2) { c.set(5, 6, P.flower[1]); c.set(5, 7, P.tuft); c.set(9, 10, P.flower[3]); c.set(10, 10, mix(P.flower[3], '#000000', 0.2)); c.set(9, 11, P.tuft) }
    if (v === 3) { c.rect(7, 8, 2, 1, '#b9a278'); c.set(10, 9, '#cdb68a'); c.set(4, 11, '#b9a278') }
    return c
  }
  if (v === 0) c.line(3, 4, 9, 10, '#2a3044')
  if (v === 1) { c.rect(5, 5, 6, 6, '#2a3044'); for (let i = 6; i < 11; i += 2) c.vline(i, 6, 9, '#1d2130') }
  if (v === 2) { c.set(7, 7, '#5b4a3a'); c.set(8, 7, '#7a5d43'); c.set(8, 8, '#5b4a3a') }
  if (v === 3) { c.ellipse(8, 9, 5, 2, '#5ef2ff18'); c.hline(6, 9, 9, '#5ef2ff30') }
  return c
}
/** Rug 9-slice: corners/edges cut from a virtual rug, the centre repeats with period 16. */
function rugPart(P, part) {
  const [field, dark, border, motif] = P.rug
  const c = T16()
  const top = part.includes('t'), bottom = part.includes('b'), left = part.includes('l'), right = part.includes('r')
  each(c, (x, y) => {
    const ex = left ? x : right ? 15 - x : 99, ey = top ? y : bottom ? 15 - y : 99
    const e = Math.min(ex, ey)
    if (e === 0) return dark
    if (e <= 2) return border
    if (e === 3) return dark
    const mx = x % 16, my = y % 16
    if (Math.abs(mx - 8) + Math.abs(my - 8) === 5) return motif
    if (mx === 8 && my === 8) return border
    return field
  })
  return c
}
function runner(P, part) {
  const c = T16(), e = T16()
  each(c, (x, y) => {
    if (y < 2 || y > 13) return null
    const edge = y === 2 || y === 13, band = y === 3 || y === 12
    if (neon(P)) { if (edge) e.set(x, y, '#3fb8c8'); return edge ? P.runner[1] : P.runner[0] }
    if (part === 'l' && x === 0) return P.runner[0]
    if (part === 'r' && x === 15) return P.runner[0]
    return edge ? P.runner[0] : band ? P.runner[2] : (x + y) % 8 === 0 ? P.runner[2] : P.runner[1]
  })
  return { pix: c, emit: neon(P) ? e : undefined }
}
function cap(P, kind) {
  const c = T16(), e = T16()
  if (kind === 'side') {
    each(c, (x, y) => (x === 0 || x === 15 ? P.cap[2] : x === 1 ? P.cap[1] : (y % 6 === 3 && x > 2 && x < 13) ? mix(P.cap[0], P.cap[2], 0.35) : P.cap[0]))
    if (neon(P)) for (let y = 0; y < 16; y++) { c.set(7, y, '#1d2129'); c.set(8, y, mix(P.edge, P.cap[0], 0.3)); e.set(8, y, mix(P.edge, '#000000', 0.25)) }
  } else {
    each(c, (x, y) => (y === 0 ? P.cap[1] : y === 1 ? mix(P.cap[1], P.cap[0], 0.5) : y === 15 ? P.cap[2] : ((y === 5 && x % 8 === 2) || (y === 10 && x % 8 === 6)) ? mix(P.cap[0], P.cap[2], 0.4) : P.cap[0]))
    if (neon(P)) for (let x = 0; x < 16; x++) { const yy = kind === 'front' ? 14 : 1; c.set(x, yy, mix(P.edge, P.cap[0], 0.3)); e.set(x, yy, mix(P.edge, '#000000', 0.25)) }
  }
  return { pix: c, emit: neon(P) ? e : undefined }
}
function face(P, v) {
  const c = new Pix(16, 32), e = new Pix(16, 32)
  if (neon(P)) {
    each(c, (x, y) => {
      if (y <= 20) { const slat = (x >> 2) % 2; return y === 0 ? P.wainscot[1] : x % 4 === 0 ? P.wainscot[1] : slat ? P.wainscot[0] : P.wainscot[2] }
      if (y === 21) return '#0d1018'
      if (y === 22) { e.set(x, y, '#5ef2ff'); return '#5ef2ff' }
      if (y >= 30) return P.skirting
      return v === 1 && x === 8 ? P.paper[1] : P.paper[0]
    })
    return { pix: c, emit: e }
  }
  each(c, (x, y) => {
    if (y < 18) return y === 0 ? P.paper[2] : x % 8 === 0 ? P.paper[1] : (v === 1 && x % 8 === 4 && y % 6 === 3) ? P.paper[1] : P.paper[0]
    if (y === 18) return P.rail
    if (y === 19) return mix(P.rail, '#2b1d1b', 0.3)
    if (y >= 30) return P.skirting
    if (x === 2 || x === 13) return x === 2 ? P.wainscot[1] : P.wainscot[2]
    if (x > 2 && x < 13 && y === 21) return P.wainscot[1]
    if (x > 2 && x < 13 && y === 28) return P.wainscot[2]
    return P.wainscot[0]
  })
  return { pix: c }
}
function shadeTile(dir) {
  const c = dir === 'top' ? new Pix(16, 8) : new Pix(6, 16)
  each(c, (x, y) => {
    const t = dir === 'top' ? y / 8 : dir === 'left' ? x / 6 : (5 - x) / 6
    const a = Math.round((1 - t) * 0.32 * 255)
    return a > 0 ? '#2b1d1b' + a.toString(16).padStart(2, '0') : null
  })
  return c
}
function facade(P, part) {
  const c = new Pix(16, 24), e = new Pix(16, 24)
  each(c, (x, y) => {
    if (neon(P)) return y < 3 ? P.facade[2] : x === 0 ? P.mortar : P.facade[part === 'plain' ? 0 : 1]
    const row = y >> 2, off = row % 2 ? 4 : 0
    if (y % 4 === 3 || (x + off) % 8 === 0) return P.mortar
    return P.facade[((x + off) >> 3) % 3]
  })
  if (part !== 'plain') {
    const x0 = part === 'win.l' ? 6 : 0, w = 10
    for (let y = 4; y < 20; y++) for (let x = x0; x < x0 + w; x++) {
      const lit = neon(P)
      const col = lit ? (x - x0 < 3 && part === 'win.l' ? '#e0b860' : '#c99a4a') : (x - x0 < 3 && part === 'win.l' ? '#c7ebff' : '#9fd4f2')
      c.set(x, y, col); if (lit) e.set(x, y, mix(col, '#000000', 0.15))
    }
    if (part === 'win.l') c.vline(15, 4, 19, neon(P) ? '#30364a' : '#6a4d39')
    for (let x = 0; x < 16; x++) if ((part === 'win.l' && x >= 5) || (part === 'win.r' && x <= 10)) c.set(x, 20, neon(P) ? '#30364a' : '#e8d8b6')
  }
  return { pix: c, emit: neon(P) && part !== 'plain' ? e : undefined }
}

export function buildTiles(P) {
  const out = []
  const t = (id, frame, layers) => out.push({ id, atlas: 'tiles', layers, anchor: { x: 0, y: 0 }, states: { default: S([frame]) } })
  for (let v = 0; v < 4; v++) t(`tile.floor.hall.${v}`, hall(P, v), ['floor'])
  for (let v = 0; v < 3; v++) t(`tile.floor.corridor.${v}`, corridor(P, v), ['floor'])
  for (let v = 0; v < 2; v++) t(`tile.floor.lobby.${v}`, lobby(P, v), ['floor'])
  t('tile.floor.server', server(P), ['floor'])
  for (let v = 0; v < 4; v++) t(`tile.ground.${v}`, ground(P, v), ['floor'])
  for (let v = 0; v < 2; v++) t(`tile.ground.path.${v}`, path(P, v), ['floor'])
  for (let v = 0; v < 4; v++) t(`tile.ground.decal.${v}`, decal(P, v), ['floor-shade'])
  for (const part of ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']) t(`tile.rug.${part}`, rugPart(P, part), ['rug'])
  for (const part of ['l', 'c', 'r']) t(`tile.runner.${part}`, runner(P, part), ['rug'])
  t('tile.wall.cap', cap(P, 'top'), ['wall'])
  t('tile.wall.side', cap(P, 'side'), ['wall'])
  t('tile.wall.front', cap(P, 'front'), ['wall-front'])
  for (let v = 0; v < 2; v++) t(`tile.wall.face.${v}`, face(P, v), ['wall'])
  t('tile.wall.shade.top', shadeTile('top'), ['floor-shade'])
  t('tile.wall.shade.left', shadeTile('left'), ['floor-shade'])
  t('tile.wall.shade.right', shadeTile('right'), ['floor-shade'])
  for (const part of ['plain', 'win.l', 'win.r']) t(`tile.facade.${part}`, facade(P, part), ['wall'])
  return out
}
