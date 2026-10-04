// escrow.mjs: "Mit Passwort anmelden" (optional). The room's recovery code, sealed under a key derived from a
// passphrase, stored on the hub (opaque to it). A fresh device with the room link and the passphrase derives the key
// and the escrow id, fetches the blob by that id, opens the recovery code, and adds itself as a human device with an
// entry signed by the recovery key (every human device then shows the alert 'recovery-add').
//
// escrow_version 2 (written now):
//   okm       = PBKDF2-HMAC-SHA-256(passphrase NFC UTF-8, salt "trommi/v2/escrow" 0x00 || room_id(32), 2,000,000, 512 bits)
//   key       = okm[0..32];  escrow_id = hex(SHA-256("trommi/v2/escrow-id" 0x00 || okm[32..64]))[0..32]
//   blob      = 0x02 || nonce(12) || AES-256-GCM(key, nonce, aad "trommi/v2/escrow" 0x00 || room_id || escrow_id(16 raw), code(32 raw))
//   routes    PUT /escrow { escrow_version: 2, escrow_id, key_escrow }, GET /escrow/:escrow_id (anonymous, rate-limited)
// The blob is addressed by a passphrase-derived id, not the room id: fetching it at all costs one slow derivation per
// guess and goes through the hub's rate limit. Whoever holds the hub's database still guesses offline against PBKDF2
// (not memory-hard: WebCrypto has no Argon2, and no vetted small pure-JS Argon2id is in the tree). So the default is a
// GENERATED passphrase (generatePassphrase: 24 characters, 120 bits): offline guessing is hopeless. A passphrase of the
// human's own must pass passphraseProblem (>= 6 words of >= 3 letters, >= 24 characters); it is weaker, and the README says so.
//
// escrow_version 1 (read only, for blobs written before): 0x01 || iterations u32 || salt(16) || nonce(12) || GCM(...),
//   key = PBKDF2(passphrase, salt || room_id, iterations), aad = "trommi/v1/escrow" 0x00 || room_id || iterations u32.
import * as z from './zcrypto.mjs'

const { ZError, b64u, unb64u, concat, hex, unhex } = z
export const ESCROW_VERSION = 2
export const ESCROW_ITERATIONS = 1_000_000          // v1 (read only)
export const ESCROW_V2_ITERATIONS = 2_000_000
const te = new TextEncoder()
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b }

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'      // 32 letters and digits, no 0/o/1/l
const GENERATED = /^([a-km-np-z2-9]{4}-){5}[a-km-np-z2-9]{4}$/
/** A strong passphrase: six groups of four, e.g. 'k7m2-x9qp-...' (120 bits). Offer this; show it once, like the recovery code. */
export function generatePassphrase() {
  const out = []
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  for (let i = 0; i < 24; i++) out.push(ALPHABET[bytes[i] & 31])
  return out.join('').match(/.{4}/g).join('-')
}

/** null if the passphrase is acceptable, else a reason (English, short). Generated passphrases always pass. */
export function passphraseProblem(passphrase) {
  const p = String(passphrase ?? '').normalize('NFC')
  if (GENERATED.test(p.trim().toLowerCase())) return null
  const words = p.trim().split(/\s+/).filter(w => w.length >= 3)
  if (words.length < 6 || p.length < 24) return 'at least six words (or take the generated passphrase)'
  if (new Set(p.replace(/\s/g, '')).size < 10) return 'too repetitive'
  return null
}
const normalise = p => { const s = String(p).normalize('NFC'); return GENERATED.test(s.trim().toLowerCase()) ? s.trim().toLowerCase() : s }

/** v2: the key and the escrow id from the passphrase (one slow derivation). */
export async function escrowKeyAndId(passphrase, room_id) {
  const roomId = unhex(room_id)
  const base = await crypto.subtle.importKey('raw', te.encode(normalise(passphrase)), 'PBKDF2', false, ['deriveBits'])
  const okm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: concat(te.encode('trommi/v2/escrow'), Uint8Array.of(0), roomId), iterations: ESCROW_V2_ITERATIONS }, base, 512))
  const key = await crypto.subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const escrow_id = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', concat(te.encode('trommi/v2/escrow-id'), Uint8Array.of(0), okm.slice(32))))).slice(0, 32)
  return { key, escrow_id }
}
const aadV2 = (roomId, escrowId) => concat(te.encode('trommi/v2/escrow'), Uint8Array.of(0), roomId, unhex(escrowId))

/** v2: seal the recovery code. Returns { escrow_version: 2, escrow_id, key_escrow }. */
export async function sealEscrowV2({ room_id, recovery_code, passphrase }) {
  const why = passphraseProblem(passphrase)
  if (why) throw new ZError('weak-passphrase', why)
  const { key, escrow_id } = await escrowKeyAndId(passphrase, room_id)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadV2(unhex(room_id), escrow_id) }, key, z.parseRecoveryCode(recovery_code)))
  return { escrow_version: 2, escrow_id, key_escrow: b64u(concat(Uint8Array.of(2), nonce, ct)) }
}
/** v2: open with the key from escrowKeyAndId. */
export async function openEscrowV2({ room_id, key_escrow, key, escrow_id }) {
  const b = unb64u(key_escrow)
  if (b.length !== 1 + 12 + 32 + 16 || b[0] !== 2) throw new ZError('bad-format', 'escrow blob')
  let raw
  try { raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(1, 13), additionalData: aadV2(unhex(room_id), escrow_id) }, key, b.slice(13))) }
  catch { throw new ZError('wrong-passphrase', 'this passphrase does not open the escrow') }
  return z.formatRecoveryCode(raw)
}

async function deriveKey(passphrase, salt, roomId, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: concat(salt, roomId), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const aadOf = (roomId, iterations) => concat(te.encode('trommi/v1/escrow'), Uint8Array.of(0), roomId, u32(iterations))

/** v1 (kept for tests and old blobs; new escrows use sealEscrowV2): seal the recovery code. Returns the b64u blob. */
export async function sealEscrow({ room_id, recovery_code, passphrase, iterations = ESCROW_ITERATIONS }) {
  const why = passphraseProblem(passphrase)
  if (why) throw new ZError('weak-passphrase', why)
  const roomId = unhex(room_id)
  const salt = crypto.getRandomValues(new Uint8Array(16)), nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, roomId, iterations)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadOf(roomId, iterations) }, key, z.parseRecoveryCode(recovery_code)))
  return b64u(concat(Uint8Array.of(1), u32(iterations), salt, nonce, ct))
}

/** Open the blob with the passphrase: the recovery code (text form). Wrong passphrase: ZError 'wrong-passphrase'. */
export async function openEscrow({ room_id, key_escrow, passphrase }) {
  const b = unb64u(key_escrow)
  if (b.length < 1 + 4 + 16 + 12 + 16 || b[0] !== 1) throw new ZError('bad-format', 'escrow blob')
  const iterations = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0)
  if (iterations < 1_000_000 || iterations > 50_000_000) throw new ZError('bad-format', 'escrow iterations out of range')
  const salt = b.slice(5, 21), nonce = b.slice(21, 33), ct = b.slice(33)
  const roomId = unhex(room_id)
  const key = await deriveKey(passphrase, salt, roomId, iterations)
  let raw
  try { raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadOf(roomId, iterations) }, key, ct)) }
  catch { throw new ZError('wrong-passphrase', 'this passphrase does not open the escrow') }
  return z.formatRecoveryCode(raw)
}

export { hex }
