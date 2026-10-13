import { join, isAbsolute, basename } from 'node:path'

/** XDG directories must be absolute; relative values are ignored by the spec. */
function xdg(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]
  return value && isAbsolute(value) ? value : fallback
}

export function desktopPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) {
  return platform === 'linux' ? {
    userData: join(xdg(env, 'XDG_CONFIG_HOME', join(home, '.config')), 'Drover'),
    attachments: join(xdg(env, 'XDG_DATA_HOME', join(home, '.local', 'share')), 'drover', 'attachments')
  } : { userData: null, attachments: join(home, '.drover', 'attachments') }
}

export function desktopWindowOptions(platform: NodeJS.Platform) {
  return platform === 'darwin' ? {
    titleBarStyle: 'hiddenInset' as const,
    trafficLightPosition: { x: 18, y: 19 },
    vibrancy: 'sidebar' as const,
    visualEffectState: 'followWindow' as const,
    backgroundColor: '#00000000'
  } : { backgroundColor: '#141419' }
}

/** Keep the GUI session's bus/display identity while the shell supplies PATH. */
export function graphicalSessionEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (platform !== 'linux') return {}
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && (
    key.startsWith('XDG_') || ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
      'SSH_AUTH_SOCK', 'DESKTOP_SESSION', 'GDK_BACKEND', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(key)
  )))
}

export function loginShell(platform: NodeJS.Platform, envShell: string | undefined, accountShell: string | null): string {
  return envShell || accountShell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

export function shellProbeArgs(shell: string, executable: string, marker: string, platform: NodeJS.Platform = process.platform): string[] {
  // fish uses backslash escaping inside single quotes, unlike POSIX shells.
  const fish = platform === 'linux' && basename(shell) === 'fish'
  const quoted = fish ? executable.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : executable.replace(/'/g, "'\\''")
  const script = `'${quoted}' -e 'process.stdout.write("${marker}"+JSON.stringify(process.env)+"${marker}")'`
  return fish ? ['--login', '--interactive', '-c', script] : ['-ilc', script]
}

export function lsofCommand(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof'
}

/** Avoid consuming readline/agent control keys in Linux terminals. */
export function appAccelerator(platform: NodeJS.Platform, key: string): string {
  if (platform !== 'linux') return `CmdOrCtrl+${key}`
  if (key === ',') return 'Ctrl+,'
  if (['Shift+A', 'Shift+C', 'Shift+P'].includes(key)) return `Ctrl+${key}`
  if (key.startsWith('Shift+')) return `Ctrl+Alt+${key.slice(6)}`
  return `Ctrl+Shift+${key}`
}

export function imageCommand(platform: NodeJS.Platform, operation: 'convert' | 'dimensions', src: string, dest?: string) {
  if (platform === 'darwin') return operation === 'convert'
    ? { file: '/usr/bin/sips', args: ['-s', 'format', 'jpeg', src, '--out', dest!] }
    : { file: '/usr/bin/sips', args: ['-g', 'pixelWidth', '-g', 'pixelHeight', src] }
  // Absolute paths prevent ImageMagick option/format injection. [0] selects the
  // first TIFF/HEIF frame and avoids writing a series of output files.
  return operation === 'convert'
    ? { file: '/usr/bin/convert', args: [`${src}[0]`, `jpeg:${dest!}`] }
    : { file: '/usr/bin/identify', args: ['-ping', '-format', '%w %h', `${src}[0]`] }
}
