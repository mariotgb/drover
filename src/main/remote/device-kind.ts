import type { RemoteDeviceKind } from '@shared/remote'

/** Best effort only; persist the category, never the browser's user-agent string. */
export function webDeviceKind(userAgent: string | undefined): RemoteDeviceKind {
  const ua = (userAgent ?? '').slice(0, 4096)
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || /Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet'
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|Mobi/i.test(ua)) return 'phone'
  // iPad desktop-mode UA cannot reliably be distinguished from a Mac here.
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return 'desktop'
  return 'other'
}
