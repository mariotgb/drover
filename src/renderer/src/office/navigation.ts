/** Capture the navigation action, including reselecting the same pane/board. */
export function isSidebarNavigation(target: EventTarget | null, key?: string): boolean {
  if (key !== undefined && key !== 'Enter') return false
  const element = target as Element | null
  if (typeof element?.closest !== 'function') return false
  return !!element.closest('.sidebar .thread') && !element.closest('button, a, input')
}

export function adjacentHall(ids: string[], current: string | null, direction: number): string | null {
  if (!ids.length) return null
  const index = current ? ids.indexOf(current) : -1
  if (index < 0) return direction < 0 ? ids.at(-1)! : ids[0]
  return ids[(index + direction + ids.length) % ids.length]
}

/** Touch swipes page between halls; a mouse drag continues to pan the camera. */
export function hallSwipe(start: { x: number; y: number }, end: { x: number; y: number }, duration: number): number {
  const dx = end.x - start.x, dy = end.y - start.y
  return duration <= 700 && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5 ? dx < 0 ? 1 : -1 : 0
}
