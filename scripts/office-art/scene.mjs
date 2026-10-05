// Reference scene: composes the generated atlases the way the engine should
// (lot 24×20 tiles, desks 4×3 at the engine's seat positions, Y-sorted sprites).
// Usage: node scripts/office-art/scene.mjs <out.png> [scale] [--offline]
import { writeFileSync } from 'node:fs'
import { Pix } from './canvas.mjs'
import { encodePng } from './png.mjs'
import { text } from './font.mjs'
import { build } from './build.mjs'

const T = 16
/** Agent/chair offsets relative to the desk anchor (bottom-centre of the 4×3 desk). */
export const SEAT_OFFSETS = {
  front: { agent: { x: 0, y: -27 }, chair: { x: 0, y: -28 } },
  back: { agent: { x: 0, y: 9 }, chair: { x: 0, y: 10 } }
}

export function renderScene({ offline = false } = {}) {
  const { pixes, manifest } = build()
  const W = 24 * 2 + 2 + 11, H = 20 + 1
  const world = new Pix(W * T, H * T)
  world.rect(0, 0, world.w, world.h, '#5e8a4a')
  for (let y = 0; y < world.h; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < world.w; x += 7) world.set(x, y, '#6f9a58')
  const LAYER = Object.fromEntries(manifest.layers.map((l, i) => [l, i]))
  const queue = []
  const frameOf = (id, state, index = 0) => {
    const s = manifest.sprites[id]
    const a = s.states[state] ?? s.states.default ?? Object.values(s.states)[0]
    return { sprite: s, f: a.frames[index % a.frames.length] }
  }
  const put = (id, state, x, y, index = 0, sort = true) => {
    const { sprite, f } = frameOf(id, state, index)
    const item = { sprite, f, x, y, layer: LAYER[sprite.layers[0]] ?? 0 }
    if (sort) queue.push(item)
    else draw(item)
  }
  const draw = ({ sprite, f, x, y }) => world.blit(pixes[sprite.atlas], f.rect.x, f.rect.y, f.rect.width, f.rect.height, Math.round(x - f.anchor.x), Math.round(y - f.anchor.y))
  const tile = (id, tx, ty) => put(id, 'default', tx * T, ty * T, 0, false)

  function room(ox, oy, carpet, agents, name) {
    for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) tile(`tile.floor.wood.${(x * 7 + y * 3) % 3}`, ox + x, oy + y)
    for (let y = 4; y < 16; y++) for (let x = 1; x < 23; x++) {
      const part = (y === 4 ? 't' : y === 15 ? 'b' : '') + (x === 1 ? 'l' : x === 22 ? 'r' : '')
      tile(`tile.floor.carpet.${carpet}.${part || 'c'}`, ox + x, oy + y)
    }
    for (let x = 0; x < 24; x++) { tile('tile.wall.cap', ox + x, oy); tile('tile.wall.face.top', ox + x, oy + 1); tile('tile.wall.face.bottom', ox + x, oy + 2); tile('tile.wall.shadow', ox + x, oy + 3) }
    for (let y = 1; y < 20; y++) { tile('tile.wall.cap', ox, oy + y); tile('tile.wall.cap', ox + 23, oy + y) }
    put('object.sign', 'default', (ox + 12) * T, (oy + 2) * T - 1)
    put('object.taskboard', 'default', (ox + 4) * T, (oy + 3) * T - 2)
    put('object.window', 'default', (ox + 18) * T, (oy + 2) * T - 4)
    put('object.door', 'default', (ox + 8) * T, (oy + 3) * T)
    put('object.plant.big', 'default', (ox + 1) * T + 8, (oy + 4) * T)
    put('object.cooler', 'default', (ox + 22) * T + 8, (oy + 4) * T)
    put('object.sofa', 'default', (ox + 18) * T, (oy + 19) * T)
    put('object.table.coffee', 'default', (ox + 13) * T, (oy + 18) * T)
    put('object.plant.big', 'default', (ox + 2) * T, (oy + 19) * T)
    put('object.bookshelf', 'default', (ox + 7) * T, (oy + 19) * T)
    agents.forEach((a, i) => {
      if (!a) return
      const x = (ox + 1 + (i % 4) * 6) * T, y = (oy + 5 + Math.floor(i / 4) * 7) * T
      const anchor = { x: x + 2 * T, y: y + 3 * T }
      const dir = i < 4 ? 'front' : 'back'
      if (a.terminal) { put('object.desk.terminal', offline ? 'off' : 'on', anchor.x, anchor.y, a.frame); return }
      const off = SEAT_OFFSETS[dir]
      put(`object.desk.${dir}`, a.state === 'unknown' || offline ? 'off' : 'on', anchor.x, anchor.y, a.frame)
      put(`object.chair.${dir}`, 'default', anchor.x + off.chair.x, anchor.y + off.chair.y)
      const ax = anchor.x + off.agent.x, ay = anchor.y + off.agent.y
      put(`agent.${a.kind}`, `${a.state}:${dir}`, ax, ay, a.frame)
      put(`role.${a.role}`, `${a.state}:${dir}`, ax, ay, a.frame)
      if (a.badge) put(`effect.${a.badge}`, 'default', ax + 9, ay - 40, 0)
      if (a.state === 'done') put('effect.sparkle', 'default', ax - 9, ay - 34, 1)
      a.at = { x: ax, y: ay - 28 }
    })
    put('object.plant.small', 'default', (ox + 6) * T, (oy + 8) * T - 4)
    queue.push({ label: name, x: (ox + 12) * T, y: (oy + 2) * T - 9 })
  }

  const dept1 = [
    { kind: 'claude', role: 'lead', state: 'working', frame: 1 },
    { kind: 'codex', role: 'backend', state: 'working', frame: 2 },
    { kind: 'gemini', role: 'designer', state: 'idle', frame: 0 },
    { kind: 'general', role: 'docs', state: 'done', frame: 0 },
    { kind: 'codex', role: 'reviewer', state: 'blocked', frame: 0 },
    { kind: 'claude', role: 'frontend', state: 'working', frame: 3 },
    { kind: 'codex', role: 'devops', state: 'idle', frame: 1 },
    { kind: 'claude', role: 'general', state: 'unknown', frame: 0 }
  ]
  const dept2 = [
    { kind: 'claude', role: 'lead', state: 'idle', frame: 2 },
    { kind: 'gemini', role: 'general', state: 'working', frame: 0 },
    null,
    { terminal: true, frame: 0 },
    { kind: 'codex', role: 'devops', state: 'working', frame: 1 },
    null, null, null
  ]
  room(0, 0, 'red', dept1, 'Studio')
  room(26, 0, 'blue', dept2, 'Platform')
  // Server corner outside the departments (machines pc / homeserver).
  const sx = 51
  for (let y = 0; y < 9; y++) for (let x = 0; x < 10; x++) tile('tile.floor.server', sx + x, 1 + y)
  for (let x = 0; x < 10; x++) { tile('tile.wall.cap', sx + x, 0); tile('tile.wall.cap.front', sx + x, 10) }
  for (let y = 0; y < 11; y++) { tile('tile.wall.cap', sx - 1, y); tile('tile.wall.cap', sx + 10, y) }
  put('object.server.rack', 'default', (sx + 1) * T + 8, 5 * T, 1)
  put('object.server.rack', 'default', (sx + 2) * T + 8, 5 * T, 2)
  put('object.machine.pc', 'default', (sx + 5) * T, 5 * T, 1)
  put('object.machine.homeserver', 'default', (sx + 8) * T, 5 * T, 0)
  queue.push({ label: 'pc', x: (sx + 5) * T, y: 5 * T + 4 }, { label: 'homeserver', x: (sx + 8) * T, y: 5 * T + 4 })

  // The user node «Вы» on the grass between the departments.
  put('object.user', 'default', 25 * T, 19 * T, 0)
  queue.push({ label: 'you', x: 25 * T, y: 16 * T - 3 })

  queue.sort((a, b) => a.y - b.y || (a.layer ?? 99) - (b.layer ?? 99))
  const labels = []
  for (const q of queue) q.label ? labels.push(q) : draw(q)
  // Links: a delivered prompt (envelope), an unconfirmed attempt (dashes) and an SSH cable.
  const lead = dept1[0].at, back = dept1[1].at, rev = dept1[4].at, ops = dept2[4].at
  const dashLine = (a, b, id) => { const n = Math.hypot(b.x - a.x, b.y - a.y) / 7; for (let i = 1; i < n; i++) put(id, 'default', a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n, 0, false) }
  dashLine(lead, back, 'effect.dash')
  put('effect.envelope', 'default', lead.x + (back.x - lead.x) * 0.55, lead.y + (back.y - lead.y) * 0.55 - 6, 1, false)
  dashLine(lead, rev, 'effect.dash')
  put('effect.attempt', 'default', (lead.x + rev.x) / 2, (lead.y + rev.y) / 2, 0, false)
  for (let x = ops.x + 12; x < (sx + 8) * T - 12; x += 8) put('effect.cable.h', 'default', x, 13 * T + 4, 0, false)
  for (let y = 5 * T + 6; y < 13 * T; y += 8) put('effect.cable.v', 'default', (sx + 8) * T - 4, y, 0, false)
  for (const l of labels) {
    const w = l.label.length * 4
    if (l.label === 'pc' || l.label === 'homeserver') { world.rect(l.x - w / 2 - 2, l.y - 1, w + 3, 7, '#2b1d1bb0'); text(world, l.x - w / 2, l.y, l.label, '#fffaf0') }
    else text(world, l.x - w / 2, l.y, l.label, '#fbe6c4')
  }
  return world
}

if (process.argv[1]?.endsWith('scene.mjs')) {
  const [out, scale = '2'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const world = renderScene({ offline: process.argv.includes('--offline') })
  const s = world.scaled(Number(scale))
  writeFileSync(out, encodePng(s.w, s.h, s.d))
  console.log('scene →', out, s.w, s.h)
}
