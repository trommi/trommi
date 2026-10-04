// account.mjs: the Trommi account. An email and a password the person chooses (like a password manager), and an
// optional Emergency Kit (recovery words) for "Forgot password". The account is a way into the ROOM the first
// device founded: what the password and the kit open is the room's recovery code, from which a new device adds itself
// (room.mjs joinWithRecoveryCode). The hub never sees the password, the recovery words or the code.
//
// account v1 (bytes):
//   email     = trim, lowercase (NFC)
//   salt      = SHA-256("trommi/v1/account-salt" 0x00 || email)                 (per account, known without a round trip)
//   master    = Argon2id(password NFC UTF-8, salt, m = 64 MiB, t = 3, p = 1, 32 bytes)
//   auth_key  = HKDF-SHA-256(master, salt, "trommi/v1/account-auth", 32)        -> sent to the hub at login; it keeps a scrypt hash
//   wrap_key  = HKDF-SHA-256(master, salt, "trommi/v1/account-wrap", 32)        -> AES-256-GCM, never leaves the device
//   key_wrapped = 0x01 || nonce(12) || AES-GCM(wrap_key, nonce, aad "trommi/v1/account-wrap" 0x00 || room_id(32) || "password", code(32 raw))
//   recovery words: 12 words of the EFF large list (155 bits); r = UTF-8(words joined by one space)
//   recovery_auth = HKDF(r, salt, "trommi/v1/recovery-auth", 32), recovery wrap key = HKDF(r, salt, "trommi/v1/recovery-wrap", 32),
//   recovery_wrapped = as key_wrapped with "recovery" in the aad. (No slow KDF: 155 random bits need none.)
// Changing the password re-wraps the 32-byte code (and swaps the auth hash); nothing else is re-encrypted.
//
// Hub routes (README "Accounts"): POST /rooms/:room/account, GET it, PUT …/account/password, PUT …/account/recovery,
// POST …/account/verify, POST …/account/code; POST /accounts/login, POST /accounts/recover (anonymous, rate-limited,
// one answer for "no such email" and "wrong password").
import * as z from './zcrypto.mjs'
import { argon2id } from './argon2.mjs'
import { WORDS } from './wordlist.mjs'
import { Hub, normaliseHubUrl } from './transport.mjs'
import { foundRoom, joinWithRecoveryCode } from './room.mjs'

const { ZError, b64u, unb64u, concat, unhex } = z
const te = new TextEncoder()
export const ACCOUNT_KDF = Object.freeze({ alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 })
export const PASSWORD_MIN = 12
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/

export function normaliseEmail(email) {
  const e = String(email ?? '').normalize('NFC').trim().toLowerCase()
  if (e.length > 254 || !EMAIL.test(e)) throw new ZError('bad-email', 'not an email address')
  return e
}
/** null if the password may be used, else why not. The only rule: at least 12 characters. */
export function passwordProblem(password) {
  return [...String(password ?? '').normalize('NFC')].length >= PASSWORD_MIN ? null : `at least ${PASSWORD_MIN} characters`
}

/** n uniformly random words of the list (rejection sampling, no modulo bias). */
function randomWords(n) {
  const out = []
  const limit = Math.floor(65536 / WORDS.length) * WORDS.length
  while (out.length < n) {
    for (const v of crypto.getRandomValues(new Uint16Array(n * 2))) if (v < limit && out.length < n) out.push(WORDS[v % WORDS.length])
  }
  return out
}
/** A strong password to offer: five words joined by "-" (≈64 bits), e.g. 'acorn-velvet-tidy-hamper-oxford'. */
export function generatePassword() { return randomWords(5).join('-') }
/** The Emergency Kit's recovery words: twelve words (≈155 bits), one space between. */
export function generateRecoveryWords() { return randomWords(12).join(' ') }
const WORD_SET = new Set(WORDS)
/** Normalised recovery words (lowercase, single spaces), or ZError 'bad-recovery-words'. */
export function parseRecoveryWords(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (words.length !== 12) throw new ZError('bad-recovery-words', 'the Emergency Kit has 12 words')
  const unknown = words.filter(w => !WORD_SET.has(w))
  if (unknown.length) throw new ZError('bad-recovery-words', `not a word of the kit: ${unknown.join(', ')}`)
  return words.join(' ')
}

const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const accountSalt = email => sha256(concat(te.encode('trommi/v1/account-salt'), Uint8Array.of(0), te.encode(email)))
async function hkdfBytes(ikm, salt, label) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(label) }, k, 256))
}
const aesKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

/** The Argon2id master key (the slow step: ≈0.15 s desktop, ≈0.5–1.5 s phone). */
export async function masterKey(email, password, kdf = ACCOUNT_KDF) {
  if (kdf.alg !== 'argon2id' || kdf.v !== 1) throw new ZError('bad-kdf', 'unknown account kdf')
  return argon2id({ password: te.encode(String(password).normalize('NFC')), salt: await accountSalt(email), iterations: kdf.t, parallelism: kdf.p, memorySize: kdf.m, hashLength: 32, outputType: 'binary' })
}
/** { auth_key (b64u, for the hub), wrap_key (CryptoKey) } from email and password. */
export async function passwordKeys(email, password, kdf = ACCOUNT_KDF) {
  email = normaliseEmail(email)
  const salt = await accountSalt(email)
  const master = await masterKey(email, password, kdf)
  return { auth_key: b64u(await hkdfBytes(master, salt, 'trommi/v1/account-auth')), wrap_key: await aesKey(await hkdfBytes(master, salt, 'trommi/v1/account-wrap')) }
}
/** { recovery_auth (b64u), wrap_key } from email and the recovery words. */
export async function recoveryKeys(email, words) {
  email = normaliseEmail(email)
  const salt = await accountSalt(email)
  const r = te.encode(parseRecoveryWords(words))
  return { recovery_auth: b64u(await hkdfBytes(r, salt, 'trommi/v1/recovery-auth')), wrap_key: await aesKey(await hkdfBytes(r, salt, 'trommi/v1/recovery-wrap')) }
}
const aad = (room_id, what) => concat(te.encode('trommi/v1/account-wrap'), Uint8Array.of(0), unhex(room_id), te.encode(what))
/** Seal the room's recovery code under a wrap key ('password' or 'recovery'). */
export async function wrapCode(wrap_key, room_id, code, what = 'password') {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(room_id, what) }, wrap_key, z.parseRecoveryCode(code)))
  return b64u(concat(Uint8Array.of(1), nonce, ct))
}
export async function unwrapCode(wrap_key, room_id, blob, what = 'password') {
  const b = unb64u(blob)
  if (b.length !== 1 + 12 + 32 + 16 || b[0] !== 1) throw new ZError('bad-format', 'account key blob')
  try { return z.formatRecoveryCode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(1, 13), additionalData: aad(room_id, what) }, wrap_key, b.slice(13)))) }
  catch { throw new ZError('wrong-login', 'this password does not open the account') }
}

/** The account body for the hub: email, auth key, the code wrapped under the password. */
async function passwordPart(email, password, room_id, code) {
  const why = passwordProblem(password)
  if (why) throw new ZError('weak-password', why)
  const k = await passwordKeys(email, password)
  return { auth_key: k.auth_key, key_wrapped: await wrapCode(k.wrap_key, room_id, code, 'password'), kdf: ACCOUNT_KDF }
}

/**
 * Create an account: this device founds the room (as foundRoom), then registers email + password with the hub,
 * which mails a code to confirm the email. Returns { client, recovery_code } — keep recovery_code in memory only
 * until the Emergency Kit is made (makeEmergencyKit) or skipped, never store it.
 */
export async function createAccount({ hub_url, email, password, storage, device_name = '', device_info = null, found_token = null, fetch = null, client: client_name = null }) {
  email = normaliseEmail(email)
  const why = passwordProblem(password)
  if (why) throw new ZError('weak-password', why)
  const { client, recovery_code } = await foundRoom({ hub_url, storage, client: client_name, device_name, device_info, found_token, fetch })
  const room_id = client.model.room.room_id
  await client.hub.request('POST', client.hub.roomPath('/account'), { body: { email, ...(await passwordPart(email, password, room_id, recovery_code)) } })
  return { client, recovery_code }
}

/**
 * Add a login to a room that has none yet (founded before accounts): needs the room's recovery code, which only
 * the person has (shown once at founding). Same as createAccount after the founding.
 */
export async function addAccount(client, { email, password, recovery_code }) {
  email = normaliseEmail(email)
  const room_id = client.model.room.room_id
  z.parseRecoveryCode(recovery_code)
  return client.hub.request('POST', client.hub.roomPath('/account'), { body: { email, ...(await passwordPart(email, password, room_id, recovery_code)) } })
}

/** The account of the room, as a human device sees it: { email, email_verified_at, has_recovery, revision, … } or null. */
export async function accountStatus(client) {
  try { return await client.hub.request('GET', client.hub.roomPath('/account')) } catch (e) { if (e.status === 404) return null; throw e }
}
/** The room's recovery code from the account password (for a new kit or a password change on a signed-in device). */
async function codeFromPassword(client, password, st = null) {
  st = st ?? await accountStatus(client)
  if (!st) throw new ZError('no-account', 'this room has no account yet')
  const k = await passwordKeys(st.email, password, st.kdf)
  return { st, code: await unwrapCode(k.wrap_key, client.model.room.room_id, st.key_wrapped, 'password') }
}

/**
 * The Emergency Kit: new recovery words, the code sealed under them, stored on the hub (replacing an older kit).
 * Either recovery_code (right after createAccount) or the account password. Returns { words, email }.
 */
export async function makeEmergencyKit(client, { recovery_code = null, password = null } = {}) {
  let st = await accountStatus(client)
  if (!st) throw new ZError('no-account', 'this room has no account yet')
  const code = recovery_code ?? (await codeFromPassword(client, password, st)).code
  const words = generateRecoveryWords()
  const k = await recoveryKeys(st.email, words)
  await client.hub.request('PUT', client.hub.roomPath('/account/recovery'), { body: { recovery_auth: k.recovery_auth, recovery_wrapped: await wrapCode(k.wrap_key, client.model.room.room_id, code, 'recovery'), revision: st.revision } })
  return { words, email: st.email }
}

/** A signed-in device changes the password: the code is re-wrapped, the hub swaps the auth hash. Content is untouched. */
export async function changePassword(client, { current, next }) {
  const why = passwordProblem(next)
  if (why) throw new ZError('weak-password', why)
  const { st, code } = await codeFromPassword(client, current)
  await client.hub.request('PUT', client.hub.roomPath('/account/password'), { body: { ...(await passwordPart(st.email, next, client.model.room.room_id, code)), revision: st.revision } })
}

export const verifyEmail = (client, code) => client.hub.request('POST', client.hub.roomPath('/account/verify'), { body: { code: String(code).replace(/\D/g, '') } })
export const resendEmailCode = client => client.hub.request('POST', client.hub.roomPath('/account/code'), { body: {} })

/**
 * Log in on a new device with email and password. One error for unknown email and wrong password: 'wrong-login'.
 * The device adds itself to the room (joinWithRecoveryCode). Returns { client }.
 */
export async function loginWithPassword({ hub_url, email, password, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }) {
  email = normaliseEmail(email)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const k = await passwordKeys(email, password)
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/login', { auth: false, body: { email, auth_key: k.auth_key } })
  const code = await unwrapCode(k.wrap_key, r.room_id, r.key_wrapped, 'password')
  return joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
}

/**
 * Forgot password: email + the Emergency Kit's words + a new password. The device adds itself, then sets the new
 * password (the old one stops working). Returns { client }. One error for every miss: 'wrong-recovery'.
 */
export async function resetPassword({ hub_url, email, words, new_password, storage, device_name = '', device_info = null, fetch = null, client: client_name = null }) {
  email = normaliseEmail(email)
  const why = passwordProblem(new_password)
  if (why) throw new ZError('weak-password', why)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const k = await recoveryKeys(email, words)
  const pub = new Hub({ hub_url, fetch, client: client_name })
  const r = await pub.request('POST', '/accounts/recover', { auth: false, body: { email, recovery_auth: k.recovery_auth } })
  let code
  try { code = await unwrapCode(k.wrap_key, r.room_id, r.recovery_wrapped, 'recovery') } catch { throw new ZError('wrong-recovery', 'these words do not open the account') }
  const { client } = await joinWithRecoveryCode({ hub_url: normaliseHubUrl(hub_url), room_id: r.room_id, code, storage, client: client_name, device_name, device_info, fetch, challenge: r.challenge ?? null })
  const st = await accountStatus(client)
  await client.hub.request('PUT', client.hub.roomPath('/account/password'), { body: { ...(await passwordPart(email, new_password, r.room_id, code)), revision: st.revision } })
  return { client }
}
