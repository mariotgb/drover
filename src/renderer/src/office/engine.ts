import { OFFICE_LIMITS, type OfficeAgent, type OfficeState, type OfficeUpdate } from '@shared/office'
import { OfficeArt } from './art'
import { DragGesture, fitCamera, hitTest, zoomAt, type Camera, type HitTarget } from './camera'
import { arcPoint, carrierPhase, decayedWeight, EnvelopeQueue, rasterArc } from './effects'
import { OfficeLayout, type Layout, type Point, type Rect, type Seat } from './layout'
import { FrameLoop } from './scheduler'
import { roomDecor, seatPose } from './scene'
import { pointOnRoute, routeCable } from './routes'
import { shortAgentNames } from './labels'
import { language, t } from '../i18n'
import { officeText } from './text'

export interface WorldLabel { id: string; name: string; kind: 'department' | 'user' | 'machine'; x: number; y: number }
export interface MapSnapshot { bounds: Rect; rooms: Rect[]; viewport: Rect; camera: Camera; width: number; height: number }
interface EngineOptions {
  onOpen(paneId: string): void
  onHover(paneId: string | null): void
  onSelect?(paneId: string): void
  onLabels?(labels: WorldLabel[]): void
  onMap?(map: MapSnapshot): void
}
interface NodePose { agent: Point; hand: Point; land: Point; label: Point; bubble: Point }
export class OfficeEngine {
  readonly performance = { samples: [] as number[], frames: 0, p95: 0 }
  private nextSnapshotBaseline = true
  private frozenAt = Date.now()
  camera: Camera = { x: 24, y: 24, zoom: 2 }
  private state: OfficeState | null = null
  private layoutModel = new OfficeLayout()
  private layout: Layout = this.layoutModel.update([], [])
  private geometryKey = ''
  private world: HTMLCanvasElement | null = null
  private bakeKey = ''
  private art = new OfficeArt()
  private effects = new EnvelopeQueue()
  private loop: FrameLoop
  private resizeObserver: ResizeObserver
  private width = 1
  private height = 1
  private dpr = 1
  private visible = false
  private focused = true
  private connected = true
  private reducedMotion = false
  private showTerminals = false
  private showLinks = true
  private hasFit = false
  private department: string | null = null
  private selected: string | null = null
  private targets: HitTarget[] = []
  private hovered: string | null = null
  private gesture = new DragGesture()
  private pointer: { id: number; start: Point; initial: Camera } | null = null
  private disposed = false
  private linkPaths = new Map<string, { core: Path2D; shade: Path2D }>()
  private routes = new Map<string, Point[]>()
  private seatsByPane = new Map<string, Seat>()
  private agentsByPane = new Map<string, OfficeAgent>()
  private nodes = new Map<string, NodePose>()
  private names = new Map<string, string>()
  private themeRequest = 0
  private hudWidth = 312
  private machineActivity = new Map<string, number>()
  private boardCounts = new Map<string, [number, number, number]>()

  constructor(private canvas: HTMLCanvasElement, private options: EngineOptions) {
    this.loop = new FrameLoop({ request: cb => requestAnimationFrame(cb), cancel: id => cancelAnimationFrame(id) }, this.draw)
    this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(canvas)
    canvas.addEventListener('pointerdown', this.pointerDown); canvas.addEventListener('pointermove', this.pointerMove)
    canvas.addEventListener('pointerup', this.pointerUp); canvas.addEventListener('pointercancel', this.pointerCancel)
    canvas.addEventListener('lostpointercapture', this.pointerCancel); canvas.addEventListener('pointerleave', this.pointerLeave)
    canvas.addEventListener('wheel', this.wheel, { passive: false })
    this.resize()
  }
  async setTheme(dark: boolean) {
    const request = ++this.themeRequest
    await this.art.setTheme(dark ? 'neon' : 'cozy')
    if (this.disposed || request !== this.themeRequest) return
    this.linkPaths.clear(); this.bakeKey = ''; this.world = null; this.invalidate()
  }
  private externalPoint(id: string): Point {
    const node = this.state?.externalNodes.find(n => n.id === id)
    if (node?.kind === 'user') return { x: this.layout.lobby.x + 96, y: this.layout.lobby.y + 132 }
    const index = this.state?.externalNodes.filter(n => n.kind === 'machine').findIndex(n => n.id === id) ?? 0
    return { x: (this.layout.server?.x ?? 0) + (3 + index * 3) * 16, y: -96 }
  }
  private occupants(state: OfficeState) {
    const leads = new Map<string, string>()
    const priority = (a: OfficeAgent) => a.isBoss ? 0 : a.roleSource === 'projectLead' ? 1 : a.role === 'lead' && a.roleSource !== 'name' ? 2 : a.role === 'lead' ? 3 : Infinity
    for (const a of [...state.agents].sort((a, b) => priority(a) - priority(b))) if (!leads.has(a.departmentId) && Number.isFinite(priority(a))) leads.set(a.departmentId, a.paneId)
    const occupied = state.agents.map(a => ({ paneId: a.paneId, departmentId: a.departmentId, lead: leads.get(a.departmentId) === a.paneId, boss: !!a.isBoss }))
    for (const s of state.seats) if (s.terminal && s.paneId && !occupied.some(a => a.paneId === s.paneId)) occupied.push({ paneId: s.paneId, departmentId: s.departmentId, lead: false, boss: false })
    return occupied
  }
  private rebuildGeometry(now: number, repack = false) {
    if (!this.state) return
    const state = this.state
    this.layout = this.layoutModel.update(state.departments, this.occupants(state), repack, now, state.externalNodes.filter(n => n.kind === 'machine').length)
    this.seatsByPane = new Map(this.layout.seats.map(s => [s.paneId, s])); this.agentsByPane = new Map(state.agents.map(a => [a.paneId, a]))
    this.nodes.clear(); this.names.clear(); this.routes.clear(); this.linkPaths.clear(); this.bakeKey = ''
    for (const a of state.agents) {
      const seat = this.seatsByPane.get(a.paneId); if (!seat) continue
      const pose = seatPose(seat), lot = this.layout.lots.find(l => l.departmentId === a.departmentId)!
      this.nodes.set(a.id, a.isBoss ? { ...pose, hand: { x: lot.x + 124, y: lot.y + 70 }, label: { x: lot.x + 112, y: lot.y + 40 }, bubble: { x: lot.x + 112, y: lot.y + 39 } } : pose)
    }
    for (const d of state.departments) {
      const lot = this.layout.lots.find(l => l.departmentId === d.id)
      if (lot) { const p = { x: lot.x + 32, y: lot.y + 22 }; this.nodes.set(d.id, { agent: p, hand: p, land: p, label: p, bubble: p }) }
      for (const [id, name] of shortAgentNames(state.agents.filter(a => a.departmentId === d.id), [d])) this.names.set(id, name)
    }
    for (const n of state.externalNodes) {
      const p = this.externalPoint(n.id)
      this.nodes.set(n.id, { agent: p, hand: { x: p.x + 10, y: p.y - 30 }, land: { x: p.x, y: p.y + 28 }, label: { x: p.x, y: p.y + (n.kind === 'user' ? -50 : 34) }, bubble: { x: p.x, y: p.y - 44 } })
    }
    this.invalidate()
  }
  update(update: OfficeUpdate) {
    const now = Date.now(), previous = this.state
    const baseline = this.nextSnapshotBaseline || !previous || previous.session !== update.state.session || previous.generation !== update.state.generation
    this.nextSnapshotBaseline = false
    if (baseline) {
      this.machineActivity.clear(); this.effects.clear(); this.effects.baseline(update.state.recentEvents)
      if (!previous || previous.session !== update.state.session) { this.layoutModel.clear(); this.geometryKey = ''; this.hasFit = false }
    }
    this.state = update.state
    this.agentsByPane = new Map(update.state.agents.map(a => [a.paneId, a]))
    const key = JSON.stringify([update.state.departments, this.occupants(update.state), update.state.externalNodes])
    // Update hysteresis on snapshots as well as membership changes.
    const layout = this.layoutModel.update(update.state.departments, this.occupants(update.state), false, now, update.state.externalNodes.filter(n => n.kind === 'machine').length)
    if (key !== this.geometryKey || JSON.stringify(layout.lots) !== JSON.stringify(this.layout.lots)) {
      this.geometryKey = key; this.rebuildGeometry(now)
    }
    if (!this.hasFit && update.state.departments.length && this.width > 1) this.focusDepartment(this.department ?? update.state.departments[0].id)
    const distance = (a: string, b: string) => { const from = this.nodes.get(a)?.hand, to = this.nodes.get(b)?.land; return from && to ? Math.hypot(from.x - to.x, from.y - to.y) : 0 }
    const enabled = this.visible && this.focused && this.connected
    if (!baseline) {
      if (enabled) for (const receipt of update.animations) {
        if (now - receipt.ts > OFFICE_LIMITS.animationTtlMs || receipt.ts > now + 1000 || !update.state.externalNodes.some(n => n.kind === 'machine' && n.id === receipt.to)) continue
        this.machineActivity.set(receipt.to, Math.max(this.machineActivity.get(receipt.to) ?? -Infinity, receipt.ts))
      }
      this.effects.ingest(update.animations, now, enabled, distance, this.reducedMotion)
      this.effects.ingestEvents(update.state, now, enabled, distance, this.reducedMotion)
      if (enabled && !this.reducedMotion) for (const a of update.state.agents) {
        const old = previous?.agents.find(p => p.id === a.id)
        if (a.status === 'done' && old && old.status !== 'done' && now - a.lastStatusAt <= OFFICE_LIMITS.animationTtlMs) this.effects.celebrations.set(a.id, now)
      }
    }
    this.effects.pruneNotes(update.state, now)
    for (const [id, at] of this.machineActivity) if (now - at >= 4000) this.machineActivity.delete(id)
  }
  setVisibility(visible: boolean, focused: boolean) {
    if (!visible || !focused || !this.visible) { this.effects.discardMotion(); this.machineActivity.clear() }
    if (visible && !this.visible) this.nextSnapshotBaseline = true
    this.visible = visible; this.focused = focused; this.loop.setVisibility(visible, focused)
    if (!visible) this.setHovered(null)
  }
  setConnected(connected: boolean) { if (!connected && this.connected) { this.frozenAt = Date.now(); this.nextSnapshotBaseline = true }; this.connected = connected; if (!connected) { this.effects.discardMotion(); this.machineActivity.clear() } }
  setOptions(showTerminals: boolean, reducedMotion: boolean, showLinks = true, hudWidth = 312) {
    if (reducedMotion && !this.reducedMotion) this.effects.discardMotion()
    this.hudWidth = hudWidth
    this.showTerminals = showTerminals; this.reducedMotion = reducedMotion; this.showLinks = showLinks
  }
  setBoardCounts(counts: Map<string, [number, number, number]>) { if (JSON.stringify([...this.boardCounts]) !== JSON.stringify([...counts])) { this.boardCounts = counts; this.bakeKey = ''; this.world = null } }
  select(paneId: string | null) { this.selected = paneId }
  locate(paneId: string) {
    const seat = this.seatsByPane.get(paneId)
    if (!seat) return
    this.selected = paneId; this.center(seatPose(seat).agent)
  }
  setDepartment(id: string | null) { this.department = id; if (!this.hasFit && id) this.home() }
  home() { this.focusDepartment(this.department ?? this.state?.departments[0]?.id ?? '') }
  mapPoint(x: number, y: number, width: number, height: number) { const b = this.layout.bounds; this.center({ x: b.x + x / width * b.width, y: b.y + y / height * b.height }) }
  focusDepartment(id: string) {
    this.department = id
    const lot = this.layout.lots.find(l => l.departmentId === id)
    if (!lot) return
    this.camera = { zoom: 2, x: (this.width - this.hudWidth - lot.width * 2) / 2 - lot.x * 2, y: 120 - lot.y * 2 }
    this.hasFit = true; this.invalidate()
  }
  center(p: Point) { this.camera.x = (this.width - this.hudWidth) / 2 - p.x * this.camera.zoom; this.camera.y = this.height / 2 - p.y * this.camera.zoom; this.hasFit = true; this.invalidate() }
  fit() { this.camera = fitCamera(this.layout.bounds, this.width - this.hudWidth, this.height); this.hasFit = true; this.invalidate() }
  reset() { this.focusDepartment(this.department ?? this.state?.departments[0]?.id ?? '') }
  zoom(zoom: number) { this.camera = zoomAt(this.camera, Math.max(1, Math.min(3, Math.round(zoom))), { x: (this.width - this.hudWidth) / 2, y: this.height / 2 }); this.hasFit = true; this.invalidate() }
  repack() { this.rebuildGeometry(Date.now(), true); this.reset() }
  mapState(): MapSnapshot {
    const c = this.hitCamera()
    return { camera: c, width: this.width, height: this.height, bounds: this.layout.bounds, rooms: [this.layout.lobby, ...this.layout.lots, ...(this.layout.server ? [this.layout.server] : [])], viewport: { x: -c.x / c.zoom, y: -c.y / c.zoom, width: Math.max(1, this.width - this.hudWidth) / c.zoom, height: this.height / c.zoom } }
  }
  paintMap(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d'); if (!ctx || !this.world) return
    ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(this.world, 0, 0, canvas.width, canvas.height)
    const { bounds: b, viewport: v } = this.mapState()
    ctx.strokeStyle = this.art.theme === 'neon' ? '#b9f7ff' : '#fff9e0'; ctx.lineWidth = 2
    ctx.strokeRect((v.x - b.x) / b.width * canvas.width, (v.y - b.y) / b.height * canvas.height, v.width / b.width * canvas.width, v.height / b.height * canvas.height)
  }
  portrait(paneId: string, canvas: HTMLCanvasElement) {
    const a = this.agentsByPane.get(paneId), ctx = canvas.getContext('2d'); if (!a || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.imageSmoothingEnabled = false
    this.art.paint(ctx, a.isBoss ? 'agent.boss' : `agent.${a.kind}`, a.isBoss ? 'sit:front' : 'idle:front', { x: 16, y: 44 }, 0)
    if (!a.isBoss) this.art.paint(ctx, `role.${a.role}`, 'idle:front', { x: 16, y: 44 }, 0)
  }
  private invalidate() {
    if (this.disposed) return
    const c = this.hitCamera()
    const labels: WorldLabel[] = this.layout.lots.map(l => ({ id: l.departmentId, name: this.state?.departments.find(d => d.id === l.departmentId)?.name ?? '', kind: 'department', x: l.x + 90, y: 12 }))
    for (const n of this.state?.externalNodes ?? []) { const p = this.nodes.get(n.id)?.label; if (p) labels.push({ id: n.id, name: n.kind === 'user' ? t('You') : n.name, kind: n.kind, ...p }) }
    this.options.onLabels?.(labels.map(l => ({ ...l, ...{ x: Math.round(l.x * c.zoom + c.x), y: Math.round(l.y * c.zoom + c.y) } })))
    this.options.onMap?.(this.mapState())
  }
  private resize = () => {
    const rect = this.canvas.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return
    this.width = rect.width; this.height = rect.height; this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr); this.invalidate()
  }
  private hitCamera(): Camera { return { ...this.camera, x: Math.round(this.camera.x), y: Math.round(this.camera.y) } }
  private screen(e: MouseEvent): Point { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  private setHovered(id: string | null) { if (id !== this.hovered) { this.hovered = id; this.options.onHover(id) } }
  private pointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.pointer) return
    const p = this.screen(e); this.gesture.begin(p); this.pointer = { id: e.pointerId, start: p, initial: { ...this.camera } }; this.canvas.setPointerCapture(e.pointerId)
  }
  private pointerMove = (e: PointerEvent) => {
    const p = this.screen(e)
    if (this.pointer?.id === e.pointerId) {
      if (this.gesture.move(p)) { this.camera.x = this.pointer.initial.x + p.x - this.pointer.start.x; this.camera.y = this.pointer.initial.y + p.y - this.pointer.start.y; this.hasFit = true; this.invalidate(); this.setHovered(null) }
    } else this.setHovered(hitTest(this.targets, p, this.hitCamera()))
  }
  private pointerUp = (e: PointerEvent) => {
    if (this.pointer?.id !== e.pointerId) return
    const click = this.gesture.end(this.screen(e)); this.pointer = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    if (click && this.connected) { const id = hitTest(this.targets, this.screen(e), this.hitCamera()); if (id) { this.selected = id; (this.options.onSelect ?? this.options.onOpen)(id) } }
  }
  private pointerCancel = () => { this.gesture.cancel(); this.pointer = null }
  private pointerLeave = () => { if (!this.pointer) this.setHovered(null) }
  private wheel = (e: WheelEvent) => {
    e.preventDefault(); const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1
    if (e.ctrlKey || e.metaKey) this.camera = zoomAt(this.camera, Math.max(1, Math.min(3, this.camera.zoom + (e.deltaY > 0 ? -1 : 1))), this.screen(e))
    else { this.camera.x -= e.deltaX * multiplier; this.camera.y -= e.deltaY * multiplier }
    this.hasFit = true; this.invalidate()
  }
  private inView(r: Rect) { const c = this.camera; return (r.x + r.width) * c.zoom + c.x >= 0 && r.x * c.zoom + c.x < this.width && (r.y + r.height) * c.zoom + c.y >= 0 && r.y * c.zoom + c.y < this.height }
  private bake(now: number) {
    const key = `${this.geometryKey}:${this.art.theme}:${language()}:${Math.floor(now / 600_000)}:${this.layout.bounds.height}`
    if (key === this.bakeKey) return
    this.world = this.art.bake(this.layout, new Map(this.state?.departments.map(d => [d.id, d.name]) ?? []), now, this.boardCounts)
    this.bakeKey = key; this.options.onMap?.(this.mapState())
  }
  private cable(from: string, to: string): Point[] {
    const key = JSON.stringify([from, to]), cached = this.routes.get(key); if (cached) return cached
    const a = this.state?.agents.find(a => a.id === from), seat = a && this.seatsByPane.get(a.paneId), lot = seat && this.layout.lots.find(l => l.departmentId === seat.departmentId)
    const machine = this.nodes.get(to)?.land
    const route = seat && lot && machine && this.layout.server ? routeCable(seat, lot, this.layout.server, machine) : []
    this.routes.set(key, route); return route
  }
  private paintLinks(ctx: CanvasRenderingContext2D, now: number, floor: boolean) {
    if (!this.state) return
    const motion = this.connected && this.focused && !this.reducedMotion
    for (const link of this.state.links) {
      if ((link.style === 'machine') !== floor || now - link.lastAt > OFFICE_LIMITS.historyMs || !floor && !this.showLinks) continue
      const a = this.nodes.get(link.from), b = this.nodes.get(link.to); if (!a || !b) continue
      const fresh = decayedWeight(1, link.lastAt, now), active = floor ? link.kind !== 'ssh_attempt' && now - (this.machineActivity.get(link.to) ?? -Infinity) < 4000 : now - link.lastAt < 4000
      ctx.globalAlpha = floor ? active ? 1 : Math.max(0.1, fresh * 0.3) : Math.max(0.08, Math.min(0.9, fresh))
      if (floor) {
        const route = this.cable(link.from, link.to); if (route.length < 2) continue
        ctx.strokeStyle = this.art.manifest?.version === 2 ? this.art.manifest.palette.cable[1] : this.art.theme === 'neon' ? '#55ba70' : '#4376a4'; ctx.lineWidth = link.kind === 'ssh_attempt' ? 1 : 3; ctx.setLineDash(link.kind === 'ssh_attempt' ? [3, 5] : [])
        ctx.beginPath(); ctx.moveTo(route[0].x, route[0].y); const reveal = Math.max(0, Math.min(1, (now - link.lastAt) / 300)), distance = route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0); let remaining = distance * (this.reducedMotion ? 1 : reveal); for (let i = 1; i < route.length; i++) { const previous = route[i - 1], p = route[i], segment = Math.hypot(p.x - previous.x, p.y - previous.y); if (remaining < segment) { const t = remaining / segment; ctx.lineTo(previous.x + (p.x - previous.x) * t, previous.y + (p.y - previous.y) * t); break }; ctx.lineTo(p.x, p.y); remaining -= segment }; ctx.stroke()
        if (active) {
          const length = route.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0)
          for (let d = motion ? (now - link.lastAt) * 0.09 % 140 : 70; d < length; d += 140) { const p = pointOnRoute(route, d / length)!; this.art.paint(ctx, 'effect.link.dot', 'machine', p, 0) }
        }
      } else {
        const from = a.label, to = b.label, weight = link.count >= 8 ? 3 : link.count >= 3 ? 2 : 1
        const palette = this.art.manifest?.version === 2 ? this.art.manifest.palette : null, key = JSON.stringify([link.from, link.to, weight, link.style, this.art.theme])
        let paths = this.linkPaths.get(key)
        if (!paths) {
          paths = { core: new Path2D(), shade: new Path2D() }
          const dotted = link.style === 'attempt' || palette?.linkStyle === 'dotted' || this.art.theme === 'cozy'
          rasterArc(from, to).forEach((p, i) => {
            if (dotted && i % 3) return
            paths!.core.rect(p.x, p.y, 1, 1)
            if (dotted || weight >= 2) paths!.shade.rect(p.x, p.y + 1, 1, 1)
            if (weight >= 3) paths!.shade.rect(p.x, p.y - 1, 1, 1)
          })
          if (this.linkPaths.size >= 500) this.linkPaths.clear()
          this.linkPaths.set(key, paths)
        }
        ctx.fillStyle = typeof palette?.linkShade === 'string' ? palette.linkShade : '#425161'; ctx.fill(paths.shade)
        ctx.fillStyle = link.style === 'attempt' ? palette?.attempt ?? '#a09a8c' : link.style === 'user' ? palette?.user ?? '#78bce8' : palette?.link ?? (this.art.theme === 'neon' ? '#9bdcef' : '#fff2c9')
        ctx.fill(paths.core)
        if (motion && link.style !== 'attempt') for (let i = 0; i < 2 + weight; i++) {
          const p = arcPoint(from, to, ((now / 1000 * 40 / Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))) + i / (2 + weight)) % 1, 22)
          this.art.paint(ctx, 'effect.link.dot', link.style === 'user' ? 'user' : 'agent', p, 0)
        }
        const flash = this.effects.flashes.get(JSON.stringify([link.from, link.to]))
        if (flash !== undefined) { ctx.globalAlpha = Math.max(0, 1 - (now - flash) / 400); ctx.fillStyle = '#fff8df'; ctx.fill(paths.core) }

      }
    }
    ctx.globalAlpha = 1; ctx.setLineDash([])
  }
  private paintCarriers(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.connected || this.reducedMotion) return
    for (const a of this.effects.active) {
      const from = this.nodes.get(a.from)?.hand, to = this.nodes.get(a.to)?.land; if (!from || !to) continue
      const { phase, progress } = carrierPhase(a, now), user = a.kind === 'user_prompt', boss = this.state?.agents.some(agent => agent.id === a.from && agent.isBoss)
      if (phase === 'throw') continue
      let p = arcPoint(from, to, phase === 'fall' || phase === 'crumple' ? 0.7 : progress, a.kind === 'board' ? 16 : 40)
      if (phase === 'catch') {
        this.art.overlay(ctx, 'arrival', { ...to, progress: Math.min(1, (now - a.startedAt - 280 - a.duration) / 240) })
        const bubble = this.nodes.get(a.to)?.bubble; if (bubble) this.art.overlay(ctx, 'bubble', { ...bubble, symbol: '!' })
        continue
      }
      if (phase === 'pin') { this.art.overlay(ctx, 'card', { ...to }); continue }
      if (phase === 'fall' || phase === 'crumple') {
        p = { x: p.x + 12 * progress, y: p.y + 52 * progress ** 2 }
        if (phase === 'crumple') { ctx.globalAlpha = Math.max(0, Math.min(1, (280 + a.duration * 0.7 + 3500 - (now - a.startedAt)) / 500)); this.art.overlay(ctx, 'crumple', { ...p }); ctx.globalAlpha = 1; continue }
      }
      if (phase === 'flight') { ctx.fillStyle = user ? '#78bce8' : this.art.theme === 'neon' ? '#5ef2ff' : '#fff4dc'; for (let i = 1; i <= 4; i++) { const tail = arcPoint(from, to, Math.max(0, progress - i * 0.035), a.kind === 'board' ? 16 : 40); ctx.globalAlpha = 0.75 - i * 0.12; ctx.fillRect(Math.round(tail.x), Math.round(tail.y), 2, 1) }; ctx.globalAlpha = 1 }
      if (phase === 'fall') { this.art.overlay(ctx, 'fall', { ...p, progress }); continue }
      const next = arcPoint(from, to, Math.min(1, progress + 0.01), a.kind === 'board' ? 16 : 40), angle = Math.atan2(next.y - p.y, next.x - p.x)
      this.art.overlay(ctx, a.kind === 'board' ? 'card' : this.art.theme === 'neon' ? 'packet' : 'plane', { ...p, angle, user, boss })
      if (a.count > 1) { ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#fff5d5'; ctx.fillText(`×${a.count}`, p.x + 8, p.y) }
    }
  }
  private draw = () => {
    if (this.disposed) return
    if (this.dpr !== window.devicePixelRatio) this.resize()
    const ctx = this.canvas.getContext('2d'); if (!ctx) return
    const started = performance.now(), now = this.connected ? Date.now() : this.frozenAt, motion = this.connected && this.focused && !this.reducedMotion
    this.effects.advance(now); this.bake(now)
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); ctx.imageSmoothingEnabled = false
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.translate(Math.round(this.camera.x), Math.round(this.camera.y)); ctx.scale(this.camera.zoom, this.camera.zoom)
    if (this.world) ctx.drawImage(this.world, this.layout.bounds.x, this.layout.bounds.y)
    this.targets = []; if (!this.state) return
    this.paintLinks(ctx, now, true)
    const objects: { y: number; paint(): void }[] = []
    const add = (id: string, state: string, p: Point, time = 0, y = p.y) => objects.push({ y, paint: () => { this.art.paint(ctx, id, state, p, time) } })
    const frameTime = motion ? Math.floor(now / 300) * 300 : 0
    const mode = (seat?: Seat) => { const a = seat && this.agentsByPane.get(seat.paneId); return !a ? seat?.paneId ? 'term' : 'off' : !this.connected || a.status === 'unknown' || a.status === 'disconnect' ? 'off' : a.status === 'blocked' ? 'ask' : a.status === 'done' ? 'done' : 'code' }
    for (const lot of this.layout.lots) {
      if (!this.inView(lot)) continue
      if (!this.art.ready) for (const sprite of roomDecor(lot)) add(sprite.id, 'default', sprite.anchor, frameTime)
      const head = this.layout.seats.find(s => s.departmentId === lot.departmentId && s.side === 'head')
      if (head) add(lot.boss ? 'object.desk.boss' : 'object.desk.head', lot.boss ? 'default' : mode(head) === 'off' ? 'off' : 'on', { x: lot.x + lot.width / 2, y: lot.y + (lot.boss ? 132 : 124) }, frameTime)
      for (let row = 0; row < lot.shape.rows; row++) for (let bench = 0; bench < lot.shape.benches; bench++) {
        const seats = [...this.layout.seats, ...this.layout.vacancies].filter(s => s.departmentId === lot.departmentId && s.row === row && s.bench === bench && s.side !== 'head')
        const first = seats[0]
        if (first) for (let col = 0; col < lot.shape.cols; col++) {
          const anchor = { x: lot.x + 64 + bench * (lot.shape.cols * 48 + 32) + col * 48 + 24, y: first.deskTop + 36 }
          const north = seats.find(s => s.col === col && s.side === 'north'), south = seats.find(s => s.col === col && s.side === 'south')
          add('object.bench.col', `${lot.shape.cols === 1 ? 'single' : col === 0 ? 'left' : col === lot.shape.cols - 1 ? 'right' : 'mid'}:${col % 4}`, anchor)
          add('object.monitor.back', mode(north) === 'off' ? 'off' : 'on', anchor, frameTime, anchor.y + 0.1)
          add('object.monitor.front', mode(south), anchor, frameTime, anchor.y + 0.2)
        }
      }
      if (motion && this.art.theme === 'cozy') add('object.steam', 'default', { x: lot.x + lot.width - 40, y: lot.y + lot.height - 66 }, frameTime)
      // Pets only patrol the side aisle and lounge, never between workstations.
      if (!lot.boss) {
        const phase = motion ? now / 1000 % 60 : 40, moving = phase < 16, lounge = lot.y + lot.height - 80
        const p = moving ? { x: lot.x + 36, y: lounge + 32 - phase * 14 % 64 } : this.art.theme === 'neon' ? { x: lot.x + 38, y: lounge - 20 } : { x: lot.x + (lot.width >= 320 ? 170 : 154), y: lounge + 22 }
        add(this.art.theme === 'neon' ? 'object.robot' : 'object.cat', this.art.theme === 'neon' ? moving ? 'move' : 'charge' : moving ? 'walk:side' : 'sleep', p, frameTime, moving ? p.y : lounge + 31)
      } else add('object.phone', 'idle', { x: lot.x + 140, y: lot.y + 110 }, 0, lot.y + 133)
    }
    for (const seat of [...this.layout.seats, ...this.layout.vacancies]) {
      if (!this.inView({ x: seat.x, y: seat.y - 48, width: 64, height: 100 })) continue
      const a = this.agentsByPane.get(seat.paneId), pose = seatPose(seat)
      if (!a && seat.paneId && !this.showTerminals) continue
      add(`object.chair.${seat.side === 'head' ? a?.isBoss ? 'boss' : 'lead' : pose.direction}`, seat.side === 'head' ? 'default' : a ? 'out' : 'in', pose.chair)
      if (!a) { if (seat.paneId) this.targets.push({ paneId: seat.paneId, rect: seat, y: seat.y }); continue }
      const status = this.connected ? a.status : 'unknown'
      let time = motion && status !== 'unknown' && status !== 'disconnect' ? Math.max(0, now - a.lastStatusAt) : 0
      let state: string = status === 'disconnect' ? 'unknown' : status
      for (const carrier of this.effects.active) {
        const phase = carrierPhase(carrier, now).phase
        if (carrier.from === a.id && phase === 'throw') { state = 'throw'; time = now - carrier.startedAt }
        if (carrier.to === a.id && phase === 'catch') { state = 'catch'; time = now - carrier.startedAt - 280 - carrier.duration }
      }
      if (motion && status === 'idle' && time > 180_000 && (Math.floor(now / 1000) + a.name.length * 7) % 70 < 2) state = 'stretch'
      const anchor = { ...pose.agent, y: pose.agent.y - (state === 'catch' ? 3 : 0) }
      add(a.isBoss ? 'agent.boss' : `agent.${a.kind}`, a.isBoss ? `${state === 'throw' ? 'dispatch' : state === 'done' ? 'pleased' : 'sit'}:front` : `${state}:${pose.direction}`, anchor, time, pose.agent.y)
      if (!a.isBoss) add(`role.${a.role}`, `${state}:${pose.direction}`, anchor, time, pose.agent.y)
      this.targets.push({ paneId: a.paneId, y: pose.agent.y, rect: seat }, { paneId: a.paneId, y: pose.agent.y, rect: this.art.hitRect(a.isBoss ? 'agent.boss' : `agent.${a.kind}`, a.isBoss ? 'sit:front' : `${state}:${pose.direction}`, anchor) })
    }
    const lobby = this.layout.lobby
    add('object.reception', 'default', { x: lobby.x + 96, y: lobby.y + 146 })
    add('object.cooler', 'default', { x: lobby.x + 166, y: lobby.y + 80 }, frameTime)
    const waiting = this.state.agents.filter(a => a.status === 'blocked').length
    add('object.bell', waiting && motion && now % 4000 < 1200 ? 'ring' : 'default', { x: lobby.x + 118, y: lobby.y + 138 }, motion ? now : 0)
    for (const node of this.state.externalNodes) {
      const p = this.externalPoint(node.id)
      if (node.kind === 'user') {
        const throwing = this.effects.active.find(a => a.from === node.id && carrierPhase(a, now).phase === 'throw')
        add('agent.user', throwing ? 'throw:front' : 'idle:front', p, throwing ? now - throwing.startedAt : frameTime)
      } else {
        const active = this.connected && now - (this.machineActivity.get(node.id) ?? -Infinity) < 4000
        add('object.machine', active ? 'active' : 'idle', { x: p.x, y: p.y + 28 }, frameTime)
        if (active) objects.push({ y: Infinity, paint: () => this.art.overlay(ctx, 'waves', { x: p.x, y: p.y - 10, phase: motion ? Math.floor(now / 200) % 3 : 0 }) })
      }
    }
    if (this.layout.server) for (let i = 0; i < 3; i++) {
      const hot = [...this.machineActivity.values()].some(at => now - at < 4000)
      add('object.rack', this.connected && hot ? 'hot' : 'idle', { x: this.layout.server.x + 30 + i * 20, y: -122 }, frameTime + (motion ? i * 300 : 0))
    }
    objects.sort((a, b) => a.y - b.y).forEach(o => o.paint())
    this.art.paintFront(ctx, this.layout)
    this.paintLinks(ctx, now, false); this.paintCarriers(ctx, now)
    for (const a of this.state.agents) {
      const seat = this.seatsByPane.get(a.paneId); if (!seat || !this.inView({ ...seat, y: seat.y - 48, height: 120 })) continue
      const pose = this.nodes.get(a.id) ?? seatPose(seat), status = this.connected ? a.status : 'disconnect'
      const notice = this.effects.flashes.get(a.id); ctx.globalAlpha = this.reducedMotion && notice !== undefined && now - notice < 200 ? 0.55 : 1
      this.art.overlay(ctx, 'plaque', { ...pose.label, text: this.names.get(a.id) ?? a.name, status, south: seat.side === 'south', lead: seat.side === 'head', phase: motion ? Math.floor(now / 220) % 4 : 0 })
      ctx.globalAlpha = 1
      if (this.selected === a.paneId) this.art.overlay(ctx, 'select', { x: pose.agent.x, y: pose.agent.y - 24 })
      if (status === 'done' || status === 'blocked') this.art.overlay(ctx, 'bubble', { ...pose.bubble, symbol: status === 'done' ? 'ok' : '?', phase: motion ? Math.floor(now / 440) % 2 : 0 })
      const note = this.effects.notes.get(a.id); if (note) this.art.overlay(ctx, 'note', { ...pose.land, user: note.user })
      const celebration = this.effects.celebrations.get(a.id); if (celebration !== undefined && motion) this.art.overlay(ctx, 'confetti', { ...pose.bubble, progress: (now - celebration) / 900 })
      const flash = this.effects.flashes.get(a.id); if (flash !== undefined && !this.reducedMotion) this.art.overlay(ctx, 'arrival', { ...pose.land, progress: 0.5 })
    }
    if (waiting && this.connected) {
      ctx.font = 'bold 9px system-ui'; ctx.fillStyle = this.art.theme === 'neon' ? '#ffb978' : '#88511d'; ctx.fillText(officeText('{n} waiting', { n: waiting }), lobby.x + 80, lobby.y + 110)
    }
    const samples = this.performance.samples; samples.push(performance.now() - started); if (samples.length > 300) samples.shift(); this.performance.frames++
    if (this.performance.frames % 30 === 0) this.performance.p95 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? 0
  }
  dispose() {
    this.disposed = true; this.themeRequest++; this.loop.dispose(); this.resizeObserver.disconnect(); this.effects.clear(); this.routes.clear(); this.linkPaths.clear(); this.machineActivity.clear(); this.world = null
    this.canvas.removeEventListener('pointerdown', this.pointerDown); this.canvas.removeEventListener('pointermove', this.pointerMove); this.canvas.removeEventListener('pointerup', this.pointerUp)
    this.canvas.removeEventListener('pointercancel', this.pointerCancel); this.canvas.removeEventListener('lostpointercapture', this.pointerCancel); this.canvas.removeEventListener('pointerleave', this.pointerLeave); this.canvas.removeEventListener('wheel', this.wheel)
    this.pointerCancel(); this.setHovered(null)
  }
}
