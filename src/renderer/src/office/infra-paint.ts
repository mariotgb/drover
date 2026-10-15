import type { OfficeStatus } from '@shared/office'
import type { OfficeArt } from './art'
import type { CableKind, InfraCable, InfraDevice, InfraScene } from './infra'
import { pointOnRoute } from './routes'
import { pathLength } from './visibility'
import { t } from '../i18n'

/** Cable colours follow the Machines map: green home network, blue internet, rust bridge, grey backup, red down. */
const ROUTE: Record<'cozy' | 'neon', Record<CableKind, string>> = {
  cozy: { lan: '#2fae63', internet: '#3b82f6', bridge: '#c96442', standby: '#9a9a92', down: '#d9443c' },
  neon: { lan: '#3ecf7a', internet: '#60a5fa', bridge: '#ff9a6b', standby: '#9aa3b8', down: '#ff5a5a' }
}
export const routeColor = (theme: string, kind: CableKind) => ROUTE[theme === 'neon' ? 'neon' : 'cozy'][kind]
export const legendText = (kind: CableKind) => kind === 'lan' ? t('Home network') : kind === 'internet' ? t('Internet') : kind === 'bridge' ? t('Via bridge') : kind === 'standby' ? t('Backup route') : t('not answering')

interface CablePath { cable: InfraCable; core: Path2D; shade: Path2D; length: number }
/** Right-angled, pixel-aligned cables: solid for routes in use, dashed through the bridge, dotted for quiet ones. */
export function cablePaths(scene: InfraScene): CablePath[] {
  return scene.cables.map(cable => {
    const core = new Path2D(), shade = new Path2D(), style = cable.kind === 'bridge' ? 'dash' : cable.kind === 'standby' || cable.kind === 'down' ? 'dot' : 'solid'
    let n = 0
    for (let i = 0; i < cable.points.length - 1; i++) {
      const a = cable.points[i], b = cable.points[i + 1], steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)), flat = a.y === b.y
      for (let k = 0; k <= steps; k++, n++) {
        if (style === 'dash' && n % 8 >= 5 || style === 'dot' && n % 4) continue
        const x = Math.round(a.x + (b.x - a.x) * k / Math.max(1, steps)), y = Math.round(a.y + (b.y - a.y) * k / Math.max(1, steps))
        core.rect(x, y, 1, 1); if (style !== 'dot') shade.rect(x + (flat ? 0 : 1), y + (flat ? 1 : 0), 1, 1)
      }
    }
    return { cable, core, shade, length: pathLength(cable.points) }
  })
}

export interface InfraPaintState { theme: string; motion: boolean; now: number; active: Set<string>; onlineDevices: boolean }
export function paintCables(ctx: CanvasRenderingContext2D, paths: CablePath[], s: InfraPaintState) {
  for (const p of paths) {
    const color = routeColor(s.theme, p.cable.kind)
    ctx.globalAlpha = p.cable.kind === 'standby' ? 0.75 : 1
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(p.shade)
    ctx.fillStyle = color; ctx.fill(p.core)
    ctx.globalAlpha = 1
    // Data packets run on routes in use; a machine an agent just reached gets a denser stream.
    const live = p.cable.kind === 'lan' || p.cable.kind === 'internet' || p.cable.kind === 'bridge' && (p.cable.id !== 'devices-bridge' || s.onlineDevices)
    if (!live || p.length < 8) continue
    const hot = !!p.cable.machineId && s.active.has(p.cable.machineId), spacing = hot ? 18 : 44
    const offset = s.motion ? Math.floor(s.now / 50) * (hot ? 2 : 1) % spacing : spacing / 2
    for (let d = offset; d < p.length; d += spacing) {
      const q = pointOnRoute(p.cable.points, d / p.length)!
      ctx.fillStyle = s.theme === 'neon' ? '#fff6c8' : '#fff2b8'; ctx.fillRect(q.x - 1, q.y - 1, 3, 3)
      ctx.fillStyle = '#ffffff'; ctx.fillRect(q.x, q.y, 1, 1)
    }
  }
}

/** Small device on the wall shelf: phone, tablet, laptop/desktop or a browser window. */
export function paintDevice(ctx: CanvasRenderingContext2D, d: InfraDevice, theme: string) {
  const neon = theme === 'neon', body = '#2b2f3a', lit = d.online ? (neon ? '#5ef2ff' : '#9fd3ff') : '#3a3f4c', line = d.online ? '#e8f6ff' : '#4a5060'
  const x = Math.round(d.anchor.x), y = Math.round(d.anchor.y)
  const box = (bx: number, by: number, w: number, h: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(bx, by, w, h) }
  if (d.kind === 'phone') { box(x - 4, y - 14, 8, 14, body); box(x - 3, y - 12, 6, 9, lit); box(x - 1, y - 2, 2, 1, '#5b6378'); if (d.online) { box(x - 2, y - 10, 4, 1, line); box(x - 2, y - 8, 3, 1, line) } }
  else if (d.kind === 'tablet') { box(x - 7, y - 16, 14, 16, body); box(x - 6, y - 14, 12, 12, lit); if (d.online) { box(x - 4, y - 11, 6, 1, line); box(x - 4, y - 9, 8, 1, line); box(x - 4, y - 7, 5, 1, line) } }
  else if (d.kind === 'desktop') { box(x - 8, y - 14, 16, 11, body); box(x - 7, y - 13, 14, 8, lit); box(x - 2, y - 3, 4, 2, body); box(x - 5, y - 1, 10, 1, body); if (d.online) { box(x - 5, y - 11, 7, 1, line); box(x - 5, y - 9, 9, 1, line) } }
  else { box(x - 7, y - 12, 14, 12, body); box(x - 6, y - 10, 12, 9, lit); box(x - 6, y - 12, 12, 2, '#4a5060'); box(x - 5, y - 11, 1, 1, '#ff6b6b'); box(x - 3, y - 11, 1, 1, '#ffd36b'); box(x - 1, y - 11, 1, 1, '#6bdc8a'); if (d.online) box(x - 4, y - 7, 8, 1, line) }
  // Status light under the shelf.
  box(x - 2, y + 5, 4, 4, '#1a1a1a'); box(x - 1, y + 6, 2, 2, d.online ? routeColor(theme, 'lan') : routeColor(theme, 'standby'))
}

/** Plaque with an optional route-coloured light: machine roles, "this computer", the bridge. */
export function paintPlaque(ctx: CanvasRenderingContext2D, art: OfficeArt, text: string, cx: number, y: number, tone: string | null, maxWidth = 76) {
  const neon = art.theme === 'neon', pixel = art.ready
  const measured = pixel ? art.measure(text) : Math.ceil(text.length * 4.2)
  const inner = Math.min(maxWidth - (tone ? 13 : 8), measured), w = inner + (tone ? 13 : 8), l = Math.round(cx - w / 2)
  ctx.fillStyle = neon ? '#5ef2ff' : '#7a5236'; ctx.fillRect(l, y, w, 11)
  ctx.fillStyle = neon ? '#121826' : '#fbf0d6'; ctx.fillRect(l + 1, y + 1, w - 2, 9)
  if (tone) { ctx.fillStyle = tone; ctx.fillRect(l + 3, y + 3, 4, 4) }
  const tx = l + (tone ? 9 : 4)
  if (pixel) art.text(ctx, text, tx, y + 3, neon ? 'light' : 'ink', 1, inner + 1)
  else { ctx.save(); ctx.font = '7px system-ui'; ctx.textBaseline = 'top'; ctx.fillStyle = neon ? '#dffbff' : '#4a2e1f'; ctx.fillText(text, tx, y + 2, inner); ctx.restore() }
}
const tinted = new Map<string, HTMLCanvasElement>()
export function paintText(ctx: CanvasRenderingContext2D, art: OfficeArt, text: string, x: number, y: number, color: string, maxWidth = Infinity, center = false) {
  const width = Math.min(maxWidth, art.ready ? art.measure(text) : text.length * 4), left = Math.round(center ? x - width / 2 : x)
  if (art.ready) {
    // Tint the ink-coloured glyphs: draw them into a mask, then fill with the colour.
    const key = `${art.theme}:${color}:${maxWidth}:${text}`
    let mask = tinted.get(key)
    if (!mask) {
      mask = document.createElement('canvas'); mask.width = Math.max(1, Math.ceil(width) + 2); mask.height = 8
      const m = mask.getContext('2d')!; m.imageSmoothingEnabled = false; art.text(m, text, 0, 0, 'ink', 1, maxWidth)
      m.globalCompositeOperation = 'source-in'; m.fillStyle = color; m.fillRect(0, 0, mask.width, mask.height)
      if (tinted.size > 200) tinted.clear()
      tinted.set(key, mask)
    }
    ctx.drawImage(mask, left, Math.round(y))
  } else { ctx.save(); ctx.font = '7px system-ui'; ctx.textBaseline = 'top'; ctx.fillStyle = color; ctx.fillText(text, left, y, maxWidth); ctx.restore() }
}
export const remoteState = (status: OfficeStatus) => status === 'disconnect' ? 'unknown' : status
