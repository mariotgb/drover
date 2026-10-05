// Office v2 scene renderer: composes a campus for a theme, lights it and draws the
// interaction overlays. Used for the mock-ups and as the engine's visual reference.
import { Pix, mix, rng } from '../canvas.mjs'
import { drawBody, drawRole, drawUser, STATES } from '../characters.mjs'
import { THEMES, ground, floor, rug, shade } from './themes.mjs'
import * as Pr from './props.mjs'
import * as O from './overlay.mjs'
import { LightMap, glow } from './light.mjs'
import { measure } from './pixfont.mjs'
import { campus, T, COL, ROW_PITCH, HEAD, CORRIDOR, MARGIN } from './layout.mjs'

const hashStr = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

/** Shared name prefix inside a hall («drover-»), dropped on plaques. */
function commonPrefix(names) {
  if (names.length < 2) return ''
  let p = names[0]
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1)
  const cut = p.lastIndexOf('-')
  return cut >= 2 ? p.slice(0, cut + 1) : ''
}

function character(kind, role, dir, pose, grey) {
  const p = { ...pose, grey }
  const k = ['claude', 'codex', 'gemini'].includes(kind) ? kind : 'general'
  const c = drawBody(k, dir, p)
  const r = drawRole(role ?? 'general', dir, p)
  c.blit(r, 0, 0, 32, 48, 0, 0)
  return c
}

function poseFor(agent, ev, frameSeed) {
  const st = agent.status
  if (ev?.throw !== undefined) return { arms: 'throw', phase: ev.throw, mouth: 'smile' }
  if (ev?.caught) return { arms: 'stretch', reach: 1, eyes: 'open', mouth: 'o', bob: -1 }
  if (ev?.cheer !== undefined) return STATES.done.poses[ev.cheer]
  if (st === 'blocked') return { arms: 'throw', phase: 0, mouth: 'o', bob: frameSeed % 2 ? 0 : 1 }
  const plan = STATES[st] ?? STATES.idle
  return plan.poses[frameSeed % plan.poses.length]
}

const screenMode = (a) => !a ? 'off' : a.terminal ? 'term' : a.status === 'unknown' ? 'off' : a.status === 'blocked' ? 'ask' : 'code'

/**
 * spec: { projects, machines, events: [...], links: [...], phase }
 * events: { type: 'prompt'|'attempt'|'user_prompt'|'done'|'ssh'|'board', from, to, at, t }
 */
export function renderScene(themeId, spec) {
  const P = THEMES[themeId]
  const L = campus(spec.projects, { machines: spec.machines ?? [] })
  const W = L.width, H = L.height
  const world = new Pix(W, H), emit = new Pix(W, H)
  const light = new LightMap(W, H, P.ambient)
  const sprites = []
  const add = (s, x, y, sort = y) => {
    if (!s) return
    sprites.push({ s, x: Math.round(x), y: Math.round(y), sort })
    for (const l of s.lights ?? []) light.pool(x + l.dx, y + l.dy, l.rx, l.ry, l.color, l.k)
  }
  const blit = (s, x, y) => {
    const ox = Math.round(x - s.ax), oy = Math.round(y - s.ay)
    world.blit(s.pix, 0, 0, s.pix.w, s.pix.h, ox, oy)
    if (s.emit) emit.blit(s.emit, 0, 0, s.emit.w, s.emit.h, ox, oy)
  }
  const events = spec.events ?? []
  const evAt = (name) => {
    const out = {}
    for (const e of events) {
      if ((e.type === 'prompt' || e.type === 'attempt') && e.from === name && e.t < 0.12) out.throw = e.t < 0.05 ? 0 : 1
      if (e.type === 'prompt' && e.to === name && e.t >= 0.92) out.caught = true
      if (e.type === 'done' && e.at === name) out.cheer = e.t < 0.5 ? 1 : 0
    }
    return out
  }

  // ------------------------------------------------------------ outside
  ground(P, world, 0, 0, W, H)
  const bottom = L.corridorY + CORRIDOR + T + 24
  const occupied = new Set()
  const occ = (x, y, w, h) => { for (let j = Math.floor(y / T); j <= Math.floor((y + h - 1) / T); j++) for (let i = Math.floor(x / T); i <= Math.floor((x + w - 1) / T); i++) occupied.add(i + ',' + j) }
  const free = (x, y, w, h) => { for (let j = Math.floor(y / T); j <= Math.floor((y + h - 1) / T); j++) for (let i = Math.floor(x / T); i <= Math.floor((x + w - 1) / T); i++) if (occupied.has(i + ',' + j) || i < 0 || j < 0 || i * T >= W || j * T >= H) return false; return true }
  for (const r of L.rooms) occ(r.x - T, r.y - T, r.width + 2 * T, r.height + T)
  occ(L.corridor.x - T, L.corridorY, L.corridor.width + 2 * T, bottom - L.corridorY + T)
  // sidewalk along the facade + path from the entrance
  const lobby = L.rooms[0]
  const entrance = { x: lobby.x + 5 * T, w: 2 * T }
  const pathTile = (x, y) => { for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) { const edge = i === 0 || j === 0; world.set(x + i, y + j, edge ? P.path[3] : P.path[(Math.floor(x / T) + Math.floor(y / T)) % 3]) } }
  if (P.id === 'cozy') {
    for (let x = MARGIN - T; x < L.corridor.x + L.corridor.width + T; x += T) pathTile(x, bottom)
    for (let y = bottom + T; y < H; y += T) { pathTile(entrance.x, y); pathTile(entrance.x + T, y) }
  }
  occ(entrance.x, bottom, entrance.w, H - bottom)
  occ(0, bottom, W, T)
  // garden / plaza: flowerbeds along the outer walls, trees on a jittered grid, a hedge on top
  const rr = rng(W * 7 + H)
  const decor = []
  for (const r of L.rooms) {
    const w = Math.min(r.width - 4 * T, 6 * T)
    if (r.y - 2 * T > 0) { decor.push([Pr.flowerBed(P, w), r.x + r.width / 2, r.y - 4]); if (P.id === 'cozy') decor.push([Pr.bush(P), r.x + 2 * T, r.y - 3], [Pr.bush(P), r.x + r.width - 2 * T, r.y - 3]) }
  }
  for (let y = 2 * T; y < H; y += 3 * T) for (let x = T; x < W; x += 3 * T) {
    const jx = Math.floor(rr() * 2) * T, jy = Math.floor(rr() * 2) * T
    const tx = x + jx, ty = y + jy
    const roll = rr()
    if (roll < 0.55 && free(tx - T, ty - 2 * T, 3 * T, 3 * T)) { decor.push([Pr.tree(P, 0.8 + rr() * 0.5), tx + 8, ty + T]); occ(tx - T, ty - 2 * T, 3 * T, 3 * T) }
    else if (roll < 0.75 && free(tx, ty, 2 * T, T)) { decor.push([Pr.bush(P), tx + T, ty + 13]); occ(tx, ty, 2 * T, T) }
    else if (roll < 0.82 && P.id === 'neon' && free(tx, ty - 2 * T, T, 3 * T)) { decor.push([Pr.lampPost(P), tx + 8, ty + 12]); occ(tx, ty - 2 * T, T, 3 * T) }
  }
  for (let x = 0; x < W; x += 20) if (free(x, 0, 20, T)) decor.push([Pr.bush(P), x + 10, 12])
  // street furniture by the sidewalk
  for (let x = MARGIN; x < L.corridor.x + L.corridor.width - 2 * T; x += 7 * T) {
    if (Math.abs(x - entrance.x) < 3 * T) continue
    decor.push([Pr.lampPost(P), x + 4, bottom + T + 12])
    if (rr() < 0.6) decor.push([Pr.parkBench(P), x + 40, bottom + T + 18])
  }
  decor.push([Pr.bikeRack(P), entrance.x + 3 * T + 16, bottom + T + 14])
  for (const [s, x, y] of decor) add(s, x, y)

  // ------------------------------------------------------------ rooms
  const plaques = [], bubbles = [], labels = []
  const userNode = L.nodes['Вы']
  const blockedCount = spec.projects.reduce((n, p) => n + p.agents.filter((a) => a.status === 'blocked').length, 0)

  function shell(r, floorKind) {
    const { x, y, width: w, height: h } = r
    floor(P, world, floorKind, x + T, y + 3 * T, w - 2 * T, h - 4 * T, hashStr(r.name))
    Pr.wallCap(P, world, x, y, w, 16, emit)
    Pr.wallFace(P, world, x + T, y + T, w - 2 * T, emit)
    Pr.wallSide(P, world, x, y, h, emit); Pr.wallSide(P, world, x + w - T, y, h, emit)
    Pr.wallFront(P, world, x, y + h - T, w, r.door ? [[r.door.x, r.door.width]] : [])
    if (r.door) floor(P, world, floorKind, r.door.x, y + h - T, r.door.width, T, 1)
    shade(world, x + T, y + 3 * T, w - 2 * T, 7, 'down', P.id === 'neon' ? 0.5 : 0.3)
    shade(world, x + T, y + 3 * T, 4, h - 4 * T, 'right', 0.2); shade(world, x + w - T - 4, y + 3 * T, 4, h - 4 * T, 'left', 0.2)
  }
  function windows(r, x0, x1) {
    const y = r.y + T + 3
    for (let x = x0; x + 30 <= x1; x += 52) {
      Pr.windowOnWall(P, world, x, y, 28, emit, hashStr(r.name) + x)
      if (P.id === 'cozy') light.poly([[x, r.y + 3 * T], [x + 28, r.y + 3 * T], [x + 28 + 34, r.y + 3 * T + 56], [x + 34, r.y + 3 * T + 56]], [1, 0.92, 0.72], 0.2)
      else light.pool(x + 14, r.y + 3 * T + 6, 22, 10, [0.45, 0.55, 1], 0.25)
    }
  }

  for (const r of L.rooms) {
    if (r.kind === 'lobby') {
      shell(r, 'lobby')
      rug(P, world, r.x + 2 * T + 8, r.y + 6 * T, 7 * T, 4 * T, true)
      Pr.sign(P, world, r.x + r.width / 2, r.y + T + 2, 'ПРИЁМНАЯ', emit)
      const dir = Pr.taskBoard(P, world, r.x + 2 * T - 4, r.y + T + 4, [spec.projects.length, 0, 0], emit)
      for (const l of dir.lights ?? []) light.pool(l.x, l.y, l.rx, l.ry, l.color, l.k)
      Pr.clock(P, world, r.x + r.width - 3 * T, r.y + 2 * T, 10, 10)
      windows(r, r.x + r.width - 4 * T - 6, r.x + r.width - T)
      const u = r.user
      add(Pr.reception(P), u.x, u.y + 14, u.y + 14)
      add({ pix: drawUser({ steam: 0 }), ax: 16, ay: 44 }, u.x, u.y)
      add(Pr.deskBell(P, blockedCount ? 1 + ((spec.tick ?? 0) % 2) : 0), u.x + 22, u.y + 6, u.y + 15)
      add(Pr.plant(P, 'monstera'), r.x + T + 14, r.y + 4 * T + 6)
      add(Pr.sofa(P, 44), r.x + 4 * T, r.y + r.height - 2 * T - 2)
      add(Pr.plant(P, 'big'), r.x + r.width - T - 10, r.y + r.height - T - 2)
      add(Pr.cooler(P), r.x + r.width - T - 10, r.y + 5 * T)
      if (P.id === 'neon') { light.pool(u.x, u.y - 10, 60, 40, [1, 0.85, 0.6], 0.8); light.pool(r.x + 4 * T, r.y + r.height - 3 * T, 40, 20, [1, 0.85, 0.6], 0.5) }
      plaques.push({ cx: u.x, y: u.y - 50, name: 'ВЫ', status: blockedCount ? 'blocked' : 'idle', pointer: 'down', you: true })
      if (blockedCount) labels.push({ cx: u.x + 22, y: u.y - 18, text: `${blockedCount} ЖДУТ`, tone: 'warn' })
      continue
    }
    if (r.kind === 'server') {
      shell(r, 'server')
      Pr.sign(P, world, r.x + r.width / 2, r.y + T + 2, 'СЕРВЕРНАЯ', emit)
      const hot = new Set(events.filter((e) => e.type === 'ssh').map((e) => e.to))
      for (let i = 0; i < 3; i++) add(Pr.rack(P, i, hot.size > 0 && i === 1), r.x + T + 14 + i * 20, r.y + 4 * T + 22)
      r.machines.forEach((m, i) => {
        const n = L.nodes[m]
        add(Pr.machineStation(P, m, hot.has(m) ? 'term' : 'code'), n.center, n.deskTop + 32)
        labels.push({ cx: n.center, y: n.deskTop + 36, text: m.toUpperCase() })
      })
      add(Pr.plant(P, 'small'), r.x + r.width - T - 10, r.y + r.height - T - 4)
      if (P.id === 'neon') light.pool(r.x + r.width / 2, r.y + 7 * T, r.width / 2, 50, [0.4, 0.7, 1], 0.45)
      continue
    }
    // ---------------- hall
    const { shape, project } = r
    shell(r, 'hall')
    const names = project.agents.map((a) => a.name)
    const prefix = commonPrefix(names) || `${project.name}-`
    const short = (n) => (n.startsWith(prefix) && n.length > prefix.length ? n.slice(prefix.length) : n)
    const wx0 = r.x + T, wx1 = r.x + r.width - T
    // north wall: board, sign, clock, windows, pictures
    const tasks = project.tasks ?? [3, 2, 1]
    const tb = Pr.taskBoard(P, world, wx0 + 10, r.y + T + 3, tasks, emit)
    for (const l of tb.lights ?? []) light.pool(l.x, l.y, l.rx, l.ry, l.color, l.k)
    r.board = { x: wx0 + 35, y: r.y + T + 14 }
    const signText = (project.title ?? project.name).toUpperCase(), signScale = r.width >= 20 * T && measure(signText) <= 40 ? 2 : 1
    const signHalf = (measure(signText) * signScale + 8 + 4 * signScale) / 2
    const sg = Pr.sign(P, world, r.x + r.width / 2, r.y + T - 1, signText, emit, signScale)
    if (sg.glow) r.signGlow = sg.glow
    Pr.clock(P, world, r.x + r.width / 2 + (r.width >= 20 * T ? -64 : 30), r.y + T + 12, 10, 10)
    windows(r, Math.round(r.x + r.width / 2 + signHalf + 10), wx1 - 4)
    if (r.width >= 20 * T) Pr.picture(P, world, r.x + r.width / 2 - 40, r.y + T + 10, hashStr(r.name))
    // head zone
    const lead = r.lead
    if (lead) {
      const hd = r.headDesk
      const leadState = L.nodes[lead.name]
      const ev = evAt(lead.name)
      add(Pr.chairFront(P, P.leadChair), hd.center, hd.deskTop + 7)
      const pose = poseFor(lead, ev, hashStr(lead.name) + (spec.tick ?? 0))
      add({ pix: character(lead.kind, lead.role, 'front', pose, lead.status === 'unknown'), ax: 16, ay: 44 }, hd.center, hd.deskTop + 8)
      add(Pr.headDesk(P, short(lead.name), screenMode(lead)), hd.center, hd.deskTop + 32)
      leadState.hand = { x: hd.center + 12, y: hd.deskTop - 22 }
      leadState.land = { x: hd.center, y: hd.deskTop + 6 }
      leadState.head = { x: hd.center, y: hd.deskTop - 32 }
      plaques.push({ cx: hd.center, y: hd.deskTop - 41, name: short(lead.name), status: lead.status, pointer: 'down', lead: true })
      if (P.id === 'neon') light.pool(hd.center, hd.deskTop + 4, 56, 30, [1, 0.86, 0.62], 0.75)
    }
    if (r.width >= 20 * T) add(Pr.meetingTable(P), r.x + r.width - 5 * T, r.y + HEAD - 6)
    else if (!lead) add(Pr.meetingTable(P), r.x + r.width / 2, r.y + HEAD - 6)
    add(Pr.plant(P, 'monstera'), wx0 + 14, r.y + HEAD - 4)
    if (r.width >= 20 * T) add(Pr.bookshelf(P), wx0 + 5 * T, r.y + HEAD - 30)
    // benches
    const workers = project.agents.filter((a) => a !== lead)
    for (let row = 0; row < shape.rows; row++) for (let b = 0; b < shape.benches; b++) {
      const seatsHere = []
      for (let c = 0; c < shape.cols; c++) {
        const ni = row * shape.perRow + b * shape.cols + c
        const si = ni + shape.cols * shape.benches
        seatsHere.push({ n: workers[ni], s: workers[si], ni, si })
      }
      const first = L.seats.find((s) => s.room === r && s.row === row && s.bench === b && s.col === 0 && s.side === 'north')
      const bx = first.x - 2, deskTop = first.deskTop
      const benchSprite = Pr.bench(P, shape.cols, seatsHere.map(({ n, s }) => ({ north: { mode: screenMode(n) }, south: { mode: screenMode(s) } })), hashStr(r.name) + row * 3 + b)
      add(benchSprite, bx + benchSprite.ax, deskTop + 36)
      if (P.id === 'neon') light.pool(bx + benchSprite.ax, deskTop + 12, shape.cols * 30, 40, [1, 0.86, 0.62], 0.55)
      else light.pool(bx + benchSprite.ax, deskTop + 12, shape.cols * 30, 40, [1, 0.95, 0.8], 0.05)
      seatsHere.forEach(({ n, s }, c) => {
        const cx = first.x + c * COL + COL / 2
        // north (faces you)
        if (n) {
          const ev = evAt(n.name), pose = poseFor(n, ev, hashStr(n.name) + (spec.tick ?? 0))
          add(Pr.chairFront(P), cx + 3, deskTop + 7)
          const jump = ev.caught ? -3 : 0
          add({ pix: character(n.kind, n.role, 'front', pose, n.status === 'unknown'), ax: 16, ay: 44 }, cx + 3, deskTop + 8 + jump, deskTop + 8)
          Object.assign(L.nodes[n.name], { hand: { x: cx + 15, y: deskTop - 22 }, land: { x: cx + 6, y: deskTop + 4 }, head: { x: cx + 3, y: deskTop - 31 } })
          plaques.push({ cx: cx + 3, y: deskTop - 40 + jump, name: short(n.name), status: n.status, pointer: 'down' })
          if (n.status === 'blocked') bubbles.push({ cx: cx + 3, bottom: deskTop - 41, kind: '?' })
          if (ev.caught) bubbles.push({ cx: cx + 3, bottom: deskTop - 44, kind: '!' })
          if (n.status === 'done') bubbles.push({ cx: cx + 3, bottom: deskTop - 41, kind: 'ok' })
        } else add(Pr.chairFront(P, P.chair, true), cx + 3, deskTop + 7)
        // south (back to you)
        if (s) {
          const ev = evAt(s.name), pose = poseFor(s, ev, hashStr(s.name) + (spec.tick ?? 0))
          const jump = ev.caught ? -3 : 0
          add({ pix: character(s.kind, s.role, 'back', pose, s.status === 'unknown'), ax: 16, ay: 44 }, cx - 6, deskTop + 44 + jump, deskTop + 44)
          add(Pr.chairBack(P), cx - 6, deskTop + 47)
          Object.assign(L.nodes[s.name], { hand: { x: cx + 4, y: deskTop + 12 }, land: { x: cx + 12, y: deskTop + 18 }, head: { x: cx - 6, y: deskTop + 6 } })
          plaques.push({ cx: cx - 6, y: deskTop + 50, name: short(s.name), status: s.status, pointer: 'up' })
          if (s.status === 'blocked') bubbles.push({ cx: cx - 6, bottom: deskTop + 4, kind: '?' })
          if (ev.caught) bubbles.push({ cx: cx - 6, bottom: deskTop + 2, kind: '!' })
          if (s.status === 'done') bubbles.push({ cx: cx - 6, bottom: deskTop + 4, kind: 'ok' })
        } else add(Pr.chairBack(P), cx - 6, deskTop + 40)
      })
    }
    // lounge by the door
    const ly = r.y + HEAD + shape.rows * ROW_PITCH
    const narrow = r.width < 20 * T
    if (P.id === 'cozy') {
      rug(P, world, r.x + 6 * T, ly + 4, narrow ? 6 * T : 9 * T, 3 * T + 8)
      add(Pr.sofa(P, narrow ? 44 : 52), r.x + (narrow ? 9 : 10) * T, ly + 30)
      add(Pr.coffeeTable(P, 26), r.x + (narrow ? 9 : 10) * T, ly + 58)
      add(Pr.cat(P, 'sleep'), r.x + (narrow ? 9 : 10) * T + 10, ly + 22, ly + 31)
      add(Pr.coffeeMachine(P), wx1 - 22, ly + 30)
      add(Pr.plant(P, 'big'), wx1 - 10, ly + 62)
      if (!narrow) { add(Pr.armchair(P), r.x + 14 * T, ly + 56); add(Pr.floorLamp(P), r.x + 6 * T + 4, ly + 34); add(Pr.bookshelf(P), r.x + 16 * T, ly + 36) }
      if (r.width > 30 * T) { add(Pr.armchair(P), r.x + 21 * T, ly + 56); add(Pr.bookshelf(P), r.x + 26 * T, ly + 36); add(Pr.plant(P, 'monstera'), r.x + 29 * T, ly + 60) }
    } else {
      add(Pr.beanbag(P, P.sofa[0]), r.x + 7 * T, ly + 30); add(Pr.beanbag(P, P.armchair[0]), r.x + 9 * T, ly + 44)
      add(Pr.coffeeMachine(P), wx1 - 22, ly + 30)
      add(Pr.floorLamp(P), r.x + 5 * T + 8, ly + 40)
      if (!narrow) { add(Pr.arcade(P), r.x + 13 * T, ly + 40); add(Pr.vending(P), r.x + 15 * T, ly + 40); add(Pr.beanbag(P, '#7c5cff'), r.x + 11 * T, ly + 30) }
      if (r.width > 30 * T) { add(Pr.pingpong(P), r.x + 22 * T, ly + 50); add(Pr.arcade(P), r.x + 27 * T, ly + 40) }
      add(Pr.plant(P, 'big'), wx1 - 10, ly + 62)
      add(Pr.robotVac(P), r.x + 2 * T + 6, ly - 20)
      light.pool(r.x + r.width / 2, ly + 30, r.width / 2, 40, [1, 0.8, 0.6], 0.35)
    }
  }

  // ------------------------------------------------------------ corridor
  const C = L.corridor
  Pr.wallFace(P, world, C.x + T, C.y, C.width - 2 * T, emit)
  floor(P, world, 'corridor', C.x + T, C.y + 2 * T, C.width - 2 * T, CORRIDOR - 2 * T)
  shade(world, C.x + T, C.y + 2 * T, C.width - 2 * T, 6, 'down', P.id === 'neon' ? 0.5 : 0.3)
  // runner
  const ry = C.y + 2 * T + 18
  for (let x = C.x + 2 * T; x < C.x + C.width - 2 * T; x++) for (let j = 0; j < 12; j++) {
    const edge = j === 0 || j === 11, band = j === 1 || j === 10
    if (P.id === 'neon') { world.set(x, ry + j, edge ? P.runner[1] : P.runner[0]); if (edge) emit.set(x, ry + j, '#3fb8c8'); continue }
    world.set(x, ry + j, edge ? P.runner[0] : band ? P.runner[2] : ((x + j) % 8 === 0 ? P.runner[2] : P.runner[1]))
  }
  Pr.wallSide(P, world, C.x, C.y, CORRIDOR + T, emit); Pr.wallSide(P, world, C.x + C.width - T, C.y, CORRIDOR + T, emit)
  Pr.wallFront(P, world, C.x, C.y + CORRIDOR, C.width, [[entrance.x, entrance.w]])
  floor(P, world, 'corridor', entrance.x, C.y + CORRIDOR, entrance.w, T)
  Pr.facade(P, world, C.x, C.y + CORRIDOR + T, C.width, 24, emit)
  for (let i = 0; i < entrance.w; i++) for (let j = 0; j < 24; j++) world.set(entrance.x + i, C.y + CORRIDOR + T + j, j % 6 === 0 ? P.path[3] : P.path[j % 12 < 6 ? 0 : 2])
  // doorways in the corridor wall, name plates next to them
  for (const r of L.rooms) {
    if (!r.door) continue
    const dx = r.door.x, dy = C.y
    for (let i = 0; i < r.door.width; i++) for (let j = 0; j < 2 * T; j++) world.set(dx + i, dy + j, mix(r.kind === 'hall' ? P.plank[0] : r.kind === 'server' ? P.raised[0] : P.parquet[0], '#000000', 0.25 + (j < 4 ? 0.2 : 0)))
    world.rect(dx - 2, dy, 2, 2 * T, P.cap[2]); world.rect(dx + r.door.width, dy, 2, 2 * T, P.cap[2])
    const nm = r.kind === 'hall' ? (r.project.title ?? r.project.name).toUpperCase() : r.kind === 'server' ? 'СЕРВЕРНАЯ' : 'ПРИЁМНАЯ'
    labels.push({ cx: dx + r.door.width + 6 + nm.length * 2, y: dy + 10, text: nm, tone: 'plate' })
  }
  for (let x = C.x + 3 * T; x < C.x + C.width - 3 * T; x += 9 * T) {
    if (L.rooms.some((r) => r.door && Math.abs(r.door.x - x) < 3 * T)) continue
    Pr.picture(P, world, x, C.y + 6, x)
    add(Pr.plant(P, 'small'), x + 20, C.y + 2 * T + 14)
  }
  if (P.id === 'neon') for (let x = C.x + 3 * T; x < C.x + C.width - 2 * T; x += 6 * T) light.pool(x, C.y + 3 * T + 4, 44, 22, [1, 0.86, 0.62], 0.75)

  // ------------------------------------------------------------ SSH cables on the floor (under furniture)
  const packets = [], sshMarks = []
  for (const e of events.filter((e) => e.type === 'ssh')) {
    const a = L.nodes[e.from], m = L.nodes[e.to]
    if (!a || !m) continue
    const hall = a.room, server = m.room
    const sx = a.side === 'south' ? a.center + 10 : a.center + 14
    const sy = a.side === 'south' ? a.deskTop + 40 : a.deskTop + 30
    const aisleX = hall.x + T + 20
    const route = [[sx, sy], [sx, sy + (a.side === 'south' ? 16 : 70)], [aisleX, sy + (a.side === 'south' ? 16 : 70)], [aisleX, hall.y + hall.height - T + 4], [hall.door.x + 16, hall.y + hall.height - T + 4], [hall.door.x + 16, C.y + 2 * T + 6], [server.door.x + 16, C.y + 2 * T + 6], [server.door.x + 16, server.y + server.height - T - 8], [m.center, server.y + server.height - T - 8], [m.center, m.deskTop + 28]]
    const [c0, c1, c2] = P.cable
    for (let i = 0; i < route.length - 1; i++) {
      const [x0, y0] = route[i], [x1, y1] = route[i + 1]
      if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) { world.set(x, y0 - 1, c1); world.set(x, y0, c0); world.set(x, y0 + 1, c2) }
      else for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) { world.set(x0 - 1, y, c1); world.set(x0, y, c0); world.set(x0 + 1, y, c2) }
    }
    // packets travelling to the machine
    let total = 0
    const segs = route.slice(1).map((p, i) => { const l = Math.abs(p[0] - route[i][0]) + Math.abs(p[1] - route[i][1]); total += l; return l })
    for (let k = 0; k < 7; k++) {
      let d = ((e.t + k / 7) % 1) * total
      for (let i = 0; i < segs.length; i++) {
        if (d > segs[i]) { d -= segs[i]; continue }
        const [x0, y0] = route[i], [x1, y1] = route[i + 1], f = d / segs[i]
        packets.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]); break
      }
    }
    for (const [x, y] of packets) { world.rect(Math.round(x) - 2, Math.round(y) - 2, 5, 5, '#2b1d1b'); world.rect(Math.round(x) - 1, Math.round(y) - 1, 3, 3, P.packet); light.pool(x, y, 8, 8, P.id === 'neon' ? [0.5, 1, 0.6] : [1, 0.9, 0.4], P.id === 'neon' ? 0.9 : 0.5) }
    sshMarks.push({ plug: { x: sx, y: sy }, machine: { x: m.center, y: m.deskTop - 2 } })
  }

  // ------------------------------------------------------------ sprites, lighting, emissive
  sprites.sort((a, b) => a.sort - b.sort)
  for (const { s, x, y } of sprites) blit(s, x, y)
  light.apply(world, P.steps)
  world.blit(emit, 0, 0, W, H, 0, 0)
  if (P.id === 'neon') {
    for (const r of L.rooms) if (r.signGlow) glow(world, r.signGlow.x, r.signGlow.y, r.signGlow.r, r.signGlow.color, r.signGlow.k)
    for (const [x, y] of packets) glow(world, x, y, 4, [0.5, 1, 0.6], 0.6)
  }

  // ------------------------------------------------------------ overlays
  const nodePoint = (name, what = 'head') => {
    const n = L.nodes[name]
    if (!n) return null
    if (n.user) return what === 'hand' ? { x: n.center + 10, y: n.deskTop - 22 } : { x: n.center, y: n.deskTop - 40 }
    if (n.machine) return { x: n.center, y: n.deskTop + 2 }
    return n[what] ?? n.head
  }
  const phase = spec.phase ?? 0
  for (const l of spec.links ?? []) {
    const a = nodePoint(l.from), b = nodePoint(l.to)
    if (a && b) O.link(P, world, { x: a.x, y: a.y - 12 }, { x: b.x, y: b.y - 12 }, { ...l, phase: (phase + (hashStr(l.from + l.to) % 7) / 7) % 1 })
  }
  if (spec.select && L.nodes[spec.select]?.head) { const h = L.nodes[spec.select].head; O.selection(P, world, h.x - 15, h.y - 14, 30, 50) }
  for (const p of plaques) O.plaque(P, world, p.cx, p.y, p.name, p.status, { pointer: p.pointer, lead: p.lead, phase })
  for (const l of labels) {
    if (l.tone === 'warn') { const w = O.label(P, world, l.cx, l.y, l.text, 'light'); world.hline(Math.round(l.cx - w / 2), Math.round(l.cx + w / 2) - 1, l.y, P.status.blocked) }
    else O.label(P, world, l.cx, l.y, l.text, l.tone === 'plate' ? 'light' : 'dark')
  }
  for (const m of sshMarks) {
    const col = P.id === 'neon' ? '#7cf28c' : '#3a6fb0'
    for (const r of [4, 7, 10]) for (let a = -0.9; a <= 0.9; a += 0.15) world.set(Math.round(m.machine.x + Math.sin(a) * r), Math.round(m.machine.y - 4 - Math.cos(a) * r), col)
    if (P.id === 'neon') glow(world, m.machine.x, m.machine.y - 6, 12, [0.5, 1, 0.6], 0.5)
  }
  for (const b of bubbles) O.bubble(P, world, b.cx, b.bottom, b.kind, spec.tick ?? 0)
  for (const e of events) {
    if (e.type === 'prompt' || e.type === 'user_prompt') {
      const a = nodePoint(e.type === 'user_prompt' ? 'Вы' : e.from, 'hand'), b = nodePoint(e.to, 'land')
      if (a && b && e.t > 0.05 && e.t < 0.95) O.promptFlight(P, world, a, b, (e.t - 0.05) / 0.9, { user: e.type === 'user_prompt' })
      if (a && b && e.t >= 0.95) { O.deskNote(P, world, b, e.type === 'user_prompt'); O.arrival(P, world, { x: b.x, y: b.y - 6 }, Math.min(1, (e.t - 0.95) / 0.05)) }
    }
    if (e.type === 'attempt') {
      const a = nodePoint(e.from, 'hand'), b = nodePoint(e.to, 'land')
      if (a && b && e.t > 0.05) O.attemptFlight(P, world, a, b, (e.t - 0.05) / 0.95)
    }
    if (e.type === 'note') { const b = nodePoint(e.at, 'land'); if (b) O.deskNote(P, world, b, e.user) }
    if (e.type === 'done') { const h = nodePoint(e.at); if (h) O.confetti(P, world, h.x, h.y - 4, e.t, hashStr(e.at)) }
    if (e.type === 'board') {
      const a = nodePoint(e.from, 'hand'), hall = L.nodes[e.from]?.room
      if (a && hall?.board) O.boardCard(P, world, a, hall.board, e.t)
    }
  }
  return { pix: world, layout: L }
}
