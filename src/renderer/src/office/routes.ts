import { TILE, type Lot, type Point, type Rect, type Seat } from './layout'
import { seatPose } from './scene'

const CLEARANCE = 8 // Room for arrowheads, envelopes and cable stamps, not just their centre line.
const expand = (r: Rect): Rect => ({ x: r.x - CLEARANCE, y: r.y - CLEARANCE, width: r.width + 2 * CLEARANCE, height: r.height + 2 * CLEARANCE })
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  if (a.x === b.x) return a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height
  if (a.y === b.y) return a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width
  throw new Error('Office routes must be orthogonal')
}
const clear = (a: Point, b: Point, obstacles: Rect[]) => !obstacles.some(r => segmentHitsRect(a, b, r))
function simplify(points: Point[]): Point[] {
  const result: Point[] = []
  for (const p of points) {
    const b = result.at(-1), a = result.at(-2)
    if (b?.x === p.x && b.y === p.y) continue
    if (a && b && (a.x === b.x && b.x === p.x || a.y === b.y && b.y === p.y)) result.pop()
    result.push(p)
  }
  return result
}
export function aboveHead(anchor: Point, hit: Rect): Point {
  return { x: anchor.x, y: Math.min(anchor.y - 46, hit.y - CLEARANCE) }
}

/** Shortest orthogonal path on obstacle-edge coordinates. Called only when geometry changes. */
export function routeLine(from: Point, to: Point, hitRects: Rect[]): Point[] {
  const obstacles = hitRects.map(expand)
  for (const bend of [{ x: to.x, y: from.y }, { x: from.x, y: to.y }]) {
    if (clear(from, bend, obstacles) && clear(bend, to, obstacles)) return simplify([from, bend, to])
  }
  const xs = [...new Set([from.x, to.x, ...obstacles.flatMap(r => [r.x, r.x + r.width])])].sort((a, b) => a - b)
  const ys = [...new Set([from.y, to.y, ...obstacles.flatMap(r => [r.y, r.y + r.height])])].sort((a, b) => a - b)
  const index = (p: Point) => ys.indexOf(p.y) * xs.length + xs.indexOf(p.x)
  const point = (id: number) => ({ x: xs[id % xs.length], y: ys[Math.floor(id / xs.length)] })
  const start = index(from), end = index(to), distance = new Map([[start, 0]]), previous = new Map<number, number>()
  const open = new Set([start]), closed = new Set<number>()
  const heuristic = (id: number) => { const p = point(id); return Math.abs(p.x - to.x) + Math.abs(p.y - to.y) }
  while (open.size) {
    let current = -1, score = Infinity
    for (const id of open) { const cost = distance.get(id)! + heuristic(id); if (cost < score) { current = id; score = cost } }
    if (current === end) {
      const path = [to]
      while (current !== start) { current = previous.get(current)!; path.push(point(current)) }
      return simplify(path.reverse())
    }
    open.delete(current); closed.add(current)
    const x = current % xs.length, y = Math.floor(current / xs.length), a = point(current)
    const neighbors = [x > 0 ? current - 1 : -1, x + 1 < xs.length ? current + 1 : -1, y > 0 ? current - xs.length : -1, y + 1 < ys.length ? current + xs.length : -1]
    for (const next of neighbors) {
      if (next < 0 || closed.has(next)) continue
      const b = point(next)
      if (!clear(a, b, obstacles)) continue
      const cost = distance.get(current)! + Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
      if (cost >= (distance.get(next) ?? Infinity)) continue
      distance.set(next, cost); previous.set(next, current); open.add(next)
    }
  }
  return [] // No invented straight fallback through a character.
}

/** Leave the source room through its floor aisle; all remaining segments stay on grass. */
export function routeCable(seat: Seat, lot: Lot, rooms: Rect[], to: Point, hitRects: Rect[]): Point[] {
  const agent = seatPose(seat).agent
  const from = { x: seat.anchor.x, y: Math.max(seat.anchor.y, agent.y + 16) }
  const aisleX = seat.index % 4 === 3 ? seat.x - TILE : seat.x + seat.width + TILE
  const exit = { x: aisleX, y: lot.y + lot.height + TILE * 1.5 }
  const approach = { x: to.x, y: 12 * TILE } // Below the server room's front wall.
  const local = [from, { x: aisleX, y: from.y }, exit]
  if (local.slice(1).some((p, i) => !clear(local[i], p, hitRects.map(expand)))) return []
  const outside = routeLine(exit, approach, rooms)
  if (!outside.length || !clear(approach, to, hitRects.map(expand))) return []
  return simplify([...local, ...outside, to])
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
