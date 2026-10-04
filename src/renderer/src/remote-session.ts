import { REMOTE_AUTH_ROUTES } from '@shared/remote'
import { t } from './i18n'

/** Navigate only after the server has invalidated the cookie/session. */
export async function logoutRemote(fetcher: typeof fetch = fetch, navigate: (url: string) => void = url => location.replace(url)): Promise<void> {
  const response = await fetcher(REMOTE_AUTH_ROUTES.logout, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })
  if (!response.ok) throw new Error(t('Could not sign out. Try again.'))
  navigate('/login')
}
