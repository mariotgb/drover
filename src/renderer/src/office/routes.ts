import { type Lot, type Point, type Rect, type Seat } from './layout'
import { seatPose } from './scene'

export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  if (a.x === b.x) return a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height
  if (a.y === b.y) return a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width
  throw new Error('Office cables must be orthogonal')
}
/** Floor cables follow the side aisle, room door, corridor and server door.
 * Their source is the desk, so the first leg is intentionally under furniture.
 */
export function routeCable(seat: Seat, lot: Lot, server: Rect, to: Point): Point[] {
  const south = seat.side === 'south', pose = seatPose(seat)
  const from = { x: pose.land.x, y: seat.deskTop + (south ? 40 : 30) }
  const aisle = lot.x + 36, door = lot.x + 48, serverDoor = server.x + 48
  const y = seat.deskTop + 100
  return [from, { x: from.x, y }, { x: aisle, y }, { x: aisle, y: -12 }, { x: door, y: -12 }, { x: door, y: 38 }, { x: serverDoor, y: 38 }, { x: serverDoor, y: -24 }, { x: to.x, y: -24 }, to]
}
export function pointOnRoute(route: Point[], progress: number): Point | null {
  if (!route.length) return null
  const lengths = route.slice(1).map((p, i) => Math.hypot(p.x - route[i].x, p.y - route[i].y))
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, progress))
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i]) {
      const t = remaining / lengths[i], a = route[i], b = route[i + 1]
      return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) }
    }
    remaining -= lengths[i]
  }
  return route.at(-1)!
}
