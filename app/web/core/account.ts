// account.ts: the Trommi account. An email with a passkey, a password the person chooses (like a password manager),
// or both, and an Emergency Kit (recovery words, made with the account) for when those are lost. The account is a way
// into the ROOM the first device founded: what the passkey, the password and the kit open is the room's recovery code,
// from which a new device adds itself (room.ts joinWithRecoveryCode). The hub never sees the password, the recovery
// words, a passkey's prf output or the code.
//
// account (bytes; the labels follow v1.md section 3: every label is followed by one 0x00, and a label has ONE use.
// Known answers: spec/account-vectors.json, checked by core/account-test.mjs and the iOS app's tests):
//   email     = normaliseEmail (passwords.ts): ASCII only, the blanks around it dropped, A-Z as a-z
//   salt      = SHA-256("trommi/v1/account-salt" 0x00 || email)                 (per account, known without a round trip)
//   master    = Argon2id(password NFC UTF-8, salt, m = 64 MiB, t = 3, p = 1, 32 bytes)
//   KDF(ikm, label) = HKDF-SHA-256(ikm, salt, info = label 0x00, 32 bytes)
//   auth_key  = KDF(master, "trommi/v1/account-auth")                           -> sent to the hub at login; it keeps a scrypt hash
//   wrap_key  = KDF(master, "trommi/v1/account-wrap-key")                       -> AES-256-GCM, never leaves the device
//   key_wrapped = 0x02 || nonce(12) || AES-GCM(wrap_key, nonce, aad "trommi/v1/account-wrap" 0x00 || room_id(32) || "password", code(32 raw))
//   recovery words: 12 words of the EFF large list (155 bits); r = UTF-8(words joined by one space)
//   recovery_auth = KDF(r, "trommi/v1/recovery-auth"), recovery wrap key = KDF(r, "trommi/v1/recovery-wrap-key"),
//   recovery_wrapped = as key_wrapped with "recovery" in the aad. (No slow KDF: 155 random bits need none.)
//   passkey: prf = the WebAuthn prf extension's output over the fixed input "trommi/v1/passkey-prf" (32 bytes; the
//   page asks for it, hands it here, and it goes nowhere else),
//   passkey wrap key = HKDF-SHA-256(prf, salt = room_id(32), info = "trommi/v1/passkey-wrap-key" 0x00 || credential_id, 32),
//   its key_wrapped = as above with the aad "trommi/v1/account-wrap" 0x00 || room_id(32) || "passkey" || credential_id.
//   Fixed bytes of all three copies as account.ts seals them: spec/account-vectors.json (core/account-test.mjs).
// (A copy whose first byte is 0x01 is refused, not converted.)
// Changing the password re-wraps the 32-byte code (and swaps the auth hash); nothing else is re-encrypted.
// WebAuthn itself runs on the page (navigator.credentials, auth.mjs): the functions here take what a ceremony
// returned as bytes and never see a prompt.
//
// Hub routes (README "Accounts"): POST /rooms/:room/account (the password's part and the kit in one request: the hub
// makes no account without its kit), GET it, PUT …/account/password, PUT …/account/recovery (a new kit),
// POST …/account/verify, POST …/account/code; POST /accounts/login, POST /accounts/recover (anonymous, rate-limited,
// one answer for "no such email" and "wrong password"); POST /accounts/passkey/challenge, POST /accounts/passkey/login,
// POST …/account/passkeys/challenge, POST …/account/passkeys, DELETE …/account/passkeys/:id.
import * as z from './crypto/zcrypto.mjs'
import { argon2id } from './crypto/argon2.mjs'
import type { Storage } from './types.ts'
import { Hub, normaliseHubUrl } from './transport.ts'
import { foundRoom, joinWithRecoveryCode } from './room.ts'
import type { Client } from './client.ts'
import { normaliseEmail, passwordProblem, generateRecoveryWords, parseRecoveryWords } from './passwords.ts'
import { ACCOUNT_LABEL, labelBytes, aesKey, passkeyKeys, wrapCode, unwrapCode, wrapCodeForPasskey, unwrapCodeWithPasskey } from './passkey.ts'
export { ACCOUNT_LABEL } from './passkey.ts'
export { PASSWORD_MIN, normaliseEmail, passwordProblem, generatePassword, generateRecoveryWords, parseRecoveryWords } from './passwords.ts'

const { ZError, b64u } = z

/** What the account needs of a signed-in client: its room id and its hub (a Client, or remote.ts RemoteClient). */
export interface AccountClient { model: { room: { room_id: string | null } }; hub: { request(method: string, path: string, opts?: Record<string, unknown>): Promise<any>; roomPath(path?: string): string } }
/** The account as the hub keeps it (GET …/account). */
export interface AccountStatus { email: string; email_verified_at?: number | null; has_recovery?: boolean; has_password?: boolean; revision: number; kdf?: Kdf | null; key_wrapped: string | null; user_handle?: string; passkeys?: PasskeyStatus[]; [field: string]: unknown }
/** A passkey of the account as the hub lists it. `backup_eligible`: its provider may sync it; else it lives on one device. */
export interface PasskeyStatus { credential_id: string; algorithm: number; transports: string[]; aaguid: string; backup_eligible: boolean; backup_state: boolean; sign_count: number; created_at: number; last_used_at: number | null; key_wrapped: string }
/** What navigator.credentials.create() gave, as bytes, with the prf output of that passkey (auth.mjs). */
export interface PasskeyRegistration { credential_id: Bytes; attestation_object: Bytes; client_data_json: Bytes; transports?: string[]; prf: Bytes }
/** What navigator.credentials.get() gave, as bytes, with the prf output. */
export interface PasskeyAssertion { credential_id: Bytes; authenticator_data: Bytes; client_data_json: Bytes; signature: Bytes; user_handle?: Bytes | null; prf: Bytes }
/** A way a signed-in device opens the room's recovery code: the password, a passkey of the account, or the kit's words. */
export type Unlock = { password: string } | { passkey: { credential_id: Bytes; prf: Bytes } } | { words: string }
type Bytes = Uint8Array<ArrayBuffer>
export interface Kdf { alg: string; v: number; m: number; t: number; p: number }
/** What opening a room takes besides the account (room.ts). */
interface DeviceOptions { storage: Storage; device_name?: string; device_info?: Record<string, unknown> | null; fetch?: typeof globalThis.fetch | null; client?: string | null }
const te = new TextEncoder()
export const ACCOUNT_KDF: Readonly<Kdf> = Object.freeze({ alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 })
const accountSalt = (email: string) => z.sha256(labelBytes(ACCOUNT_LABEL.salt), te.encode(email))
/** HKDF-SHA-256(ikm, salt, info = label 0x00), 32 bytes (zcrypto.mjs hkdf()). */
const hkdfBytes = (ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> => z.hkdf(ikm, salt, label, new Uint8Array(0), 32)

/**
 * The kdf record of an account as the hub hands it out: accepted only if it is exactly ACCOUNT_KDF, the one set this
 * client derives with (anything else: 'bad-kdf'). The hub stores the record, so it must not choose the cost: a client
 * that took its numbers would run a derivation of the password with the memory and time the hub names (a cheap one, or
 * one that exhausts the device). No record (null) is the pinned set. Returns ACCOUNT_KDF, never the hub's object.
 */
export function acceptKdf(kdf: unknown): Readonly<Kdf> {
  if (kdf == null) return ACCOUNT_KDF
  const k = kdf as Record<string, unknown>
  if (typeof kdf !== 'object' || k.alg !== ACCOUNT_KDF.alg || k.v !== ACCOUNT_KDF.v || k.m !== ACCOUNT_KDF.m || k.t !== ACCOUNT_KDF.t || k.p !== ACCOUNT_KDF.p) {
    throw new ZError('bad-kdf', 'this account names key derivation parameters this app does not use')
  }
  return ACCOUNT_KDF
}
/** The Argon2id master key (the slow step: ≈0.15 s desktop, ≈0.5–1.5 s phone). `kdf`: the hub's record, checked by acceptKdf. */
export async function masterKey(email: string, password: unknown, kdf: unknown = ACCOUNT_KDF): Promise<Uint8Array<ArrayBuffer>> {
  const k = acceptKdf(kdf)
  return argon2id({ password: te.encode(String(password).normalize('NFC')), salt: await accountSalt(email), iterations: k.t, parallelism: k.p, memorySize: k.m, hashLength: 32, outputType: 'binary' })
}
/** { auth_key (b64u, for the hub), wrap_key (CryptoKey) } from email and password. */
export async function passwordKeys(email: string, password: unknown, kdf: unknown = ACCOUNT_KDF): Promise<{ auth_key: string; wrap_key: CryptoKey }> {
  email = normaliseEmail(email)
  const salt = await accountSalt(email)
  const master = await masterKey(email, password, kdf)
  return { auth_key: b64u(await hkdfBytes(master, salt, ACCOUNT_LABEL.auth)), wrap_key: await aesKey(await hkdfBytes(master, salt, ACCOUNT_LABEL.wrapKey)) }
}
/** { recovery_auth (b64u), wrap_key } from email and the recovery words. */
export async function recoveryKeys(email: string, words: unknown): Promise<{ recovery_auth: string; wrap_key: CryptoKey }> {
  email = normaliseEmail(email)
  const salt = await accountSalt(email)
  const r = te.encode(parseRecoveryWords(words))
  return { recovery_auth: b64u(await hkdfBytes(r, salt, ACCOUNT_LABEL.recoveryAuth)), wrap_key: await aesKey(await hkdfBytes(r, salt, ACCOUNT_LABEL.recoveryWrapKey)) }
}
export { PASSKEY_PRF_INPUT, passkeyKeys, wrapCode, unwrapCode, wrapCodeForPasskey, unwrapCodeWithPasskey, passkeyChallenge } from './passkey.ts'

/** The account body for the hub: email, auth key, the code wrapped under the password. */
async function passwordPart(email: string, password: unknown, room_id: string, code: string): Promise<{ auth_key: string; key_wrapped: string; kdf: Readonly<Kdf> }> {
  const why = passwordProblem(password)
  if (why) throw new ZError('weak-password', why)
  const k = await passwordKeys(email, password)
  return { auth_key: k.auth_key, key_wrapped: await wrapCode(k.wrap_key, room_id, code, 'password'), kdf: ACCOUNT_KDF }
}

/** The Emergency Kit's part of an account body: new recovery words, their auth key, the code sealed under them. */
async function kitPart(email: string, room_id: string, code: string): Promise<{ words: string; recovery_auth: string; recovery_wrapped: string }> {
  const words = generateRecoveryWords()
  const k = await recoveryKeys(email, words)
  return { words, recovery_auth: k.recovery_auth, recovery_wrapped: await wrapCode(k.wrap_key, room_id, code, 'recovery') }
}
/** A passkey's part of a request: the registration as the hub takes it, and the code sealed under the passkey (opened once more before it is sent). */
async function passkeyPart(p: PasskeyRegistration, room_id: string, code: string): Promise<{ attestation_object: string; client_data_json: string; key_wrapped: string; transports: string[] }> {
  const key_wrapped = await wrapCodeForPasskey(p.prf, room_id, p.credential_id, code)
  if (await unwrapCodeWithPasskey(p.prf, room_id, p.credential_id, key_wrapped) !== z.formatRecoveryCode(z.parseRecoveryCode(code))) throw new ZError('internal', 'the passkey copy does not open')
  const transports = (p.transports ?? []).filter(t => /^[a-z0-9-]{1,32}$/.test(t)).slice(0, 8)
  return { attestation_object: b64u(p.attestation_object), client_data_json: b64u(p.client_data_json), key_wrapped, transports }
}
/** POST …/account: email, a way in (password or passkey) and the Emergency Kit in ONE request (the hub writes all or nothing). Returns the kit. */
async function postAccount(client: AccountClient, email: string, way: { password: unknown } | { passkey: PasskeyRegistration & { user_handle: Bytes } }, code: string): Promise<{ words: string; email: string }> {
  const room_id = client.model.room.room_id!
  const { words, ...kit } = await kitPart(email, room_id, code)
  const part = 'passkey' in way ? { passkey: { user_handle: b64u(way.passkey.user_handle), ...(await passkeyPart(way.passkey, room_id, code)) } } : await passwordPart(email, way.password, room_id, code)
  await client.hub.request('POST', client.hub.roomPath('/account'), { body: { email, ...part, ...kit } })
  return { words, email }
}

/**
 * Create an account: this device founds the room (as foundRoom) and registers email + password WITH the Emergency
 * Kit in one request (the hub mails a code to confirm the email): there is no account without a kit, at no moment.
 * Returns { client, kit: { words, email } }: the words are shown once (auth.mjs) and never stored; the room's recovery
 * code does not leave this function. A refused account leaves nothing in storage, so the person can try again.
 */
export async function createAccount({ hub_url, email: given, password, storage, device_name = '', device_info = null, found_token = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; email: string; password: string; found_token?: string | null }): Promise<{ client: Client; kit: { words: string; email: string } }> {
  const email = normaliseEmail(given)
  const why = passwordProblem(password)
  if (why) throw new ZError('weak-password', why)
  return foundWithAccount({ hub_url, storage, client: client_name, device_name, device_info, found_token, fetch }, email, { password })
}
async function foundWithAccount(o: DeviceOptions & { hub_url: string; found_token?: string | null }, email: string, way: Parameters<typeof postAccount>[2]): Promise<{ client: Client; kit: { words: string; email: string } }> {
  const { client, recovery_code } = await foundRoom(o)
  try { return { client, kit: await postAccount(client, email, way, recovery_code) } }
  catch (e) {
    // the room it founded has no account and never will: this storage forgets it (else "Create account" again is refused)
    await client.stop().catch(() => {})
    for (const k of await o.storage.keys()) await o.storage.delete(k)
    throw e
  }
}

/** A challenge (as passkey.ts passkeyChallenge) for a passkey added to the account of a signed-in device. */
export const passkeyChallengeFor = async (client: AccountClient): Promise<string> => (await client.hub.request('POST', client.hub.roomPath('/account/passkeys/challenge'), { body: {} })).challenge

/**
 * Create an account whose way in is a passkey: as createAccount, with the passkey's registration in place of a
 * password. The page made the passkey over passkeyChallenge() and has its prf output BEFORE it calls this: nothing
 * reaches the hub until then.
 * `user_handle`: the 32 random bytes the page gave the authenticator as the user's id.
 */
export async function createAccountWithPasskey({ hub_url, email: given, passkey, storage, device_name = '', device_info = null, found_token = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; email: string; passkey: PasskeyRegistration & { user_handle: Bytes }; found_token?: string | null }): Promise<{ client: Client; kit: { words: string; email: string } }> {
  const email = normaliseEmail(given)
  if (passkey.user_handle?.length !== 32) throw new ZError('bad-argument', 'user_handle is 32 bytes')
  await passkeyKeys(passkey.prf, '00'.repeat(32), passkey.credential_id)      // no prf output: refused before a room is founded
  return foundWithAccount({ hub_url, storage, client: client_name, device_name, device_info, found_token, fetch }, email, { passkey })
}

/**
 * Add a login to a room that has none yet (founded without an account): needs the room's recovery code, which only
 * the person has (shown once at founding). Same request as createAccount after the founding; returns
 * { kit: { words, email } }, the Emergency Kit made with it.
 */
export async function addAccount(client: AccountClient, { email: given, password, recovery_code }: { email: string; password: string; recovery_code: string }): Promise<{ kit: { words: string; email: string } }> {
  const email = normaliseEmail(given)
  z.parseRecoveryCode(recovery_code)
  return { kit: await postAccount(client, email, { password }, recovery_code) }
}

/** The account of the room, as a human device sees it: { email, email_verified_at, has_recovery, revision, … } or null. */
export async function accountStatus(client: AccountClient): Promise<AccountStatus | null> {
  try { return await client.hub.request('GET', client.hub.roomPath('/account')) } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e }
}
/**
 * The room's recovery code on a signed-in device, from a way in the person gives again (for a new kit, a new password,
 * a new passkey): the account password, a passkey of the account (its prf output from a get() on the page), or the
 * Emergency Kit's words (their copy is fetched as "Forgot password" fetches it). 'wrong-login' / 'wrong-recovery' when it does not open.
 */
async function codeFrom(client: AccountClient, unlock: Unlock, st: AccountStatus | null = null): Promise<{ st: AccountStatus; code: string }> {
  st = st ?? await accountStatus(client)
  if (!st) throw new ZError('no-account', 'this room has no account yet')
  const room_id = client.model.room.room_id!
  if ('passkey' in unlock) {
    const id = b64u(unlock.passkey.credential_id), p = (st.passkeys ?? []).find(x => x.credential_id === id)
    if (!p) throw new ZError('wrong-login', 'this passkey does not belong to the account')
    return { st, code: await unwrapCodeWithPasskey(unlock.passkey.prf, room_id, unlock.passkey.credential_id, p.key_wrapped) }
  }
  if ('words' in unlock) {
    const k = await recoveryKeys(st.email, unlock.words)
    const r = await client.hub.request('POST', '/accounts/recover', { auth: false, body: { email: st.email, recovery_auth: k.recovery_auth } })
    try { return { st, code: await unwrapCode(k.wrap_key, room_id, r.recovery_wrapped, 'recovery') } } catch { throw new ZError('wrong-recovery', 'these words do not open the account') }
  }
  if (!st.key_wrapped) throw new ZError('no-password', 'this account has no password')
  const k = await passwordKeys(st.email, unlock.password, st.kdf ?? ACCOUNT_KDF)
  return { st, code: await unwrapCode(k.wrap_key, room_id, st.key_wrapped, 'password') }
}
/** Does this way in open the account? (asked before a passkey is made, so a wrong password leaves no stray passkey) */
export async function checkUnlock(client: AccountClient, unlock: Unlock): Promise<void> { await codeFrom(client, unlock) }

/**
 * A new Emergency Kit for an account that exists (the first one is made with the account): new recovery words, the
 * code (opened with the password or a passkey) sealed under them, stored on the hub, replacing the kit before.
 * Returns { words, email }.
 */
export async function makeEmergencyKit(client: AccountClient, unlock: Unlock): Promise<{ words: string; email: string }> {
  const { st, code } = await codeFrom(client, unlock)
  const { words, ...kit } = await kitPart(st.email, client.model.room.room_id!, code)
  await client.hub.request('PUT', client.hub.roomPath('/account/recovery'), { body: { ...kit, revision: st.revision } })
  return { words, email: st.email }
}

/** A signed-in device changes the password: the code is re-wrapped, the hub swaps the auth hash. Content is untouched. */
export const changePassword = (client: AccountClient, { current, next }: { current: string; next: string }): Promise<void> => setPassword(client, { unlock: { password: current }, next })
/** The same from any way in: how an account with passkeys only gets a password ("Add a password"), and a new one after the kit. */
export async function setPassword(client: AccountClient, { unlock, next }: { unlock: Unlock; next: string }): Promise<void> {
  const why = passwordProblem(next)
  if (why) throw new ZError('weak-password', why)
  const { st, code } = await codeFrom(client, unlock)
  await client.hub.request('PUT', client.hub.roomPath('/account/password'), { body: { ...(await passwordPart(st.email, next, client.model.room.room_id!, code)), revision: st.revision } })
}

/**
 * Add a passkey to the account: the code (opened with `unlock`) sealed under the new passkey, with its registration
 * (made on the page over passkeyChallengeFor(), as for a new account). Returns { credential_id } (base64url).
 */
export async function addPasskey(client: AccountClient, { unlock, passkey }: { unlock: Unlock; passkey: PasskeyRegistration }): Promise<{ credential_id: string }> {
  const { code } = await codeFrom(client, unlock)
  const r = await client.hub.request('POST', client.hub.roomPath('/account/passkeys'), { body: await passkeyPart(passkey, client.model.room.room_id!, code) })
  return { credential_id: r.credential_id }
}
/** Remove a passkey (its id, base64url). 'last-way-in' when the account has no password and no other passkey. */
export const removePasskey = (client: AccountClient, credential_id: string): Promise<any> => client.hub.request('DELETE', client.hub.roomPath(`/account/passkeys/${credential_id}`))

export const verifyEmail = (client: AccountClient, code: unknown): Promise<any> => client.hub.request('POST', client.hub.roomPath('/account/verify'), { body: { code: String(code).replace(/\D/g, '') } })
export const resendEmailCode = (client: AccountClient): Promise<any> => client.hub.request('POST', client.hub.roomPath('/account/code'), { body: {} })

/**
 * Log in on a new device with email and password. One error for unknown email and wrong password: 'wrong-login'.
 * The device adds itself to the room (joinWithRecoveryCode). Returns { client }.
 */
export async function loginWithPassword({ hub_url, email: given, password, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; email: string; password: string }): Promise<{ client: Client }> {
  const email = normaliseEmail(given)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const k = await passwordKeys(email, password)
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/login', { auth: false, body: { email, auth_key: k.auth_key } })
  const code = await unwrapCode(k.wrap_key, r.room_id, r.key_wrapped, 'password')
  return joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
}

/**
 * Log in on a new device with a passkey: the assertion of a get() over passkeyChallenge(), with its prf output. No
 * email is needed (the passkey names its account). One error for every miss at the hub: 'wrong-login'; 'no-prf' when
 * the passkey gave no key here (nothing is sent then). The device adds itself to the room. Returns { client }.
 */
export async function loginWithPasskey({ hub_url, assertion: a, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; assertion: PasskeyAssertion }): Promise<{ client: Client }> {
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  if (!(a.prf instanceof Uint8Array) || a.prf.length !== 32) throw new ZError('no-prf', 'this passkey gave no key (no prf output)')
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/passkey/login', { auth: false, body: { credential_id: b64u(a.credential_id), authenticator_data: b64u(a.authenticator_data), client_data_json: b64u(a.client_data_json), signature: b64u(a.signature), ...(a.user_handle?.length ? { user_handle: b64u(a.user_handle) } : {}) } })
  const code = await unwrapCodeWithPasskey(a.prf, r.room_id, a.credential_id, r.key_wrapped)
  return joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
}

/**
 * The Emergency Kit without a new password: email + words, the device adds itself and that is all. For an account
 * whose way in was a passkey: the page then makes a new passkey (addPasskey with { words }) or sets a password
 * (setPassword with { words }). One error for every miss: 'wrong-recovery'. Returns { client }.
 */
export async function recoverWithKit({ hub_url, email: given, words, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; email: string; words: string }): Promise<{ client: Client }> {
  const email = normaliseEmail(given)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const k = await recoveryKeys(email, words)
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/recover', { auth: false, body: { email, recovery_auth: k.recovery_auth } })
  let code: string
  try { code = await unwrapCode(k.wrap_key, r.room_id, r.recovery_wrapped, 'recovery') } catch { throw new ZError('wrong-recovery', 'these words do not open the account') }
  return joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
}

/**
 * Forgot password: email + the Emergency Kit's words + a new password. The device adds itself, then sets the new
 * password (the old one stops working). Returns { client }. One error for every miss: 'wrong-recovery'.
 */
export async function resetPassword({ hub_url, email: given, words, new_password, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }: DeviceOptions & { hub_url: string; email: string; words: string; new_password: string }): Promise<{ client: Client }> {
  const email = normaliseEmail(given)
  const why = passwordProblem(new_password)
  if (why) throw new ZError('weak-password', why)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const k = await recoveryKeys(email, words)
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/recover', { auth: false, body: { email, recovery_auth: k.recovery_auth } })
  let code: string
  try { code = await unwrapCode(k.wrap_key, r.room_id, r.recovery_wrapped, 'recovery') } catch { throw new ZError('wrong-recovery', 'these words do not open the account') }
  const { client } = await joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
  const st = await accountStatus(client)
  await client.hub.request('PUT', client.hub.roomPath('/account/password'), { body: { ...(await passwordPart(email, new_password, r.room_id, code)), revision: st!.revision } })
  return { client }
}
