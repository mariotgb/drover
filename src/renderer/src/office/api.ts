import type { OfficeState, OfficeUpdate } from '@shared/office'
import { api } from '../api'

/** Desktop boundary: never called or subscribed from a remote renderer. */
interface OfficeBridge {
  officeInit(): Promise<OfficeState | null>
  officeStop(): void
  on: { office(callback: (update: OfficeUpdate) => void): () => void }
}
export function officeBridge(): OfficeBridge | null {
  if (window.droverRemote) return null
  // Reject an unavailable bridge before subscribing; remote clients expose no office API.
  const bridge = api as typeof api & Partial<OfficeBridge>
  if (typeof bridge.officeInit !== 'function' || typeof bridge.officeStop !== 'function' || typeof bridge.on.office !== 'function') return null
  return bridge as typeof api & OfficeBridge
}
