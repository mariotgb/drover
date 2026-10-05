import type { Point, Rect } from './layout'
export interface Camera { x: number; y: number; zoom: number }
export const worldToScreen = (p: Point, c: Camera): Point => ({ x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y })
export const screenToWorld = (p: Point, c: Camera): Point => ({ x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom })
export function zoomAt(c: Camera, zoom: number, screen: Point): Camera {
  const p = screenToWorld(screen, c)
  return { x: screen.x - p.x * zoom, y: screen.y - p.y * zoom, zoom }
}
export function fitCamera(bounds: Rect, width: number, height: number): Camera {
  const zoom = Math.max(1, Math.min(3, Math.floor(Math.min((width - 48) / bounds.width, (height - 48) / bounds.height))))
  return { zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom }
}
/** Preserve integer pixel scales when possible; large halls still fit small viewports. */
export function fitHallCamera(bounds: Rect, width: number, height: number): Camera {
  const scale = Math.min(3, Math.max(0.01, Math.min(Math.max(1, width - 48) / bounds.width, Math.max(1, height - 48) / bounds.height)))
  const zoom = scale >= 1 ? Math.floor(scale) : scale
  return { zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom }
}
export const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
export interface HitTarget { paneId: string; rect: Rect; y: number }
export function hitTest(targets: HitTarget[], screen: Point, camera: Camera): string | null {
  const p = screenToWorld(screen, camera)
  // Reverse paint order, including equal-Y ties.
  const sorted = [...targets].sort((a, b) => a.y - b.y)
  for (let i = sorted.length - 1; i >= 0; i--) if (contains(sorted[i].rect, p)) return sorted[i].paneId
  return null
}
export class DragGesture {
  private start: Point | null = null
  private dragged = false
  begin(p: Point) { this.start = p; this.dragged = false }
  move(p: Point) { if (this.start && Math.hypot(p.x - this.start.x, p.y - this.start.y) > 4) this.dragged = true; return this.dragged }
  end(p: Point) { this.move(p); const click = !!this.start && !this.dragged; this.start = null; return click }
  cancel() { this.start = null; this.dragged = false }
}
