import { t } from './i18n'
import type { RemoteAuthOptionsResponse } from '@shared/remote'

type AuthProblem = 'unavailable' | 'rate_limited' | 'address' | 'pairing_expired' | 'challenge_expired' | 'passkey' | 'cancelled' | 'network' | 'invalid_response' | 'unknown'
export class AuthScreenError extends Error {
  constructor(public problem: AuthProblem) { super(problem) }
}

/** Read status before JSON: a proxy's HTML error is not a WebAuthn failure. */
export async function readAuthResponse<T>(response: Response): Promise<T> {
  if ([502, 503, 504].includes(response.status)) throw new AuthScreenError('unavailable')
  if (response.status === 404) throw new AuthScreenError('invalid_response')
  if (response.status === 429) throw new AuthScreenError('rate_limited')
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (mime !== 'application/json') throw new AuthScreenError(response.status === 403 ? 'address' : 'invalid_response')
  let data: { error?: { code?: string } }
  try { data = await response.json() } catch { throw new AuthScreenError('invalid_response') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthScreenError('invalid_response')
  if (!response.ok) {
    switch (data.error?.code) {
      case 'invalid_pairing_code': case 'pairing_expired': throw new AuthScreenError('pairing_expired')
      case 'invalid_origin': case 'invalid_host': case 'invalid_settings': throw new AuthScreenError('address')
      case 'invalid_challenge': throw new AuthScreenError('challenge_expired')
      case 'invalid_authentication': throw new AuthScreenError('passkey')
      case 'rate_limited': throw new AuthScreenError('rate_limited')
      default: throw new AuthScreenError('unknown')
    }
  }
  return data as T
}

export async function authRequest<T>(route: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  } catch { throw new AuthScreenError('network') }
  return readAuthResponse<T>(response)
}

export function checkedAuthOptions(data: RemoteAuthOptionsResponse): RemoteAuthOptionsResponse {
  const options = data.options
  if (typeof data.challengeId !== 'string' || !data.challengeId || !options || typeof options !== 'object' ||
      !('challenge' in options) || typeof options.challenge !== 'string' || !options.challenge) throw new AuthScreenError('invalid_response')
  return data
}

/** Errors from credentials.create/get must not expose browser/library internals. */
export async function requestPasskey<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) {
    const cause = error as { name?: string; code?: string; cause?: { name?: string } } | null
    const names = [cause?.name, cause?.cause?.name]
    if (names.includes('SecurityError') || ['ERROR_INVALID_DOMAIN', 'ERROR_INVALID_RP_ID'].includes(cause?.code ?? '')) throw new AuthScreenError('address')
    if (names.some(n => n === 'NotAllowedError' || n === 'AbortError') || cause?.code === 'ERROR_CEREMONY_ABORTED') throw new AuthScreenError('cancelled')
    throw new AuthScreenError('passkey')
  }
}

export function authErrorText(error: unknown): string {
  switch (error instanceof AuthScreenError ? error.problem : 'unknown') {
    case 'unavailable': return t('Drover on your Mac is unavailable. Keep Drover running and check the SSH tunnel, then try again.')
    case 'rate_limited': return t('Too many sign-in attempts. Please wait before trying again.')
    case 'address': return t('Passkeys belong to the address where they were created. Open the public HTTPS address from Drover on your Mac, or pair this device again.')
    case 'pairing_expired': return t('This pairing link has expired. Create a new one on your Mac.')
    case 'challenge_expired': return t('The sign-in request expired or Drover settings changed. Tap the button to try again.')
    case 'passkey': return t('The passkey could not be used or verified. Try again, or pair this device at the current public HTTPS address.')
    case 'cancelled': return t('Passkey request cancelled or timed out. Tap the button to try again.')
    case 'network': return t('Could not reach Drover. Check your connection and try again.')
    case 'invalid_response': return t('This address did not return a valid Drover response. Check the public HTTPS address in Drover on your Mac.')
    default: return t('Could not sign in. Try again or create a new pairing link on your Mac.')
  }
}
