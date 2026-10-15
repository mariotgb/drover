import { Globe, Laptop, Smartphone, Tablet } from 'lucide-react'
import { t } from './i18n'
import type { RemoteDeviceKind } from '@shared/remote'

/** Devices that open Drover through the bridge or web access: phones, tablets and any other browser. */
export type DeviceKind = RemoteDeviceKind
const KINDS: readonly string[] = ['phone', 'tablet', 'desktop', 'other']

/** Uses the kind the backend reports; records from an older main only carry a name, so guess from it. */
export function deviceKind(device: { name?: string; kind?: string | null }): DeviceKind {
  if (device.kind && KINDS.includes(device.kind)) return device.kind as DeviceKind
  const name = (device.name ?? '').toLowerCase()
  if (/ipad|tablet|\btab\b|galaxy tab|kindle|surface go/.test(name)) return 'tablet'
  if (/iphone|android|pixel|galaxy|phone|mobile/.test(name)) return 'phone'
  if (/mac|windows|linux|desktop|laptop|\bpc\b|chromebook/.test(name)) return 'desktop'
  return 'other'
}

/** Web access works from any browser, so each device keeps its own icon. */
export function DeviceIcon({ kind, size = 20 }: { kind: DeviceKind; size?: number }) {
  return kind === 'phone' ? <Smartphone size={size} /> : kind === 'tablet' ? <Tablet size={size} /> : kind === 'desktop' ? <Laptop size={size} /> : <Globe size={size} />
}
export const deviceKindName = (kind: DeviceKind) => kind === 'phone' ? t('Phone') : kind === 'tablet' ? t('Tablet') : kind === 'desktop' ? t('Computer') : t('Browser')
