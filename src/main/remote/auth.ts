import { randomBytes, randomUUID } from 'node:crypto'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON
} from '@simplewebauthn/server'
import { REMOTE_AUTH_ROUTES, type RemoteAccessSettings } from '@shared/remote'
import { Challenges, PairingCodes, RemoteFailure, remoteIdentity } from './security'
import { RemoteAuthStore, sessionCookie } from './store'

interface Challenge {
  kind: 'register' | 'login'
  challenge: string
  origin: string
  rpID: string
  generation: number
  codeHash?: string
  name?: string
  userID?: string
}
interface AuthResult { body: unknown; cookie?: string }
// Injectable only through the main-process constructor for signature-verification tests.
export const webAuthn = { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse }

export class RemoteAuth {
  readonly codes = new PairingCodes()
  private challenges = new Challenges<Challenge>()
  private generation = 0
  constructor(readonly store: RemoteAuthStore, private settings: () => RemoteAccessSettings, private verifier = webAuthn) {}
  clearPending(): void {
    this.generation++
    this.codes.clear()
    this.challenges.clear()
  }
  private ensureCurrent(challenge: Challenge): void {
    if (challenge.generation !== this.generation || remoteIdentity(this.settings()).origin !== challenge.origin) {
      throw new RemoteFailure('invalid_challenge', 'Remote access configuration changed', 403)
    }
  }
  async post(path: string, body: Record<string, unknown>, origin: string): Promise<AuthResult> {
    const identity = remoteIdentity(this.settings())
    // Local WS access is permitted, but passkeys belong to the configured RP/origin.
    if (origin !== identity.origin) throw new RemoteFailure('invalid_origin', 'Authenticate at the configured public address', 403)
    const generation = this.generation
    if (path === REMOTE_AUTH_ROUTES.registerOptions) {
      const codeHash = this.codes.check(body.code)
      const userID = randomBytes(32).toString('base64url')
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'iPhone'
      const options = await this.verifier.generateRegistrationOptions({
        rpName: 'Drover', rpID: identity.rpID, userID: Buffer.from(userID, 'base64url'),
        userName: `drover-${randomUUID()}`, userDisplayName: name,
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: this.store.credentials(identity.rpID).map((d) => ({ id: d.credential.id, transports: d.credential.transports }))
      })
      const challenge: Challenge = { kind: 'register', challenge: options.challenge, origin, rpID: identity.rpID, codeHash, name, userID, generation }
      this.ensureCurrent(challenge)
      this.codes.check(body.code)
      return { body: { challengeId: this.challenges.add(challenge), options } }
    }
    if (path === REMOTE_AUTH_ROUTES.loginOptions) {
      const options = await this.verifier.generateAuthenticationOptions({
        rpID: identity.rpID, userVerification: 'required'
        // Discoverable passkeys: don't disclose credential IDs to unauthenticated visitors.
      })
      const challenge: Challenge = { kind: 'login', challenge: options.challenge, origin, rpID: identity.rpID, generation }
      this.ensureCurrent(challenge)
      return { body: { challengeId: this.challenges.add(challenge), options } }
    }
    if (path !== REMOTE_AUTH_ROUTES.registerVerify && path !== REMOTE_AUTH_ROUTES.loginVerify) {
      throw new RemoteFailure('not_found', 'Unknown authentication route', 404)
    }
    const challenge = this.challenges.take(body.challengeId)
    this.ensureCurrent(challenge)
    if (origin !== challenge.origin || !body.response || typeof body.response !== 'object') {
      throw new RemoteFailure('invalid_authentication', 'Invalid passkey response', 403)
    }
    let deviceId: string
    if (path === REMOTE_AUTH_ROUTES.registerVerify && challenge.kind === 'register') {
      const verification = await this.verifier.verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin, expectedRPID: challenge.rpID,
        requireUserVerification: true, supportedAlgorithmIDs: [-7, -257]
      }).catch(() => { throw new RemoteFailure('invalid_authentication', 'Passkey verification failed', 403) })
      this.ensureCurrent(challenge)
      if (!verification.verified || !verification.registrationInfo) throw new RemoteFailure('invalid_authentication', 'Passkey verification failed', 403)
      const credential = verification.registrationInfo.credential
      // Atomic, after cryptographic verification: concurrent uses cannot register two phones.
      this.codes.consume(challenge.codeHash!)
      deviceId = this.store.addDevice({
        name: challenge.name!, userID: challenge.userID!, rpID: challenge.rpID,
        credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, transports: credential.transports }
      }).id
    } else if (path === REMOTE_AUTH_ROUTES.loginVerify && challenge.kind === 'login') {
      const response = body.response as AuthenticationResponseJSON
      const device = this.store.credential(response.id, challenge.rpID)
      if (!device || (response.response?.userHandle && response.response.userHandle !== device.userID)) {
        throw new RemoteFailure('invalid_authentication', 'Passkey verification failed', 403)
      }
      const verification = await this.verifier.verifyAuthenticationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rpID,
        credential: { ...device.credential, publicKey: Buffer.from(device.credential.publicKey, 'base64url') }, requireUserVerification: true
      }).catch(() => { throw new RemoteFailure('invalid_authentication', 'Passkey verification failed', 403) })
      this.ensureCurrent(challenge)
      if (!verification.verified) throw new RemoteFailure('invalid_authentication', 'Passkey verification failed', 403)
      deviceId = this.store.updateCredential(device.id, verification.authenticationInfo.newCounter).id
    } else throw new RemoteFailure('invalid_challenge', 'Wrong challenge type', 403)
    const session = this.store.issueSession(deviceId, origin)
    return { body: { ok: true, device: this.store.devices().find((d) => d.id === deviceId) }, cookie: sessionCookie(session.token, identity.secure) }
  }
}
