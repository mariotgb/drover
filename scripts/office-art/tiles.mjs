// Room tiles (16×16, anchor top-left) and furniture objects (anchor bottom-centre,
// draw-sorted by that Y). Warm 16-bit palette, light from the top-left.
import { Pix, mix, rng } from './canvas.mjs'
import { FRAME, USER_DURATIONS, USER_POSES, drawUser } from './characters.mjs'

const OUT = '#2b1d1b'
const WOOD = { light: '#e3ab70', base: '#cf9056', dark: '#b4743f', seam: '#a5683a', knot: '#b07142' }
const WALL = {
  plaster: '#f3e6c8', plasterShade: '#e4d1aa', plasterLight: '#fbf3df',
  trim: '#7a5236', trimLight: '#9c6c47', cap: '#8d6a4f', capLight: '#ad8a6c', capDark: '#6a4d39',
  wainscot: '#c8956a', wainscotLight: '#dcab80', wainscotDark: '#a5764f', base: '#5b3d2a'
}
export const CARPETS = {
  red: { field: '#b5543f', fieldDark: '#9b4434', motif: '#cc6b52', border: '#d9a441', borderDark: '#ad7c2a' },
  green: { field: '#5d8f55', fieldDark: '#4a7645', motif: '#74a868', border: '#e0c27a', borderDark: '#b39352' },
  blue: { field: '#4f6fa0', fieldDark: '#40598a', motif: '#6888ba', border: '#e8d6a8', borderDark: '#b9a478' }
}

const tile = () => new Pix(16, 16)

function woodFloor(variant) {
  const c = tile(), r = rng(100 + variant)
  for (let plank = 0; plank < 4; plank++) {
    const y0 = plank * 4
    const tone = [WOOD.base, WOOD.light, WOOD.base, WOOD.dark][(plank + variant) % 4]
    c.rect(0, y0, 16, 4, tone)
    c.hline(0, 15, y0, mix(tone, '#ffffff', 0.12))
    c.hline(0, 15, y0 + 3, WOOD.seam)
    const joint = (variant * 5 + plank * 7 + 3) % 16
    c.vline(joint, y0, y0 + 2, WOOD.seam)
    for (let k = 0; k < 3; k++) {
      const x = Math.floor(r() * 16), y = y0 + 1 + Math.floor(r() * 2)
      if (x !== joint) c.set(x, y, mix(tone, WOOD.knot, 0.55))
    }
  }
  return c
}

function carpet(colors, part) {
  const c = tile()
  const top = part.includes('t'), bottom = part.includes('b'), left = part.includes('l'), right = part.includes('r')
  c.rect(0, 0, 16, 16, colors.field)
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.abs(((x + 4) % 8) - 4) + Math.abs(((y + 4) % 8) - 4)
    if (d === 1) c.set(x, y, colors.motif)
    if (d === 0) c.set(x, y, mix(colors.motif, colors.border, 0.5))
    if ((x + y * 3) % 11 === 0 && d > 2) c.set(x, y, colors.fieldDark)
  }
  const band = (x, y, w, h) => { c.rect(x, y, w, h, colors.border) }
  if (top) { band(0, 0, 16, 3); c.hline(0, 15, 3, colors.borderDark); c.hline(0, 15, 0, mix(colors.border, '#ffffff', 0.3)) }
  if (bottom) { band(0, 13, 16, 3); c.hline(0, 15, 12, colors.borderDark); c.hline(0, 15, 15, colors.borderDark) }
  if (left) { band(0, 0, 3, 16); c.vline(3, top ? 4 : 0, bottom ? 11 : 15, colors.borderDark) }
  if (right) { band(13, 0, 3, 16); c.vline(12, top ? 4 : 0, bottom ? 11 : 15, colors.borderDark); c.vline(15, 0, 15, colors.borderDark) }
  return c
}

function serverFloor() {
  const c = tile()
  c.rect(0, 0, 16, 16, '#b7c0c8')
  c.rect(0, 0, 8, 8, '#c5cdd4'); c.rect(8, 8, 8, 8, '#c5cdd4')
  c.hline(0, 15, 7, '#8f99a2'); c.vline(7, 0, 15, '#8f99a2'); c.hline(0, 15, 15, '#8f99a2'); c.vline(15, 0, 15, '#8f99a2')
  c.set(2, 2, '#dfe5ea'); c.set(10, 10, '#dfe5ea'); c.set(12, 3, '#a9b3bb'); c.set(4, 12, '#a9b3bb')
  return c
}

function wallCap(front) {
  const c = tile()
  c.rect(0, 0, 16, 16, WALL.cap)
  c.hline(0, 15, 0, WALL.capLight); c.hline(0, 15, 1, mix(WALL.cap, WALL.capLight, 0.5))
  for (let x = 1; x < 16; x += 5) c.set(x, 6, WALL.capDark)
  for (let x = 3; x < 16; x += 5) c.set(x, 11, WALL.capDark)
  if (front) { c.hline(0, 15, 13, WALL.capDark); c.rect(0, 14, 16, 2, WALL.trim) }
  return c
}

function wallFace(part) {
  const c = tile()
  if (part === 'top') {
    c.rect(0, 0, 16, 16, WALL.plaster)
    c.rect(0, 0, 16, 3, WALL.trim); c.hline(0, 15, 0, WALL.trimLight); c.hline(0, 15, 3, mix(WALL.plaster, WALL.trim, 0.4))
    c.hline(0, 15, 4, WALL.plasterShade)
    for (let x = 0; x < 16; x += 4) c.set(x + 2, 9, WALL.plasterLight)
  } else {
    c.rect(0, 0, 16, 16, WALL.wainscot)
    c.hline(0, 15, 0, WALL.trim); c.hline(0, 15, 1, WALL.wainscotLight)
    for (const x of [0, 8]) { c.vline(x, 2, 12, WALL.wainscotDark); c.vline(x + 1, 2, 12, WALL.wainscotLight) }
    c.rect(0, 13, 16, 3, WALL.base); c.hline(0, 15, 13, WALL.trim)
  }
  return c
}

function wallShadow() {
  const c = tile()
  for (let y = 0; y < 16; y++) c.hline(0, 15, y, `#2b1d1b${Math.round(0x50 * (1 - y / 16)).toString(16).padStart(2, '0')}`)
  return c
}

// ---------------------------------------------------------------- objects

function shadowUnder(c, x0, x1, y) {
  for (let x = x0; x <= x1; x++) for (const dy of [0, 1]) if (!c.alpha(x, y + dy)) c.set(x, y + dy, dy ? '#2b1d1b22' : '#2b1d1b40')
}

function deskBase(c, panelTop) {
  // top surface
  c.rect(2, 14, 60, panelTop - 14, WOOD.light)
  c.hline(2, 61, 14, mix(WOOD.light, '#ffffff', 0.3))
  for (let x = 4; x < 56; x += 9) c.hline(x, x + 4, 14 + ((x * 7) % (panelTop - 16)) + 1, mix(WOOD.light, WOOD.dark, 0.35))
  c.hline(2, 61, panelTop - 1, WOOD.dark)
  // front panel with drawers
  c.rect(2, panelTop, 60, 44 - panelTop, WOOD.base)
  c.hline(2, 61, panelTop, mix(WOOD.base, WOOD.dark, 0.6))
  for (const x of [6, 40]) {
    c.rect(x, panelTop + 3, 18, 44 - panelTop - 6, WOOD.dark); c.rect(x + 1, panelTop + 4, 16, 44 - panelTop - 8, WOOD.base)
    c.rect(x + 7, panelTop + 6, 4, 2, '#e8c78a'); c.hline(x + 7, x + 10, panelTop + 7, '#a5764f')
  }
  c.vline(2, 14, 43, mix(WOOD.light, '#ffffff', 0.15)); c.vline(61, 14, 43, WOOD.dark)
  c.hline(2, 61, 43, mix(WOOD.dark, OUT, 0.3))
}

function mug(c, x, y) {
  c.rect(x, y, 5, 6, '#f6efe3'); c.hline(x, x + 4, y, '#7a4a32'); c.vline(x + 4, y + 1, y + 5, '#d8cbb5')
  c.vline(x + 5, y + 2, y + 3, '#f6efe3'); c.set(x + 6, y + 2, '#d8cbb5'); c.set(x + 6, y + 3, '#d8cbb5')
}
function papers(c, x, y) {
  c.rect(x + 1, y + 1, 9, 6, '#e4dccb'); c.rect(x, y, 9, 6, '#fffaf0'); c.hline(x + 1, x + 6, y + 2, '#a9b3bb'); c.hline(x + 1, x + 5, y + 4, '#a9b3bb')
}

function deskFront(on) {
  const c = new Pix(64, 48)
  deskBase(c, 28)
  papers(c, 8, 18)
  mug(c, 49, 16)
  // monitor seen from behind, centred: the agent's head shows above it
  c.round(22, 9, 20, 11, 2, '#4a5260'); c.round(23, 10, 18, 9, 2, '#5d6676')
  c.hline(24, 39, 11, '#727c8c'); c.rect(29, 19, 6, 3, '#3d4450'); c.rect(26, 21, 12, 2, '#4a5260')
  c.set(39, 17, on ? '#7cf28c' : '#3d4450')
  if (on) for (let x = 23; x <= 40; x++) c.set(x, 8, '#bfe8ff70')
  c.outline(OUT, 0.55)
  shadowUnder(c, 3, 60, 45)
  return c
}

function screen(c, x, y, w, h, mode, frame) {
  c.round(x - 2, y - 2, w + 4, h + 4, 2, '#3d4450')
  c.hline(x - 1, x + w, y - 1, '#5d6676')
  if (mode === 'off') {
    c.rect(x, y, w, h, '#1b2430'); c.line(x + 2, y + h - 3, x + 6, y + 1, '#2d3a4a'); c.line(x + 4, y + h - 2, x + 8, y + 2, '#2d3a4a')
    return
  }
  if (mode === 'term') {
    c.rect(x, y, w, h, '#0f2418')
    const lines = [['#7cf28c', 4], ['#4fc76a', 9], ['#7cf28c', 6], ['#4fc76a', 11]]
    lines.forEach(([col, len], i) => c.hline(x + 2, x + 1 + Math.min(len, w - 4), y + 2 + i * 2, col))
    c.hline(x + 2, x + 3, y + 2 + 4 * 2, '#7cf28c')
    if (frame === 0) c.rect(x + 5, y + 2 + 4 * 2 - 1, 2, 2, '#c9ffd2')
    return
  }
  c.rect(x, y, w, h, '#1e3a52')
  const rows = [['#8fe3ff', 3, 7], ['#f2c230', 5, 5], ['#d97757', 3, 9], ['#8fe3ff', 7, 4], ['#c9b6ff', 5, 8], ['#7cf28c', 3, 6]]
  for (let i = 0; i < 5; i++) {
    const [col, indent, len] = rows[(i + frame) % rows.length]
    c.hline(x + 1 + indent, x + Math.min(indent + len, w - 2), y + 2 + i * 2, col)
  }
  c.set(x + w - 2, y + 1, '#ffffff')
}

function deskBack(mode, frame) {
  const c = new Pix(64, 48)
  deskBase(c, 30)
  screen(c, 22, 3, 20, 13, mode, frame)
  c.rect(29, 18, 6, 3, '#3d4450'); c.rect(25, 20, 14, 2, '#4a5260')
  // keyboard + mouse
  c.rect(22, 23, 20, 5, '#c9d1d6'); c.hline(22, 41, 23, '#e6ebee')
  for (let x = 23; x < 41; x += 2) { c.set(x, 25, '#9aa5ad'); c.set(x + 1, 26, '#9aa5ad') }
  c.round(45, 23, 4, 5, 1, '#c9d1d6'); c.set(46, 23, '#e6ebee')
  if (mode === 'term') { c.rect(8, 18, 9, 7, '#2f3640'); c.hline(9, 15, 19, '#7cf28c'); c.set(9, 21, '#7cf28c'); c.hline(11, 13, 21, '#4fc76a') }
  else { mug(c, 9, 17); papers(c, 50, 18) }
  c.outline(OUT, 0.55)
  shadowUnder(c, 3, 60, 45)
  return c
}

function chair(front) {
  const c = new Pix(24, 24)
  const fabric = '#3e5a7a', light = '#577aa0', dark = '#2c4058'
  if (front) {
    c.round(3, 1, 18, 15, 4, fabric); c.round(4, 2, 16, 12, 3, light); c.rect(5, 4, 14, 9, fabric)
    c.rect(10, 16, 4, 4, '#3d4450'); c.rect(5, 20, 14, 2, '#4a5260')
  } else {
    c.round(4, 8, 16, 7, 2, fabric); c.hline(5, 18, 8, light)
    c.round(2, 13, 20, 6, 2, dark); c.hline(3, 20, 13, fabric)
    c.rect(10, 19, 4, 2, '#3d4450'); c.rect(5, 21, 14, 1, '#4a5260')
  }
  c.outline(OUT, 0.55)
  return c
}

function plant(big) {
  const c = new Pix(16, big ? 32 : 16)
  const pot = { base: '#c46a3d', light: '#df8a58', dark: '#8e4524' }
  const potTop = big ? 22 : 9
  c.rect(3, potTop, 10, (big ? 31 : 15) - potTop, pot.base)
  c.hline(2, 13, potTop, pot.light); c.hline(2, 13, potTop + 1, pot.dark); c.vline(12, potTop + 2, big ? 30 : 14, pot.dark)
  c.vline(3, potTop + 2, big ? 30 : 14, pot.light)
  const leaves = big
    ? [[8, 2, 3, 6], [4, 6, 3, 5], [12, 7, 3, 5], [6, 11, 4, 6], [11, 13, 3, 5], [3, 15, 3, 4], [8, 17, 4, 5]]
    : [[8, 1, 3, 4], [4, 4, 3, 4], [12, 4, 3, 4], [8, 6, 3, 3]]
  for (const [x, y, rx, ry] of leaves) { c.ellipse(x, y, rx, ry, '#4f9a3a'); c.ellipse(x - 1, y - 1, rx - 1, ry - 1, '#7fbf4d'); c.set(x, y + ry - 1, '#2f6b2e') }
  if (big) { c.vline(8, 8, potTop - 1, '#2f6b2e'); c.line(8, 14, 5, 10, '#2f6b2e'); c.line(8, 16, 11, 12, '#2f6b2e') }
  c.outline(OUT, 0.55)
  return c
}

function cooler(frame) {
  const c = new Pix(16, 32)
  c.round(3, 1, 10, 11, 3, '#9fd4f2'); c.round(4, 2, 8, 8, 2, '#c7ebff'); c.rect(6, 0, 4, 2, '#5aa9d6')
  c.set(5 + (frame ? 2 : 0), 7 - frame * 2, '#ffffff'); c.set(8 - frame, 5 + frame, '#ffffff')
  c.rect(2, 12, 12, 18, '#eef1f3'); c.hline(2, 13, 12, '#ffffff'); c.vline(13, 13, 29, '#c9d1d6'); c.vline(2, 13, 29, '#ffffff')
  c.rect(5, 16, 6, 4, '#3d4450'); c.set(6, 17, '#d94a4a'); c.set(9, 17, '#4a8fd9')
  c.rect(4, 26, 8, 2, '#c9d1d6')
  c.outline(OUT, 0.55)
  shadowUnder(c, 2, 13, 30)
  return c
}

function sofa() {
  const c = new Pix(48, 32)
  const f = { base: '#6f9a6a', light: '#8fbb88', dark: '#557a51' }
  c.round(2, 4, 44, 14, 4, f.dark); c.round(3, 5, 42, 11, 3, f.base); c.hline(5, 42, 6, f.light)
  c.round(0, 12, 8, 16, 3, f.dark); c.round(40, 12, 8, 16, 3, f.dark); c.vline(1, 14, 26, f.base); c.vline(46, 14, 26, f.base)
  c.round(7, 15, 34, 9, 2, f.base); c.hline(8, 39, 15, f.light); c.vline(23, 15, 23, f.dark); c.vline(24, 15, 23, f.light)
  c.rect(6, 24, 36, 4, f.dark)
  c.rect(4, 28, 3, 2, '#5b3d2a'); c.rect(41, 28, 3, 2, '#5b3d2a')
  c.round(10, 8, 7, 6, 2, '#e8c070'); c.hline(11, 15, 9, '#f6dc9c')
  c.outline(OUT, 0.55)
  shadowUnder(c, 2, 45, 30)
  return c
}

function coffeeTable() {
  const c = new Pix(32, 16)
  c.round(1, 2, 30, 8, 2, WOOD.dark); c.round(2, 2, 28, 6, 2, WOOD.light); c.hline(3, 28, 2, mix(WOOD.light, '#ffffff', 0.3))
  c.rect(3, 10, 2, 4, WOOD.dark); c.rect(27, 10, 2, 4, WOOD.dark)
  mug(c, 7, 3)
  c.rect(17, 4, 8, 3, '#d97757'); c.hline(17, 24, 4, '#ef9a76')
  c.outline(OUT, 0.55)
  shadowUnder(c, 2, 29, 14)
  return c
}

function taskBoard() {
  const c = new Pix(32, 32)
  c.rect(1, 2, 30, 24, WALL.trim); c.rect(2, 3, 28, 22, '#c99a62')
  for (let i = 0; i < 18; i++) c.set(3 + ((i * 7) % 26), 4 + ((i * 11) % 20), '#b88a54')
  const notes = [[4, 5, '#f7e07a'], [12, 5, '#f4a6b8'], [20, 5, '#9ee09a'], [4, 14, '#9ee09a'], [12, 14, '#f7e07a'], [21, 14, '#a9d4f5']]
  for (const [x, y, col] of notes) {
    c.rect(x, y, 7, 7, col); c.hline(x, x + 6, y + 6, mix(col, OUT, 0.25)); c.set(x + 3, y, '#d94a4a')
    c.hline(x + 1, x + 4, y + 2, mix(col, OUT, 0.45)); c.hline(x + 1, x + 5, y + 4, mix(col, OUT, 0.45))
  }
  c.rect(2, 26, 28, 2, WALL.trimLight)
  c.outline(OUT, 0.55)
  return c
}

function sign() {
  const c = new Pix(48, 16)
  c.round(1, 1, 46, 13, 2, '#7a5236'); c.round(2, 2, 44, 11, 2, '#a8744a'); c.round(3, 3, 42, 9, 1, '#8a5a36')
  c.hline(4, 43, 3, '#c08a5a')
  for (const x of [4, 43]) c.set(x, 7, '#e8c78a')
  c.outline(OUT, 0.55)
  return c
}

function windowObj() {
  const c = new Pix(32, 16)
  c.rect(1, 1, 30, 13, WALL.trim); c.rect(2, 2, 28, 11, '#9fd4f2')
  c.rect(2, 2, 28, 4, '#c7ebff'); c.line(4, 11, 10, 3, '#e6f6ff'); c.line(6, 11, 12, 3, '#e6f6ff')
  c.vline(15, 2, 12, WALL.trim); c.vline(16, 2, 12, WALL.trimLight); c.hline(2, 29, 7, WALL.trim)
  c.rect(0, 13, 32, 2, WALL.trimLight); c.hline(0, 31, 14, WALL.trim)
  return c
}

function door() {
  const c = new Pix(32, 32)
  c.rect(0, 0, 32, 32, WALL.trim)
  c.rect(2, 2, 13, 30, WOOD.base); c.rect(17, 2, 13, 30, WOOD.base)
  for (const x of [2, 17]) {
    c.rect(x + 2, 4, 9, 9, '#9fd4f2'); c.hline(x + 2, x + 10, 4, '#c7ebff'); c.vline(x + 6, 4, 12, WALL.trim)
    c.rect(x + 2, 16, 9, 12, WOOD.dark); c.rect(x + 3, 17, 7, 10, WOOD.light)
  }
  c.rect(13, 18, 2, 3, '#e8c78a'); c.rect(17, 18, 2, 3, '#e8c78a')
  c.hline(0, 31, 0, WALL.trimLight)
  return c
}

function rack(frame) {
  const c = new Pix(16, 32)
  c.rect(1, 1, 14, 29, '#2f3640'); c.vline(1, 1, 29, '#4a5260'); c.vline(14, 1, 29, '#1d2229')
  for (let i = 0; i < 6; i++) {
    const y = 3 + i * 4
    c.rect(3, y, 10, 3, '#3d4450'); c.hline(3, 12, y, '#4f5868')
    const on = (i + frame) % 3 !== 0
    c.set(4, y + 1, on ? '#7cf28c' : '#2f6b3a'); c.set(6, y + 1, (i * 3 + frame) % 4 === 0 ? '#f2c230' : '#5a4a1a')
    c.hline(8, 11, y + 1, '#262c34')
  }
  c.outline(OUT, 0.55)
  shadowUnder(c, 1, 14, 30)
  return c
}

function machinePc(frame) {
  const c = new Pix(32, 32)
  // tower
  c.rect(2, 8, 10, 20, '#d8dde1'); c.vline(2, 8, 27, '#f2f4f6'); c.vline(11, 9, 27, '#a9b3bb'); c.hline(2, 11, 8, '#f2f4f6')
  c.rect(4, 11, 6, 2, '#9aa5ad'); c.rect(4, 15, 6, 1, '#9aa5ad'); c.set(5, 24, frame ? '#7cf28c' : '#2f6b3a'); c.set(8, 24, frame ? '#5a4a1a' : '#f2c230')
  // monitor
  c.round(13, 4, 18, 14, 1, '#3d4450')
  c.rect(15, 6, 14, 10, '#1e3a52'); c.hline(16, 22, 8, '#8fe3ff'); c.hline(16, 25, 10, '#c9b6ff'); c.hline(16, 20, 12, '#7cf28c')
  if (frame) c.rect(21, 12, 2, 1, '#ffffff')
  c.rect(20, 18, 4, 4, '#3d4450'); c.rect(16, 22, 12, 2, '#4a5260')
  c.rect(14, 25, 14, 3, '#c9d1d6'); c.hline(14, 27, 25, '#e6ebee')
  c.outline(OUT, 0.55)
  shadowUnder(c, 2, 29, 29)
  return c
}

function homeServer(frame) {
  const c = new Pix(32, 32)
  for (let u = 0; u < 4; u++) {
    const y = 6 + u * 6
    c.rect(4, y, 24, 5, '#2f3640'); c.hline(4, 27, y, '#4f5868'); c.hline(4, 27, y + 4, '#1d2229')
    for (let b = 0; b < 4; b++) c.rect(7 + b * 4, y + 1, 3, 3, '#3d4450')
    const on = (u + frame) % 2 === 0
    c.set(24, y + 2, on ? '#7cf28c' : '#2f6b3a'); c.set(26, y + 2, (u + frame) % 3 === 0 ? '#4fb3e0' : '#24425a')
  }
  c.rect(3, 4, 26, 2, '#4a5260'); c.rect(3, 30, 26, 1, '#1d2229')
  c.outline(OUT, 0.55)
  shadowUnder(c, 3, 28, 30)
  return c
}

function bookshelf() {
  const c = new Pix(32, 32)
  c.rect(1, 1, 30, 29, WOOD.dark); c.rect(2, 2, 28, 27, WOOD.base)
  const colors = ['#b5543f', '#4f6fa0', '#5d8f55', '#d9a441', '#8a5a9e', '#c46a3d', '#3e5a7a']
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = 3 + shelf * 9
    c.hline(2, 29, y + 8, WOOD.dark)
    let x = 3
    for (let b = 0; x < 28; b++) {
      const w = 2 + ((b + shelf) % 3 === 0 ? 1 : 0), h = 6 + ((b * 5 + shelf) % 3 === 0 ? -1 : 0)
      c.rect(x, y + 8 - h, w, h, colors[(b + shelf * 2) % colors.length]); c.vline(x, y + 9 - h, y + 7, mix(colors[(b + shelf * 2) % colors.length], '#ffffff', 0.25))
      x += w + (b % 4 === 3 ? 2 : 0)
    }
  }
  c.outline(OUT, 0.55)
  shadowUnder(c, 1, 30, 30)
  return c
}

/** All tiles and objects: id → { frames: Pix[], durations, anchor, layers }. */
export function buildTiles() {
  const out = []
  const t = (id, pix, layers) => out.push({ id, frames: [pix], durations: [1000], loop: false, anchor: { x: 0, y: 0 }, layers })
  for (let v = 0; v < 3; v++) t(`tile.floor.wood.${v}`, woodFloor(v), ['floor'])
  t('tile.floor.server', serverFloor(), ['floor'])
  for (const [name, colors] of Object.entries(CARPETS)) for (const part of ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br']) t(`tile.floor.carpet.${name}.${part}`, carpet(colors, part), ['rug'])
  t('tile.wall.cap', wallCap(false), ['wall'])
  t('tile.wall.cap.front', wallCap(true), ['wall-front'])
  t('tile.wall.face.top', wallFace('top'), ['wall'])
  t('tile.wall.face.bottom', wallFace('bottom'), ['wall'])
  t('tile.wall.shadow', wallShadow(), ['floor-shade'])

  const o = (id, frames, durations, layers, states) => out.push({ id, frames, durations, loop: frames.length > 1, layers, states, anchor: { x: frames[0].w / 2, y: frames[0].h } })
  out.push({ id: 'object.desk.front', layers: ['furniture'], anchor: { x: 32, y: 48 }, states: { on: { frames: [deskFront(true)], durations: [1000], loop: false }, off: { frames: [deskFront(false)], durations: [1000], loop: false } } })
  out.push({ id: 'object.desk.back', layers: ['furniture'], anchor: { x: 32, y: 48 }, states: { on: { frames: [deskBack('code', 0), deskBack('code', 1), deskBack('code', 2)], durations: [900, 900, 900], loop: true }, off: { frames: [deskBack('off', 0)], durations: [1000], loop: false } } })
  out.push({ id: 'object.desk.terminal', layers: ['furniture'], anchor: { x: 32, y: 48 }, states: { on: { frames: [deskBack('term', 0), deskBack('term', 1)], durations: [530, 530], loop: true }, off: { frames: [deskBack('off', 0)], durations: [1000], loop: false } } })
  o('object.chair.front', [chair(true)], [1000], ['furniture-back'])
  o('object.chair.back', [chair(false)], [1000], ['furniture'])
  o('object.plant.big', [plant(true)], [1000], ['furniture'])
  o('object.plant.small', [plant(false)], [1000], ['furniture'])
  o('object.cooler', [cooler(0), cooler(1)], [1400, 1400], ['furniture'])
  o('object.sofa', [sofa()], [1000], ['furniture'])
  o('object.table.coffee', [coffeeTable()], [1000], ['furniture'])
  o('object.bookshelf', [bookshelf()], [1000], ['furniture'])
  o('object.taskboard', [taskBoard()], [1000], ['wall-decor'])
  o('object.sign', [sign()], [1000], ['wall-decor'])
  o('object.window', [windowObj()], [1000], ['wall-decor'])
  o('object.door', [door()], [1000], ['wall-decor'])
  o('object.server.rack', [rack(0), rack(1), rack(2)], [500, 500, 500], ['furniture'])
  o('object.machine.pc', [machinePc(0), machinePc(1)], [800, 800], ['furniture'])
  o('object.machine.homeserver', [homeServer(0), homeServer(1)], [650, 650], ['furniture'])
  // The user node «Вы»: a standing person, drawn like an agent (feet at the anchor).
  out.push({ id: 'object.user', layers: ['body'], anchor: { ...FRAME.anchor }, frames: USER_POSES.map(drawUser), durations: [...USER_DURATIONS], loop: true })
  return out
}
