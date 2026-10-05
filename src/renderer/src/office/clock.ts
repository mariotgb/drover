/** One 1Hz clock for age labels; its subscribers never include OfficeView. */
let now = Date.now(), timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()
export const officeClock = {
  get: () => now,
  subscribe(listener: () => void) {
    listeners.add(listener)
    if (!timer) { now = Date.now(); timer = setInterval(() => { now = Date.now(); for (const notify of listeners) notify() }, 1000) }
    return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = null } }
  }
}
