import type { OfficeDirection } from '@shared/office'
import { TILE, type Lot, type Point, type Seat } from './layout'

/** Matches scripts/office-art/scene.mjs; anchors include the seated pose. */
export const SEAT_OFFSETS = {
  front: { agent: { x: 0, y: -27 }, chair: { x: 0, y: -28 } },
  back: { agent: { x: 0, y: 9 }, chair: { x: 0, y: 10 } }
} as const
export interface SceneSprite { id: string; anchor: Point; state?: string }
export function seatPose(seat: Seat) {
  const direction: OfficeDirection = seat.index % 8 < 4 ? 'front' : 'back'
  const offset = SEAT_OFFSETS[direction]
  return { direction, agent: { x: seat.anchor.x + offset.agent.x, y: seat.anchor.y + offset.agent.y }, chair: { x: seat.anchor.x + offset.chair.x, y: seat.anchor.y + offset.chair.y } }
}
export function roomSize(lot: Lot, occupied: boolean) { return { width: occupied ? lot.width : 12 * TILE, height: occupied ? lot.height : 8 * TILE } }
export function roomDecor(lot: Lot, occupied: boolean): SceneSprite[] {
  const { width, height } = roomSize(lot, occupied)
  const at = (id: string, x: number, y: number) => ({ id, anchor: { x: lot.x + x, y: lot.y + y } })
  const sprites = [at('object.sign', width / 2, 31), at('object.taskboard', 4 * TILE, 46), at('object.window', width - 6 * TILE, 28), at('object.door', width / 3, 48), at('object.plant.big', 24, 64), at('object.cooler', width - 24, 64)]
  if (occupied) sprites.push(at('object.sofa', width - 6 * TILE, height - TILE), at('object.table.coffee', 13 * TILE, height - 2 * TILE), at('object.plant.big', 2 * TILE, height - TILE), at('object.bookshelf', 7 * TILE, height - TILE), at('object.plant.small', 6 * TILE, 8 * TILE - 4))
  return sprites
}
