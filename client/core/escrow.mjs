// escrow.mjs: "Mit Passwort anmelden" (optional). The room's recovery code, sealed under a key derived from the
// human's passphrase, stored on the hub (PUT/GET/DELETE /v1/rooms/:room_id/escrow, opaque to the hub). A fresh
// device with the room link and the passphrase derives the key, opens the recovery code, and adds itself as a human
// device with an entry signed by the recovery key; the other devices stay.
//
// Format, escrow_version 1 (bytes, base64url in `key_escrow`):
//   0x01 || iterations u32 || salt(16) || nonce(12) || AES-256-GCM(key, nonce, aad, recovery code (32 raw bytes))
//   key = PBKDF2-HMAC-SHA-256(passphrase NFC UTF-8, salt || room_id, iterations, 256 bits)
//   aad = "trommi/v1/escrow" 0x00 || room_id(32) || iterations u32
//
// Trade-off, plainly: whoever holds the blob (the hub, a thief of its database) can guess passphrases offline.
// PBKDF2 is not memory-hard, so GPUs guess fast; 1,000,000 iterations and the length rule (>= 14 characters and
// >= 4 words, or >= 20 characters) make a good passphrase expensive, a bad one is not saved. The paper recovery
// code stays the root: the escrow is off by default, holds nothing the code does not, and can be removed.
import * as z from './zcrypto.mjs'

const { ZError, b64u, unb64u, concat, hex, unhex } = z
export const ESCROW_VERSION = 1
export const ESCROW_ITERATIONS = 1_000_000
const te = new TextEncoder()
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b }

/** null if the passphrase is acceptable, else a reason (English, short). */
export function passphraseProblem(passphrase) {
  const p = String(passphrase ?? '').normalize('NFC')
  const words = p.trim().split(/\s+/).filter(w => w.length >= 2)
  if (p.length < 14) return 'at least 14 characters'
  if (words.length < 4 && p.length < 20) return 'at least four words, or 20 characters'
  if (new Set(p.replace(/\s/g, '')).size < 6) return 'too repetitive'
  return null
}

async function deriveKey(passphrase, salt, roomId, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: concat(salt, roomId), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const aadOf = (roomId, iterations) => concat(te.encode('trommi/v1/escrow'), Uint8Array.of(0), roomId, u32(iterations))

/** Seal the recovery code (text form) under the passphrase. Returns the b64u blob. */
export async function sealEscrow({ room_id, recovery_code, passphrase, iterations = ESCROW_ITERATIONS }) {
  const why = passphraseProblem(passphrase)
  if (why) throw new ZError('weak-passphrase', why)
  const roomId = unhex(room_id)
  const salt = crypto.getRandomValues(new Uint8Array(16)), nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, roomId, iterations)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadOf(roomId, iterations) }, key, z.parseRecoveryCode(recovery_code)))
  return b64u(concat(Uint8Array.of(ESCROW_VERSION), u32(iterations), salt, nonce, ct))
}

/** Open the blob with the passphrase: the recovery code (text form). Wrong passphrase: ZError 'wrong-passphrase'. */
export async function openEscrow({ room_id, key_escrow, passphrase }) {
  const b = unb64u(key_escrow)
  if (b.length < 1 + 4 + 16 + 12 + 16 || b[0] !== ESCROW_VERSION) throw new ZError('bad-format', 'escrow blob')
  const iterations = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0)
  if (iterations < 100_000 || iterations > 50_000_000) throw new ZError('bad-format', 'escrow iterations out of range')
  const salt = b.slice(5, 21), nonce = b.slice(21, 33), ct = b.slice(33)
  const roomId = unhex(room_id)
  const key = await deriveKey(passphrase, salt, roomId, iterations)
  let raw
  try { raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadOf(roomId, iterations) }, key, ct)) }
  catch { throw new ZError('wrong-passphrase', 'this passphrase does not open the escrow') }
  return z.formatRecoveryCode(raw)
}

export { hex }
