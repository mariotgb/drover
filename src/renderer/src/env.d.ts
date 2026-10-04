/// <reference types="vite/client" />

import type { DroverApi } from '../../preload/api'
import type { RemoteManagementApi, RemotePushApi } from '@shared/remote'
declare global {
  interface Window { droverRemote?: boolean; api?: DroverApi & Partial<RemoteManagementApi & RemotePushApi> }
}
