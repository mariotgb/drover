import type { OfficeArtAnimation, OfficeArtFrame, OfficeArtManifestV1, OfficeAtlasId } from '@shared/office'
import type { Point, Rect } from './layout'

// Vite imports put the atlas files in out/renderer; no runtime resources path.
const manifests = import.meta.glob('./assets/manifest.json', { eager: true, import: 'default' })
const urls = import.meta.glob(['./assets/*.png', '!./assets/preview.png'], { eager: true, query: '?url', import: 'default' })
const candidate = Object.values(manifests)[0] as OfficeArtManifestV1 | undefined
export const placeholderFrame: OfficeArtFrame = { rect: { x: 0, y: 0, width: 32, height: 48 }, anchor: { x: 16, y: 44 }, hitRect: { x: 4, y: 8, width: 24, height: 40 } }
export function animationFrame(animation: OfficeArtAnimation, time: number): OfficeArtFrame | undefined {
  const duration = animation.durationsMs.reduce((sum, ms) => sum + ms, 0)
  if (!animation.frames.length || duration <= 0) return animation.frames[0]
  let elapsed = animation.loop ? Math.max(0, time) % duration : Math.min(Math.max(0, time), duration - 1)
  for (let i = 0; i < animation.frames.length; i++) {
    elapsed -= animation.durationsMs[i] ?? 1
    if (elapsed < 0) return animation.frames[i]
  }
  return animation.frames.at(-1)
}
export class OfficeArt {
  readonly manifest = candidate?.version === 1 ? candidate : null
  private images = new Map<OfficeAtlasId, HTMLImageElement>()
  async load() {
    if (!this.manifest) return
    await Promise.all(Object.entries(this.manifest.atlases).map(async ([atlas, info]) => {
      const url = urls[`./assets/${info.file}`]
      if (typeof url !== 'string') return
      const img = new Image()
      img.src = url
      try { await img.decode(); this.images.set(atlas as OfficeAtlasId, img) } catch { /* Procedural fallback remains usable. */ }
    }))
  }
  frame(id: string, state: string, time: number): OfficeArtFrame | undefined {
    const sprite = this.manifest?.sprites[id]
    const animation = sprite?.states[state] ?? sprite?.states['idle:front'] ?? sprite?.states.idle ?? (sprite ? Object.values(sprite.states)[0] : undefined)
    return animation ? animationFrame(animation, time) : undefined
  }
  hitRect(id: string, state: string, anchor: Point): Rect {
    const frame = this.frame(id, state, 0) ?? placeholderFrame
    return { ...frame.hitRect, x: anchor.x - frame.anchor.x + frame.hitRect.x, y: anchor.y - frame.anchor.y + frame.hitRect.y }
  }
  paint(ctx: CanvasRenderingContext2D, id: string, state: string, anchor: Point, time: number): boolean {
    const sprite = this.manifest?.sprites[id], frame = this.frame(id, state, time)
    const image = sprite && this.images.get(sprite.atlas)
    if (!frame || !image) return false
    ctx.drawImage(image, frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height,
      Math.round(anchor.x - frame.anchor.x), Math.round(anchor.y - frame.anchor.y), frame.rect.width, frame.rect.height)
    return true
  }
}
