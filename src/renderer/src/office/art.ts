import type { OfficeArtAnimation, OfficeArtFrame, OfficeArtManifestV1 } from '@shared/office'
import type { OfficeArtManifestV2 } from './assets/v2/manifest'
import type { Point, Rect, Layout } from './layout'
import { GeneratedArt, pixelCanvas, type OfficeTheme } from './generated-art'
import { atlasScene } from './atlas-scene'
// @ts-expect-error Shared with the offline art generator.
import { Pix } from '../../../../scripts/office-art/canvas.mjs'
// @ts-expect-error Shared with the offline art generator.
import { LightMap } from '../../../../scripts/office-art/v2/light.mjs'
const manifests = import.meta.glob(['./assets/manifest.json', './assets/**/manifest*.json'], { eager: true, import: 'default' })
const urls = import.meta.glob(['./assets/**/*.png', '!./assets/**/preview*.png'], { eager: true, query: '?url', import: 'default' })
const themedManifest = (theme: OfficeTheme) => Object.entries(manifests).find(([path]) => path.includes(`/v2/${theme}/`) || path.includes(`manifest-${theme === 'cozy' ? 'a' : 'b'}.json`))
export const placeholderFrame: OfficeArtFrame = { rect: { x: 0, y: 0, width: 32, height: 48 }, anchor: { x: 16, y: 44 }, hitRect: { x: 4, y: 8, width: 24, height: 40 } }
export function animationFrame(animation: OfficeArtAnimation, time: number): OfficeArtFrame | undefined {
  const duration = animation.durationsMs.reduce((sum, ms) => sum + ms, 0)
  if (!animation.frames.length || duration <= 0) return animation.frames[0]
  let elapsed = animation.loop ? Math.max(0, time) % duration : Math.min(Math.max(0, time), duration - 1)
  for (let i = 0; i < animation.frames.length; i++) { elapsed -= animation.durationsMs[i] ?? 1; if (elapsed < 0) return animation.frames[i] }
  return animation.frames.at(-1)
}
export class OfficeArt {
  manifest: OfficeArtManifestV1 | OfficeArtManifestV2 | null = null
  theme: OfficeTheme = 'cozy'
  private generated = new GeneratedArt()
  private base = './assets/'
  private images = new Map<string, HTMLImageElement>()
  private request = 0
  private lit = new Map<string, HTMLCanvasElement>()
  private fronts = new WeakMap<Layout, HTMLCanvasElement>()
  get ready() { return this.manifest?.version === 2 && this.images.size === Object.keys(this.manifest.atlases).length }
  async setTheme(theme: OfficeTheme) {
    this.theme = theme; this.generated.setTheme(theme); this.images.clear(); this.lit.clear(); this.fronts = new WeakMap()
    const entry = themedManifest(theme)
    this.manifest = entry ? entry[1] as OfficeArtManifestV1 | OfficeArtManifestV2 : null
    this.base = entry ? entry[0].slice(0, entry[0].lastIndexOf('/') + 1) : './assets/'
    await this.load()
  }
  async load() {
    const manifest = this.manifest, base = this.base, request = ++this.request
    if (!manifest) return
    const decoded = await Promise.all(Object.entries(manifest.atlases).map(async ([atlas, info]) => {
      const url = urls[`${base}${info.file}`]; if (typeof url !== 'string') return null
      const img = new Image(); img.src = url
      try { await img.decode(); return [atlas, img] as const } catch { return null }
    }))
    if (request === this.request) this.images = new Map(decoded.filter((v): v is readonly [string, HTMLImageElement] => !!v))
  }
  private resolve(id: string, state: string): [string, string] {
    if (this.manifest?.version !== 2) return [id, state]
    if (id === 'effect.status' && state === 'disconnect') return [id, 'unknown']
    if (id === 'object.user') return ['agent.user', state.startsWith('throw') ? 'throw:front' : 'idle:front']
    if (id === 'object.server.rack') return ['object.rack', state === 'hot' ? 'hot' : 'idle']
    if (id === 'object.pet') return this.theme === 'cozy' ? ['object.cat', state === 'walk' ? 'walk:side' : 'sleep'] : ['object.robot', state === 'walk' ? 'move' : 'charge']
    if (id === 'object.steam') return ['effect.steam', 'default']
    if (id === 'object.desk.head') return [id, state === 'off' ? 'off' : 'on']
    if (id.startsWith('object.chair.')) return [id, state === 'empty' ? 'in' : state]
    if (id === 'object.bell') return [id, state === 'ring' ? 'ring' : 'idle']
    if (id.startsWith('agent.') && !this.manifest.sprites[id]) return ['agent.general', state]
    if (id.startsWith('role.') && !this.manifest.sprites[id]) return ['role.general', state]
    return [id, state]
  }
  frame(id: string, state: string, time: number): OfficeArtFrame | undefined {
    const [key, pose] = this.resolve(id, state), sprite = this.manifest?.sprites[key]
    const animation = sprite?.states[pose] ?? sprite?.states.default ?? (sprite && Object.values(sprite.states)[0])
    return animation ? animationFrame(animation, time) : this.generated.frame(id, state, time)
  }
  hitRect(id: string, state: string, anchor: Point): Rect {
    const frame = this.frame(id, state, 0) ?? placeholderFrame
    return { ...frame.hitRect, x: anchor.x - frame.anchor.x + frame.hitRect.x, y: anchor.y - frame.anchor.y + frame.hitRect.y }
  }
  raw(ctx: CanvasRenderingContext2D, id: string, state: string, anchor: Point, time: number, emission = false): boolean {
    const [key, pose] = this.resolve(id, state), sprite = this.manifest?.sprites[key], frame = this.frame(key, pose, time), img = sprite && this.images.get(sprite.atlas)
    if (!sprite || !frame || !img) return false
    const r = emission ? ('emit' in frame ? frame.emit as Rect : undefined) : frame.rect
    if (r) ctx.drawImage(img, r.x, r.y, r.width, r.height, Math.round(anchor.x - frame.anchor.x), Math.round(anchor.y - frame.anchor.y), r.width, r.height)
    return true
  }
  paint(ctx: CanvasRenderingContext2D, id: string, state: string, anchor: Point, time: number): boolean {
    const [key, pose] = this.resolve(id, state), M = this.manifest, sprite = M?.sprites[key], frame = this.frame(key, pose, time), img = sprite && this.images.get(sprite.atlas)
    if (M?.version === 2 && sprite && frame && img && !key.startsWith('effect.')) {
      const hour = new Date().getHours(), night = hour < 7 || hour >= 21, cacheKey = `${key}:${pose}:${frame.rect.x}:${frame.rect.y}:${night}`
      let canvas = this.lit.get(cacheKey)
      if (!canvas) {
        const r = frame.rect, source = document.createElement('canvas'); source.width = r.width; source.height = r.height
        const sourceCtx = source.getContext('2d')!; sourceCtx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
        const pix = new Pix(r.width, r.height); pix.d.set(sourceCtx.getImageData(0, 0, r.width, r.height).data)
        const ambient = night ? (M.lighting.night as { ambient: [number, number, number] } | undefined)?.ambient ?? M.lighting.ambient : M.lighting.ambient
        const light = new LightMap(r.width, r.height, ambient)
        for (const l of (sprite as import('./assets/v2/manifest').OfficeArtSpriteV2).lights ?? []) if (!l.states || l.states.includes(pose)) light.pool(frame.anchor.x + l.dx, frame.anchor.y + l.dy, l.rx, l.ry, l.color, l.k)
        const pendant = M.lighting.pendant as { color: [number, number, number]; k: number; rxPerColumn: number; ry: number } | null
        if (pendant && /^(agent|role|object\.(bench|monitor|chair|desk))/.test(key)) light.pool(frame.anchor.x, frame.anchor.y - 16, pendant.rxPerColumn, pendant.ry, pendant.color, pendant.k)
        light.apply(pix, M.lighting.steps); canvas = pixelCanvas(pix)
        if (this.lit.size >= 2500) this.lit.clear()
        this.lit.set(cacheKey, canvas)
      }
      ctx.drawImage(canvas, Math.round(anchor.x - frame.anchor.x), Math.round(anchor.y - frame.anchor.y)); this.raw(ctx, key, pose, anchor, time, true); return true
    }
    if (this.raw(ctx, id, state, anchor, time)) { this.raw(ctx, id, state, anchor, time, true); return true }
    return this.generated.paint(ctx, id, state, anchor, time)
  }
  measure(text: string): number {
    if (this.manifest?.version !== 2) return text.length * 4
    const f = this.manifest.font
    return Math.max(0, [...text.toUpperCase()].reduce((n, ch) => n + (ch === ' ' ? f.space : (f.glyphs[ch]?.w ?? f.height + 2)) + f.spacing, -f.spacing))
  }
  text(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = 'ink', scale = 1, maxWidth = Infinity) {
    if (this.manifest?.version !== 2) return
    const f = this.manifest.font, img = this.images.get('font'); if (!img) return
    if ([...text.toUpperCase()].some(ch => ch !== ' ' && !f.glyphs[ch])) {
      // Keep names and translated signs legible when the pixel font has no glyph (e.g. CJK).
      const palette = this.manifest.palette, ink = color === 'sign' ? palette.signText : color === 'ink' ? palette.plaqueText : palette.labelText
      ctx.save(); ctx.font = `${(f.height + 2) * scale}px system-ui`; ctx.textBaseline = 'top'; ctx.fillStyle = typeof ink === 'string' ? ink : '#222'
      if (Number.isFinite(maxWidth)) ctx.fillText(text, Math.round(x), Math.round(y - scale), Math.max(1, maxWidth)); else ctx.fillText(text, Math.round(x), Math.round(y - scale))
      ctx.restore(); return
    }
    let dx = 0
    for (const ch of text.toUpperCase()) {
      const g = f.glyphs[ch] ?? f.glyphs[f.fallback], width = (ch === ' ' ? f.space : g.w) * scale
      if (dx + width > maxWidth) break
      if (ch !== ' ') ctx.drawImage(img, g.x, g.y + (f.colors[color] ?? 0), g.w, f.height, Math.round(x + dx), Math.round(y), width, f.height * scale)
      dx += width + f.spacing * scale
    }
  }
  nine(ctx: CanvasRenderingContext2D, key: string, x: number, y: number, width: number) {
    if (this.manifest?.version !== 2) return
    const n = this.manifest.nineSlices[key]; if (!n) return
    const s = this.manifest.sprites[n.sprite], f = this.frame(n.sprite, n.state, 0), img = this.images.get(s.atlas); if (!f || !img) return
    const r = f.rect, w = Math.max(n.left + n.right, Math.round(width)), top = Math.round(y - (n.sprite === 'object.sign' ? 3 : 0))
    const draw = (sx: number, sw: number, dx: number, dw: number) => { for (let i = 0; i < dw; i += sw) { const part = Math.min(sw, dw - i); ctx.drawImage(img, r.x + sx, r.y, part, r.height, Math.round(dx + i), top, part, r.height) } }
    draw(0, n.left, x, n.left); draw(n.left, r.width - n.left - n.right, x + n.left, w - n.left - n.right); draw(r.width - n.right, n.right, x + w - n.right, n.right)
  }
  sign(ctx: CanvasRenderingContext2D, name: string, cx: number, y: number, width: number, scale: number) {
    if (this.manifest?.version !== 2) return
    const key = `sign.x${scale}`, n = this.manifest.nineSlices[key], x = Math.round(cx - width / 2)
    this.nine(ctx, key, x, y, width); this.text(ctx, name, x + (n.textX ?? 3), y + (n.textY ?? 2), n.font, scale, width - (n.textX ?? 3) - n.right)
  }
  overlay(ctx: CanvasRenderingContext2D, kind: string, data: Record<string, unknown>) {
    const p = { x: Math.round(Number(data.x)), y: Math.round(Number(data.y)) }
    const effects: Record<string, [string, string, number]> = {
      bubble: ['effect.bubble', String(data.symbol), Number(data.phase ?? 0) * 440],
      note: ['effect.note', data.user ? 'user' : 'agent', 0],
      arrival: ['effect.arrival', 'default', Math.min(239, Number(data.progress ?? 0) * 240)],
      confetti: ['effect.confetti', 'default', Math.min(899, Number(data.progress ?? 0) * 900)],
      card: ['effect.card', 'default', 0],
      fall: ['effect.attempt', 'fall', Number(data.progress ?? 0) * 499],
      crumple: ['effect.crumple', 'default', 0],
      waves: ['effect.activity', 'default', Number(data.phase ?? 0) * 200],
      select: ['effect.select', 'default', 0]
    }
    if (kind === 'plane' || kind === 'packet') {
      const direction = (Math.round(Number(data.angle ?? 0) / (Math.PI / 8)) + 16) % 16
      if (this.paint(ctx, 'effect.carrier', `${data.boss ? 'boss' : data.user ? 'user' : 'agent'}:${direction}`, p, 0)) return
    }
    if (kind === 'plaque' && this.ready && this.manifest?.version === 2) {
      const variant = data.lead ? 'lead' : data.status === 'blocked' ? 'blocked' : 'default', key = `plaque.${variant}`, n = this.manifest.nineSlices[key], text = String(data.text ?? ''), width = Math.max(n.left + n.right, Math.min(n.maxWidth ?? 80, this.measure(text) + (n.textX ?? 3) + 2)), x = Math.round(p.x - width / 2)
      this.nine(ctx, key, x, p.y, width)
      this.paint(ctx, 'effect.plaque.pointer', `${data.south ? 'up' : 'down'}:${variant}`, { x: p.x, y: p.y + (data.south ? -2 : n.height) }, 0)
      this.paint(ctx, 'effect.status', String(data.status), { x: x + (n.markX ?? 3), y: p.y + (n.markY ?? 4) }, Number(data.phase ?? 0) * 220)
      this.text(ctx, text, x + (n.textX ?? 3), p.y + (n.textY ?? 2), data.status === 'unknown' ? 'dim' : 'ink', 1, width - (n.textX ?? 3) - 2)
      if (data.lead) this.paint(ctx, 'effect.star', 'default', { x: x + width - 1, y: p.y }, 0)
      return
    }
    if (kind === 'select') p.y += 32
    const effect = effects[kind]
    if (effect && this.paint(ctx, effect[0], effect[1], p, effect[2])) return
    this.generated.overlay(ctx, kind, data)
  }
  paintFront(ctx: CanvasRenderingContext2D, layout: Layout) {
    const canvas = this.ready ? this.fronts.get(layout) : this.generated.front(layout)
    if (canvas) ctx.drawImage(canvas, layout.bounds.x, layout.bounds.y)
  }
  bake(layout: Layout, names: Map<string, string>, time: number, boards = new Map<string, [number, number, number]>()) {
    if (!this.ready) return this.generated.bake(layout, names, time, boards)
    this.fronts.set(layout, atlasScene(this, layout, names, time, boards, true))
    return atlasScene(this, layout, names, time, boards)
  }
}
