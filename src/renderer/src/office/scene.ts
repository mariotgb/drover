import type { OfficeDirection } from '@shared/office'
import { type Lot, type Point, type Seat } from './layout'
export interface SceneSprite { id: string; anchor: Point; state?: string }
export function seatPose(seat: Seat) {
  const south = seat.side === 'south', c = seat.center, dt = seat.deskTop
  const direction: OfficeDirection = south ? 'back' : 'front'
  return { direction, agent: { x: c + (south ? -6 : seat.side === 'head' ? 0 : 3), y: dt + (south ? 44 : 8) }, chair: { x: c + (south ? -6 : seat.side === 'head' ? 0 : 3), y: dt + (south ? 47 : 7) }, hand: { x: c + (south ? 4 : 15), y: dt + (south ? 12 : -22) }, land: { x: c + (south ? 12 : 6), y: dt + (south ? 18 : 4) }, label: { x: c + (south ? -6 : 3), y: dt + (south ? 50 : -40) }, bubble: { x: c + (south ? -6 : 3), y: dt + (south ? 4 : -41) } }
}
export function roomSize(lot: Lot, _occupied?: boolean) { return { width: lot.width, height: lot.height } }
export function roomDecor(lot: Lot, _occupied?: boolean): SceneSprite[] {
  const at = (id: string, x: number, y: number) => ({ id, anchor: { x: lot.x + x, y: lot.y + y } })
  return [at('object.plant.monstera', 30, 124), at('object.bookshelf', 80, 98), at('object.sofa', lot.width - 64, lot.height - 50), at('object.table.coffee', lot.width - 64, lot.height - 22), at('object.coffee', lot.width - 38, lot.height - 50), at('object.plant.big', 30, lot.height - 20)]
}
