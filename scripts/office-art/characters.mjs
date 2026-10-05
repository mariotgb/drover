// Characters 32×48, anchor (16,44) at the feet. Every frame is drawn from a pose,
// so role overlays use exactly the same head/torso/arm geometry as the body.
import { Pix, mix } from './canvas.mjs'

export const FRAME = { w: 32, h: 48, anchor: { x: 16, y: 44 } }
export const HIT = { x: 6, y: 2, width: 20, height: 44 }
export const DIRECTIONS = ['front', 'back']
export const KINDS = ['claude', 'codex', 'gemini', 'general']
export const ROLES = ['lead', 'reviewer', 'devops', 'frontend', 'backend', 'docs', 'designer', 'general']
const OUT = '#2b1d1b'

const SKIN = { claude: ['#f2c6a3', '#d99c78'], codex: ['#ecc19d', '#cf9d78'], gemini: ['#c98e66', '#a8704d'], general: ['#f4d2b4', '#dcae8c'], user: ['#e8b48e', '#c99470'], boss: ['#f0c8a8', '#d4a382'] }
const STYLE = {
  claude: { shirt: ['#ef9a76', '#d97757', '#b55a3e'], hair: ['#c7703f', '#9c4a2a', '#7a3720'], pants: ['#4b4a6b', '#36354f'], collar: '#fbe6d4', logo: '#fbe6d4' },
  codex: { shirt: ['#4a4a50', '#2c2c31', '#19191c'], hair: ['#f4f4f4', '#d2d2d6', '#a9a9b0'], pants: ['#3b3b40', '#26262a'], collar: '#f2f2f2', logo: '#f2f2f2' },
  gemini: { shirt: ['#8eaaff', '#5b7cf0', '#4258c2'], hair: ['#4a4580', '#2f2a5c', '#211d45'], pants: ['#3e3a66', '#2b284c'], collar: '#c9b6ff', logo: '#f3ecff', accent: '#a983f0' },
  general: { shirt: ['#8fc2aa', '#5f9e86', '#467a66'], hair: ['#7a5136', '#5c3a28', '#45291c'], pants: ['#4a5470', '#353d55'], collar: '#e9f3ee', logo: null },
  // «Вы»: the person at the Mac, a mustard sweater no agent kind wears.
  user: { shirt: ['#f2cf73', '#dcab45', '#b5852c'], hair: ['#5a4a42', '#3a2c26', '#271c18'], pants: ['#4a5a80', '#36425f'], collar: '#fff4dc', logo: null },
  // «Главный босс»: navy suit, red tie, gold crown pin, silver hair.
  boss: { shirt: ['#3d4870', '#2c3557', '#1d2440'], hair: ['#d4d7e0', '#a9adba', '#7d8292'], pants: ['#2a2f45', '#1e2235'], collar: '#ffffff', logo: null }
}
const LOGOS = {
  claude: ['..x..', 'x.x.x', '.xxx.', 'x.x.x', '..x..'],
  codex: ['x....', '.x...', 'x..xx'],
  gemini: ['..x..', '.xxx.', 'xxxxx', '.xxx.', '..x..'],
  general: null
}

/** Frame plan per state: pose per frame and durations (ms). */
export const STATES = {
  idle: { durations: [700, 700, 700, 140], poses: [{}, { bob: 1 }, {}, { eyes: 'closed' }] },
  working: { durations: [140, 140, 140, 140], poses: [{ arms: 'type', tap: 0, eyes: 'down' }, { arms: 'type', tap: 1, eyes: 'down', bob: 1 }, { arms: 'type', tap: 2, eyes: 'down' }, { arms: 'type', tap: 3, eyes: 'down', bob: 1 }] },
  blocked: { durations: [220, 220, 220, 220], poses: [0, 1, 0, 1].map((w, i) => ({ arms: 'raise', wave: w, mouth: 'o', ask: i % 2 })) },
  done: { durations: [420, 420, 900, 160], poses: [{ arms: 'stretch', reach: 0, eyes: 'happy', mouth: 'grin' }, { arms: 'stretch', reach: 1, eyes: 'happy', mouth: 'grin', bob: -1 }, { eyes: 'happy', mouth: 'smile' }, { eyes: 'closed', mouth: 'smile' }] },
  unknown: { durations: [1000, 1000], poses: [{ eyes: 'dot', mouth: 'flat', grey: true }, { eyes: 'dot', mouth: 'flat', grey: true }] }
}
export const STATE_NAMES = Object.keys(STATES)
export const FRAMES_PER_DIRECTION = STATE_NAMES.reduce((n, s) => n + STATES[s].poses.length, 0)

function geometry(p) {
  const bob = p.bob ?? 0
  return { H: 6 + bob, T: 24 + Math.max(0, bob) }
}

function legs(c, s, dir, p = {}) {
  const [pants, pantsShade] = s.pants
  for (const x0 of [11, 17]) {
    // Walking: one foot is lifted on frames 0 and 2.
    const lift = p.walk === undefined ? 0 : (p.walk === 0 && x0 === 11) || (p.walk === 2 && x0 === 17) ? 1 : 0
    c.rect(x0, 36, 4, 6 - lift, pants)
    c.vline(x0 === 11 ? 14 : 17, 37, 41 - lift, pantsShade)
    c.rect(x0, 42 - lift, 4, 2, dir === 'front' ? '#4a3329' : '#3b2b26')
    c.hline(x0, x0 + 3, 42 - lift, dir === 'front' ? '#6b4a3a' : '#4a3329')
  }
  c.rect(11, 36, 10, 2, pants)
}

function torso(c, kind, s, g, dir) {
  const [light, base, shade] = s.shirt
  const top = g.T
  c.rect(10, top, 12, 1, base)
  c.rect(9, top + 1, 14, 36 - top - 1, base)
  c.vline(9, top + 1, 35, light)
  c.vline(10, top, top + 3, light)
  c.vline(21, top + 1, 35, shade)
  c.vline(22, top + 1, 35, shade)
  c.hline(9, 22, 35, shade)
  if (kind === 'gemini') for (let y = top + 7; y < 35; y++) for (let x = 9; x <= 22; x++) if ((x + y) % 2 === 0 && y > top + 9) c.set(x, y, mix(c.get(x, y), STYLE.gemini.accent, 0.45))
  if (dir === 'front') {
    c.set(15, top, s.collar); c.set(16, top, s.collar)
    c.set(14, top, s.collar); c.set(17, top, s.collar)
    c.set(15, top + 1, SKIN[kind][1]); c.set(16, top + 1, SKIN[kind][1])
    if (kind === 'codex') {
      c.vline(14, top + 1, top + 2, s.collar); c.vline(17, top + 1, top + 2, s.collar)
      c.rect(11, top + 8, 10, 3, s.shirt[0]); c.hline(11, 20, top + 8, s.shirt[2])
    }
    const logo = LOGOS[kind]
    if (logo) c.stamp(kind === 'codex' ? 13 : 13, top + (kind === 'codex' ? 4 : 5), logo, { x: s.logo })
    if (kind === 'general') { c.rect(17, top + 4, 3, 3, shade); c.hline(17, 19, top + 4, s.collar) }
    if (kind === 'boss') {
      for (let j = 0; j < 5; j++) c.hline(15 - Math.floor(j / 2), 16 + Math.floor(j / 2), top + j, s.collar)
      c.rect(15, top + 1, 2, 2, '#c0392b'); c.vline(15, top + 3, top + 9, '#c0392b'); c.vline(16, top + 3, top + 10, '#a5281f')
      c.line(13, top + 1, 12, top + 6, light); c.line(18, top + 1, 19, top + 6, shade)
      c.set(11, top + 4, '#f2c230'); c.set(13, top + 4, '#f2c230'); c.hline(11, 13, top + 5, '#f2c230'); c.set(12, top + 4, '#fff3a8')
      c.set(17, top + 8, '#1d2440'); c.set(17, top + 11, '#1d2440')
    }
  } else {
    if (kind === 'boss') c.vline(15, top + 6, 35, shade)
    if (kind === 'codex') { c.round(11, top, 10, 4, 1, '#3a3a40'); c.hline(12, 19, top + 3, '#19191c') }
    if (kind === 'gemini') c.stamp(14, top + 6, ['..x..', '.xxx.', '..x..'], { x: STYLE.gemini.logo })
  }
}

function arm(c, s, skin, side, kind, p, g, dir) {
  const [, base, shade] = s.shirt
  const L = side < 0
  const sx = L ? 7 : 22
  const sleeve = L ? base : shade
  const hand = skin[0], handShade = skin[1]
  const top = g.T
  if (p.arms === 'type') {
    if (dir === 'front') {
      c.rect(sx, top + 1, 3, 5, sleeve)
      const lift = (p.tap === (L ? 0 : 1) || p.tap === (L ? 2 : 3)) && p.tap % 2 === (L ? 0 : 1) ? 1 : 0
      const y = top + 6 - lift
      if (L) { c.rect(8, y, 5, 2, sleeve); c.rect(11, y, 3, 2, hand); c.hline(11, 13, y + 1, handShade) }
      else { c.rect(19, y, 5, 2, sleeve); c.rect(18, y, 3, 2, hand); c.hline(18, 20, y + 1, handShade) }
    } else {
      const out = (p.tap + (L ? 0 : 1)) % 2
      c.rect(L ? sx - out : sx + out, top + 1, 3, 6, sleeve)
      c.rect(L ? sx + 1 - out : sx + out, top + 6, 2, 2, sleeve)
    }
    return
  }
  if (p.arms === 'throw' && !L && p.phase === 1) {
    // Release: the arm swings out to the side, hand open.
    c.rect(22, top, 3, 3, sleeve)
    c.rect(24, top + 1, 5, 3, sleeve); c.hline(24, 28, top + 3, mix(sleeve, OUT, 0.25))
    c.rect(29, top + 1, 3, 3, hand); c.vline(31, top + 1, top + 3, handShade)
    return
  }
  if ((p.arms === 'raise' || p.arms === 'throw') && !L) {
    const w = p.wave ?? 0
    c.rect(22, top, 3, 3, sleeve)
    c.rect(24, g.H + 1, 3, top - g.H + 1, sleeve)
    c.vline(26, g.H + 1, top + 1, mix(sleeve, OUT, 0.25))
    c.rect(24 + w, g.H - 3, 3, 4, hand)
    c.set(24 + w, g.H - 4, hand); c.set(26 + w, g.H - 4, hand)
    c.vline(26 + w, g.H - 3, g.H, handShade)
    return
  }
  if (p.arms === 'stretch') {
    const r = p.reach ?? 0
    const x = L ? 5 - r : 24 + r
    c.rect(L ? 7 : 22, top, 3, 3, sleeve)
    c.rect(x, g.H + 2 - r, 3, top - g.H, sleeve)
    c.rect(x, g.H - 2 - r, 3, 4, hand)
    c.vline(L ? x : x + 2, g.H - 2 - r, g.H + 1 - r, handShade)
    return
  }
  // Arms down at the sides (swinging a little while walking).
  const sw = p.walk === undefined ? 0 : p.walk === 0 ? (L ? -1 : 1) : p.walk === 2 ? (L ? 1 : -1) : 0
  c.rect(sx, top + 1, 3, 9 + sw, sleeve)
  c.vline(L ? sx : sx + 2, top + 2, top + 9 + sw, L ? mix(base, '#ffffff', 0.12) : mix(shade, OUT, 0.15))
  c.rect(sx, top + 10 + sw, 3, 2, hand)
  c.hline(sx, sx + 2, top + 11 + sw, handShade)
  void kind
}

function hair(c, kind, s, g, dir) {
  const [light, base, dark] = s.hair
  const H = g.H
  if (dir === 'back') {
    c.round(8, H, 16, 15, 5, base)
    c.hline(11, 17, H + 1, light); c.hline(10, 13, H + 2, light)
    for (let y = H + 10; y < H + 15; y++) c.hline(9, 22, y, dark)
    if (kind === 'claude') { c.rect(8, H + 8, 2, 8, base); c.rect(22, H + 8, 2, 8, base); c.hline(9, 22, H + 15, dark) }
    if (kind === 'codex') for (const x of [10, 14, 18, 21]) c.set(x, H - 1, base)
    return
  }
  // Front: cap of hair, side locks, fringe.
  c.round(8, H, 16, 7, 4, base)
  c.hline(11, 18, H + 1, light); c.hline(10, 13, H + 2, light)
  c.rect(8, H + 4, 2, kind === 'claude' ? 10 : 6, base)
  c.rect(22, H + 4, 2, kind === 'claude' ? 10 : 6, kind === 'claude' ? dark : base)
  const fringe = {
    claude: ['xxxxxxxxxxxxxxxx', 'xxxx.xxxxx..xxxx', 'xx....xx.....xxx'],
    codex: ['xxxxxxxxxxxxxxxx', 'xx.xx.xxx.xx.xxx', '.x..x...x..x..x.'],
    gemini: ['xxxxxxxxxxxxxxxx', 'xxxxxxxxx....xxx', 'xxxxxx.......xxx'],
    general: ['xxxxxxxxxxxxxxxx', 'xxxxxxx.xxxxxxxx', 'xx.xxx...xxx.xxx'],
    user: ['xxxxxxxxxxxxxxxx', 'xxxxxxxxxxx..xxx', 'xxxxxx.......xxx'],
    boss: ['xxxxxxxxxxxxxxxx', 'xxx..........xxx', 'xx............xx']
  }[kind]
  c.stamp(8, H + 5, fringe, { x: base })
  c.hline(9, 22, H + 7, mix(base, dark, 0.5))
  for (let x = 9; x < 23; x++) if (c.get(x, H + 7)[0] && c.get(x, H + 8)[3] && fringe[2][x - 8] === 'x') c.set(x, H + 7, dark)
  if (kind === 'codex') for (const x of [9, 13, 17, 21]) c.set(x, H - 1, base)
  if (kind === 'user') { c.set(16, H - 1, base); c.set(17, H - 2, base) }
}

function face(c, kind, g, p) {
  const [skin, shade] = SKIN[kind]
  const H = g.H
  c.round(8, H + 3, 16, 14, 5, skin)
  c.vline(22, H + 7, H + 14, shade); c.vline(21, H + 12, H + 15, shade)
  c.hline(12, 20, H + 16, shade)
  c.rect(7, H + 9, 1, 3, skin); c.rect(24, H + 9, 1, 3, shade)
  const eye = '#2b1d1b', shine = '#ffffff'
  const eyes = p.eyes ?? 'open'
  for (const x of [11, 19]) {
    if (eyes === 'open') { c.rect(x, H + 9, 2, 3, eye); c.set(x, H + 9, shine) }
    else if (eyes === 'down') { c.rect(x, H + 10, 2, 2, eye); c.hline(x, x + 1, H + 9, mix(skin, eye, 0.35)) }
    else if (eyes === 'closed') c.hline(x, x + 1, H + 11, eye)
    else if (eyes === 'happy') { c.set(x, H + 11, eye); c.set(x + 1, H + 10, eye); c.set(x + 2, H + 11, eye) }
    else if (eyes === 'dot') c.rect(x + 1, H + 10, 1, 2, eye)
  }
  c.hline(9, 10, H + 13, '#eaa08a'); c.hline(21, 22, H + 13, '#e3957f')
  if (kind === 'boss') { c.hline(13, 18, H + 12, '#a9adba'); c.set(12, H + 13, '#a9adba'); c.set(19, H + 13, '#a9adba') }
  const mouth = p.mouth ?? 'smile', lip = '#8a3b33'
  if (mouth === 'smile') { c.set(14, H + 13, lip); c.hline(15, 16, H + 14, lip); c.set(17, H + 13, lip) }
  else if (mouth === 'flat') c.hline(15, 16, H + 14, lip)
  else if (mouth === 'o') { c.rect(15, H + 13, 2, 2, lip); c.set(15, H + 13, '#5a2420') }
  else if (mouth === 'grin') { c.hline(14, 17, H + 13, lip); c.hline(15, 16, H + 14, '#d86a6a') }
}

function backHead(c, kind, g) {
  const [skin, shade] = SKIN[kind]
  c.rect(7, g.H + 9, 1, 3, skin)
  c.rect(24, g.H + 9, 1, 3, shade)
  c.rect(13, g.H + 15, 6, 2, shade)
}

function askBubble(c, p) {
  const y = p.ask ? 1 : 0
  c.round(0, y, 9, 10, 2, '#fffaf0')
  c.set(3, y + 10, '#fffaf0'); c.set(2, y + 11, '#fffaf0')
  c.stamp(2, y + 2, ['.xxx.', 'x...x', '...x.', '..x..', '.....', '..x..'], { x: '#c0392b' })
}

/** One body frame. */
export function drawBody(kind, dir, pose) {
  const c = new Pix(FRAME.w, FRAME.h)
  const s = STYLE[kind], skin = SKIN[kind], g = geometry(pose)
  legs(c, s, dir, pose)
  if (dir === 'back') {
    arm(c, s, skin, -1, kind, pose, g, dir); arm(c, s, skin, 1, kind, pose, g, dir)
    torso(c, kind, s, g, dir)
    if (pose.arms === 'raise' || pose.arms === 'stretch' || pose.arms === 'throw') { arm(c, s, skin, 1, kind, pose, g, dir); if (pose.arms === 'stretch') arm(c, s, skin, -1, kind, pose, g, dir) }
    backHead(c, kind, g)
    hair(c, kind, s, g, dir)
  } else {
    torso(c, kind, s, g, dir)
    face(c, kind, g, pose)
    hair(c, kind, s, g, dir)
    arm(c, s, skin, -1, kind, pose, g, dir); arm(c, s, skin, 1, kind, pose, g, dir)
  }
  if (pose.arms === 'raise' && !pose.noAsk) askBubble(c, pose)
  c.outline(OUT, 0.62)
  if (pose.grey) c.desaturate(0.55)
  contactShadow(c)
  return c
}

/** Soft contact shadow, only under the artwork. */
function contactShadow(c) {
  for (let y = 42; y <= 46; y++) for (let x = 6; x <= 26; x++) {
    const nx = (x - 16) / 9, ny = (y - 44) / 2.2
    if (nx * nx + ny * ny <= 1 && !c.alpha(x, y)) c.set(x, y, '#2b1d1b40')
  }
}

const H = (g) => g.H

/** «Вы» (object.user): standing, a closed laptop hugged to the chest, a mug of tea.
 *  Same frame and anchor as the agents; frame 0 is the still pose. */
export const USER_POSES = [{ steam: 0 }, { steam: 1 }, { steam: 2, bob: 1 }, { steam: 0, eyes: 'closed' }]
export const USER_DURATIONS = [600, 600, 600, 140]
export function drawUser(pose) {
  const c = new Pix(FRAME.w, FRAME.h)
  const s = STYLE.user, [hand, handShade] = SKIN.user, g = geometry(pose), T = g.T
  const [, base, shade] = s.shirt
  legs(c, s, 'front')
  torso(c, 'user', s, g, 'front')
  for (let x = 10; x <= 21; x += 2) c.set(x, 34, shade)
  face(c, 'user', g, pose)
  hair(c, 'user', s, g, 'front')
  // Left arm hugs the laptop: upper arm, elbow, forearm under the laptop, hand at its corner.
  c.rect(7, T + 1, 3, 8, base); c.vline(7, T + 2, T + 8, mix(base, '#ffffff', 0.12))
  c.rect(8, T + 8, 9, 3, base); c.hline(8, 16, T + 10, shade)
  c.rect(9, T + 2, 10, 7, '#c9d1d6'); c.hline(9, 18, T + 2, '#eef1f3'); c.vline(9, T + 3, T + 8, '#e2e7ea')
  c.vline(18, T + 3, T + 8, '#a9b3bb'); c.hline(9, 18, T + 8, '#8a96a3')
  c.rect(15, T + 4, 2, 2, '#e06a9b'); c.set(11, T + 6, '#4fb3e0'); c.set(12, T + 6, '#4fb3e0')
  c.rect(16, T + 8, 3, 2, hand); c.hline(16, 18, T + 9, handShade)
  if (pose.throw !== undefined) {
    // Throw (user_prompt): the mug is put down, the right hand lifts a note / sends it.
    if (pose.throw === 0) { c.rect(22, T, 3, 3, shade); c.rect(24, H(g) + 2, 3, T - H(g) - 1, shade); c.rect(24, H(g) - 2, 3, 4, hand); c.rect(23, H(g) - 6, 7, 5, '#cfe6ff'); c.hline(23, 29, H(g) - 6, '#ffffff'); c.line(23, H(g) - 2, 29, H(g) - 6, '#5a8fd0') }
    else { c.rect(22, T, 3, 3, shade); c.rect(24, T + 1, 5, 3, shade); c.rect(29, T + 1, 3, 3, hand) }
    c.outline(OUT, 0.62)
    contactShadow(c)
    return c
  }
  // Right arm bent forward with the mug.
  c.rect(22, T + 1, 3, 6, shade); c.rect(22, T + 6, 2, 2, shade)
  const mx = 24, my = T + 3
  c.rect(mx, my, 5, 6, '#f6efe3'); c.hline(mx, mx + 4, my, '#7a4a32'); c.vline(mx + 4, my + 1, my + 5, '#d8cbb5')
  c.hline(mx, mx + 3, my + 3, '#c0392b')
  c.vline(mx + 5, my + 2, my + 3, '#f6efe3'); c.vline(mx + 6, my + 2, my + 3, '#d8cbb5')
  c.rect(23, my + 3, 2, 3, hand); c.set(23, my + 5, handShade)
  c.outline(OUT, 0.62)
  // Steam rises after the outline so it stays soft.
  const puffs = [[[26, 2], [25, 3], [25, 4], [26, 5]], [[25, 2], [26, 3], [26, 4], [25, 6]], [[26, 2], [26, 3], [25, 5], [25, 6]]][pose.steam]
  puffs.forEach(([x, dy], i) => c.set(x, my - dy, i < 2 ? '#ffffffc8' : '#ffffff80'))
  contactShadow(c)
  return c
}

/** One role overlay frame, same geometry as drawBody(kind, dir, pose). */
export function drawRole(role, dir, pose) {
  const c = new Pix(FRAME.w, FRAME.h)
  const g = geometry(pose), H = g.H, T = g.T
  const front = dir === 'front'
  switch (role) {
    case 'lead': {
      c.hline(10, 21, H - 1, '#3d4250'); c.hline(9, 22, H, '#3d4250'); c.hline(11, 20, H - 1, '#59607a')
      c.vline(8, H + 1, H + 7, '#3d4250'); c.vline(23, H + 1, H + 7, '#3d4250')
      c.round(6, H + 7, 3, 5, 1, '#d97757'); c.round(23, H + 7, 3, 5, 1, '#d97757')
      c.vline(6, H + 8, H + 10, '#f2a57f'); c.vline(25, H + 8, H + 10, '#b55a3e')
      if (front) { c.line(8, H + 12, 11, H + 14, '#3d4250'); c.rect(12, H + 14, 2, 1, '#2b1d1b') }
      break
    }
    case 'reviewer': {
      if (front) {
        for (const x of [10, 18]) {
          c.hline(x, x + 3, H + 8, '#8a5a32'); c.hline(x, x + 3, H + 12, '#8a5a32'); c.vline(x - 1, H + 9, H + 11, '#8a5a32'); c.vline(x + 4, H + 9, H + 11, '#8a5a32')
          c.set(x, H + 9, '#dff3ff'); c.set(x + 3, H + 11, '#dff3ff')
        }
        c.hline(14, 17, H + 9, '#8a5a32')
        if (pose.arms !== 'type') { c.round(17, T + 3, 5, 5, 2, '#c9d1d6'); c.rect(18, T + 4, 3, 3, '#bfe6ff'); c.set(18, T + 4, '#ffffff'); c.vline(19, T + 8, T + 10, '#7a5636') }
      } else {
        c.hline(7, 8, H + 9, '#5a3a22'); c.hline(23, 24, H + 9, '#5a3a22')
        c.round(22, 31, 5, 5, 2, '#c9d1d6'); c.rect(23, 32, 3, 3, '#bfe6ff'); c.vline(24, 36, 38, '#7a5636')
      }
      break
    }
    case 'devops': {
      c.round(8, H - 2, 16, 7, 4, '#f2c230'); c.hline(11, 17, H - 1, '#ffe27a'); c.vline(15, H - 2, H + 4, '#d9a21b'); c.vline(16, H - 2, H + 4, '#d9a21b')
      c.hline(6, 25, H + 5, '#d9a21b'); c.hline(7, 24, H + 4, '#f2c230')
      if (pose.arms !== 'raise' && pose.arms !== 'stretch') {
        const x = front ? 21 : 7
        c.round(x, T - 1, 5, 6, 2, '#3a6fb0'); c.vline(x + 1, T, T + 3, '#5a8fd0')
        c.clear(x + 2, T + 1); c.clear(x + 2, T + 2)
        c.rect(x + 1, T + 5, 2, 2, '#8a96a3'); c.set(x + 1, T + 7, '#d0d6dc')
      }
      break
    }
    case 'frontend': {
      c.round(8, H - 1, 16, 7, 4, '#3fb6c9'); c.hline(11, 18, H, '#7fe0ec'); c.rect(15, H - 2, 2, 1, '#2a8a9b')
      if (front) { c.rect(3, H + 5, 7, 2, '#2a8a9b'); c.hline(3, 8, H + 5, '#3fb6c9') } else c.rect(22, H + 5, 7, 2, '#2a8a9b')
      if (front && pose.arms !== 'type') c.stamp(12, T + 5, ['.x...x.', 'x..x..x', '.x.x.x.'], { x: '#3fb6c9' })
      break
    }
    case 'backend': {
      c.round(8, H - 2, 16, 8, 5, '#5d6f8c'); c.hline(11, 18, H - 1, '#7f92b0')
      for (let x = 8; x <= 23; x++) c.set(x, H + 4, x % 2 ? '#7f92b0' : '#4a5a74'); c.hline(8, 23, H + 5, '#4a5a74')
      c.round(14, H - 5, 4, 4, 1, '#e9eef5'); c.set(15, H - 4, '#ffffff')
      if (front && pose.arms !== 'type') c.stamp(12, T + 4, ['.x.x.', 'xxxxx', 'xx.xx', 'xxxxx', '.x.x.'], { x: '#c9d1d6' })
      break
    }
    case 'docs': {
      const x = front ? 23 : 6
      c.line(x, H + 3, x + 3, H + 8, '#f2c230'); c.line(x + 1, H + 3, x + 4, H + 8, '#d9a21b')
      c.set(x, H + 2, '#e88aa0'); c.set(x + 1, H + 2, '#e88aa0'); c.set(x + 4, H + 9, '#2b1d1b')
      if (front && pose.arms !== 'type' && pose.arms !== 'raise') { c.rect(11, T + 4, 6, 5, '#fffaf0'); c.vline(14, T + 4, T + 8, '#c9b48a'); c.rect(11, T + 8, 6, 1, '#7a5636'); c.hline(12, 13, T + 6, '#9aa5ad'); c.hline(15, 16, T + 6, '#9aa5ad') }
      break
    }
    case 'designer': {
      c.ellipse(15, H + 1, 9, 3, '#c2447a'); c.hline(9, 18, H, '#e06a9b'); c.rect(15, H - 3, 2, 2, '#9c2f5e')
      const x = front ? 4 : 25
      c.line(x, H + 4, x + 3, H + 9, '#7a5636'); c.rect(x - 1, H + 2, 2, 2, '#3fb6c9')
      break
    }
    case 'general': {
      if (front) {
        if (pose.arms !== 'type') { c.line(12, T, 15, T + 4, '#3a6fb0'); c.line(19, T, 16, T + 4, '#3a6fb0'); c.rect(14, T + 5, 4, 5, '#fffaf0'); c.hline(14, 17, T + 5, '#3a6fb0'); c.rect(15, T + 7, 2, 1, '#9aa5ad') }
        else { c.line(12, T, 15, T + 3, '#3a6fb0'); c.line(19, T, 16, T + 3, '#3a6fb0') }
      } else c.hline(12, 19, T, '#3a6fb0')
      break
    }
  }
  c.outline(OUT, 0.55)
  if (pose.grey) c.desaturate(0.55)
  return c
}

// ---------------------------------------------------------------- side view (facing right)

function hairSide(c, kind, s, g) {
  const [light, base, dark] = s.hair, H = g.H
  c.round(9, H, 14, 8, 4, base)
  c.rect(9, H + 4, 6, 8, base)
  c.hline(12, 18, H + 1, light); c.hline(11, 14, H + 2, light)
  c.rect(18, H + 4, 4, 2, base); c.set(21, H + 6, base)
  c.vline(9, H + 5, H + 11, dark)
  if (kind === 'claude') { c.rect(8, H + 6, 4, 11, base); c.vline(8, H + 8, H + 16, dark); c.hline(9, 11, H + 16, dark) }
  if (kind === 'codex') for (const x of [10, 13, 16, 19]) c.set(x, H - 1, base)
  if (kind === 'gemini') { c.rect(19, H + 4, 4, 3, base); c.set(22, H + 7, base) }
  if (kind === 'user') { c.set(16, H - 1, base); c.set(17, H - 2, base) }
}

/** Side view, facing right; the engine mirrors it for walking left. pose: { walk?: 0..3, bob?, eyes?, mouth?, grey? } */
export function drawSide(kind, pose = {}) {
  const k = STYLE[kind] ? kind : 'general'
  const c = new Pix(FRAME.w, FRAME.h)
  const s = STYLE[k], [skin, skinShade] = SKIN[k], g = geometry(pose), Hh = g.H, T = g.T
  const [light, base, shade] = s.shirt, [pants, pantsShade] = s.pants
  const w = pose.walk
  const off = w === undefined ? [1, -1] : [[3, -3], [0, 0], [-3, 3], [0, 0]][w]
  const lift = w === undefined ? [0, 0] : [[0, 0], [1, 0], [0, 0], [0, 1]][w]
  const leg = (dx, lifted, col, shoe) => {
    for (let y = 35; y <= 41 - lifted; y++) c.rect(14 + Math.round((dx * (y - 35)) / 6), y, 4, 1, col)
    const fx = 14 + dx
    c.rect(fx, 42 - lifted, 5, 2, shoe); c.hline(fx, fx + 4, 42 - lifted, mix(shoe, '#ffffff', 0.18))
  }
  leg(off[1], lift[1], pantsShade, '#3b2b26')
  leg(off[0], lift[0], pants, '#4a3329')
  c.rect(12, T, 9, 36 - T, base); c.vline(12, T + 1, 35, light); c.vline(20, T + 1, 35, shade); c.hline(12, 20, 35, shade)
  c.hline(17, 19, T, s.collar)
  if (k === 'boss') { c.vline(19, T + 1, T + 3, s.collar); c.vline(20, T + 1, T + 8, '#c0392b'); c.set(18, T + 4, '#f2c230') }
  if (k === 'gemini') for (let y = T + 7; y < 35; y++) for (let x = 12; x <= 20; x++) if ((x + y) % 2 === 0) c.set(x, y, mix(c.get(x, y), STYLE.gemini.accent, 0.45))
  if (k === 'codex') { c.round(11, T - 1, 6, 4, 1, '#3a3a40') }
  c.rect(15, Hh + 16, 3, Math.max(1, T - Hh - 16), skinShade)
  c.round(10, Hh + 3, 13, 14, 5, skin)
  c.vline(22, Hh + 8, Hh + 13, skinShade)
  c.set(23, Hh + 10, skin); c.set(23, Hh + 11, skinShade)
  c.rect(15, Hh + 9, 2, 3, skinShade)
  const eye = '#2b1d1b', eyes = pose.eyes ?? 'open'
  if (eyes === 'open') { c.rect(19, Hh + 9, 2, 3, eye); c.set(19, Hh + 9, '#ffffff') }
  else if (eyes === 'closed') c.hline(19, 20, Hh + 11, eye)
  else if (eyes === 'happy') { c.set(19, Hh + 11, eye); c.set(20, Hh + 10, eye); c.set(21, Hh + 11, eye) }
  else c.rect(20, Hh + 10, 1, 2, eye)
  c.set(18, Hh + 13, '#eaa08a')
  const mouth = pose.mouth ?? 'smile', lip = '#8a3b33'
  if (mouth === 'smile') { c.set(20, Hh + 13, lip); c.set(21, Hh + 14, lip) }
  else if (mouth === 'o') c.rect(20, Hh + 13, 2, 2, lip)
  else c.hline(20, 21, Hh + 14, lip)
  hairSide(c, k, s, g)
  const a = w === undefined ? 0 : [-2, 0, 2, 0][w]
  for (let y = T + 1; y <= T + 9; y++) c.rect(15 + Math.round((a * (y - T)) / 9), y, 3, 1, y === T + 1 ? light : base)
  c.rect(15 + a, T + 10, 3, 2, skin); c.hline(15 + a, 17 + a, T + 11, skinShade)
  c.outline(OUT, 0.62)
  if (pose.grey) c.desaturate(0.55)
  contactShadow(c)
  return c
}

/** Role overlay for drawSide (same geometry). */
export function drawRoleSide(role, pose = {}) {
  const c = new Pix(FRAME.w, FRAME.h)
  const g = geometry(pose), Hh = g.H, T = g.T
  switch (role) {
    case 'lead':
      c.hline(11, 19, Hh - 1, '#59607a'); c.hline(10, 20, Hh, '#3d4250'); c.vline(13, Hh + 1, Hh + 7, '#3d4250')
      c.round(12, Hh + 7, 4, 5, 1, '#d97757'); c.vline(12, Hh + 8, Hh + 10, '#f2a57f')
      c.line(15, Hh + 12, 20, Hh + 14, '#3d4250'); c.rect(20, Hh + 14, 2, 1, '#2b1d1b')
      break
    case 'reviewer':
      c.rect(18, Hh + 8, 5, 5, '#8a5a32'); c.rect(19, Hh + 9, 3, 3, '#dff3ff'); c.set(19, Hh + 9, '#ffffff'); c.hline(15, 17, Hh + 9, '#8a5a32')
      break
    case 'devops':
      c.round(9, Hh - 2, 14, 7, 4, '#f2c230'); c.hline(12, 18, Hh - 1, '#ffe27a'); c.vline(16, Hh - 2, Hh + 4, '#d9a21b')
      c.hline(8, 25, Hh + 5, '#d9a21b'); c.hline(9, 24, Hh + 4, '#f2c230')
      break
    case 'frontend':
      c.round(9, Hh - 1, 13, 7, 4, '#3fb6c9'); c.hline(12, 18, Hh, '#7fe0ec'); c.rect(21, Hh + 4, 6, 2, '#2a8a9b'); c.hline(21, 26, Hh + 4, '#3fb6c9')
      break
    case 'backend':
      c.round(9, Hh - 2, 14, 8, 5, '#5d6f8c'); c.hline(12, 18, Hh - 1, '#7f92b0')
      for (let x = 9; x <= 22; x++) c.set(x, Hh + 4, x % 2 ? '#7f92b0' : '#4a5a74'); c.hline(9, 22, Hh + 5, '#4a5a74')
      c.round(13, Hh - 5, 4, 4, 1, '#e9eef5'); c.set(14, Hh - 4, '#ffffff')
      break
    case 'docs':
      c.line(12, Hh + 4, 15, Hh + 9, '#f2c230'); c.line(13, Hh + 4, 16, Hh + 9, '#d9a21b'); c.set(12, Hh + 3, '#e88aa0'); c.set(16, Hh + 10, '#2b1d1b')
      break
    case 'designer':
      c.ellipse(15, Hh + 1, 8, 3, '#c2447a'); c.hline(9, 18, Hh, '#e06a9b'); c.rect(14, Hh - 3, 2, 2, '#9c2f5e')
      break
    case 'general':
      c.line(18, T, 19, T + 4, '#3a6fb0'); c.rect(18, T + 5, 3, 4, '#fffaf0'); c.hline(18, 20, T + 5, '#3a6fb0')
      break
  }
  c.outline(OUT, 0.55)
  if (pose.grey) c.desaturate(0.55)
  return c
}

/** «Главный босс». pose: sit | stand | dispatch (phase 0 windup, 1 fan release, 2 follow-through) | pleased | walk (side). */
export function drawBoss({ pose = 'stand', phase = 0, bob = 0, eyes, walk } = {}) {
  if (pose === 'walk') return drawSide('boss', { walk, bob })
  const p = { bob, eyes }
  if (pose === 'dispatch') Object.assign(p, { arms: 'stretch', reach: phase === 0 ? 0 : 1, mouth: phase === 2 ? 'grin' : 'smile', eyes: phase === 2 ? 'happy' : eyes })
  if (pose === 'pleased') Object.assign(p, { eyes: 'happy', mouth: 'grin', bob: phase })
  const c = drawBody('boss', 'front', p)
  const env = (x, y, gold) => { c.rect(x - 1, y - 1, 8, 6, OUT); c.rect(x, y, 6, 4, gold ? '#f6e3a0' : '#fffaf0'); c.line(x, y, x + 3, y + 2, '#c9a24a'); c.line(x + 5, y, x + 3, y + 2, '#c9a24a'); c.set(x + 3, y + 3, '#c0392b') }
  const H = 6 + bob
  if (pose === 'dispatch' && phase === 0) { env(21, 5, true); env(23, 3, true); env(25, 1, true) }
  if (pose === 'dispatch' && phase === 1) { env(1, 8, true); env(13, 1, true); env(25, 8, true) }
  if (pose === 'pleased') { c.set(12, 28 + bob, '#ffffff'); c.set(11, 27 + bob, '#fff3a8'); c.set(13, 27 + bob, '#fff3a8') }
  return c
}
