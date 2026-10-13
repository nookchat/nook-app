import { serverTag, serverUrl } from '../backend'
import { bundleOfThisDevice, type Bundle } from './link'
import { dropVault, keepVault, keysFrom, openVault, records, sha256Id, vaultServer, type VaultRecord } from './vault'

/**
 * A passkey that holds this account. The passkey's own secret (the WebAuthn PRF extension) seals
 * the account on a server. A synced passkey (iCloud Keychain, Google Password Manager, 1Password)
 * is on every device the person owns, so a new one signs in with a fingerprint or a face and
 * nothing else: no camera, no typing, no other device that is open.
 */
const enc = new TextEncoder()
/** What the passkey is asked to turn into a secret. It never changes. */
const PRF_INPUT = enc.encode('nook passkey vault v1')
const HANDLE_VERSION = 1
/** The user handle is at most 64 bytes: a version, six random, then the server. */
const HANDLE_MAX = 64
const HANDLE_RANDOM = 6

export function passkeysAvailable(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && window.isSecureContext && !!navigator.credentials?.create
}

/** The server is in the passkey's user handle, so a new device needs to be told nothing. */
function handleFor(server: string): Uint8Array {
  const tag = enc.encode(serverTag(server)).slice(0, HANDLE_MAX - 1 - HANDLE_RANDOM)
  const out = new Uint8Array(1 + HANDLE_RANDOM + tag.length)
  out[0] = HANDLE_VERSION
  out.set(crypto.getRandomValues(new Uint8Array(HANDLE_RANDOM)), 1)
  out.set(tag, 1 + HANDLE_RANDOM)
  return out
}

function serverInHandle(handle: ArrayBuffer | null | undefined): string {
  if (!handle) return ''
  const bytes = new Uint8Array(handle)
  if (bytes[0] !== HANDLE_VERSION) return ''
  return serverUrl(new TextDecoder().decode(bytes.slice(1 + HANDLE_RANDOM)))
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

const prfOf = (credential: PublicKeyCredential): PrfResults => credential.getClientExtensionResults() as PrfResults

const fresh = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32))

/** Asks the passkey for its secret. The browser shows its own fingerprint or face prompt. */
async function secretOf(
  credentialId: BufferSource | null,
  first: PublicKeyCredential | null,
): Promise<{ seed: Uint8Array; id: Uint8Array; handle: ArrayBuffer | null }> {
  let credential = first
  let seed = credential ? prfOf(credential).prf?.results?.first : undefined
  // A passkey on another device, or some makers' own, gives the secret only when asked for by id.
  if (!seed && credentialId) {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fresh(),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        extensions: { prf: { eval: { first: PRF_INPUT } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null
    seed = credential ? prfOf(credential).prf?.results?.first : undefined
  }
  if (!credential || !seed) {
    throw new Error('This passkey cannot hold your account. Use a recovery key instead, or a passkey from a password manager.')
  }
  const response = credential.response as AuthenticatorAssertionResponse
  return { seed: new Uint8Array(seed), id: new Uint8Array(credential.rawId), handle: response.userHandle ?? null }
}

/** Makes a passkey and keeps this account in a vault it opens. */
export async function makePasskey(): Promise<VaultRecord> {
  if (!passkeysAvailable()) throw new Error('This browser cannot make a passkey.')
  const server = vaultServer()
  if (!server) throw new Error('Add a server first: the account is kept there, sealed.')
  const me = bundleOfThisDevice()
  const name = me.n || 'Nook'
  let made: PublicKeyCredential | null
  try {
    made = (await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: 'Nook' },
        user: { id: handleFor(server) as BufferSource, name: `${name} on Nook`, displayName: name },
        challenge: fresh(),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        extensions: { prf: {} },
      } as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential | null
  } catch (err) {
    throw passkeyError(err, 'The passkey could not be made.')
  }
  if (!made) throw new Error('The passkey could not be made.')
  if (prfOf(made).prf?.enabled === false) {
    throw new Error('This passkey cannot hold your account. Use a recovery key instead, or a passkey from a password manager.')
  }
  let secret: Awaited<ReturnType<typeof secretOf>>
  try {
    secret = await secretOf(made.rawId, made)
  } catch (err) {
    throw passkeyError(err, 'The passkey could not be used.')
  }
  const id = await sha256Id(enc.encode('nook passkey vault v1'), secret.id)
  return keepVault('passkey', id, await keysFrom(secret.seed), server, name)
}

/** Signs in with a passkey: the account it holds, opened, for the caller to ask about and take. */
export async function signInWithPasskey(): Promise<Bundle> {
  if (!passkeysAvailable()) throw new Error('This browser cannot use a passkey.')
  let found: PublicKeyCredential | null
  try {
    found = (await navigator.credentials.get({
      publicKey: {
        challenge: fresh(),
        rpId: location.hostname,
        userVerification: 'required',
        extensions: { prf: { eval: { first: PRF_INPUT } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null
  } catch (err) {
    throw passkeyError(err, 'The passkey could not be used.')
  }
  if (!found) throw new Error('No passkey was chosen.')
  let secret: Awaited<ReturnType<typeof secretOf>>
  try {
    secret = await secretOf(found.rawId, found)
  } catch (err) {
    throw passkeyError(err, 'The passkey could not be used.')
  }
  const server = serverInHandle(secret.handle) || vaultServer()
  if (!server) throw new Error('This passkey does not say which server holds your account. Use a recovery key.')
  const id = await sha256Id(enc.encode('nook passkey vault v1'), secret.id)
  return openVault(id, await keysFrom(secret.seed), server)
}

export function passkeys(): VaultRecord[] {
  return records('passkey')
}

/** Takes the account off the server. The passkey stays in the person's keychain: only they can delete that. */
export async function removePasskey(record: VaultRecord): Promise<void> {
  await dropVault(record)
}

function passkeyError(err: unknown, fallback: string): Error {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return new Error('The passkey was cancelled, or timed out.')
    if (err.name === 'InvalidStateError') return new Error('A passkey is already kept here for this account.')
    if (err.name === 'NotSupportedError') return new Error('This browser or app cannot make this kind of passkey.')
    if (err.name === 'SecurityError') return new Error('Passkeys do not work on this address.')
  }
  return err instanceof Error ? err : new Error(fallback)
}
