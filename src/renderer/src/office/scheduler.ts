export interface FrameHost { request(callback: (time: number) => void): number; cancel(id: number): void }
/** One outstanding RAF, no React work in the animation path. */
export class FrameLoop {
  private handle: number | null = null
  private last = -Infinity
  private visible = false
  private focused = true
  constructor(private host: FrameHost, private draw: (time: number, delta: number) => void) {}
  setVisibility(visible: boolean, focused: boolean) {
    this.focused = focused
    if (this.visible === visible) return
    this.visible = visible
    if (visible) { this.last = -Infinity; this.schedule() }
    else if (this.handle !== null) { this.host.cancel(this.handle); this.handle = null }
  }
  private schedule() { if (this.visible && this.handle === null) this.handle = this.host.request(this.tick) }
  private tick = (time: number) => {
    this.handle = null
    if (!this.visible) return
    const interval = 1000 / (this.focused ? 30 : 5)
    if (time - this.last >= interval - 0.01) {
      const delta = Number.isFinite(this.last) ? Math.min(250, time - this.last) : 0
      this.last = time
      this.draw(time, delta)
    }
    this.schedule()
  }
  dispose() { this.setVisibility(false, this.focused) }
}
