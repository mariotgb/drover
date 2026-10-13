// Packages the host OS, or an explicit --mac/--linux target. The macOS icon is the Icon Composer document
// (resources/Drover.icon), which macOS 26+ renders as live Liquid Glass; it
// needs a working actool (Xcode 26+, after `sudo xcodebuild -runFirstLaunch`).
// Without one, the pre-rendered resources/icon.icns is used instead.
// Extra arguments go to electron-builder, e.g. `node scripts/dist.mjs --dir`.
import { spawnSync } from 'node:child_process'
import { packagingTarget, builderArgs } from './dist-platform.mjs'

const extra = process.argv.slice(2)
const target = packagingTarget(process.platform, extra)
const actool = target === '--mac' ? spawnSync('actool', ['--version'], { encoding: 'utf8' }) : null
const glass = !!actool && actool.status === 0 && actool.stdout.includes('short-bundle-version')
if (target === '--mac' && !glass) {
  console.warn('actool is not usable (try `sudo xcodebuild -runFirstLaunch`): packaging with the static resources/icon.icns')
}
const args = builderArgs(target, extra, glass)
const r = spawnSync('npx', args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
