/** Geometry stays local to the renderer: status and incarnation never allocate seats. */
export const TILE = 16
export const LOT_WIDTH = 24 * TILE
export const LOT_HEIGHT = 20 * TILE
const GAP = 2 * TILE
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface LayoutDepartment { id: string; number: number }
export interface LayoutOccupant { paneId: string; departmentId: string }
export interface Lot extends Rect { departmentId: string; block: number; slot: number }
export interface Seat extends Rect { paneId: string; departmentId: string; index: number; anchor: Point }
export interface Layout { lots: Lot[]; seats: Seat[]; bounds: Rect }

export class OfficeLayout {
  private lots = new Map<string, { departmentId: string; block: number; slot: number }>()
  private places = new Map<string, { departmentId: string; index: number }>()
  private columns = 3

  clear() { this.lots.clear(); this.places.clear() }

  update(departments: LayoutDepartment[], occupants: LayoutOccupant[], repack = false): Layout {
    if (repack) this.clear()
    const ids = new Set(departments.map(d => d.id))
    const panes = new Set(occupants.map(a => a.paneId))
    for (const [id, lot] of this.lots) if (!ids.has(lot.departmentId)) this.lots.delete(id)
    for (const [id, place] of this.places) if (!panes.has(id) || !ids.has(place.departmentId)) this.places.delete(id)
    // Once placed, columns do not change at a project-count boundary.
    const sorted = [...departments].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
    const allocateLot = (departmentId: string, block: number) => {
      const key = JSON.stringify([departmentId, block])
      if (this.lots.has(key)) return
      const used = new Set([...this.lots.values()].map(l => l.slot))
      let slot = 0
      while (used.has(slot)) slot++
      this.lots.set(key, { departmentId, block, slot })
    }
    for (const d of sorted) allocateLot(d.id, 0)
    for (const a of [...occupants].sort((a, b) => a.paneId.localeCompare(b.paneId))) {
      if (!ids.has(a.departmentId)) continue
      const old = this.places.get(a.paneId)
      if (old?.departmentId === a.departmentId) continue
      const used = new Set([...this.places.entries()].filter(([id, p]) => id !== a.paneId && p.departmentId === a.departmentId).map(([, p]) => p.index))
      let index = 0
      while (used.has(index)) index++
      this.places.set(a.paneId, { departmentId: a.departmentId, index })
      allocateLot(a.departmentId, Math.floor(index / 8))
    }
    const lots = [...this.lots.values()].map(l => ({ ...l, x: (l.slot % this.columns) * (LOT_WIDTH + GAP), y: Math.floor(l.slot / this.columns) * (LOT_HEIGHT + GAP), width: LOT_WIDTH, height: LOT_HEIGHT }))
    const seats: Seat[] = []
    for (const a of occupants) {
      const p = this.places.get(a.paneId)
      if (!p || p.departmentId !== a.departmentId) continue
      const lot = lots.find(l => l.departmentId === p.departmentId && l.block === Math.floor(p.index / 8))!
      const local = p.index % 8
      const x = lot.x + (1 + local % 4 * 6) * TILE
      const y = lot.y + (5 + Math.floor(local / 4) * 7) * TILE
      seats.push({ ...p, paneId: a.paneId, x, y, width: 4 * TILE, height: 3 * TILE, anchor: { x: x + 2 * TILE, y: y + 3 * TILE } })
    }
    return { lots, seats, bounds: { x: -GAP, y: -GAP, width: lots.length ? Math.max(...lots.map(l => l.x + l.width)) + GAP * 2 : LOT_WIDTH, height: lots.length ? Math.max(...lots.map(l => l.y + l.height)) + GAP * 2 : LOT_HEIGHT } }
  }
}
