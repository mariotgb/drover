/** Fallback adapter for Opus' v2 generator when an atlas is unavailable. */
// @ts-expect-error The art generator is authored as plain JavaScript.
import { Pix } from '../../../../scripts/office-art/canvas.mjs'
// @ts-expect-error The art generator is authored as plain JavaScript.
import { drawBody, drawRole, drawUser, STATES } from '../../../../scripts/office-art/characters.mjs'
// @ts-expect-error The art generator is authored as plain JavaScript.
import { THEMES, ground, floor, rug, shade } from '../../../../scripts/office-art/v2/themes.mjs'
// @ts-expect-error The art generator is authored as plain JavaScript.
import * as Pr from '../../../../scripts/office-art/v2/props.mjs'
// @ts-expect-error The art generator is authored as plain JavaScript.
import * as O from '../../../../scripts/office-art/v2/overlay.mjs'
// @ts-expect-error The art generator is authored as plain JavaScript.
import { LightMap, glow } from '../../../../scripts/office-art/v2/light.mjs'
import type { Layout, Point } from './layout'

function canvasLayout(layout: Layout): Layout {
  if (!layout.bounds.x) return layout
  const offset = layout.bounds.x
  const shift = <T extends { x: number }>(r: T): T => ({ ...r, x: r.x - offset })
  return { ...layout, lots: layout.lots.map(shift), lobby: shift(layout.lobby), server: layout.server && shift(layout.server), corridor: shift(layout.corridor), bounds: { ...layout.bounds, x: 0 } }
}
import type { OfficeArtFrame } from '@shared/office'
export type OfficeTheme = 'cozy' | 'neon'
export const officeTheme = (dark: boolean): OfficeTheme => dark ? 'neon' : 'cozy'
interface Pixels { w: number; h: number; d: Uint8Array }
interface GeneratedSprite { pix: Pixels; ax: number; ay: number; emit?: Pixels }
export function pixelCanvas(pix: Pixels): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = pix.w; canvas.height = pix.h
  const ctx = canvas.getContext('2d')!
  const data = ctx.createImageData(pix.w, pix.h); data.data.set(pix.d); ctx.putImageData(data, 0, 0)
  return canvas
}
export class GeneratedArt {
  theme: OfficeTheme = 'cozy'
  private cache = new Map<string, { canvas: HTMLCanvasElement; frame: OfficeArtFrame }>()
  clear() { this.cache.clear() }
  setTheme(theme: OfficeTheme) { if (theme !== this.theme) { this.theme = theme; this.clear() } }
  private sprite(id: string, state: string, frame: number): GeneratedSprite | null {
    const P = THEMES[this.theme], [mode, dir = 'front'] = state.split(':')
    if (id.startsWith('agent.') || id.startsWith('role.')) {
      const pose = mode === 'stretch' ? STATES.done.poses[frame % 2] : mode === 'throw' ? { arms: 'throw', phase: frame % 2, mouth: 'smile' } : mode === 'catch' ? { arms: 'stretch', reach: 1, mouth: 'o' } : STATES[mode]?.poses[frame % STATES[mode].poses.length] ?? STATES.unknown.poses[0]
      const kind = id.slice(6), pix = id.startsWith('role.') ? drawRole(id.slice(5), dir, pose) : drawBody(['claude', 'codex', 'gemini'].includes(kind) ? kind : 'general', dir, pose)
      return { pix, ax: 16, ay: 44 }
    }
    if (id === 'object.user') return { pix: drawUser(mode === 'throw' ? { arms: 'throw', phase: frame % 2 } : { steam: frame % 3 }), ax: 16, ay: 44 }
    if (/^object\.bench\.\d+$/.test(id)) {
      const cols = Number(id.split('.')[2])
      const screens = mode.split(',').map((s: string) => ({ north: { mode: s.split('/')[0] }, south: { mode: s.split('/')[1] } }))
      return Pr.bench(P, cols, screens, frame)
    }
    switch (id) {
      case 'object.chair.front': return Pr.chairFront(P, P.chair, mode === 'empty')
      case 'object.chair.back': return Pr.chairBack(P)
      case 'object.chair.lead': return Pr.chairFront(P, P.leadChair)
      case 'object.desk.head': return Pr.headDesk(P, '', mode)
      case 'object.table.meeting': return Pr.meetingTable(P)
      case 'object.sofa': return this.theme === 'cozy' ? Pr.sofa(P) : Pr.beanbag(P, '#ff8a4c')
      case 'object.table.coffee': return Pr.coffeeTable(P)
      case 'object.bookshelf': return Pr.bookshelf(P)
      case 'object.coffee': return Pr.coffeeMachine(P)
      case 'object.plant.monstera': return Pr.plant(P, 'monstera')
      case 'object.plant.big': return Pr.plant(P, 'big')
      case 'object.cooler': { const s = Pr.cooler(P); s.pix.set(5 + frame % 2, 6 - frame % 3, '#ffffff'); return s }
      case 'object.steam': { const pix = new Pix(12, 16); for (let i = 0; i < 3; i++) { const x = 3 + (i + frame) % 3, y = 14 - i * 4 - frame; pix.line(x, y, x + 1, y - 3, '#f3e6c8a0') }; return { pix, ax: 6, ay: 16 } }
      case 'object.reception': return Pr.reception(P)
      case 'object.bell': return Pr.deskBell(P, mode === 'ring' ? 1 + frame % 2 : 0)
      case 'object.server.rack': return Pr.rack(P, frame % 3, mode === 'hot')
      case 'object.machine': return Pr.machineStation(P, '', mode)
      case 'object.pet': return this.theme === 'cozy' ? Pr.cat(P, mode === 'walk' ? 'walk' : 'sleep') : Pr.robotVac(P)
    }
    return null
  }
  private get(id: string, state: string, time: number) {
    const mode = state.split(':')[0]
    const durations: number[] = mode === 'throw' ? [160, 120] : mode === 'catch' ? [300] : STATES[mode]?.durations ?? [300, 300, 300]
    const total = durations.reduce((a, b) => a + b, 0)
    let age = ['throw', 'catch', 'done'].includes(mode) ? Math.min(time, total - 1) : time % total, phase = 0
    while (phase < durations.length - 1 && age >= durations[phase]) age -= durations[phase++]
    const key = `${id}:${state}:${phase}`, old = this.cache.get(key)
    if (old) return old
    const s = this.sprite(id, state, phase)
    if (!s) return null
    const canvas = pixelCanvas(s.pix)
    if (s.emit) canvas.getContext('2d')!.drawImage(pixelCanvas(s.emit), 0, 0)
    const value = { canvas, frame: { rect: { x: 0, y: 0, width: s.pix.w, height: s.pix.h }, anchor: { x: s.ax, y: s.ay }, hitRect: { x: 6, y: 2, width: Math.max(1, s.pix.w - 12), height: Math.max(1, s.pix.h - 4) } } }
    if (this.cache.size > 2500) this.cache.clear()
    this.cache.set(key, value)
    return value
  }
  frame(id: string, state: string, time: number) { return this.get(id, state, time)?.frame }
  paint(ctx: CanvasRenderingContext2D, id: string, state: string, anchor: Point, time: number) {
    const s = this.get(id, state, time); if (!s) return false
    ctx.drawImage(s.canvas, Math.round(anchor.x - s.frame.anchor.x), Math.round(anchor.y - s.frame.anchor.y)); return true
  }
  overlay(ctx: CanvasRenderingContext2D, kind: string, data: Record<string, unknown>) {
    // Small cached patches avoid processing a full campus for effects.
    data = { ...data, ...(typeof data.angle === 'number' ? { angle: Math.round(data.angle / (Math.PI / 8)) * Math.PI / 8 } : {}), ...(typeof data.progress === 'number' ? { progress: Math.floor(data.progress * 6) / 6 } : {}) }
    const { x: _x, y: _y, ...patch } = data
    const key = JSON.stringify([kind, patch]), cached = this.cache.get(key)
    if (cached) { ctx.drawImage(cached.canvas, Number(data.x) - cached.frame.anchor.x, Number(data.y) - cached.frame.anchor.y); return }
    const P = THEMES[this.theme], pix = new Pix(96, 96), cx = 48, cy = 48
    if (kind === 'select') O.selection(P, pix, cx - 18, cy - 24, 36, 50)
    if (kind === 'plaque') O.plaque(P, pix, cx, cy, data.text, data.status, { pointer: data.south ? 'up' : 'down', lead: data.lead, phase: data.phase ?? 0 })
    if (kind === 'bubble') O.bubble(P, pix, cx, cy, data.symbol, data.phase ?? 0)
    if (kind === 'note') O.deskNote(P, pix, { x: cx, y: cy }, data.user)
    if (kind === 'arrival') O.arrival(P, pix, { x: cx, y: cy }, data.progress)
    if (kind === 'confetti') O.confetti(P, pix, cx, cy, data.progress)
    if (kind === 'plane') O.paperPlane(P, pix, { x: cx, y: cy }, data.angle, data.user ? '#9dd5ff' : '#fffaf0')
    if (kind === 'packet') { glow(pix, cx, cy, 14, data.user ? [1, 0.6, 0.4] : [0.37, 0.95, 1], 0.7); pix.rect(cx - 4, cy - 3, 9, 7, data.user ? P.user : '#5ef2ff'); pix.rect(cx - 2, cy - 1, 5, 3, '#ffffff') }
    if (kind === 'waves') { for (let i = 0; i < 3; i++) { const r = 3 + i * 3 + Number(data.phase ?? 0); pix.line(cx - r, cy - r, cx - r + 3, cy - r - 3, P.cable[1]); pix.line(cx + r, cy - r, cx + r - 3, cy - r - 3, P.cable[1]) } }
    if (kind === 'crumple') { pix.ellipse(cx, cy, 4, 3, '#efe6d2'); O.bubble(P, pix, cx + 9, cy - 3, '?') }
    if (kind === 'select') O.selection(P, pix, cx - 14, cy - 22, 28, 42)
    if (kind === 'card') { pix.rect(cx - 3, cy - 3, 7, 7, '#fff3a8'); pix.set(cx, cy - 3, '#d94a4a') }
    const canvas = pixelCanvas(pix)
    // Coordinates are excluded from reusable patch identity.
    const frame = { rect: { x: 0, y: 0, width: 96, height: 96 }, anchor: { x: cx, y: cy }, hitRect: { x: 0, y: 0, width: 96, height: 96 } }
    if (this.cache.size > 2500) this.cache.clear()
    this.cache.set(key, { canvas, frame }); ctx.drawImage(canvas, Number(data.x) - cx, Number(data.y) - cy)
  }
  front(layout: Layout): HTMLCanvasElement {
    layout = canvasLayout(layout)
    const key = `front:${JSON.stringify([layout.lots, layout.corridor, layout.server, this.theme])}`, old = this.cache.get(key)
    if (old) return old.canvas
    const P = THEMES[this.theme], b = layout.bounds, pix = new Pix(b.width, b.height), emit = new Pix(b.width, b.height)
    const rooms = [...(!layout.isolated ? [layout.lobby] : []), ...layout.lots, ...(layout.server ? [layout.server] : [])]
    for (const r of rooms) Pr.wallFront(P, pix, r.x, r.y + r.height - 16 - b.y, r.width, [[r.x + (r === layout.lobby ? r.width - 64 : 32), 32]])
    Pr.wallFront(P, pix, layout.corridor.x, 80 - b.y, layout.corridor.width, [[layout.lobby.x + 80, 32]])
    const light = new LightMap(b.width, b.height, P.ambient); light.apply(pix, 12); pix.blit(emit, 0, 0, emit.w, emit.h, 0, 0)
    const canvas = pixelCanvas(pix), frame = { rect: { x: 0, y: 0, width: b.width, height: b.height }, anchor: { x: 0, y: 0 }, hitRect: { x: 0, y: 0, width: b.width, height: b.height } }
    this.cache.set(key, { canvas, frame }); return canvas
  }
  board(ctx: CanvasRenderingContext2D, lot: Point, counts: [number, number, number]) {
    const key = `board:${this.theme}:${counts.join(',')}`
    let cached = this.cache.get(key)
    if (!cached) {
      const pix = new Pix(64, 40), emit = new Pix(64, 40), P = THEMES[this.theme]
      Pr.taskBoard(P, pix, 4, 3, counts, emit)
      new LightMap(64, 40, P.ambient).apply(pix, 12); pix.blit(emit, 0, 0, emit.w, emit.h, 0, 0)
      const canvas = pixelCanvas(pix), frame = { rect: { x: 0, y: 0, width: 64, height: 40 }, anchor: { x: 0, y: 0 }, hitRect: { x: 0, y: 0, width: 64, height: 40 } }
      cached = { canvas, frame }; if (this.cache.size > 2500) this.cache.clear(); this.cache.set(key, cached)
    }
    ctx.drawImage(cached.canvas, lot.x + 16, lot.y + 16)
  }
  bake(layout: Layout, names: Map<string, string>, time: number, boards = new Map<string, [number, number, number]>()): HTMLCanvasElement {
    layout = canvasLayout(layout)
    const P = THEMES[this.theme], { bounds } = layout, oy = -bounds.y
    const world = new Pix(bounds.width, bounds.height), emit = new Pix(bounds.width, bounds.height), light = new LightMap(bounds.width, bounds.height, P.ambient)
    ground(P, world, 0, 0, bounds.width, bounds.height)
    const stamp = (s: GeneratedSprite, x: number, y: number) => world.blit(s.pix, 0, 0, s.pix.w, s.pix.h, x - s.ax, y + oy - s.ay)
    const rooms = [...(!layout.isolated ? [{ ...layout.lobby, name: '', kind: 'lobby' }] : []), ...layout.lots.map(l => ({ ...l, name: names.get(l.departmentId) ?? '', kind: 'hall' })), ...(layout.server ? [{ ...layout.server, name: '', kind: 'server' }] : [])]
    for (let y = bounds.y + 24; y < 0; y += 48) for (let x = 24; x < bounds.width; x += 48) {
      if (rooms.some(r => x + 24 >= r.x && x - 24 < r.x + r.width && y + 24 >= r.y && y - 32 < r.y + r.height)) continue
      stamp(this.theme === 'cozy' ? Pr.tree(P, 0.9) : Pr.lampPost(P), x + (y % 3) * 4, y)
    }
    for (const r of rooms) {
      const y = r.y + oy, { x, width: w, height: h } = r
      floor(P, world, r.kind, x + 16, y + 48, w - 32, h - 64, x)
      Pr.wallCap(P, world, x, y, w, 16, emit); Pr.wallFace(P, world, x + 16, y + 16, w - 32, emit)
      Pr.wallSide(P, world, x, y, h, emit); Pr.wallSide(P, world, x + w - 16, y, h, emit)
      shade(world, x + 16, y + 48, w - 32, 7, 'down', 0.3)
      Pr.taskBoard(P, world, x + 20, y + 19, 'departmentId' in r ? boards.get(r.departmentId) ?? [0, 0, 0] : [rooms.length - 1, 0, 0], emit)
      if (r.name) Pr.sign(P, world, x + w / 2, y + 15, r.name.toUpperCase(), emit, w >= 320 && r.name.length <= 8 ? 2 : 1)
      Pr.clock(P, world, x + w / 2 - 48, y + 28, new Date(time).getHours(), new Date(time).getMinutes())
      for (let wx = x + w / 2 + 48; wx + 28 < x + w - 16; wx += 52) {
        Pr.windowOnWall(P, world, wx, y + 19, 28, emit)
        const day = new Date(time).getHours(), strength = day >= 7 && day < 19 ? 0.2 : 0.04
        light.poly([[wx, y + 48], [wx + 28, y + 48], [wx + 62, y + 104], [wx + 34, y + 104]], [1, 0.92, 0.72], strength)
      }
      const door = x + (r.kind === 'lobby' ? w - 64 : 32)
      Pr.wallFront(P, world, x, y + h - 16, w, [[door, 32]])
      floor(P, world, r.kind, door, y + h - 16, 32, 16)
      if (r.kind === 'hall') rug(P, world, x + 96, y + h - 76, Math.min(144, w - 128), 56)
      light.pool(x + w / 2, y + h - 50, w / 2, 80, [1, 0.86, 0.62], this.theme === 'neon' ? 0.65 : 0.05)
    }
    const c = layout.corridor
    floor(P, world, 'corridor', c.x, oy, c.width, c.height)
    Pr.wallFace(P, world, c.x, oy, c.width, emit)
    for (const r of rooms) { const door = r.x + (r.kind === 'lobby' ? r.width - 64 : 32); world.rect(door, oy, 32, 32, P.cap[2]); world.rect(door + 2, oy + 2, 28, 30, r.kind === 'hall' ? P.plank[0] : r.kind === 'server' ? P.raised[0] : P.parquet[0]) }
    for (const r of rooms) {
      const door = r.x + (r.kind === 'lobby' ? r.width - 64 : 32)
      floor(P, world, r.kind, door, oy, 32, 32)
      world.rect(door - 2, oy, 2, 32, P.cap[2]); world.rect(door + 32, oy, 2, 32, P.cap[2])
    }
    Pr.wallFront(P, world, c.x, oy + 80, c.width, [[layout.lobby.x + 80, 32]])
    Pr.facade(P, world, c.x, oy + 96, c.width, 24, emit)
    world.rect(layout.lobby.x + 80, oy + 80, 32, 40, P.path[0])
    floor(P, world, 'corridor', c.x, oy + 120, c.width, 16)
    for (let x = c.x; x < c.x + c.width - 80; x += 112) { stamp(Pr.parkBench(P), x + 40, 147); stamp(Pr.lampPost(P), x + 4, 140) }
    if (!layout.isolated) stamp(Pr.bikeRack(P), layout.lobby.x + 156, 147)
    light.apply(world, 12); world.blit(emit, 0, 0, emit.w, emit.h, 0, 0)
    return pixelCanvas(world)
  }
}
