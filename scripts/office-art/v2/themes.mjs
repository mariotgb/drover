// Two art directions over the same layout and characters.
//   cozy («Мастерская»): warm daylight, wood, rugs, paper planes and notes.
//   neon («Неоновый хаб»): evening open space, glass and neon, light beams and data packets.
import { mix, rng } from '../canvas.mjs'

export const THEMES = {
  cozy: {
    id: 'cozy', title: 'Мастерская',
    ambient: [1.0, 0.97, 0.93], steps: 12,
    grass: ['#6f9f4c', '#79aa55', '#649443', '#86b860'], tuft: '#4f8236', flower: ['#f2d16b', '#f4a3b5', '#ffffff', '#b9a7ff'],
    path: ['#d9c49b', '#cdb68a', '#e6d5b0', '#b9a278'],
    facade: ['#b5654a', '#9d543c', '#c47758'], mortar: '#e2cfb0',
    cap: ['#8d6a4f', '#ad8a6c', '#6a4d39'],
    paper: ['#f3e6c8', '#e8d6b0', '#fbf3df'], rail: '#9c6c47', wainscot: ['#c8956a', '#dcab80', '#a5764f'], skirting: '#5b3d2a',
    plank: ['#c98a52', '#c2824a', '#cf9358', '#bb7b45'], gap: '#8f5a33', grain: '#b07040',
    stone: ['#ead9b6', '#e0cca3', '#f3e7cc'], grout: '#c7b38c', runner: ['#b5543f', '#9b4434', '#d9a441'],
    parquet: ['#a8703f', '#b98252', '#94602f'], raised: ['#c4ccd2', '#b0bac1', '#dde3e7'],
    desk: { top: '#e2ab72', hi: '#f0c38f', lo: '#c98e57', front: '#b4743f', frontLo: '#8f5a33', leg: '#5b3d2a', trim: '#e8c78a' },
    divider: ['#6f9a6a', '#8fbb88', '#557a51'],
    monitor: { case: '#3d4450', hi: '#5b6378', lo: '#262b33', screen: '#1d3550', glow: [0.55, 0.8, 1] },
    chair: { seat: '#5a6f9c', hi: '#7d92bf', lo: '#435479', base: '#2b2a3a' },
    leadChair: { seat: '#8a4a32', hi: '#b06848', lo: '#6a3424', base: '#2b1d1b' },
    sofa: ['#6f9a6a', '#8fbb88', '#557a51'], armchair: ['#d9a441', '#efc46a', '#ad7c2a'], rug: ['#b5543f', '#9b4434', '#e0c27a', '#cc6b52'],
    plaque: { fill: '#fbf0d6', edge: '#7a5236', text: '#4a2e1f', shade: '#e2cfa6' },
    sign: { fill: '#8d6a4f', edge: '#5b3d2a', text: '#fbe6c4' },
    status: { working: '#3b82f6', blocked: '#e0900b', idle: '#a3a39c', done: '#1f9d55', unknown: '#8a8a84' },
    link: '#fff4dc', linkShade: '#b58a5a', attempt: '#d8cbb0', user: '#5aa9e6', board: '#e0a33a', cable: ['#3a6fb0', '#5a8fd0', '#2a4f80'], packet: '#ffe27a'
  },
  neon: {
    id: 'neon', title: 'Неоновый хаб',
    ambient: [0.42, 0.46, 0.66], steps: 12,
    grass: ['#2f3a3a', '#334040', '#2a3434', '#3a4747'], tuft: '#3f5a52', flower: ['#ff7ad9', '#5ef2ff', '#ffd36b', '#b9a7ff'],
    path: ['#4a5062', '#434959', '#535a6e', '#3b4050'],
    facade: ['#4b5367', '#424a5c', '#566078'], mortar: '#2f3545',
    cap: ['#4a5266', '#68718a', '#30364a'], edge: '#5ef2ff',
    paper: ['#2c3448', '#262d3f', '#343d54'], rail: '#5ef2ff', wainscot: ['#6b4f3f', '#86654f', '#4e392e'], skirting: '#1c2130',
    plank: ['#3c4560', '#38405a', '#414a66', '#353d55'], gap: '#2a3045', grain: '#454e6b',
    stone: ['#59627a', '#535b72', '#636c85'], grout: '#465066', runner: ['#2b3350', '#5ef2ff', '#ff7ad9'],
    parquet: ['#4a3b45', '#56444f', '#3f323b'], raised: ['#4b556b', '#434c60', '#56617a'],
    desk: { top: '#cfd6e0', hi: '#e9edf3', lo: '#aab3c2', front: '#b9c1ce', frontLo: '#808a9c', leg: '#2a2f3a', trim: '#5ef2ff' },
    divider: ['#9fd8e8', '#d4f4ff', '#6fb3c8'],
    monitor: { case: '#1d2129', hi: '#3a4152', lo: '#111419', screen: '#0d1a2b', glow: [0.35, 0.85, 1] },
    chair: { seat: '#2e3340', hi: '#4a5164', lo: '#1f232c', base: '#14171d' },
    leadChair: { seat: '#3a2e4a', hi: '#5a4874', lo: '#271f33', base: '#14171d' },
    sofa: ['#ff8a4c', '#ffae7a', '#d0652e'], armchair: ['#3fd0c9', '#7fe8e2', '#2a9a94'], rug: ['#2b3350', '#232a44', '#5ef2ff', '#ff7ad9'],
    plaque: { fill: '#121826', edge: '#5ef2ff', text: '#dffbff', shade: '#0b0f18' },
    sign: { fill: '#141a28', edge: '#2c3550', text: '#ff7ad9' },
    status: { working: '#60a5fa', blocked: '#f5b83d', idle: '#8b8f99', done: '#3ecf7a', unknown: '#6f6f78' },
    link: '#5ef2ff', linkShade: '#1d6b80', attempt: '#8a93a8', user: '#ff9a6b', board: '#ffd36b', cable: ['#7cf28c', '#c4ffd0', '#2f8a4a'], packet: '#ffffff'
  }
}

const hash = (x, y, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Outdoor ground (grass / night plaza), pixel by pixel. */
export function ground(P, c, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (P.id === 'cozy') {
      const n = hash(x >> 1, y >> 1, 3)
      let col = n < 0.18 ? P.grass[2] : n > 0.86 ? P.grass[1] : P.grass[0]
      if (hash(x, y, 9) > 0.985) col = P.grass[3]
      c.set(x, y, col)
    } else {
      const tx = Math.floor(x / 16), ty = Math.floor(y / 16), lx = x - tx * 16, ly = y - ty * 16
      const tone = hash(tx, ty, 4)
      let col = tone < 0.33 ? P.path[0] : tone < 0.66 ? P.path[1] : P.path[2]
      if (lx === 0 || ly === 0) col = P.path[3]
      else if (lx === 1 || ly === 1) col = mix(col, '#ffffff', 0.06)
      if (hash(x, y, 7) > 0.97) col = mix(col, '#000000', 0.12)
      c.set(x, y, col)
    }
  }
  if (P.id === 'cozy') {
    const r = rng(x0 * 31 + y0 * 7 + w)
    for (let i = 0; i < (w * h) / 90; i++) {
      const x = x0 + Math.floor(r() * w), y = y0 + Math.floor(r() * h)
      if (r() < 0.75) { c.set(x, y, P.tuft); c.set(x + 1, y - 1, P.tuft); c.set(x + 2, y, P.tuft) }
      else { const f = P.flower[Math.floor(r() * P.flower.length)]; c.set(x, y, f); c.set(x + 1, y, mix(f, '#000000', 0.2)); c.set(x, y + 1, P.tuft) }
    }
  }
}

/** Interior floors. kind: hall | corridor | lobby | server | rug-* */
export function floor(P, c, kind, x0, y0, w, h, seed = 0) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    let col
    if (kind === 'hall') {
      if (P.id === 'cozy') {
        const row = Math.floor(y / 5), ly = y - row * 5
        const off = Math.floor(hash(row, 1, seed) * 40)
        const plank = Math.floor((x + off) / 36), lx = (x + off) - plank * 36
        col = P.plank[Math.floor(hash(plank, row, seed) * P.plank.length)]
        if (ly === 4) col = P.gap
        else if (lx === 0) col = P.gap
        else if (ly === 0) col = mix(col, '#ffffff', 0.08)
        else if (hash(x, y, seed + 5) > 0.93) col = P.grain
      } else {
        const tx = Math.floor(x / 16), ty = Math.floor(y / 16), lx = x - tx * 16, ly = y - ty * 16
        col = P.plank[Math.floor(hash(tx, ty, seed) * P.plank.length)]
        const fibre = ((tx + ty) % 2 ? lx : ly) % 3 === 0
        if (fibre) col = mix(col, '#000000', 0.08)
        if (lx === 0 || ly === 0) col = P.gap
      }
    } else if (kind === 'corridor') {
      const tx = Math.floor(x / 16), ty = Math.floor(y / 16), lx = x - tx * 16, ly = y - ty * 16
      col = P.stone[Math.floor(hash(tx, ty, 2) * P.stone.length)]
      if (lx === 0 || ly === 0) col = P.grout
      else if (lx === 1 || ly === 1) col = mix(col, '#ffffff', 0.12)
      else if (lx === 15 || ly === 15) col = mix(col, '#000000', 0.06)
    } else if (kind === 'lobby') {
      // herringbone parquet
      const u = Math.floor((x + y) / 8), v = Math.floor((x - y + 4096) / 8)
      const a = (u + v) % 2
      col = P.parquet[(a + Math.floor(hash(u, v, 6) * 2)) % P.parquet.length]
      if (((a ? x + y : x - y + 4096) % 8) === 0) col = mix(col, '#000000', 0.18)
    } else if (kind === 'server') {
      const tx = Math.floor(x / 16), ty = Math.floor(y / 16), lx = x - tx * 16, ly = y - ty * 16
      col = P.raised[0]
      if (lx === 0 || ly === 0) col = P.raised[1]
      else if (lx === 1 || ly === 1) col = P.raised[2]
      else if (lx % 4 === 2 && ly % 4 === 2) col = P.raised[1]
    }
    c.set(x, y, col)
  }
}

/** Patterned rug (9-slice look, drawn in place). */
export function rug(P, c, x0, y0, w, h, round = false) {
  const [field, dark, border, motif] = P.rug
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const lx = x - x0, ly = y - y0
    if (round) {
      const nx = (lx - w / 2 + 0.5) / (w / 2), ny = (ly - h / 2 + 0.5) / (h / 2)
      const d = nx * nx + ny * ny
      if (d > 1) continue
      c.set(x, y, d > 0.78 ? border : d > 0.68 ? dark : ((lx + ly) % 6 === 0 ? motif : field))
      continue
    }
    const edge = Math.min(lx, ly, w - 1 - lx, h - 1 - ly)
    let col = edge === 0 ? dark : edge <= 2 ? border : edge === 3 ? dark : field
    if (edge > 4 && ((lx * 3 + ly * 5) % 11 === 0)) col = motif
    if (edge > 4 && (lx - ly) % 12 === 0 && (lx + ly) % 4 === 0) col = border
    c.set(x, y, col)
  }
  for (let x = x0 + 1; x < x0 + w - 1; x++) if (!round) c.set(x, y0 + h, '#2b1d1b30')
}

/** Ambient occlusion strip under a wall / along an edge. */
export function shade(c, x0, y0, w, h, dir = 'down', k = 0.32) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const t = dir === 'down' ? (y - y0) / h : dir === 'up' ? (y0 + h - 1 - y) / h : dir === 'right' ? (x - x0) / w : (x0 + w - 1 - x) / w
    const a = Math.round((1 - t) * k * 255)
    if (a > 0) c.set(x, y, '#2b1d1b' + a.toString(16).padStart(2, '0'))
  }
}
