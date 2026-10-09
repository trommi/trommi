// passkey.ts: the sealed copies of the account (account.ts) and the light parts of a passkey ceremony,
// without the slow key derivation: the page loads this beside navigator.credentials (auth.mjs) and never Argon2.
//   key_wrapped = 0x02 || nonce(12) || AES-256-GCM(wrap_key, nonce, aad "trommi/v1/account-wrap" 0x00 || room_id(32) || what || more, code(32 raw))
//   what = "password" | "recovery" | "passkey"; more = the credential id for a passkey, else nothing
//   passkey wrap key = HKDF-SHA-256(prf output(32), salt = room_id(32), info = "trommi/v1/passkey-wrap-key" 0x00 || credential_id, 32)
// The labels follow FORMAT.md section 3: each is followed by one 0x00 where it is used, and each has one use.
import * as z from './crypto/zcrypto.mjs'
import { Hub } from './transport.ts'

const { ZError, b64u, unb64u, concat, unhex } = z
type Bytes = Uint8Array<ArrayBuffer>
const te = new TextEncoder()
/** Raw key bytes as a non-extractable AES-GCM key. */
export const aesKey = (raw: Bytes): Promise<CryptoKey> => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

/** The account's labels. Each is followed by one 0x00 where it is used, and each has one use: five derive a key (HKDF info), one starts the sealed copy's associated data, one the salt. */
export const ACCOUNT_LABEL = Object.freeze({
  salt: 'trommi/v1/account-salt', auth: 'trommi/v1/account-auth', wrapKey: 'trommi/v1/account-wrap-key',
  recoveryAuth: 'trommi/v1/recovery-auth', recoveryWrapKey: 'trommi/v1/recovery-wrap-key', wrapAad: 'trommi/v1/account-wrap',
  passkeyWrapKey: 'trommi/v1/passkey-wrap-key',
})
/** label 0x00: how every label is used. */
export const labelBytes = (label: string): Bytes => concat(te.encode(label), Uint8Array.of(0))
/** The first byte of a sealed copy of the recovery code (a copy that starts with 0x01 is refused). */
const WRAP_VERSION = 2

/** The fixed input every Trommi passkey evaluates its prf over: a constant of the client, never chosen by a hub. */
export const PASSKEY_PRF_INPUT: Bytes = te.encode('trommi/v1/passkey-prf')
/** { wrap_key } from a passkey's prf output (32 bytes), for one room and one credential. */
export async function passkeyKeys(prf: Bytes, room_id: string, credential_id: Bytes): Promise<{ wrap_key: CryptoKey }> {
  if (!(prf instanceof Uint8Array) || prf.length !== 32) throw new ZError('no-prf', 'this passkey gave no key (no prf output)')
  // HKDF-SHA-256 for 32 bytes, written out as its two HMACs (RFC 5869: PRK = HMAC(salt, ikm), OKM = HMAC(PRK, info || 0x01)):
  // a credential id may be 1023 bytes, and some WebCrypto builds (Node) refuse an HKDF info above 1024.
  const hmac = async (key: Bytes, data: Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data))
  const raw = await hmac(await hmac(unhex(room_id), prf), concat(labelBytes(ACCOUNT_LABEL.passkeyWrapKey), credential_id, Uint8Array.of(1)))   // info = label 0x00 credential id
  return { wrap_key: await aesKey(raw) }
}
const NONE: Bytes = new Uint8Array(0)
const aad = (room_id: string, what: string, more: Bytes = NONE): Bytes => concat(labelBytes(ACCOUNT_LABEL.wrapAad), unhex(room_id), te.encode(what), more)
/** Seal the room's recovery code under a wrap key ('password', 'recovery', or 'passkey' with the credential id as `more`). `nonce`: tests only. */
export async function wrapCode(wrap_key: CryptoKey, room_id: string, code: string, what = 'password', more: Bytes = NONE, nonce: Bytes = crypto.getRandomValues(new Uint8Array(12))): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(room_id, what, more) }, wrap_key, z.parseRecoveryCode(code)))
  return b64u(concat(Uint8Array.of(WRAP_VERSION), nonce, ct))
}
export async function unwrapCode(wrap_key: CryptoKey, room_id: string, blob: string, what = 'password', more: Bytes = NONE): Promise<string> {
  const b = unb64u(blob)
  if (b.length !== 1 + 12 + 32 + 16 || b[0] !== WRAP_VERSION) throw new ZError('bad-format', 'account key blob')
  try { return z.formatRecoveryCode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(1, 13), additionalData: aad(room_id, what, more) }, wrap_key, b.slice(13)))) }
  catch { throw new ZError('wrong-login', what === 'passkey' ? 'this passkey does not open the account' : 'this password does not open the account') }
}
/** The copy of the code under a passkey, and its opening. */
export const wrapCodeForPasskey = async (prf: Bytes, room_id: string, credential_id: Bytes, code: string): Promise<string> => wrapCode((await passkeyKeys(prf, room_id, credential_id)).wrap_key, room_id, code, 'passkey', credential_id)
export const unwrapCodeWithPasskey = async (prf: Bytes, room_id: string, credential_id: Bytes, blob: string): Promise<string> => unwrapCode((await passkeyKeys(prf, room_id, credential_id)).wrap_key, room_id, blob, 'passkey', credential_id)

/** A challenge for a passkey ceremony (base64url, 2 minutes, one use): for a login or a new account, anonymous. */
export async function passkeyChallenge({ hub_url, fetch = null, client = null }: { hub_url: string; fetch?: typeof globalThis.fetch | null; client?: string | null }): Promise<string> {
  return (await new Hub({ hub_url, fetch, client }).request('POST', '/accounts/passkey/challenge', { auth: false, body: {} })).challenge
}
