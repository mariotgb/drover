/** Pixel geometry, one hall per project; the corridor is the fixed world origin. */
export const TILE = 16
export const LOT_WIDTH = 224
export const LOT_HEIGHT = 208
export const SHRINK_DELAY = 10 * 60_000
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface LayoutDepartment { id: string; number: number }
export interface LayoutOccupant { paneId: string; departmentId: string; index?: number; lead?: boolean; boss?: boolean }
export interface HallShape { cols: number; benches: number; perRow: number; rows: number; width: number; height: number }
export interface Lot extends Rect { departmentId: string; block: number; slot: number; shape: HallShape; boss?: boolean }
export interface Seat extends Rect { paneId: string; departmentId: string; index: number; anchor: Point; side: 'north' | 'south' | 'head'; center: number; deskTop: number; row: number; bench: number; col: number }
export interface Layout { lots: Lot[]; seats: Seat[]; vacancies: Seat[]; lobby: Rect; server: Rect | null; corridor: Rect; bounds: Rect }
export function hallShape(workers: number): HallShape {
  const cols = workers <= 4 ? 2 : 4, benches = workers > 16 ? 2 : 1, perRow = 2 * cols * benches
  const rows = workers ? Math.ceil(workers / perRow) : 0
  return { cols, benches, perRow, rows, width: benches * cols * 48 + (benches - 1) * 32 + 128, height: 208 + rows * 112 }
}
export function seatAt(lot: Lot, index: number, paneId = ''): Seat {
  const { shape } = lot
  const row = Math.floor(index / shape.perRow), local = index % shape.perRow, perSide = shape.cols * shape.benches
  const side = index < 0 ? 'head' : local >= perSide ? 'south' : 'north'
  const bench = Math.floor((local % perSide) / shape.cols), col = local % shape.cols
  const x = side === 'head' ? lot.x + lot.width / 2 - 24 : lot.x + 64 + bench * (shape.cols * 48 + 32) + col * 48
  const center = x + 24, deskTop = lot.y + (side === 'head' ? 92 : 168 + row * 112)
  return { paneId, departmentId: lot.departmentId, index, side, row, bench, col, center, deskTop, x, y: deskTop + (side === 'south' ? 14 : -36), width: 48, height: 36, anchor: { x: center, y: deskTop + 36 } }
}
export class OfficeLayout {
  private places = new Map<string, { departmentId: string; index: number }>()
  private shapes = new Map<string, { shape: HallShape; shrinking: number | null }>()
  clear() { this.places.clear(); this.shapes.clear() }
  update(departments: LayoutDepartment[], occupants: LayoutOccupant[], repack = false, now = Date.now(), machines = 0): Layout {
    if (repack) this.clear()
    const ids = new Set(departments.map(d => d.id)), panes = new Set(occupants.map(a => a.paneId))
    for (const [id, p] of this.places) if (!panes.has(id) || !ids.has(p.departmentId) || occupants.find(a => a.paneId === id)?.departmentId !== p.departmentId) this.places.delete(id)
    for (const id of this.shapes.keys()) if (!ids.has(id)) this.shapes.delete(id)
    const bossDepartment = occupants.find(a => a.boss)?.departmentId
    const sorted = [...departments].sort((a, b) => Number(b.id === bossDepartment) - Number(a.id === bossDepartment) || a.number - b.number || a.id.localeCompare(b.id))
    const lots: Lot[] = []
    let x = 224
    for (const [slot, d] of sorted.entries()) {
      const people = occupants.filter(a => a.departmentId === d.id)
      const oldPlaces = new Map(this.places)
      const lead = people.find(a => a.boss) ?? people.find(a => a.lead)
      for (const a of people) {
        const previous = this.places.get(a.paneId), isLead = a === lead
        if (previous?.departmentId === d.id && (previous.index === -1) === isLead) continue
        const used = new Set([...this.places.entries()].filter(([id, p]) => id !== a.paneId && p.departmentId === d.id).map(([, p]) => p.index))
        let index = isLead ? -1 : a.index !== undefined && a.index >= 0 && !used.has(a.index) ? a.index : 0
        while (!isLead && used.has(index)) index++
        this.places.set(a.paneId, { departmentId: d.id, index })
      }
      const workers = people.length - (lead ? 1 : 0), desired = hallShape(workers)
      let record = this.shapes.get(d.id)
      if (!record) { record = { shape: desired, shrinking: null }; this.shapes.set(d.id, record) }
      const current = record.shape
      if (desired.width > current.width || desired.height > current.height) {
        const cols = Math.max(current.cols, desired.cols), benches = Math.max(current.benches, desired.benches), perRow = 2 * cols * benches
        // Widening a bench keeps existing occupants on the same side, row and column.
        const used = new Set<number>()
        const retained = people.filter(a => oldPlaces.get(a.paneId)?.departmentId === d.id && oldPlaces.get(a.paneId)!.index >= 0 && a !== lead)
        for (const a of retained) {
          const index = oldPlaces.get(a.paneId)!.index, row = Math.floor(index / current.perRow), local = index % current.perRow, perSide = current.cols * current.benches
          const next = row * perRow + Math.floor((local % perSide) / current.cols) * cols + local % current.cols + (local >= perSide ? cols * benches : 0)
          this.places.set(a.paneId, { departmentId: d.id, index: next }); used.add(next)
        }
        for (const a of people.filter(a => a !== lead && !retained.includes(a))) {
          let index = 0; while (used.has(index)) index++
          this.places.set(a.paneId, { departmentId: d.id, index }); used.add(index)
        }
        const high = Math.max(-1, ...people.map(a => this.places.get(a.paneId)!.index))
        const rows = Math.max(current.rows, Math.ceil((high + 1) / perRow))
        record.shape = { cols, benches, perRow, rows, width: benches * cols * 48 + (benches - 1) * 32 + 128, height: 208 + rows * 112 }
        record.shrinking = null
      }
      const high = Math.max(-1, ...people.map(a => this.places.get(a.paneId)!.index))
      if (high >= record.shape.rows * record.shape.perRow) {
        record.shape = { ...record.shape, rows: Math.ceil((high + 1) / record.shape.perRow), height: 208 + Math.ceil((high + 1) / record.shape.perRow) * 112 }
      }
      if (desired.width < record.shape.width || desired.height < record.shape.height) {
        record.shrinking ??= now
        if (now - record.shrinking >= SHRINK_DELAY) {
          people.filter(a => a !== lead).forEach((a, i) => this.places.set(a.paneId, { departmentId: d.id, index: i }))
          record.shape = desired; record.shrinking = null
        }
      } else record.shrinking = null
      const shape = record.shape
      lots.push({ departmentId: d.id, slot, block: 0, ...(d.id === bossDepartment ? { boss: true } : {}), x, y: -shape.height, width: shape.width, height: shape.height, shape })
      x += shape.width - TILE
    }
    const lobby = { x: 48, y: -208, width: 192, height: 208 }
    const server = machines ? { x, y: -208, width: Math.max(10, 4 + machines * 3) * TILE, height: 208 } : null
    if (server) x += server.width - TILE
    const corridor = { x: 48, y: 0, width: x - 32, height: 80 }
    const seats = occupants.flatMap(a => { const p = this.places.get(a.paneId), lot = lots.find(l => l.departmentId === p?.departmentId); return p && lot ? [seatAt(lot, p.index, a.paneId)] : [] })
    const vacancies = lots.flatMap(l => Array.from({ length: l.shape.rows * l.shape.perRow }, (_, i) => seatAt(l, i)).filter(s => !seats.some(a => a.departmentId === s.departmentId && a.index === s.index)))
    const top = Math.min(-208, ...lots.map(l => l.y)) - 48
    return { lots, seats, vacancies, lobby, server, corridor, bounds: { x: 0, y: top, width: x + 64, height: 168 - top } }
  }
}
