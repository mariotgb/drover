import type { Point, Rect } from './layout'

/** A quadratic arc stays inside the hull of its ends and control point.
 * Include the shade and animated dots, including arcs crossing the viewport
 * whose endpoints are both outside it. */
export function arcBounds(a: Point, b: Point, lift = 40, padding = 4): Rect {
  const controlY = Math.min(a.y, b.y) - lift * 0.6 - Math.hypot(b.x - a.x, b.y - a.y) * 0.1
  return pathBounds([a, b, { x: (a.x + b.x) / 2, y: controlY }], padding)
}
export function pathBounds(points: Point[], padding = 4): Rect {
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const x = Math.min(...xs) - padding, y = Math.min(...ys) - padding
  return { x, y, width: Math.max(...xs) + padding - x, height: Math.max(...ys) + padding - y }
}
export function pathLength(points: Point[]): number {
  return points.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0)
}
