import { OFFICE_LIMITS, type OfficeAgent, type OfficeState, type OfficeUpdate } from '@shared/office'
import { OfficeArt } from './art'
import { DragGesture, fitCamera, hitTest, zoomAt, type Camera, type HitTarget } from './camera'
import { decayedWeight, EnvelopeQueue } from './effects'
import { OfficeLayout, TILE, type Layout, type Point, type Rect, type Seat } from './layout'
import { FrameLoop } from './scheduler'
import { roomDecor, roomSize, seatPose, type SceneSprite } from './scene'
import { aboveHead, pointOnRoute, routeCable, routeLine } from './routes'

const KIND_COLORS: Record<string, string> = { claude: '#e4a16e', codex: '#79b5c5', gemini: '#aa94d0', opencode: '#8cba8b', cursor: '#d4d2c5', copilot: '#bd8aaf', amp: '#e4c36b', droid: '#bdac83' }
const makeCanvas = (width: number, height: number) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c }
export interface WorldLabel { id: string; name: string; kind: 'department' | 'user' | 'machine'; x: number; y: number }
interface EngineOptions { onOpen(paneId: string): void; onHover(paneId: string | null): void; onLabels?(labels: WorldLabel[]): void }

export class OfficeEngine {
  camera: Camera = { x: 24, y: 24, zoom: 1 }
  private state: OfficeState | null = null
  private layoutModel = new OfficeLayout()
  private layout: Layout = this.layoutModel.update([], [])
  private geometryKey = ''
  private staticKey = ''
  private staticLayer = makeCanvas(1, 1)
  private floors = new Map<string, HTMLCanvasElement>()
  private furniture = new Map<string, HTMLCanvasElement>()
  private art = new OfficeArt()
  private effects = new EnvelopeQueue()
  private loop: FrameLoop
  private resizeObserver: ResizeObserver
  private width = 1
  private height = 1
  private dpr = 1
  private visible = false
  private connected = true
  private focused = true
  private reducedMotion = false
  private showTerminals = false
  private sampledAt = Date.now()
  private hasFit = false
  private targets: HitTarget[] = []
  private hovered: string | null = null
  private gesture = new DragGesture()
  private pointer: { id: number; last: Point; initial: Camera } | null = null
  private disposed = false
  private routeKey = ''
  private routes = new Map<string, Point[]>()

  constructor(private canvas: HTMLCanvasElement, private options: EngineOptions) {
    this.loop = new FrameLoop({ request: cb => requestAnimationFrame(cb), cancel: id => cancelAnimationFrame(id) }, this.draw)
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(canvas)
    canvas.addEventListener('pointerdown', this.pointerDown)
    canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp)
    canvas.addEventListener('pointercancel', this.pointerCancel)
    canvas.addEventListener('lostpointercapture', this.pointerCancel)
    canvas.addEventListener('pointerleave', this.pointerLeave)
    canvas.addEventListener('wheel', this.wheel, { passive: false })
    void this.art.load().then(() => { if (!this.disposed) { this.floors.clear(); this.furniture.clear(); this.routes.clear(); this.invalidate() } })
    this.resize()
  }
  private invalidate() {
    this.staticKey = ''
    if (!this.options.onLabels || !this.state) return
    const labels: WorldLabel[] = this.layout.lots.map(lot => {
      const { width } = roomSize(lot, this.occupied(lot))
      const name = this.state!.departments.find(d => d.id === lot.departmentId)?.name ?? ''
      return { id: `${lot.departmentId}:${lot.block}`, name: `${name}${lot.block ? ` · ${lot.block + 1}` : ''}`, kind: 'department', x: lot.x + width / 2, y: lot.y + 23 }
    })
    for (const node of this.state.externalNodes) {
      const anchor = this.externalPoint(node.id)
      labels.push({ id: node.id, name: node.name, kind: node.kind, x: anchor.x, y: anchor.y + (node.kind === 'user' ? -50 : 8) })
    }
    const c = this.hitCamera()
    let machineRow = 0
    this.options.onLabels(labels.map(label => ({ ...label, x: Math.round(label.x * c.zoom + c.x), y: Math.round(label.y * c.zoom + c.y) + (label.kind === 'machine' ? machineRow++ * 16 : 0) })))
  }
  private occupied(lot: Layout['lots'][number]) { return this.layout.seats.some(s => s.departmentId === lot.departmentId && Math.floor(s.index / 8) === lot.block) }
  private externalPoint(id: string): Point {
    const nodes = this.state?.externalNodes ?? [], machines = nodes.filter(n => n.kind === 'machine')
    const x = this.layout.bounds.x + this.layout.bounds.width + 2 * TILE
    const node = nodes.find(n => n.id === id)
    return node?.kind === 'user' ? { x: x + 5 * TILE, y: -24 } : { x: x + (5 + machines.findIndex(n => n.id === id) * 3) * TILE, y: 5 * TILE }
  }
  private occupants(state: OfficeState) {
    const occupied = state.agents.map(a => ({ paneId: a.paneId, departmentId: a.departmentId }))
    for (const s of state.seats) if (s.terminal && s.paneId && !occupied.some(a => a.paneId === s.paneId)) occupied.push({ paneId: s.paneId, departmentId: s.departmentId })
    return occupied
  }
  update(update: OfficeUpdate) {
    const now = Date.now(), previous = this.state
    if (!previous || previous.session !== update.state.session || previous.generation !== update.state.generation) {
      // A generation is a baseline: no old relationships or effects can leak into it.
      this.effects.clear()
      if (!previous || previous.session !== update.state.session) { this.layoutModel.clear(); this.hasFit = false; this.geometryKey = '' }
    }
    this.state = update.state
    const routeKey = JSON.stringify([update.state.session, update.state.generation, update.state.agents.map(a => [a.id, a.kind, a.role])])
    if (this.routeKey !== routeKey) { this.routeKey = routeKey; this.routes.clear() }
    const activePairs = new Set([...update.state.links.map(l => JSON.stringify([l.from, l.to, l.style === 'machine'])), ...[...this.effects.active, ...update.animations].map(l => JSON.stringify([l.from, l.to, false]))])
    for (const key of this.routes.keys()) if (!activePairs.has(key)) this.routes.delete(key)
    this.sampledAt = now
    const occupants = this.occupants(update.state)
    const key = JSON.stringify([update.state.departments.map(d => [d.id, d.number, d.name]).sort(), occupants.map(a => [a.paneId, a.departmentId]).sort(), update.state.externalNodes.map(n => [n.id, n.kind, n.name]).sort()])
    if (this.geometryKey !== key) {
      this.geometryKey = key
      this.layout = this.layoutModel.update(update.state.departments, occupants)
      this.routes.clear()
      this.floors.clear(); this.invalidate()
    }
    if (!this.hasFit && update.state.departments.length && this.width > 1 && this.height > 1) this.fit()
    // init/return are baseline snapshots, even if a caller accidentally supplies historical effects.
    if (previous && previous.session === update.state.session && previous.generation === update.state.generation) this.effects.ingest(update.animations, now, this.visible && this.focused && !this.reducedMotion)
  }
  setVisibility(visible: boolean, focused: boolean) {
    if (!visible || !focused || !this.visible) this.effects.discardMotion()
    this.visible = visible; this.focused = focused
    this.loop.setVisibility(visible, focused)
    if (!visible) this.setHovered(null)
  }
  setConnected(connected: boolean) { this.connected = connected; if (!connected) this.effects.discardMotion() }
  setOptions(showTerminals: boolean, reducedMotion: boolean) {
    this.showTerminals = showTerminals; this.reducedMotion = reducedMotion
    if (reducedMotion) this.effects.discardMotion()
    this.invalidate()
  }
  private worldBounds() {
    const bounds = { ...this.layout.bounds }
    if (this.state?.externalNodes.length) { bounds.width += 13 * TILE; bounds.height = Math.max(bounds.height, 120 + this.state.externalNodes.length * 72) }
    if (this.state?.externalNodes.some(n => n.kind === 'user')) { const top = Math.min(bounds.y, -88); bounds.height += bounds.y - top; bounds.y = top }
    return bounds
  }
  fit() {
    const bounds = this.worldBounds()
    this.camera = fitCamera(bounds, this.width, this.height); this.hasFit = true; this.invalidate() }
  reset() { const bounds = this.worldBounds(); this.camera = { zoom: 1, x: 24 - bounds.x, y: 24 - bounds.y }; this.hasFit = true; this.invalidate() }
  zoom(zoom: number) { this.camera = zoomAt(this.camera, zoom, { x: this.width / 2, y: this.height / 2 }); this.hasFit = true; this.invalidate() }
  repack() {
    if (!this.state) return
    this.layout = this.layoutModel.update(this.state.departments, this.occupants(this.state), true)
    this.routes.clear()
    this.floors.clear(); this.fit()
  }
  private resize = () => {
    const bounds = this.canvas.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    this.width = bounds.width; this.height = bounds.height
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr)
    this.staticLayer.width = this.canvas.width; this.staticLayer.height = this.canvas.height
    if (!this.hasFit && this.state?.departments.length) this.fit()
    this.invalidate()
  }
  private hitCamera(): Camera { return { ...this.camera, x: Math.round(this.camera.x), y: Math.round(this.camera.y) } }
  private screen(event: MouseEvent): Point { const r = this.canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top } }
  private setHovered(id: string | null) { if (id !== this.hovered) { this.hovered = id; this.options.onHover(id) } }
  private pointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.pointer) return
    const p = this.screen(e)
    this.gesture.begin(p); this.pointer = { id: e.pointerId, last: p, initial: { ...this.camera } }
    this.canvas.setPointerCapture(e.pointerId)
  }
  private pointerMove = (e: PointerEvent) => {
    const p = this.screen(e)
    if (this.pointer?.id === e.pointerId) {
      if (this.gesture.move(p)) {
        this.camera.x = this.pointer.initial.x + p.x - this.pointer.last.x
        this.camera.y = this.pointer.initial.y + p.y - this.pointer.last.y
        this.hasFit = true; this.invalidate(); this.setHovered(null)
      }
    } else this.setHovered(hitTest(this.targets, p, this.hitCamera()))
  }
  private pointerUp = (e: PointerEvent) => {
    if (this.pointer?.id !== e.pointerId) return
    const click = this.gesture.end(this.screen(e))
    this.pointer = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (click && this.connected) { const paneId = hitTest(this.targets, this.screen(e), this.hitCamera()); if (paneId) this.options.onOpen(paneId) }
  }
  private pointerCancel = () => { this.gesture.cancel(); this.pointer = null }
  private pointerLeave = () => { if (!this.pointer) this.setHovered(null) }
  private wheel = (e: WheelEvent) => {
    e.preventDefault()
    const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1
    if (e.ctrlKey || e.metaKey) this.camera = zoomAt(this.camera, Math.min(3, Math.max(0.1, this.camera.zoom * Math.exp(-e.deltaY * multiplier * 0.01))), this.screen(e))
    else { this.camera.x -= e.deltaX * multiplier; this.camera.y -= e.deltaY * multiplier }
    this.hasFit = true; this.invalidate()
  }
  private transform(ctx: CanvasRenderingContext2D) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.translate(Math.round(this.camera.x), Math.round(this.camera.y)); ctx.scale(this.camera.zoom, this.camera.zoom)
    ctx.imageSmoothingEnabled = false
  }
  private inView(rect: { x: number; y: number; width: number; height: number }) {
    const c = this.camera
    return (rect.x + rect.width) * c.zoom + c.x >= 0 && rect.x * c.zoom + c.x < this.width && (rect.y + rect.height) * c.zoom + c.y >= 0 && rect.y * c.zoom + c.y < this.height
  }
  private paintFurniture(ctx: CanvasRenderingContext2D, sprite: SceneSprite, time = 0) {
    const state = sprite.state ?? 'default'
    const frame = this.art.frame(sprite.id, state, time)
    if (!frame) { this.art.paint(ctx, sprite.id, state, sprite.anchor, time); return }
    // Each immutable atlas frame has its own cache; animated desk.back keeps cycling.
    const key = JSON.stringify([sprite.id, state, frame.rect])
    let cached = this.furniture.get(key)
    if (!cached) {
      cached = makeCanvas(frame.rect.width, frame.rect.height)
      const context = cached.getContext('2d')!
      context.imageSmoothingEnabled = false
      if (!this.art.paint(context, sprite.id, state, frame.anchor, time)) return
      this.furniture.set(key, cached)
    }
    ctx.drawImage(cached, Math.round(sprite.anchor.x - frame.anchor.x), Math.round(sprite.anchor.y - frame.anchor.y))
  }
  private floor(lot: Layout['lots'][number]): HTMLCanvasElement {
    const key = `${lot.departmentId}:${lot.block}`, cached = this.floors.get(key)
    if (cached) return cached
    const occupied = this.occupied(lot)
    const { width, height } = roomSize(lot, occupied)
    const floor = makeCanvas(width, height), ctx = floor.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    const tile = (id: string, x: number, y: number) => this.art.paint(ctx, id, 'default', { x: x * TILE, y: y * TILE }, 0)
    for (let y = 0; y < height / TILE; y++) for (let x = 0; x < width / TILE; x++) {
      if (tile(`tile.floor.wood.${(x * 7 + y * 3) % 3}`, x, y)) continue
      ctx.fillStyle = (x + y) % 2 ? '#b8a382' : '#bda888'; ctx.fillRect(x * TILE, y * TILE, TILE, TILE)
    }
    if (occupied) {
      const number = this.state?.departments.find(d => d.id === lot.departmentId)?.number ?? 1
      const carpet = ['red', 'green', 'blue'][((number - 1) % 3 + 3) % 3]
      for (let y = 4; y < 16; y++) for (let x = 1; x < 23; x++) {
        const part = (y === 4 ? 't' : y === 15 ? 'b' : '') + (x === 1 ? 'l' : x === 22 ? 'r' : '')
        tile(`tile.floor.carpet.${carpet}.${part || 'c'}`, x, y)
      }
    }
    for (let x = 0; x < width / TILE; x++) {
      for (const [y, id] of ['tile.wall.cap', 'tile.wall.face.top', 'tile.wall.face.bottom', 'tile.wall.shadow'].entries()) tile(id, x, y)
    }
    for (let y = 1; y < height / TILE; y++) { tile('tile.wall.cap', 0, y); tile('tile.wall.cap', width / TILE - 1, y) }
    this.floors.set(key, floor)
    return floor
  }
  private paintStatic() {
    const key = JSON.stringify([this.camera, this.width, this.height, this.dpr, this.geometryKey])
    if (key === this.staticKey) return
    const ctx = this.staticLayer.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.staticLayer.width, this.staticLayer.height)
    this.transform(ctx)
    for (const lot of this.layout.lots) if (this.inView(lot)) ctx.drawImage(this.floor(lot), lot.x, lot.y)
    if (this.state?.externalNodes.some(n => n.kind === 'machine')) {
      const x = this.layout.bounds.x + this.layout.bounds.width + 2 * TILE
      if (this.inView({ x, y: 0, width: 11 * TILE, height: 11 * TILE })) {
        for (let y = 1; y < 10; y++) for (let tx = 0; tx < 10; tx++) this.paintFurniture(ctx, { id: 'tile.floor.server', anchor: { x: x + tx * TILE, y: y * TILE } })
      }
    }
    this.staticKey = key
  }
  private paintAgent(ctx: CanvasRenderingContext2D, a: OfficeAgent, seat: Seat, now: number) {
    const status = this.connected ? a.status : 'disconnect'
    const time = this.reducedMotion || status === 'disconnect' || status === 'unknown' ? 0 : Math.max(0, now - a.lastStatusAt)
    const pose = seatPose(seat)
    const state = `${status === 'disconnect' ? 'unknown' : status}:${pose.direction}`
    const id = this.art.manifest?.sprites[`agent.${a.kind}`] ? `agent.${a.kind}` : this.art.manifest?.sprites[a.kind] ? a.kind : 'agent.general'
    if (!this.art.paint(ctx, id, state, pose.agent, time)) {
      const bob = status === 'working' && !this.reducedMotion ? Math.floor(time / 180) % 2 : 0
      const { x, y } = pose.agent
      ctx.fillStyle = '#473c40'; ctx.fillRect(x - 10, y - 4, 20, 4)
      ctx.fillStyle = KIND_COLORS[a.kind] ?? '#aaa292'; ctx.fillRect(x - 9, y - 24 + bob, 18, 20)
      ctx.fillStyle = '#edd1a3'; ctx.fillRect(x - 7, y - 37 + bob, 14, 13)
      ctx.fillStyle = '#493e3c'; ctx.fillRect(x - 8, y - 40 + bob, 16, 6)
      ctx.fillStyle = '#2e3540'; ctx.fillRect(x - 4, y - 30 + bob, 2, 2); ctx.fillRect(x + 3, y - 30 + bob, 2, 2)
    }
    const role = this.art.manifest?.sprites[`role.${a.role}`] ? a.role : 'general'
    if (!this.art.paint(ctx, `role.${role}`, state, pose.agent, time) && role !== 'general') {
      ctx.fillStyle = a.role === 'lead' ? '#f5d77a' : '#fcf2d5'; ctx.fillRect(pose.agent.x + 5, pose.agent.y - 21, 5, 5)
    }
    this.targets.push({ paneId: a.paneId, y: pose.agent.y, rect: this.art.hitRect(id, state, pose.agent) })
  }
  private linkRoute(from: string, to: string, machine: boolean, points: Map<string, Point>, hits: Rect[]): Point[] {
    const key = JSON.stringify([from, to, machine]), cached = this.routes.get(key)
    if (cached) return cached
    const start = points.get(from), end = points.get(to)
    if (!start || !end) return []
    let route: Point[]
    if (machine) {
      const agent = this.state?.agents.find(a => a.id === from)
      const seat = agent && this.layout.seats.find(s => s.paneId === agent.paneId)
      const lot = seat && this.layout.lots.find(l => l.departmentId === seat.departmentId && l.block === Math.floor(seat.index / 8))
      const rooms = this.layout.lots.map(l => { const size = roomSize(l, this.occupied(l)); return { ...l, width: size.width, height: size.height + TILE } })
      route = seat && lot ? routeCable(seat, lot, rooms, end, hits) : []
    } else route = routeLine(start, end, hits)
    this.routes.set(key, route)
    return route
  }
  private paintLinks(ctx: CanvasRenderingContext2D, points: Map<string, Point>, hits: Rect[], now: number, floor: boolean) {
    if (!this.state) return
    const stamp = (id: string, from: Point, to: Point, step: number) => {
      const distance = Math.hypot(to.x - from.x, to.y - from.y)
      for (let along = Math.min(step, distance / 2); along < distance; along += step) {
        const p = { x: Math.round(from.x + (to.x - from.x) * along / distance), y: Math.round(from.y + (to.y - from.y) * along / distance) }
        if (!this.art.paint(ctx, id, 'default', p, 0)) { ctx.fillStyle = '#fbe6c4'; ctx.fillRect(p.x, p.y, 2, 2) }
      }
    }
    for (const link of this.state.links) {
      if ((link.style === 'machine') !== floor || now - link.lastAt > OFFICE_LIMITS.historyMs) continue
      const route = this.linkRoute(link.from, link.to, floor, points, hits)
      if (route.length < 2) continue
      const from = route[0], to = route.at(-1)!
      const xs = route.map(p => p.x), ys = route.map(p => p.y)
      if (!this.inView({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })) continue
      const weight = decayedWeight(link.weight, this.sampledAt, now)
      ctx.globalAlpha = Math.min(0.95, 0.6 + weight / 15)
      if (link.style === 'machine') {
        for (let i = 1; i < route.length; i++) {
          // Cable atlas anchors are at the start of each eight-pixel segment.
          const a = route[i - 1], b = route[i], horizontal = a.y === b.y
          const low = horizontal ? { x: Math.min(a.x, b.x), y: a.y } : { x: a.x, y: Math.min(a.y, b.y) }
          const length = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)
          for (let along = 0; along < length; along += 8) this.art.paint(ctx, horizontal ? 'effect.cable.h' : 'effect.cable.v', 'default', { x: low.x + (horizontal ? along : 0), y: low.y + (horizontal ? 0 : along) }, 0)
        }
        this.art.paint(ctx, 'effect.cable.plug', 'default', to, 0)
      } else if (link.style === 'attempt') {
        for (let i = 1; i < route.length; i++) stamp('effect.dash', route[i - 1], route[i], 7)
        this.art.paint(ctx, 'effect.attempt', 'default', pointOnRoute(route, 0.5)!, 0)
      } else {
        ctx.lineWidth = 2; ctx.strokeStyle = link.style === 'agent' ? '#fbe6c4' : '#b6d6d0'
        ctx.setLineDash(link.style === 'agent' ? [] : [4, 4])
        ctx.beginPath(); ctx.moveTo(from.x, from.y); for (const p of route.slice(1)) ctx.lineTo(p.x, p.y); ctx.stroke()
        const previous = route.at(-2)!, angle = Math.atan2(to.y - previous.y, to.x - previous.x)
        ctx.beginPath(); ctx.moveTo(Math.round(to.x - 8 * Math.cos(angle - 0.45)), Math.round(to.y - 8 * Math.sin(angle - 0.45))); ctx.lineTo(to.x, to.y); ctx.lineTo(Math.round(to.x - 8 * Math.cos(angle + 0.45)), Math.round(to.y - 8 * Math.sin(angle + 0.45))); ctx.stroke()
      }
    }
    ctx.globalAlpha = 1; ctx.setLineDash([])
  }
  private draw = () => {
    if (this.disposed) return
    if (this.dpr !== window.devicePixelRatio) this.resize()
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const now = Date.now()
    this.effects.advance(now)
    this.paintStatic()
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.drawImage(this.staticLayer, 0, 0)
    this.transform(ctx); this.targets = []
    if (!this.state) return
    const points = new Map<string, Point>()
    const hits: Rect[] = []
    const seatsByPane = new Map(this.layout.seats.map(s => [s.paneId, s]))
    for (const a of this.state.agents) {
      const s = seatsByPane.get(a.paneId)
      if (!s) continue
      const pose = seatPose(s), id = this.art.manifest?.sprites[`agent.${a.kind}`] ? `agent.${a.kind}` : this.art.manifest?.sprites[a.kind] ? a.kind : 'agent.general'
      const hit = this.art.hitRect(id, `idle:${pose.direction}`, pose.agent)
      hits.push(hit); points.set(a.id, aboveHead(pose.agent, hit))
    }
    for (const d of this.state.departments) { const l = this.layout.lots.find(l => l.departmentId === d.id && !l.block); if (l) points.set(d.id, { x: l.x + 4 * TILE, y: l.y + 46 }) }
    for (const node of this.state.externalNodes) {
      const anchor = this.externalPoint(node.id)
      if (node.kind === 'user' && this.art.manifest?.sprites['object.user']) {
        const hit = this.art.hitRect('object.user', 'default', anchor)
        hits.push(hit); points.set(node.id, aboveHead(anchor, hit))
      } else points.set(node.id, anchor)
    }
    // Floor cables are covered by desks, characters, furniture and front walls.
    this.paintLinks(ctx, points, hits, now, true)
    const objects: { y: number; layer: number; paint(): void }[] = []
    const addSprite = (sprite: SceneSprite, time = 0) => {
      const layer = this.art.manifest?.layers.indexOf(this.art.manifest.sprites[sprite.id]?.layers[0] ?? '') ?? 0
      objects.push({ y: sprite.anchor.y, layer, paint: () => this.paintFurniture(ctx, sprite, time) })
    }
    for (const lot of this.layout.lots) {
      if (!this.inView({ ...lot, height: lot.height + TILE })) continue
      const occupied = this.occupied(lot)
      for (const sprite of roomDecor(lot, occupied)) addSprite(sprite)
      const { width, height } = roomSize(lot, occupied)
      for (let x = 0; x < width; x += TILE) addSprite({ id: 'tile.wall.cap.front', anchor: { x: lot.x + x, y: lot.y + height } })
    }
    if (this.state.externalNodes.some(n => n.kind === 'machine')) {
      const x = this.layout.bounds.x + this.layout.bounds.width + 2 * TILE
      for (let tx = 0; tx < 10; tx++) { addSprite({ id: 'tile.wall.cap', anchor: { x: x + tx * TILE, y: 0 } }); addSprite({ id: 'tile.wall.cap.front', anchor: { x: x + tx * TILE, y: 10 * TILE } }) }
      for (let y = 0; y < 11; y++) for (const tx of [-1, 10]) addSprite({ id: 'tile.wall.cap', anchor: { x: x + tx * TILE, y: y * TILE } })
      for (const tx of [1, 2]) addSprite({ id: 'object.server.rack', anchor: { x: x + tx * TILE + 8, y: 5 * TILE } })
    }
    for (const node of this.state.externalNodes) addSprite({ id: node.kind === 'user' ? 'object.user' : `object.machine.${node.name}`, anchor: this.externalPoint(node.id) }, node.kind === 'user' && !this.reducedMotion && this.connected ? now : 0)
    const agentsByPane = new Map(this.state.agents.map(a => [a.paneId, a]))
    for (const seat of this.layout.seats) {
      const a = agentsByPane.get(seat.paneId)
      if (!a && !this.showTerminals) continue
      if (!this.inView({ x: seat.x, y: seat.y - 48, width: seat.width, height: seat.height + 64 })) continue
      const status = this.connected ? a?.status : 'disconnect'
      const time = this.reducedMotion || status === 'disconnect' || status === 'unknown' ? 0 : Math.max(0, now - (a?.lastStatusAt ?? 0))
      const pose = seatPose(seat), deskState = status === 'unknown' || status === 'disconnect' ? 'off' : 'on'
      addSprite({ id: a ? `object.desk.${pose.direction}` : 'object.desk.terminal', state: deskState, anchor: seat.anchor }, time)
      this.targets.push({ paneId: seat.paneId, y: seat.anchor.y, rect: seat })
      if (a) {
        addSprite({ id: `object.chair.${pose.direction}`, anchor: pose.chair })
        objects.push({ y: pose.agent.y, layer: this.art.manifest?.layers.indexOf('body') ?? 0, paint: () => this.paintAgent(ctx, a, seat, now) })
      }
    }
    objects.sort((a, b) => a.y - b.y || a.layer - b.layer).forEach(o => o.paint())
    this.paintLinks(ctx, points, hits, now, false)
    if (!this.reducedMotion) for (const envelope of this.effects.active) {
      const route = this.linkRoute(envelope.from, envelope.to, false, points, hits)
      const progress = Math.min(1, (now - envelope.startedAt) / 1400)
      const p = pointOnRoute(route, progress)
      if (!p) continue
      const { x, y } = p
      if (!this.art.paint(ctx, 'effect.envelope', 'default', { x, y }, now - envelope.startedAt)) {
        ctx.fillStyle = '#fff1c4'; ctx.fillRect(x - 6, y - 4, 12, 8); ctx.strokeStyle = '#755d45'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(x - 6, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + 6, y - 4); ctx.stroke()
      }
      if (envelope.count > 1) { ctx.fillStyle = '#fff1c4'; ctx.font = 'bold 11px system-ui'; ctx.fillText(`×${envelope.count}`, x + 8, y) }
    }
  }
  dispose() {
    this.disposed = true; this.loop.dispose(); this.resizeObserver.disconnect(); this.effects.clear(); this.floors.clear(); this.furniture.clear(); this.routes.clear()
    this.canvas.removeEventListener('pointerdown', this.pointerDown); this.canvas.removeEventListener('pointermove', this.pointerMove)
    this.canvas.removeEventListener('pointerup', this.pointerUp); this.canvas.removeEventListener('pointercancel', this.pointerCancel)
    this.canvas.removeEventListener('lostpointercapture', this.pointerCancel); this.canvas.removeEventListener('pointerleave', this.pointerLeave); this.canvas.removeEventListener('wheel', this.wheel)
    this.pointerCancel(); this.setHovered(null)
  }
}
