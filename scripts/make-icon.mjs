// Writes the app icon as an Icon Composer document, resources/Drover.icon.
// macOS 26+ draws it as Liquid Glass, with its own dark, tinted and clear
// looks; electron-builder compiles it with Xcode's actool and also derives
// the .icns used by older macOS. With Xcode 26+ installed, Icon Composer's
// ictool also renders PNGs for the UI, the README and the dev Dock icon, and
// a static resources/icon.icns for builds where actool can't run.
// Run: npm run icon
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const doc = join(root, 'resources', 'Drover.icon')

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>\n`
const p3 = (hex) =>
  'display-p3:' + [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',') + ',1.00000'

// The D of Drover; its counter holds the herd: three agents.
const dx = 12 // optical centering: the stem weighs more than the bowl
const monogram = `<path d="M ${300 + dx} 262 L ${460 + dx} 262 A 250 250 0 0 1 ${460 + dx} 762 L ${300 + dx} 762 Z" fill="none" stroke="#ffffff" stroke-width="104" stroke-linejoin="round"/>`
const agent = (cx, cy, r, color) => `<circle cx="${cx + dx}" cy="${cy}" r="${r}" fill="${color}"/>`
const herd = {
  'agent-orange': agent(436, 418, 72, '#ff8a4c'),
  'agent-cyan': agent(588, 506, 62, '#35d0ff'),
  'agent-lime': agent(452, 610, 64, '#9dff6a')
}

const GRADIENT = ['#2bb5a0', '#123a7a']

// Draws a PNG over an opaque square filled with a top-to-bottom gradient.
const SQUARE_SWIFT = `import AppKit
let a = CommandLine.arguments
func color(_ hex: String) -> NSColor {
  let v = Int(hex.dropFirst(), radix: 16)!
  return NSColor(displayP3Red: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let box = NSRect(x: 0, y: 0, width: 1024, height: 1024)
NSGradient(starting: color(a[3]), ending: color(a[4]))!.draw(in: box, angle: -90)
NSImage(contentsOfFile: a[1])!.draw(in: box)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
`

// Groups are listed front to back.
const icon = {
  fill: {
    'linear-gradient': GRADIENT.map(p3),
    orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } }
  },
  groups: [
    {
      name: 'Monogram',
      layers: [{ name: 'drover-d', 'image-name': 'drover-d.svg', glass: true }],
      shadow: { kind: 'neutral', opacity: 0.5 },
      translucency: { enabled: true, value: 0.4 },
      specular: true
    },
    {
      name: 'Herd',
      layers: Object.keys(herd).map((name) => ({ name, 'image-name': `${name}.svg`, glass: true })),
      shadow: { kind: 'layer-color', opacity: 0.5 },
      translucency: { enabled: true, value: 0.3 },
      specular: true
    }
  ],
  'supported-platforms': { squares: ['macOS'] }
}

rmSync(doc, { recursive: true, force: true })
mkdirSync(join(doc, 'Assets'), { recursive: true })
writeFileSync(join(doc, 'Assets', 'drover-d.svg'), svg(monogram))
for (const [name, body] of Object.entries(herd)) writeFileSync(join(doc, 'Assets', `${name}.svg`), svg(body))
writeFileSync(join(doc, 'icon.json'), JSON.stringify(icon, null, 2) + '\n')
console.log('wrote resources/Drover.icon')

const ictool = '/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool'
const render = (out, points) =>
  execFileSync(ictool, [doc, '--export-image', '--output-file', join(root, out), '--platform', 'macOS', '--rendition', 'Default',
    '--width', String(points), '--height', String(points), '--scale', '2'])
if (existsSync(ictool)) {
  render('resources/icon.png', 512)
  mkdirSync(join(root, 'src/renderer/src/assets'), { recursive: true })
  render('src/renderer/src/assets/app-icon.png', 128)
  // Static fallback for builds without a working actool (see scripts/dist.mjs).
  // macOS 26+ frames legacy icons that have transparent margins, but masks a
  // full-bleed square to its own shape like a native icon. So: the iOS render
  // (full-bleed, rounded corners) on an opaque square of the same gradient.
  const tmp = mkdtempSync(join(tmpdir(), 'drover-icon-'))
  const full = join(tmp, 'full.png')
  execFileSync(ictool, [doc, '--export-image', '--output-file', join(tmp, 'ios.png'), '--platform', 'iOS', '--rendition', 'Default',
    '--width', '512', '--height', '512', '--scale', '2'])
  writeFileSync(join(tmp, 'square.swift'), SQUARE_SWIFT)
  execFileSync('/usr/bin/xcrun', ['swift', join(tmp, 'square.swift'), join(tmp, 'ios.png'), full, ...GRADIENT])
  const iconset = join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = String(size * scale)
      execFileSync('/usr/bin/sips', ['-z', px, px, full, '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' })
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(root, 'resources', 'icon.icns')])
  rmSync(tmp, { recursive: true, force: true })
  console.log('wrote resources/icon.png, resources/icon.icns and src/renderer/src/assets/app-icon.png')
} else {
  console.log('Icon Composer (Xcode 26+) not found: PNG renders not updated')
}
