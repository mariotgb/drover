// Reference renderer that uses ONLY a v2 manifest + atlases (what the engine has):
// one hall with a lead and a bench row, lounge, corridor strip. Proves slots, nine-slices,
// font, lights and emissive frames fit together. Output: preview sample per set.
import { Pix } from '../canvas.mjs'
import { LightMap } from './light.mjs'

export function renderSample({ manifest: M, pixes }, { agents, carrierT = 0.45 } = {}) {
  const T = 16, hall = { x: 32, y: 32, w: 20 * T, h: 20 * T }
  const W = hall.x * 2 + hall.w, H = hall.y + hall.h + 5 * T + 24
  const world = new Pix(W, H), emit = new Pix(W, H)
  const light = new LightMap(W, H, M.lighting.ambient)
  const L = M.layers
  const queue = [], overlays = []
  const frameOf = (id, state, i = 0) => {
    const s = M.sprites[id]
    if (!s) throw new Error('missing sprite ' + id)
    const a = s.states[state] ?? Object.values(s.states)[0]
    return { s, f: a.frames[i % a.frames.length] }
  }
  const blitFrame = (target, s, f, x, y, rectKey = 'rect') => {
    const r = f[rectKey]
    target.blit(pixes[s.atlas], r.x, r.y, r.width, r.height, Math.round(x - f.anchor.x), Math.round(y - f.anchor.y))
  }
  const put = (id, state, x, y, { i = 0, sortY = y, unlit = false } = {}) => {
    const { s, f } = frameOf(id, state, i)
    for (const l of s.lights ?? []) if (!l.states || l.states.includes(state)) light.pool(x + l.dx, y + l.dy, l.rx, l.ry, l.color, l.k)
    const flat = ['floor', 'floor-shade', 'rug'].includes(s.layers[0])
    const item = { y: flat ? sortY - 1e6 : sortY, layer: L.indexOf(s.layers[0]), draw: () => { blitFrame(world, s, f, x, y); if (f.emit) blitFrame(unlit ? world : emit, s, f, x, y, 'emit') } }
    if (unlit) overlays.push(item); else queue.push(item)
  }
  const tile = (id, tx, ty) => { const { s, f } = frameOf(id, 'default'); blitFrame(world, s, f, tx, ty); if (f.emit) blitFrame(emit, s, f, tx, ty, 'emit') }
  const text = (x, y, str, color) => {
    const F = M.font, oy = F.colors[color] ?? 0
    let cx = x
    for (const ch of str.toUpperCase()) {
      if (ch === ' ') { cx += F.space + F.spacing; continue }
      const g = F.glyphs[ch] ?? F.glyphs[F.fallback]
      world.blit(pixes.font, g.x, g.y + oy, g.w, F.height, cx, y); emit.blit(pixes.font, g.x, g.y + oy, g.w, F.height, cx, y)
      cx += g.w + F.spacing
    }
    return cx - x - F.spacing
  }
  const measure = (str) => [...str.toUpperCase()].reduce((n, ch) => n + (ch === ' ' ? M.font.space : (M.font.glyphs[ch] ?? M.font.glyphs['?']).w) + M.font.spacing, -M.font.spacing)
  const nine = (key, x, y, width, target = 'overlay') => {
    const n = M.nineSlices[key], { s, f } = frameOf(n.sprite, n.state)
    const r = f.rect, top = y - (n.sprite === 'object.sign' ? 3 : 0)
    const draw = (sx, sw, dx, dw) => { for (let i = 0; i < dw; i += sw) { const w = Math.min(sw, dw - i); const tgt = target === 'overlay' ? [world, emit] : [world]; for (const t of tgt) t.blit(pixes[s.atlas], r.x + sx, r.y, w, r.height, dx + i, top) } }
    draw(0, n.left, x, n.left); draw(n.left, r.width - n.left - n.right, x + n.left, width - n.left - n.right); draw(r.width - n.right, n.right, x + width - n.right, n.right)
  }
  const plaque = (cx, y, name, status, { pointer = 'down', variant } = {}) => {
    const v = variant ?? (status === 'blocked' ? 'blocked' : 'default'), n = M.nineSlices['plaque.' + v]
    const w = Math.min(n.maxWidth, measure(name) + n.textX + 2), x = Math.round(cx - w / 2)
    overlays.push({ y: 1e6, layer: 0, draw: () => {
      nine('plaque.' + v, x, y, w)
      const pt = frameOf('effect.plaque.pointer', `${pointer}:${v}`)
      blitFrame(world, pt.s, pt.f, cx, pointer === 'down' ? y + n.height : y - 2)
      const mk = frameOf('effect.status', status); blitFrame(world, mk.s, mk.f, x + n.markX, y + n.markY)
      text(x + n.textX, y + n.textY, name, status === 'unknown' ? 'dim' : 'ink')
      if (v === 'lead') { const st = frameOf('effect.star', 'default'); blitFrame(world, st.s, st.f, x + w - 1, y) }
    } })
  }
  // ---- ground, floor, walls
  const ground = M.compositions.outside.ground
  for (let ty = 0; ty < H; ty += T) for (let tx = 0; tx < W; tx += T) tile(ground[(tx / T + ty / T * 3) % ground.length], tx, ty)
  for (let ty = hall.y + 3 * T; ty < hall.y + hall.h - T; ty += T) for (let tx = hall.x + T; tx < hall.x + hall.w - T; tx += T) tile(`tile.floor.hall.${(((tx / T) * 7 + (ty / T) * 3) % 4 + 4) % 4}`, tx, ty)
  for (let tx = hall.x; tx < hall.x + hall.w; tx += T) tile('tile.wall.cap', tx, hall.y)
  for (let tx = hall.x + T; tx < hall.x + hall.w - T; tx += T) { tile(`tile.wall.face.${(tx / T) % 2}`, tx, hall.y + T); tile('tile.wall.shade.top', tx, hall.y + 3 * T) }
  for (let ty = hall.y; ty < hall.y + hall.h; ty += T) { tile('tile.wall.side', hall.x, ty); tile('tile.wall.side', hall.x + hall.w - T, ty) }
  const door = { x: hall.x + 2 * T, w: 2 * T }
  for (let tx = hall.x; tx < hall.x + hall.w; tx += T) { if (tx >= door.x && tx < door.x + door.w) { tile('tile.floor.hall.0', tx, hall.y + hall.h - T); continue } tile('tile.wall.front', tx, hall.y + hall.h - T) }
  // corridor strip
  const cy = hall.y + hall.h
  for (let tx = 0; tx < W; tx += T) { tile(`tile.wall.face.${(tx / T) % 2}`, tx, cy); for (let k = 2; k < 5; k++) tile(`tile.floor.corridor.${(tx / T + k) % 3}`, tx, cy + k * T); tile(tx === 0 ? 'tile.runner.l' : tx >= W - T ? 'tile.runner.r' : 'tile.runner.c', tx, cy + 3 * T) }
  const C = M.compositions.corridor
  put(C.doorway.sprite, 'hall', door.x + C.doorway.dx, cy + C.doorway.dy)
  overlays.push({ y: 1e6, layer: 0, draw: () => { const w = measure('DROVER') + 6; nine('label.light', door.x + C.doorLabel.dx, cy + C.doorLabel.dy, w); text(door.x + C.doorLabel.dx + 3, cy + C.doorLabel.dy + 2, 'DROVER', 'ink') } })
  // ---- wall decor
  const Wc = M.compositions.wall
  put(Wc.board.sprite, 'default', hall.x + Wc.board.x, hall.y + Wc.board.y)
  const signText = 'DROVER', scale = 2, sn = M.nineSlices['sign.x2'], sw = measure(signText) * scale + 8 + 4 * scale
  const signX = Math.round(hall.x + hall.w / 2 - sw / 2), signY = hall.y + Wc.sign.top + 3
  nine('sign.x2', signX, signY, sw, 'world')
  for (const [k, row] of Object.entries(M.font.colors)) if (k === sn.font) { /* scaled text */ const F = M.font; let cx = signX + sn.textX; for (const ch of signText) { const g = F.glyphs[ch]; for (let j = 0; j < F.height; j++) for (let i = 0; i < g.w; i++) { const p = pixes.font.get(g.x + i, g.y + row + j); if (p[3]) { world.rect(cx + i * scale, signY + 3 + j * scale, scale, scale, p); if (M.theme === 'dark') emit.rect(cx + i * scale, signY + 3 + j * scale, scale, scale, p) } } cx += (g.w + F.spacing) * scale } }
  put(Wc.clock.sprite, '10:00', hall.x + hall.w / 2 + Wc.clock.wide.xc, hall.y + Wc.clock.wide.y)
  put(Wc.picture.sprite, '0', hall.x + hall.w / 2 + Wc.picture.xc, hall.y + Wc.picture.y)
  const winState = M.compositions.timeOfDay.default
  for (let x = Math.round(hall.x + hall.w / 2 + sw / 2 + Wc.windows.gap); x + Wc.windows.width <= hall.x + hall.w - T - Wc.windows.endGap; x += Wc.windows.step) {
    put(Wc.windows.sprite, winState, x + Wc.windows.anchorDx, hall.y + Wc.windows.y)
    const lw = M.lighting.window
    if (lw.kind === 'sun') light.poly([[x, hall.y + 3 * T], [x + lw.width, hall.y + 3 * T], [x + lw.width + lw.shift, hall.y + 3 * T + lw.depth], [x + lw.shift, hall.y + 3 * T + lw.depth]], lw.color, lw.k * lw.byTime[winState])
    else light.pool(x + lw.dx, hall.y + 3 * T + lw.dy, lw.rx, lw.ry, lw.color, lw.k * lw.byTime[winState])
  }
  // ---- head zone
  const cx = hall.x + hall.w / 2, deskAnchor = hall.y + 124
  const hd = M.sprites['object.desk.head'].slots
  const lead = agents[0]
  put('object.chair.lead', 'default', cx + hd.chair.x, deskAnchor + hd.chair.y)
  put(`agent.${lead.kind}`, `${lead.pose ?? lead.status}:front`, cx + hd.agent.x, deskAnchor + hd.agent.y, { i: 1 })
  put('role.lead', `${lead.pose ?? lead.status}:front`, cx + hd.agent.x, deskAnchor + hd.agent.y, { i: 1 })
  put('object.desk.head', 'on', cx, deskAnchor)
  plaque(cx + hd.agent.x, deskAnchor + hd.plaqueAgent.y, lead.name, lead.status, { variant: 'lead' })
  if (M.lighting.headDesk) light.pool(cx, deskAnchor - 28 + M.lighting.headDesk.dy, M.lighting.headDesk.rx, M.lighting.headDesk.ry, M.lighting.headDesk.color, M.lighting.headDesk.k)
  for (const it of [...M.compositions.head.narrow, ...M.compositions.head.wide]) put(it.sprite, it.state ?? 'default', it.xr !== undefined ? hall.x + hall.w - it.xr : it.xc !== undefined ? cx + it.xc : hall.x + it.x, hall.y + it.y)
  // ---- bench row
  const BS = M.sprites['object.bench.col'].slots, deskTop = hall.y + 168, by = deskTop + 36
  const workers = agents.slice(1)
  for (let c = 0; c < 4; c++) {
    const colX = hall.x + T + 48 + c * 48 + 24
    const n = workers[c], s = workers[c + 4]
    put('object.bench.col', `${['left', 'mid', 'mid', 'right'][c]}:${c % 4}`, colX, by)
    put('object.monitor.back', n ? 'on' : 'off', colX, by, { sortY: by + 0.1 })
    put('object.monitor.front', !s ? 'off' : s.status === 'blocked' ? 'ask' : s.status === 'done' ? 'done' : 'code', colX, by, { sortY: by + 0.2, i: c })
    if (M.lighting.pendant) light.pool(colX, deskTop + M.lighting.pendant.dy, M.lighting.pendant.rxPerColumn, M.lighting.pendant.ry, M.lighting.pendant.color, M.lighting.pendant.k)
    put('object.chair.front', n ? 'out' : 'in', colX + BS.chairNorth.x, by + BS.chairNorth.y)
    put('object.chair.back', s ? 'out' : 'in', colX + BS.chairSouth.x, by + (s ? BS.chairSouth.y : BS.chairSouthIn.y))
    for (const [a, side, dir] of [[n, 'North', 'front'], [s, 'South', 'back']]) {
      if (!a) continue
      const st = `${a.pose ?? a.status}:${dir}`, ax = colX + BS['agent' + side].x, ay = by + BS['agent' + side].y
      put(`agent.${a.kind}`, st, ax, ay, { i: c }); put(`role.${a.role}`, st, ax, ay, { i: c })
      plaque(colX + BS['plaque' + side].x, by + BS['plaque' + side].y, a.name, a.status, { pointer: side === 'North' ? 'down' : 'up' })
      const bub = a.status === 'blocked' ? '?' : a.status === 'done' ? 'ok' : a.pose === 'catch' ? '!' : null
      if (bub) put('effect.bubble', bub, colX + BS['bubble' + side].x, by + BS['bubble' + side].y, { unlit: true, sortY: 1e6 + 1 })
    }
  }
  // ---- lounge
  const ly = hall.y + 128 + 112, LC = M.compositions.lounge
  const items = [...LC.narrow.filter((it) => !LC.wide.some((w) => w.replaces === it.sprite || (w.replaces === 'narrow' && it.tiles))), ...LC.wide]
  for (const it of items) {
    if (it.tiles) { for (let ty = 0; ty < it.h; ty += T) for (let tx = 0; tx < it.w; tx += T) { const part = (ty === 0 ? 't' : ty + T >= it.h ? 'b' : '') + (tx === 0 ? 'l' : tx + T >= it.w ? 'r' : ''); tile(`${it.tiles}.${part || 'c'}`, hall.x + it.x + tx, ly + it.y + ty) } continue }
    put(it.sprite, it.state ?? 'default', it.xr !== undefined ? hall.x + hall.w - it.xr : hall.x + it.x, ly + it.y)
  }
  const pet = M.compositions.pet
  put(pet.sprite, pet.rest, M.theme === 'dark' ? hall.x + 2 * T + 6 : hall.x + 10 * T + 10, M.theme === 'dark' ? ly - 20 : ly + 22, { sortY: M.theme === 'dark' ? ly - 20 : ly + 31 })
  if (M.lighting.lounge) light.pool(hall.x + hall.w / 2, ly + M.lighting.lounge.dy, hall.w / 2, M.lighting.lounge.ry, M.lighting.lounge.color, M.lighting.lounge.k)
  // ---- draw
  queue.sort((a, b) => a.y - b.y || a.layer - b.layer)
  for (const q of queue) q.draw()
  light.apply(world, M.lighting.steps)
  world.blit(emit, 0, 0, W, H, 0, 0)
  // links and a carrier (procedural lines with palette + dot / carrier sprites)
  const Pa = M.palette
  const handLead = { x: cx + hd.hand.x, y: deskAnchor + hd.hand.y }
  const target = { x: hall.x + T + 48 + 1 * 48 + 24 + BS.landSouth.x, y: by + BS.landSouth.y }
  const linkTo = { x: hall.x + T + 48 + 24 + BS.headNorth.x, y: by + BS.headNorth.y - 12 }
  const bez = (a, b, lift, t) => { const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift * 0.6 - Math.hypot(b.x - a.x, b.y - a.y) * 0.1 }; return { x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y } }
  const la = { x: handLead.x - 12, y: handLead.y - 8 }
  for (let t = 0; t <= 1; t += 0.01) { const q = bez(la, linkTo, Pa.linkLift, t); if (Pa.linkStyle === 'beam' || Math.round(t * 100) % 3 === 0) world.set(Math.round(q.x), Math.round(q.y), Pa.link) }
  for (const k of [0.2, 0.6]) { const q = bez(la, linkTo, Pa.linkLift, k), d = frameOf('effect.link.dot', 'agent'); blitFrame(world, d.s, d.f, q.x, q.y) }
  for (let k = 1; k < 8; k++) { const q = bez(handLead, target, Pa.carrierLift, carrierT - k * 0.035); if (k % 2) { const d = frameOf('effect.trail', 'agent'); blitFrame(world, d.s, d.f, q.x, q.y) } }
  const p = bez(handLead, target, Pa.carrierLift, carrierT), p2 = bez(handLead, target, Pa.carrierLift, carrierT + 0.02)
  const ang = Math.atan2(p2.y - p.y, p2.x - p.x), idx = ((Math.round(ang / (Math.PI / 8)) % 16) + 16) % 16
  if (M.lighting.glowSprites) { const g = frameOf('effect.glow', 'cyan:m'); addBlit(world, pixes.effects, g.f.rect, Math.round(p.x - 16), Math.round(p.y - 16)) }
  const cr = frameOf('effect.carrier', `agent:${idx}`); blitFrame(world, cr.s, cr.f, p.x, p.y)
  overlays.sort((a, b) => a.y - b.y)
  for (const o of overlays) o.draw()
  return world
}

function addBlit(dst, src, r, dx, dy) {
  for (let j = 0; j < r.height; j++) for (let i = 0; i < r.width; i++) {
    const p = src.get(r.x + i, r.y + j)
    if (!p[3] || !dst.in(dx + i, dy + j)) continue
    const k = (dy + j) * dst.w + dx + i, a = p[3] / 255
    for (let c = 0; c < 3; c++) dst.d[k * 4 + c] = Math.min(255, dst.d[k * 4 + c] + p[c] * a)
  }
}

export const SAMPLE_AGENTS = [
  { name: 'lead', kind: 'claude', role: 'lead', status: 'working', pose: 'throw' },
  { name: 'backend', kind: 'codex', role: 'backend', status: 'working' },
  { name: 'frontend', kind: 'claude', role: 'frontend', status: 'idle', pose: 'catch' },
  { name: 'devops', kind: 'gemini', role: 'devops', status: 'working' },
  { name: 'docs', kind: 'general', role: 'docs', status: 'done' },
  { name: 'reviewer', kind: 'codex', role: 'reviewer', status: 'blocked' },
  { name: 'designer', kind: 'gemini', role: 'designer', status: 'working' },
  { name: 'general', kind: 'claude', role: 'general', status: 'unknown' }
]

/** A 14×13-tile room (lobby «Вы» or boss office) assembled from manifest compositions only. */
export function renderRoomSample({ manifest: M, pixes }, kind, { blocked = 2, bossPose = 'sit:front' } = {}) {
  const T = 16, room = { x: 16, y: 16, w: (kind === 'boss' ? 14 : 12) * T, h: 13 * T }
  const W = room.w + 32, H = room.h + 32
  const world = new Pix(W, H), emit = new Pix(W, H), light = new LightMap(W, H, M.lighting.ambient)
  const fr = (id, state) => { const s = M.sprites[id]; const a = s.states[state] ?? Object.values(s.states)[0]; return { s, f: a.frames[0] } }
  const blit = (t, s, f, x, y, key = 'rect') => { const r = f[key]; t.blit(pixes[s.atlas], r.x, r.y, r.width, r.height, Math.round(x - f.anchor.x), Math.round(y - f.anchor.y)) }
  const tile = (id, x, y) => { const { s, f } = fr(id, 'default'); blit(world, s, f, x, y); if (f.emit) blit(emit, s, f, x, y, 'emit') }
  const queue = [], late = []
  const put = (id, state, x, y, sortY = y) => { const { s, f } = fr(id, state); for (const l of s.lights ?? []) if (!l.states || l.states.includes(state)) light.pool(x + l.dx, y + l.dy, l.rx, l.ry, l.color, l.k); queue.push({ y: ['floor', 'floor-shade', 'rug'].includes(s.layers[0]) ? sortY - 1e6 : sortY, layer: M.layers.indexOf(s.layers[0]), draw: () => { blit(world, s, f, x, y); if (f.emit) blit(emit, s, f, x, y, 'emit') } }) }
  const text = (x, y, str, color, scale = 1) => { const F = M.font, oy = F.colors[color]; let cx = x; for (const ch of str.toUpperCase()) { if (ch === ' ') { cx += (F.space + 1) * scale; continue } const g = F.glyphs[ch] ?? F.glyphs['?']; for (let j = 0; j < F.height; j++) for (let i = 0; i < g.w; i++) { const p = pixes.font.get(g.x + i, g.y + oy + j); if (p[3]) world.rect(cx + i * scale, y + j * scale, scale, scale, p) } cx += (g.w + 1) * scale } }
  const measure = (str) => [...str.toUpperCase()].reduce((n, ch) => n + (ch === ' ' ? M.font.space : (M.font.glyphs[ch] ?? M.font.glyphs['?']).w) + 1, -1)
  const nine = (key, x, y, width) => { const n = M.nineSlices[key], { s, f } = fr(n.sprite, n.state), r = f.rect, top = n.sprite === 'object.sign' ? y - 3 : y; const seg = (sx, sw, dx, dw) => { for (let i = 0; i < dw; i += sw) world.blit(pixes[s.atlas], r.x + sx, r.y, Math.min(sw, dw - i), r.height, dx + i, top) }; seg(0, n.left, x, n.left); seg(n.left, r.width - n.left - n.right, x + n.left, width - n.left - n.right); seg(r.width - n.right, n.right, x + width - n.right, n.right) }
  for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) tile(M.compositions.outside.ground[(x / T + y / T) % M.compositions.outside.ground.length], x, y)
  for (let y = room.y + 3 * T; y < room.y + room.h - T; y += T) for (let x = room.x + T; x < room.x + room.w - T; x += T) tile(`tile.floor.lobby.${(x / T + y / T) % 2}`, x, y)
  for (let x = room.x; x < room.x + room.w; x += T) { tile('tile.wall.cap', x, room.y); tile('tile.wall.front', x, room.y + room.h - T) }
  for (let x = room.x + T; x < room.x + room.w - T; x += T) { tile(`tile.wall.face.${(x / T) % 2}`, x, room.y + T); tile('tile.wall.shade.top', x, room.y + 3 * T) }
  for (let y = room.y; y < room.y + room.h; y += T) { tile('tile.wall.side', room.x, y); tile('tile.wall.side', room.x + room.w - T, y) }
  const overlays = []
  for (const it of M.compositions[kind]) {
    const x = room.x + (it.xc !== undefined ? room.w / 2 + it.xc : it.xr !== undefined ? room.w - it.xr : it.x), y = room.y + (it.yb !== undefined ? room.h - it.yb : it.y)
    if (it.sign) { const sw = measure(it.sign) + 12; nine('sign.x1', Math.round(x - sw / 2), y + 3, sw); text(Math.round(x - sw / 2) + 6, y + 6, it.sign, 'sign'); continue }
    if (it.plaque) { overlays.push(() => { const n = M.nineSlices['plaque.' + it.plaque], w = measure(it.text) + n.textX + 2, px = Math.round(x - w / 2); nine('plaque.' + it.plaque, px, y, w); const m = fr('effect.status', kind === 'lobby' && blocked ? 'blocked' : 'working'); blit(world, m.s, m.f, px + n.markX, y + n.markY); text(px + n.textX, y + n.textY, it.text, 'ink'); const pt = fr('effect.plaque.pointer', `down:${it.plaque}`); blit(world, pt.s, pt.f, x, y + n.height) }); continue }
    if (it.label) { if (it.when === 'blocked' && !blocked) continue; overlays.push(() => { const str = it.text.replace('{n}', blocked), w = measure(str) + 6; nine('label.' + it.label, Math.round(x - w / 2), y, w); text(Math.round(x - w / 2) + 3, y + 2, str, it.label === 'warn' ? 'warn' : 'ink') }); continue }
    const state = it.sprite === 'agent.boss' ? bossPose : it.sprite === 'object.bell' && blocked ? 'ring' : it.sprite === 'object.window' ? M.compositions.timeOfDay.default : it.state ?? 'default'
    put(it.sprite, state, x, y, it.sortY !== undefined ? room.y + it.sortY : y)
  }
  for (const l of M.lighting[kind] ?? []) light.pool(room.x + l.x, room.y + l.y, l.rx, l.ry, l.color, l.k)
  queue.sort((a, b) => a.y - b.y || a.layer - b.layer)
  for (const q of queue) q.draw()
  light.apply(world, M.lighting.steps)
  world.blit(emit, 0, 0, W, H, 0, 0)
  for (const o of overlays) o()
  return world
}
