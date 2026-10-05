import type { OfficeArt } from './art'
import type { OfficeArtManifestV2, RGB } from './assets/v2/manifest'
import type { Layout, Rect } from './layout'
import { officeText } from './text'
// @ts-expect-error Shared with the offline art generator.
import { Pix } from '../../../../scripts/office-art/canvas.mjs'
// @ts-expect-error Shared with the offline art generator.
import { LightMap } from '../../../../scripts/office-art/v2/light.mjs'
interface Item { sprite?: string; state?: string; tiles?: string; x?: number; xr?: number; xc?: number; y?: number; yb?: number; w?: number; h?: number; sortY?: number; replaces?: string; sign?: string; plaque?: string; label?: string }
interface Composition { lounge: { narrow: Item[]; wide: Item[]; widest: Item[] }; head: { narrow: Item[]; wide: Item[]; noLead: Item[] }; lobby: Item[]; server: Item[]; boss: Item[] }
interface Pool { dx?: number; dy?: number; rx?: number; ry: number; color: RGB; k: number }
const canvasFor = (r: Rect) => { const c = document.createElement('canvas'); c.width = r.width; c.height = r.height; return c }
export function atlasScene(art: OfficeArt, layout: Layout, names: Map<string, string>, time: number, boards: Map<string, [number, number, number]>, front = false): HTMLCanvasElement {
  const M = art.manifest as OfficeArtManifestV2, C = M.compositions as unknown as Composition, b = layout.bounds
  const canvas = canvasFor(b), ctx = canvas.getContext('2d')!, emission = canvasFor(b), emit = emission.getContext('2d')!
  ctx.imageSmoothingEnabled = emit.imageSmoothingEnabled = false; ctx.translate(-b.x, -b.y); emit.translate(-b.x, -b.y)
  const hour = new Date(time).getHours(), day = hour >= 7 && hour < 17 ? 'day' : hour >= 17 && hour < 21 ? 'evening' : 'night'
  const night = M.lighting.night as { ambient: RGB } | undefined, light = new LightMap(b.width, b.height, day === 'night' && night ? night.ambient : M.lighting.ambient)
  const tile = (id: string, x: number, y: number) => { art.raw(ctx, id, 'default', { x, y }, 0); art.raw(emit, id, 'default', { x, y }, 0, true) }
  const queue: { y: number; layer: number; draw(): void }[] = []
  const put = (id: string, state: string, x: number, y: number, sortY = y) => {
    const s = M.sprites[id]; if (!s) return
    const pose = s.states[state] ? state : Object.keys(s.states)[0]
    for (const p of s.lights ?? []) if (!p.states || p.states.includes(pose)) light.pool(x - b.x + p.dx, y - b.y + p.dy, p.rx, p.ry, p.color, p.k)
    if (id === 'object.window') {
      const w = M.lighting.window as { kind: string; color: RGB; k: number; byTime: Record<string, number>; depth: number; shift: number; width: number; dx: number; dy: number; rx: number; ry: number }
      const strength = w.k * (w.byTime[day] ?? 1), wx = x - b.x - 14, wy = y - b.y + 3
      if (w.kind === 'sun') light.poly([[wx, wy], [wx + w.width, wy], [wx + w.width + w.shift, wy + w.depth], [wx + w.shift, wy + w.depth]], w.color, strength)
      else light.pool(wx + w.dx, wy + w.dy, w.rx, w.ry, w.color, strength)
    }
    queue.push({ y: ['floor', 'floor-shade', 'rug'].includes(s.layers[0]) ? sortY - 1e6 : sortY, layer: M.layers.indexOf(s.layers[0]), draw() { art.raw(ctx, id, pose, { x, y }, 0); art.raw(emit, id, pose, { x, y }, 0, true) } })
  }
  const pool = (key: string, x: number, y: number, rx: number) => { const p = M.lighting[key] as Pool | Pool[] | null; for (const q of !p ? [] : Array.isArray(p) ? p : [p]) light.pool(x - b.x + (q.dx ?? 0), y - b.y + (q.dy ?? 0), q.rx ?? rx, q.ry, q.color, q.k) }
  const items = (list: Item[], r: Rect, y = r.y) => {
    for (const i of list) {
      const x = i.xr !== undefined ? r.x + r.width - i.xr : i.xc !== undefined ? r.x + r.width / 2 + i.xc : r.x + (i.x ?? 0), iy = i.yb !== undefined ? r.y + r.height - i.yb : y + (i.y ?? 0)
      if (i.tiles) for (let ty = 0; ty < (i.h ?? 0); ty += 16) for (let tx = 0; tx < (i.w ?? 0); tx += 16) {
        const part = (ty === 0 ? 't' : ty + 16 >= i.h! ? 'b' : '') + (tx === 0 ? 'l' : tx + 16 >= i.w! ? 'r' : '')
        tile(`${i.tiles}.${part || 'c'}`, x + tx, iy + ty)
      }
      if (i.sprite && !['agent.user','agent.boss','object.reception','object.bell','object.cooler','object.rack','object.chair.boss','object.desk.boss','object.phone'].includes(i.sprite)) put(i.sprite, i.sprite === 'object.window' ? day : i.state ?? 'default', x, iy, i.sortY === undefined ? iy : y + i.sortY)
    }
  }
  const rooms = [{ ...layout.lobby, kind: 'lobby', name: officeText('Reception') }, ...layout.lots.map(l => ({ ...l, kind: l.boss ? 'boss' : 'hall', name: names.get(l.departmentId) ?? '' })), ...(layout.server ? [{ ...layout.server, kind: 'server', name: officeText('Server room') }] : [])]
  if (!front) {
    for (let y = b.y; y < b.y + b.height; y += 16) for (let x = b.x; x < b.x + b.width; x += 16) tile(`tile.ground.${Math.abs(x / 16 * 7 + y / 16 * 3) % 4}`, x, y)
    for (let y = b.y + 40; y < 0; y += 48) for (let x = b.x + 24; x < b.x + b.width; x += 48) {
      if (rooms.some(r => x + 26 >= r.x && x - 26 < r.x + r.width && y + 24 >= r.y && y - 36 < r.y + r.height)) continue
      put(M.theme === 'dark' ? 'object.lamp.post' : (Math.abs(x + y) % 3 ? 'object.tree.big' : 'object.bush'), 'default', x, y)
    }
  }
  for (const r of rooms) {
    const kind = r.kind === 'boss' ? 'hall' : r.kind, door = r.x + (kind === 'lobby' ? r.width - 64 : 32)
    if (!front) {
      for (let y = r.y + 48; y < r.y + r.height - 16; y += 16) for (let x = r.x + 16; x < r.x + r.width - 16; x += 16) tile(kind === 'server' ? 'tile.floor.server' : `tile.floor.${kind}.${Math.abs(x / 16 * 7 + y / 16 * 3) % (kind === 'lobby' ? 2 : 4)}`, x, y)
      for (let x = r.x; x < r.x + r.width; x += 16) tile('tile.wall.cap', x, r.y)
      for (let x = r.x + 16; x < r.x + r.width - 16; x += 16) { tile(`tile.wall.face.${x / 16 % 2}`, x, r.y + 16); tile('tile.wall.shade.top', x, r.y + 48) }
      for (let y = r.y; y < r.y + r.height; y += 16) { tile('tile.wall.side', r.x, y); tile('tile.wall.side', r.x + r.width - 16, y) }
      if (r.kind === 'hall') {
        put('object.board', 'default', r.x + 51, r.y + 46)
        const count = 'departmentId' in r ? boards.get(r.departmentId) ?? [0, 0, 0] : [0,0,0]
        queue.push({ y: 1e6, layer: 0, draw() { art.text(ctx, count.join('/'), r.x + 28, r.y + 22, 'ink'); art.text(emit, count.join('/'), r.x + 28, r.y + 22, 'ink') } })
        const scale = r.width >= 320 && art.measure(r.name) <= 40 ? 2 : 1, sw = Math.min(r.width - 100, art.measure(r.name) * scale + 20)
        queue.push({ y: 1e6, layer: 0, draw() { art.sign(ctx, r.name, r.x + r.width / 2, r.y + 18, sw, scale); if (M.theme === 'dark') art.sign(emit, r.name, r.x + r.width / 2, r.y + 18, sw, scale) } })
        put('object.clock', `${hour % 12}:${new Date(time).getMinutes() >= 30 ? '30' : '00'}`, r.x + r.width / 2 + (r.width >= 320 ? -64 : 30), r.y + 35)
        if (r.width >= 320) put('object.picture', '0', r.x + r.width / 2 - 33, r.y + 37)
        for (let x = r.x + r.width / 2 + sw / 2 + 10; x + 30 < r.x + r.width - 20; x += 52) put('object.window', day, x + 14, r.y + 45)
        const wide = r.width >= 320 ? C.lounge.wide : [], lounge = [...C.lounge.narrow.filter(i => !wide.some(w => w.replaces === i.sprite || w.replaces === 'narrow' && i.tiles)), ...wide, ...(r.width >= 544 ? C.lounge.widest : [])]
        items(lounge, r, r.y + r.height - 80)
        items([...C.head.narrow, ...(r.width >= 320 ? C.head.wide : []), ...(!layout.seats.some(s => 'departmentId' in r && s.departmentId === r.departmentId && s.side === 'head') ? C.head.noLead : [])], r)
        pool('lounge', r.x + r.width / 2, r.y + r.height - 80, r.width / 2)
        const lot = layout.lots.find(l => l.x === r.x)!
        for (let row = 0; row < lot.shape.rows; row++) for (let col = 0; col < lot.shape.cols * lot.shape.benches; col++) { const p = M.lighting.pendant as (Pool & { rxPerColumn: number }) | null; if (p) light.pool(r.x + 88 + col * 48 - b.x, r.y + 168 + row * 112 + (p.dy ?? 0) - b.y, p.rxPerColumn, p.ry, p.color, p.k) }
      } else {
        items(r.kind === 'boss' ? C.boss : r.kind === 'lobby' ? C.lobby : C.server, r)
        const name = r.kind === 'boss' ? r.name : r.name, width = Math.min(r.width - 32, art.measure(name) + 16)
        queue.push({ y: 1e6, layer: 0, draw() { art.sign(ctx, name, r.x + r.width / 2, r.y + 18, width, 1); if (M.theme === 'dark') art.sign(emit, name, r.x + r.width / 2, r.y + 18, width, 1) } })
        pool(r.kind, r.x + r.width / 2, r.y + 120, r.width / 2)
      }
    }
    for (let x = r.x; x < r.x + r.width; x += 16) if (x < door || x >= door + 32) tile('tile.wall.front', x, r.y + r.height - 16); else if (!front) tile(kind === 'server' ? 'tile.floor.server' : `tile.floor.${kind}.0`, x, r.y + r.height - 16)
  }
  const c = layout.corridor, entrance = layout.lobby.x + 80
  if (!front) {
    for (let x = c.x; x < c.x + c.width; x += 16) { tile(`tile.wall.face.${x / 16 % 2}`, x, 0); for (let y = 32; y < 80; y += 16) tile(`tile.floor.corridor.${(x / 16 + y / 16) % 3}`, x, y); tile(x === c.x ? 'tile.runner.l' : x + 16 >= c.x + c.width ? 'tile.runner.r' : 'tile.runner.c', x, 48) }
    for (const r of rooms) { const door = r.x + (r.kind === 'lobby' ? r.width - 64 : 32); put('object.doorway', r.kind === 'server' ? 'server' : r.kind === 'lobby' ? 'lobby' : 'hall', door + 16, 32) }
    for (let x = c.x + 48; x < c.x + c.width - 24; x += 144) { if (rooms.some(r => Math.abs(x - r.x - 48) < 50)) continue; put('object.picture', '0', x + 7, 17); put('object.plant.small', 'default', x + 20, 46) }
    for (let x = c.x; x < c.x + c.width; x += 16) { tile('tile.facade.plain', x, 96); tile(`tile.ground.path.${x / 16 % 2}`, x, 120) }
    for (let x = c.x + 8; x < c.x + c.width - 80; x += 112) { put('object.lamp.post', 'default', x, 148); if (Math.abs(x - entrance) > 64) put('object.bench.park', 'default', x + 40, 153) }
    put('object.bikes', 'default', layout.lobby.x + 160, 154)
    for (let y = 80; y < 160; y += 16) for (let x = entrance; x < entrance + 32; x += 16) tile('tile.ground.path.0', x, y)
    pool('corridor', c.x + c.width / 2, 48, c.width / 2)
  }
  for (let x = c.x; x < c.x + c.width; x += 16) if (x < entrance || x >= entrance + 32) tile('tile.wall.front', x, 80)
  queue.sort((a, z) => a.y - z.y || a.layer - z.layer).forEach(q => q.draw())
  const image = ctx.getImageData(0, 0, b.width, b.height), pix = new Pix(b.width, b.height); pix.d.set(image.data); light.apply(pix, M.lighting.steps); image.data.set(pix.d); ctx.putImageData(image, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(emission, 0, 0)
  return canvas
}
