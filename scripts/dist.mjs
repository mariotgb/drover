// Packages the macOS app. The icon is the Icon Composer document
// (resources/Drover.icon), which macOS 26+ renders as live Liquid Glass; it
// needs a working actool (Xcode 26+, after `sudo xcodebuild -runFirstLaunch`).
// Without one, the pre-rendered resources/icon.icns is used instead.
// Extra arguments go to electron-builder, e.g. `node scripts/dist.mjs --dir`.
import { spawnSync } from 'node:child_process'

const actool = spawnSync('actool', ['--version'], { encoding: 'utf8' })
const glass = actool.status === 0 && actool.stdout.includes('short-bundle-version')
if (!glass) {
  console.warn('actool is not usable (try `sudo xcodebuild -runFirstLaunch`): packaging with the static resources/icon.icns')
}
const args = ['electron-builder', '--mac', ...(glass ? [] : ['-c.mac.icon=resources/icon.icns']), ...process.argv.slice(2)]
const r = spawnSync('npx', args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
