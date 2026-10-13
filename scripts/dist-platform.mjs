export function packagingTarget(platform, args) {
  const requested = args.filter(arg => ['--mac', '--linux', '--win'].includes(arg))
  if (new Set(requested).size > 1) throw new Error('Package one operating system at a time')
  const target = requested[0] ?? ({ darwin: '--mac', linux: '--linux', win32: '--win' })[platform]
  if (!target) throw new Error(`Unsupported packaging host: ${platform}`)
  if (target === '--win') throw new Error('Native Windows support is not implemented yet; see docs/platforms.md')
  return target
}

export function builderArgs(target, args, glass = false) {
  return ['electron-builder', target, ...(target === '--mac' && !glass ? ['-c.mac.icon=resources/icon.icns'] : []), ...args.filter(arg => arg !== target)]
}
