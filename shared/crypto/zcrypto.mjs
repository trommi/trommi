// zcrypto.mjs: the cryptographic core of Trommi, as one dependency-free ES module.
//
// Uses only WebCrypto (globalThis.crypto.subtle): Ed25519, X25519, AES-256-GCM, HKDF-SHA-256,
// HMAC-SHA-256, SHA-256. The same file runs in Node 22+ and in browsers (secure context).
// No primitive is implemented here; if the runtime lacks one, requireRuntime() says which.
//
// The wire formats, labels and key schedule are specified in FORMAT.md. Keep both in step.
// Used by hub/, shared/ and the channel. Not audited.

const subtle = globalThis.crypto?.subtle
const te = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF in the output, so it is seen and refused instead of silently dropped (C19).
const tdStrict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const VERSION = 1

// ---- errors --------------------------------------------------------------------

/** Every rejection carries a stable machine-readable code. */
export class ZError extends Error {
  constructor(code, message, extra) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'ZError'
    this.code = code
    if (extra) Object.assign(this, extra)
  }
}
const fail = (code, message, extra) => { throw new ZError(code, message, extra) }

// ---- bytes ---------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_REV = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i

/** base64url without padding (RFC 4648 section 5). */
export function b64u(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16
    out += B64[n >> 18] + B64[(n >> 12) & 63]
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

/** Strict decoder: no padding, no foreign characters, no non-zero trailing bits. */
export function unb64u(str) {
  if (typeof str !== 'string') fail('bad-format', 'base64url: not a string')
  const rem = str.length % 4
  if (rem === 1) fail('bad-format', 'base64url: impossible length')
  const out = new Uint8Array(Math.floor(str.length * 3 / 4))
  let acc = 0, bits = 0, o = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const v = c < 128 ? B64_REV[c] : -1
    if (v < 0) fail('bad-format', 'base64url: foreign character')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) fail('bad-format', 'base64url: non-canonical tail')
  return out
}

export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
export function unhex(str) {
  if (typeof str !== 'string' || str.length % 2 || /[^0-9a-f]/.test(str)) fail('bad-format', 'hex')
  const out = new Uint8Array(str.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16)
  return out
}
export const utf8 = s => te.encode(s)

export function concat(...parts) {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Equality without an early exit. Used on hashes and public values; MACs go through subtle.verify. */
export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}
function compareBytes(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}
const isZero = b => { let d = 0; for (const x of b) d |= x; return d === 0 }
const ZERO32 = new Uint8Array(32)
const ZERO16 = new Uint8Array(16)
const EMPTY = new Uint8Array(0)

function need(bytes, n, what) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== n) fail('bad-argument', `${what} must be ${n} bytes`)
  return bytes
}
function needInt(v, max, what) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('bad-argument', `${what} out of range`)
  return v
}

// Canonical encoding: fixed field order, big-endian integers, length-prefixed byte strings.
// There is exactly one encoding of a value, and decoders reject everything else.
class W {
  constructor() { this.parts = [] }
  u8(v) { this.parts.push(Uint8Array.of(needInt(v, 0xff, 'u8'))); return this }
  u16(v) { needInt(v, 0xffff, 'u16'); this.parts.push(Uint8Array.of(v >> 8, v & 0xff)); return this }
  u32(v) { needInt(v, 0xffffffff, 'u32'); this.parts.push(Uint8Array.of(v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)); return this }
  u64(v) {
    needInt(v, Number.MAX_SAFE_INTEGER, 'u64')
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt(v))
    this.parts.push(b)
    return this
  }
  raw(b, n, what = 'field') { if (n != null) need(b, n, what); this.parts.push(b); return this }
  var16(b) { this.u16(b.length); this.parts.push(b); return this }
  var32(b) { this.u32(b.length); this.parts.push(b); return this }
  done() { return concat(...this.parts) }
}
class R {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) fail('bad-format', 'not bytes')
    this.b = bytes
    this.o = 0
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  left() { return this.b.length - this.o }
  want(n) { if (this.left() < n) fail('bad-format', 'truncated') }
  u8() { this.want(1); return this.b[this.o++] }
  u16() { this.want(2); const v = this.v.getUint16(this.o); this.o += 2; return v }
  u32() { this.want(4); const v = this.v.getUint32(this.o); this.o += 4; return v }
  u64() {
    this.want(8)
    const v = this.v.getBigUint64(this.o)
    this.o += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('bad-format', 'integer above 2^53-1')
    return Number(v)
  }
  take(n) { this.want(n); const out = this.b.slice(this.o, this.o + n); this.o += n; return out }
  var16() { return this.take(this.u16()) }
  var32() { return this.take(this.u32()) }
  str16(max) {
    const raw = this.var16()
    if (raw.length > max) fail('bad-format', 'string too long')
    let out
    try { out = tdStrict.decode(raw) } catch { fail('bad-format', 'string is not UTF-8') }
    if (out.charCodeAt(0) === 0xfeff) fail('bad-format', 'a string starts with a byte order mark')
    return out
  }
  end() { if (this.left() !== 0) fail('bad-format', 'trailing bytes') }
}
function str16(w, s, max) {
  if (typeof s !== 'string') fail('bad-argument', 'string expected')
  const raw = te.encode(s)
  if (raw.length > max) fail('bad-argument', 'string too long')
  if (s.charCodeAt(0) === 0xfeff) fail('bad-argument', 'a string starts with a byte order mark')
  // Round trip, so that lone surrogates (which TextEncoder silently replaces) are refused.
  if (tdStrict.decode(raw) !== s) fail('bad-argument', 'string is not well-formed')
  return w.var16(raw)
}

// ---- object types, labels ------------------------------------------------------

/** Second byte of every top-level object, after the version byte. */
export const OBJ = Object.freeze({
  LOG_ENTRY: 0x01, ENVELOPE: 0x02, ENVELOPE_PRUNED: 0x03, SEALED: 0x04, INVITE_OFFER: 0x05, INVITE_REQUEST: 0x06,
  INVITE_REVEAL: 0x07, BACK_LINK: 0x08, ASSET: 0x09, ASSET_WRAP: 0x0a, DEVICE_PUBLIC: 0x0b, DEVICE_SECRET: 0x0c, HUB_AUTH: 0x0d,
})

/** Every domain-separation label. A label is used as utf8(label) || 0x00 in front of the data. */
export const LABEL = Object.freeze({
  deviceId: 'trommi/v1/device-id',
  logEntry: 'trommi/v1/log-entry',          // hash of an entry; the room id is this hash of the genesis entry
  logSig: 'trommi/v1/log-sig',
  sealedBox: 'trommi/v1/sealed-box',
  epochWrap: 'trommi/v1/epoch-wrap',        // associated data of a wrapped epoch secret
  keyCommit: 'trommi/v1/epoch-commit/key',
  histCommit: 'trommi/v1/epoch-commit/hist',
  backLink: 'trommi/v1/back-link',
  senderKey: 'trommi/v1/sender-key',
  envelope: 'trommi/v1/envelope',           // hash of an envelope
  envelopeSig: 'trommi/v1/envelope-sig',
  inviteId: 'trommi/v1/invite-id',
  inviteMac: 'trommi/v1/invite-mac',
  inviteCommit: 'trommi/v1/invite-commit',
  inviteOffer: 'trommi/v1/invite-offer',
  inviteOfferSig: 'trommi/v1/invite-offer-sig',
  inviteRequest: 'trommi/v1/invite-request',
  inviteRequestSig: 'trommi/v1/invite-request-sig',
  inviteRevealSig: 'trommi/v1/invite-reveal-sig',
  inviteCode: 'trommi/v1/invite-code',
  assetWrap: 'trommi/v1/asset-wrap',
  recoverySign: 'trommi/v1/recovery/sign',
  recoveryKex: 'trommi/v1/recovery/kex',
  hubAuth: 'trommi/v1/hub-auth',
  objectId: 'trommi/v1/object-id',
})
const labelBytes = label => concat(te.encode(label), Uint8Array.of(0))

// ---- primitives (all WebCrypto) ------------------------------------------------

const defaultRng = n => globalThis.crypto.getRandomValues(new Uint8Array(n))
const rngOf = opts => opts?._rng ?? defaultRng   // _rng is test-only: it makes outputs deterministic

/** Probe the runtime. Returns { ok, missing: [...] }; never falls back to JavaScript primitives. */
export async function requireRuntime() {
  const missing = []
  if (!subtle) return { ok: false, missing: ['crypto.subtle (needs a secure context: https, localhost or file)'] }
  const probe = async (name, fn) => { try { await fn() } catch { missing.push(name) } }
  await probe('Ed25519', () => subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']))
  await probe('X25519', () => subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']))
  await probe('AES-GCM', () => subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
  await probe('HKDF', () => subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']))
  await probe('HMAC', () => subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))
  return { ok: missing.length === 0, missing }
}

export async function sha256(...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)))
}
/** SHA-256(utf8(label) || 0x00 || parts...) */
export async function hash(label, ...parts) {
  return sha256(labelBytes(label), ...parts)
}
/** HKDF-SHA-256 with info = utf8(label) || 0x00 || context. */
export async function hkdf(ikm, salt, label, context, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const info = concat(labelBytes(label), context ?? EMPTY)
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt ?? EMPTY, info }, key, length * 8))
}
async function aesKey(raw) {
  return subtle.importKey('raw', need(raw, 32, 'AES key'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
async function gcmSeal(key, nonce, aad, plaintext) {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext))
}
async function gcmOpen(key, nonce, aad, ciphertext) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, ciphertext))
  } catch {
    fail('decrypt-failed', 'authentication tag does not match')
  }
}

// PKCS#8 wrapping of a 32-byte private key (RFC 8410). This is key encoding, not a primitive:
// WebCrypto has no raw import for private Ed25519 and X25519 keys.
const PKCS8_ED25519 = unhex('302e020100300506032b657004220420')
const PKCS8_X25519 = unhex('302e020100300506032b656e04220420')

async function importPrivate(alg, seed, extractable) {
  need(seed, 32, 'private key seed')
  const pkcs8 = concat(alg === 'Ed25519' ? PKCS8_ED25519 : PKCS8_X25519, seed)
  const usages = alg === 'Ed25519' ? ['sign'] : ['deriveBits']
  // The public half is read from the JWK export; that needs an extractable import first.
  const open = await subtle.importKey('pkcs8', pkcs8, { name: alg }, true, usages)
  const pub = unb64u((await subtle.exportKey('jwk', open)).x)
  const priv = extractable ? open : await subtle.importKey('pkcs8', pkcs8, { name: alg }, false, usages)
  return { priv, pub }
}
async function exportSeed(key) {
  let pkcs8
  try { pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', key)) } catch { fail('not-extractable', 'this device key cannot be exported') }
  return pkcs8.slice(pkcs8.length - 32)
}

const verifyKeys = new Map()
async function verifyKey(pub) {
  const k = b64u(pub)
  let key = verifyKeys.get(k)
  if (!key) {
    key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
    if (verifyKeys.size > 512) verifyKeys.clear()
    verifyKeys.set(k, key)
  }
  return key
}

// ---- device identity -----------------------------------------------------------

export const ROLE = Object.freeze({ HUMAN: 1, AGENT: 2 })

export async function deviceId(signPub, kexPub) {
  return hash(LABEL.deviceId, need(signPub, 32, 'signPub'), need(kexPub, 32, 'kexPub'))
}

/** A device: { id, signPub, kexPub, signKey, kexKey }. Private keys are non-extractable CryptoKeys by default. */
export async function generateDevice({ extractable = false } = {}) {
  const sign = await subtle.generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify'])
  const kex = await subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits'])
  const signPub = new Uint8Array(await subtle.exportKey('raw', sign.publicKey))
  const kexPub = new Uint8Array(await subtle.exportKey('raw', kex.publicKey))
  return { id: await deviceId(signPub, kexPub), signPub, kexPub, signKey: sign.privateKey, kexKey: kex.privateKey }
}

/** Deterministic device from two 32-byte seeds. Used for the recovery key, key files and test vectors. */
export async function deviceFromSeeds(signSeed, kexSeed, { extractable = false } = {}) {
  const sign = await importPrivate('Ed25519', signSeed, extractable)
  const kex = await importPrivate('X25519', kexSeed, extractable)
  return { id: await deviceId(sign.pub, kex.pub), signPub: sign.pub, kexPub: kex.pub, signKey: sign.priv, kexKey: kex.priv }
}

export const publicDevice = d => ({ id: d.id, signPub: d.signPub, kexPub: d.kexPub })

/** 0x01 0x0b signPub(32) kexPub(32) */
export function encodeDevicePublic(d) {
  return new W().u8(VERSION).u8(OBJ.DEVICE_PUBLIC).raw(d.signPub, 32, 'signPub').raw(d.kexPub, 32, 'kexPub').done()
}
export async function decodeDevicePublic(bytes) {
  const r = new R(bytes)
  header(r, OBJ.DEVICE_PUBLIC)
  const signPub = r.take(32), kexPub = r.take(32)
  r.end()
  return { id: await deviceId(signPub, kexPub), signPub, kexPub }
}

/** 0x01 0x0c signSeed(32) kexSeed(32): for an agent's key file (mode 0600). Needs an extractable device. */
export async function exportDeviceSecret(d) {
  return new W().u8(VERSION).u8(OBJ.DEVICE_SECRET).raw(await exportSeed(d.signKey)).raw(await exportSeed(d.kexKey)).done()
}
export async function importDeviceSecret(bytes, opts) {
  const r = new R(bytes)
  header(r, OBJ.DEVICE_SECRET)
  const signSeed = r.take(32), kexSeed = r.take(32)
  r.end()
  return deviceFromSeeds(signSeed, kexSeed, opts)
}

function header(r, type) {
  const v = r.u8()
  if (v !== VERSION) fail('bad-version', `version ${v} is not supported`)
  const t = r.u8()
  if (t !== type) fail('bad-format', `object type ${t}, expected ${type}`)
}

/** Ed25519 over utf8(label) || 0x00 || message. Returns 64 bytes. */
export async function sign(device, label, message) {
  return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, device.signKey, concat(labelBytes(label), message)))
}
export async function verify(signPub, label, message, signature) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64 || signPub?.length !== 32) return false
  try {
    return await subtle.verify({ name: 'Ed25519' }, await verifyKey(signPub), signature, concat(labelBytes(label), message))
  } catch {
    return false
  }
}

// ---- sealed box: ZSEAL1 = X25519 + HKDF-SHA-256 + AES-256-GCM ------------------
//
// HPKE-style (the pattern of RFC 9180 base mode), not wire-compatible with RFC 9180.
// It gives confidentiality to the holder of the recipient key and nothing about the sender:
// anyone can seal. Authenticity must come from elsewhere (here: key commitments in the signed log).

async function x25519(priv, pub) {
  let shared
  try {
    const pubKey = await subtle.importKey('raw', need(pub, 32, 'X25519 public key'), { name: 'X25519' }, false, [])
    shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pubKey }, priv, 256))
  } catch (e) {
    if (e instanceof ZError) throw e
    fail('bad-key', 'X25519 failed (invalid or small-order public key)')
  }
  if (isZero(shared)) fail('bad-key', 'X25519 gave the all-zero secret')
  return shared
}
async function sealKeys(shared, ephPub, recipientPub) {
  const okm = await hkdf(shared, concat(ephPub, recipientPub), LABEL.sealedBox, EMPTY, 44)
  return { key: await aesKey(okm.slice(0, 32)), nonce: okm.slice(32) }
}

/** 0x01 0x04 ephemeralPub(32) ciphertext+tag. `aad` is bound but not transmitted. */
export async function seal(recipientKexPub, plaintext, aad = EMPTY, opts) {
  let ephPriv, ephPub
  if (opts?._rng) {
    ({ priv: ephPriv, pub: ephPub } = await importPrivate('X25519', opts._rng(32), false))
  } else {
    const pair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    ephPriv = pair.privateKey
    ephPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  }
  const shared = await x25519(ephPriv, recipientKexPub)
  const { key, nonce } = await sealKeys(shared, ephPub, recipientKexPub)
  return concat(Uint8Array.of(VERSION, OBJ.SEALED), ephPub, await gcmSeal(key, nonce, aad, plaintext))
}

export async function openSealed(device, sealed, aad = EMPTY) {
  const r = new R(sealed)
  header(r, OBJ.SEALED)
  const ephPub = r.take(32)
  const ct = r.take(r.left())
  if (ct.length < 16) fail('bad-format', 'sealed box too short')
  const shared = await x25519(device.kexKey, ephPub)
  const { key, nonce } = await sealKeys(shared, ephPub, device.kexPub)
  return gcmOpen(key, nonce, aad, ct)
}

// ---- membership log ------------------------------------------------------------

// Type 4 was a rotation on a schedule. It is retired: the room key changes only when someone is removed
// (remove, recover), so an entry of type 4 is refused like any unknown type.
export const ENTRY = Object.freeze({ GENESIS: 1, ADD: 2, REMOVE: 3, RECOVER: 5 })
export const SIGNER = Object.freeze({ DEVICE: 1, RECOVERY: 2 })
// v1.1 (R8): a member carries no name. Names are encrypted registers (`device/<device_id>`).
function writeMember(w, m) {
  if (m.role !== ROLE.HUMAN && m.role !== ROLE.AGENT) fail('bad-argument', 'role')
  w.u8(m.role).raw(m.signPub, 32, 'signPub').raw(m.kexPub, 32, 'kexPub')
}
function readMember(r) {
  const role = r.u8()
  if (role !== ROLE.HUMAN && role !== ROLE.AGENT) fail('bad-format', 'unknown role')
  return { role, signPub: r.take(32), kexPub: r.take(32), name: '' }
}
/**
 * The removed devices of a remove or recover entry, each with its cut (R3): the sender sequence and envelope
 * hash of its last envelope the remover had seen (0 and zeros: none). Ascending by id, no duplicates.
 */
function writeRemoved(w, ids, cuts) {
  const sorted = [...ids].sort(compareBytes)
  for (let i = 1; i < sorted.length; i++) if (compareBytes(sorted[i - 1], sorted[i]) === 0) fail('bad-argument', 'duplicate id')
  w.u16(sorted.length)
  const cutOf = id => (cuts instanceof Map ? cuts.get(hex(id)) : cuts?.[hex(id)]) ?? { seq: 0, hash: ZERO32 }
  for (const id of sorted) { const c = cutOf(id); w.raw(id, 32, 'id').u64(c.seq).raw(c.hash, 32, 'cut hash') }
}
function readRemoved(r) {
  const n = r.u16()
  const out = []
  for (let i = 0; i < n; i++) {
    const x = { id: r.take(32), seq: r.u64(), hash: r.take(32) }
    if (i && compareBytes(out[i - 1].id, x.id) >= 0) fail('bad-format', 'ids not strictly ascending')
    if (x.seq === 0 && !isZero(x.hash)) fail('bad-format', 'a cut without an envelope has a zero hash')
    out.push(x)
  }
  return out
}

function encodeEntryBody(e) {
  const w = new W().u8(VERSION).u8(OBJ.LOG_ENTRY).u8(e.type).u32(e.seq).raw(e.prev, 32, 'prev').u64(e.time).u8(e.signerKind).raw(e.signer, 32, 'signer')
  const epoch = () => w.u32(e.epoch).raw(e.keyCommit, 32, 'keyCommit').raw(e.histCommit, 32, 'histCommit')
  switch (e.type) {
    case ENTRY.GENESIS:
      w.raw(e.roomNonce, 16, 'roomNonce'); writeMember(w, e.member)
      w.raw(e.recovery.signPub, 32, 'recovery signPub').raw(e.recovery.kexPub, 32, 'recovery kexPub'); epoch(); break
    case ENTRY.ADD: writeMember(w, e.member); w.raw(e.inviteId, 16, 'inviteId'); break
    case ENTRY.REMOVE: writeRemoved(w, e.ids, e.cuts); epoch(); break
    case ENTRY.RECOVER:
      writeMember(w, e.member); writeRemoved(w, e.ids, e.cuts); epoch()
      w.raw(e.recovery.signPub, 32, 'recovery signPub').raw(e.recovery.kexPub, 32, 'recovery kexPub'); break
    default: fail('bad-argument', 'entry type')
  }
  return w.done()
}

/** Parse an entry without judging it. Wire form: body || signature(64). */
export function decodeEntry(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) fail('bad-format', 'entry too short')
  const body = bytes.slice(0, bytes.length - 64)
  const signature = bytes.slice(bytes.length - 64)
  const r = new R(body)
  header(r, OBJ.LOG_ENTRY)
  const e = { type: r.u8(), seq: r.u32(), prev: r.take(32), time: r.u64(), signerKind: r.u8(), signer: r.take(32) }
  const epoch = () => { e.epoch = r.u32(); e.keyCommit = r.take(32); e.histCommit = r.take(32) }
  const recovery = () => { e.recovery = { signPub: r.take(32), kexPub: r.take(32) } }
  switch (e.type) {
    case ENTRY.GENESIS: e.roomNonce = r.take(16); e.member = readMember(r); recovery(); epoch(); break
    case ENTRY.ADD: e.member = readMember(r); e.inviteId = r.take(16); break
    case ENTRY.REMOVE: e.removed = readRemoved(r); e.ids = e.removed.map(x => x.id); epoch(); break
    case ENTRY.RECOVER: e.member = readMember(r); e.removed = readRemoved(r); e.ids = e.removed.map(x => x.id); epoch(); recovery(); break
    default: fail('bad-format', 'unknown entry type')
  }
  r.end()
  if (e.signerKind !== SIGNER.DEVICE && e.signerKind !== SIGNER.RECOVERY) fail('bad-format', 'unknown signer kind')
  return { ...e, body, signature }
}

async function signEntry(fields, signer) {
  const body = encodeEntryBody(fields)
  return concat(body, await sign(signer, LABEL.logSig, body))
}

const idKey = b64u
/** C24: X25519 ignores bit 255, so two encodings that differ there are one key; compare with that bit cleared. */
const kexCanon = k => { const c = k.slice(); c[31] &= 0x7f; return c }
const sameKex = (a, b) => bytesEqual(kexCanon(a), kexCanon(b))
/** Two key sets that share a signing key or (canonically) a key-exchange key. */
const keysClash = (a, b) => bytesEqual(a.signPub, b.signPub) || sameKex(a.kexPub, b.kexPub)

function cloneState(s) {
  return {
    ...s,
    members: new Map([...s.members].map(([k, m]) => [k, { ...m }])),
    epochs: new Map(s.epochs),
    hashes: [...s.hashes],
    entries: [...s.entries],
    recovery: { ...s.recovery },
    inviteIds: new Set(s.inviteIds),
  }
}

/**
 * Verify one entry against the state before it and return the state after it. Never mutates.
 * `state` is null for the genesis entry. A state is trusted only as far as its room id is:
 * compare state.roomId with the id from the invite link, or use verifyLog(entries, roomId).
 */
export async function applyEntry(state, entryBytes) {
  const e = decodeEntry(entryBytes)
  const entryHash = await hash(LABEL.logEntry, e.body)
  const bad = (why) => fail('bad-entry', `entry ${e.seq}: ${why}`)
  const checkSig = async (pub) => { if (!await verify(pub, LABEL.logSig, e.body, e.signature)) fail('bad-signature', `entry ${e.seq}`) }

  if (!state) {
    if (e.type !== ENTRY.GENESIS) bad('a log starts with a genesis entry')
    if (e.seq !== 0 || !isZero(e.prev)) bad('genesis must have number 0 and no predecessor')
    if (e.signerKind !== SIGNER.DEVICE || e.member.role !== ROLE.HUMAN) bad('genesis must be signed by a human device')
    const id = await deviceId(e.member.signPub, e.member.kexPub)
    if (!bytesEqual(id, e.signer)) bad('signer is not the founding device')
    if (e.epoch !== 1) bad('the first epoch is 1')
    await checkSig(e.member.signPub)
    const recovery = { ...e.recovery, id: await deviceId(e.recovery.signPub, e.recovery.kexPub) }
    if (bytesEqual(recovery.id, id) || keysClash(recovery, e.member)) bad('recovery key equals the device key')
    return {
      roomId: entryHash,
      head: { seq: 0, hash: entryHash },
      hashes: [entryHash],
      entries: [e],
      members: new Map([[idKey(id), { id, ...e.member, addedSeq: 0, removedSeq: null }]]),
      epoch: 1,
      epochs: new Map([[1, { seq: 0, keyCommit: e.keyCommit, histCommit: e.histCommit }]]),
      recovery,
      inviteIds: new Set(),
      lastRecoverSeq: -1,
    }
  }

  if (e.type === ENTRY.GENESIS) bad('a second genesis entry')
  if (e.seq !== state.head.seq + 1) bad(`number ${e.seq} does not follow ${state.head.seq}`)
  if (!bytesEqual(e.prev, state.head.hash)) bad('predecessor hash does not match')

  // Who may sign: ANY active human device (add, remove; there is no main device) or the recovery key: a
  // recovery, or (v1.1, passphrase sign-in) the add of one human device without an invite.
  if (e.type === ENTRY.RECOVER) {
    if (e.signerKind !== SIGNER.RECOVERY || !bytesEqual(e.signer, state.recovery.id)) bad('only the recovery key may sign a recovery')
    await checkSig(state.recovery.signPub)
  } else if (e.signerKind === SIGNER.RECOVERY) {
    if (e.type !== ENTRY.ADD || e.member.role !== ROLE.HUMAN || !isZero(e.inviteId)) bad('the recovery key signs recoveries and the add of a human device without an invite only')
    if (!bytesEqual(e.signer, state.recovery.id)) bad('not the recovery key of this room')
    await checkSig(state.recovery.signPub)
  } else {
    if (e.signerKind !== SIGNER.DEVICE) bad('the recovery key signs recovery entries only')
    const m = state.members.get(idKey(e.signer))
    if (!m || m.removedSeq !== null) bad('signer is not a member')
    if (m.role !== ROLE.HUMAN) bad('agents may not change the membership')
    await checkSig(m.signPub)
  }

  const next = cloneState(state)
  const addMember = async (member) => {
    const id = await deviceId(member.signPub, member.kexPub)
    if (next.members.has(idKey(id))) bad('this device was already a member (removed devices cannot return)')
    if (bytesEqual(id, state.recovery.id) || keysClash(state.recovery, member)) bad('the recovery key cannot be a member')
    for (const m of next.members.values()) {
      if (keysClash(m, member)) bad('key already in use by another member')
    }
    next.members.set(idKey(id), { id, ...member, addedSeq: e.seq, removedSeq: null })
  }
  const removeMembers = (removed) => {
    for (const x of removed) {
      const m = next.members.get(idKey(x.id))
      if (!m || m.removedSeq !== null) bad('removing someone who is not a member')
      m.removedSeq = e.seq
      m.cut = { seq: x.seq, hash: x.hash }
    }
  }
  const newEpoch = () => {
    if (e.epoch !== state.epoch + 1) bad(`epoch ${e.epoch} does not follow ${state.epoch}`)
    next.epoch = e.epoch
    next.epochs.set(e.epoch, { seq: e.seq, keyCommit: e.keyCommit, histCommit: e.histCommit })
  }
  switch (e.type) {
    case ENTRY.ADD:
      await addMember(e.member)
      if (!isZero(e.inviteId)) {
        if (next.inviteIds.has(idKey(e.inviteId))) bad('this invite already produced a member')
        next.inviteIds.add(idKey(e.inviteId))
      }
      break
    case ENTRY.REMOVE:
      if (e.ids.length === 0) bad('nothing to remove')
      removeMembers(e.removed); newEpoch(); break
    case ENTRY.RECOVER: {
      if (e.member.role !== ROLE.HUMAN) bad('recovery enrols a human device')
      // Recovery removes the human's devices, all of them, and may remove agents too (v1.1, R6: those a thief added).
      const humans = activeMembers(state).filter(m => m.role === ROLE.HUMAN)
      if (!humans.every(m => e.ids.some(id => bytesEqual(id, m.id)))) bad('a recovery removes every human device')
      removeMembers(e.removed)
      await addMember(e.member)
      newEpoch()
      const id = await deviceId(e.recovery.signPub, e.recovery.kexPub)
      if (bytesEqual(id, state.recovery.id)) bad('recovery must install a new recovery key')
      if (next.members.has(idKey(id)) || [...next.members.values()].some(m => keysClash(m, e.recovery))) bad('recovery key equals a device key')
      next.recovery = { ...e.recovery, id }
      next.lastRecoverSeq = e.seq
      break
    }
  }
  next.head = { seq: e.seq, hash: entryHash }
  next.hashes.push(entryHash)
  next.entries.push(e)
  return next
}

/** Verify a whole log. `roomId` (from the invite link or from local storage) is what makes it trustworthy. */
export async function verifyLog(entries, roomId) {
  if (!Array.isArray(entries) || entries.length === 0) fail('bad-entry', 'empty log')
  let state = null
  for (const bytes of entries) state = await applyEntry(state, bytes)
  if (roomId && !bytesEqual(state.roomId, roomId)) fail('wrong-room', 'the genesis entry does not hash to this room id')
  return state
}

/** What a device stores to refuse rollbacks and forks: the head, all entry hashes, the last recovery. */
export const pinOf = state => ({ seq: state.head.seq, hash: state.head.hash, hashes: [...state.hashes], lastRecoverSeq: state.lastRecoverSeq })

/**
 * Compare a freshly verified log with the pinned one.
 * Returns { status: 'same' | 'extended' } or { status: 'recovery-override', forkSeq }, or throws
 * 'log-rollback' / 'log-fork'. A recovery override must be shown to the user, never applied silently.
 */
export function checkLogAgainstPin(state, pin) {
  if (!pin) return { status: 'extended' }
  const hashes = pin.hashes ?? null
  const n = Math.min(state.hashes.length, pin.seq + 1)
  let fork = -1
  if (hashes) {
    for (let i = 0; i < n; i++) if (!bytesEqual(state.hashes[i], hashes[i])) { fork = i; break }
  } else if (state.head.seq >= pin.seq && !bytesEqual(state.hashes[pin.seq], pin.hash)) {
    fork = pin.seq // the true fork point is unknown without the pinned hashes
  }
  if (fork < 0) {
    if (state.head.seq < pin.seq) fail('log-rollback', `the log ends at ${state.head.seq}, this device already saw ${pin.seq}`)
    return { status: state.head.seq === pin.seq ? 'same' : 'extended' }
  }
  // "An entry of the recovery key beats any entry of a device": only where the two logs part,
  // and only if the pinned branch holds no recovery at or after that point.
  const e = state.entries[fork]
  if (hashes && e.type === ENTRY.RECOVER && fork > (pin.lastRecoverSeq ?? -1)) return { status: 'recovery-override', forkSeq: fork }
  fail('log-fork', `entry ${fork} differs from the one this device already accepted`, { forkSeq: fork })
}

export function activeMembers(state) {
  return [...state.members.values()].filter(m => m.removedSeq === null)
}
/** The member with this id if it was active once entry `logSeq` had been applied, else null. */
export function memberAt(state, id, logSeq = state.head.seq) {
  const m = state.members.get(idKey(id))
  if (!m || m.addedSeq > logSeq || (m.removedSeq !== null && m.removedSeq <= logSeq)) return null
  return m
}
export function epochAt(state, logSeq = state.head.seq) {
  let best = 0
  for (const [epoch, info] of state.epochs) if (info.seq <= logSeq && epoch > best) best = epoch
  return best
}

// ---- room key epochs -----------------------------------------------------------
//
// An epoch secret is { epoch, key, hist }. `key` (32 bytes) is THE room key: everyone gets it.
// `hist` (32 bytes) only goes to human devices and the recovery key; it opens the back link to the
// previous epoch. Agents hold `key` only (hist: null) and therefore cannot walk back in history.

export function newEpochSecret(epoch, opts) {
  const rng = rngOf(opts)
  return { epoch: needInt(epoch, 0xffffffff, 'epoch'), key: rng(32), hist: rng(32) }
}
const epochCtx = epoch => new W().u32(epoch).done()
export async function epochCommits(secret) {
  return {
    keyCommit: await hkdf(secret.key, EMPTY, LABEL.keyCommit, epochCtx(secret.epoch), 32),
    histCommit: secret.hist ? await hkdf(secret.hist, EMPTY, LABEL.histCommit, epochCtx(secret.epoch), 32) : null,
  }
}
async function checkCommits(state, secret) {
  const info = state.epochs.get(secret.epoch)
  if (!info) fail('wrong-epoch', `the log knows no epoch ${secret.epoch}`)
  const c = await epochCommits(secret)
  if (!bytesEqual(c.keyCommit, info.keyCommit)) fail('key-mismatch', 'room key does not match the commitment in the log')
  if (secret.hist && !bytesEqual(c.histCommit, info.histCommit)) fail('key-mismatch', 'history key does not match the commitment in the log')
}

const wrapAad = (roomId, epoch, recipientId) => concat(labelBytes(LABEL.epochWrap), roomId, epochCtx(epoch), recipientId)

/** Seal an epoch secret (room key and history key) to one active human device or to the recovery key. Agents hold no room key (R6). */
export async function wrapEpochKey(state, secret, recipientId, opts) {
  let kexPub, withHist
  if (bytesEqual(recipientId, state.recovery.id)) {
    kexPub = state.recovery.kexPub; withHist = true
  } else {
    const m = memberAt(state, recipientId)
    if (!m) fail('not-member', 'cannot wrap a key for someone who is not a member')
    if (m.role !== ROLE.HUMAN) fail('bad-argument', 'agents hold no room key: they get session keys')
    kexPub = m.kexPub; withHist = true
  }
  if (withHist && !secret.hist) fail('bad-argument', 'no history key to pass on')
  const plain = withHist ? concat(Uint8Array.of(2), secret.key, secret.hist) : concat(Uint8Array.of(1), secret.key)
  return seal(kexPub, plain, wrapAad(state.roomId, secret.epoch, recipientId), opts)
}

/** Open a wrapped epoch secret and check it against the commitments in the verified log. */
export async function unwrapEpochKey(state, device, sealed, epoch) {
  const plain = await openSealed(device, sealed, wrapAad(state.roomId, epoch, device.id))
  let secret
  if (plain.length === 33 && plain[0] === 1) secret = { epoch, key: plain.slice(1), hist: null }
  else if (plain.length === 65 && plain[0] === 2) secret = { epoch, key: plain.slice(1, 33), hist: plain.slice(33) }
  else fail('bad-format', 'wrapped epoch secret')
  await checkCommits(state, secret)
  return secret
}

/** One wrap per active human device and one for the recovery key: [{ id, sealed }]. */
export async function wrapForAll(state, secret, opts) {
  const out = []
  for (const m of activeMembers(state).filter(x => x.role === ROLE.HUMAN)) out.push({ id: m.id, sealed: await wrapEpochKey(state, secret, m.id, opts) })
  out.push({ id: state.recovery.id, sealed: await wrapEpochKey(state, secret, state.recovery.id, opts) })
  return out
}

async function backLinkKeys(roomId, secret) {
  if (!secret.hist) fail('no-key', 'agents hold no history key')
  const okm = await hkdf(secret.hist, roomId, LABEL.backLink, epochCtx(secret.epoch), 44)
  return { key: await aesKey(okm.slice(0, 32)), nonce: okm.slice(32) }
}
const backLinkAad = (roomId, epoch) => concat(Uint8Array.of(VERSION, OBJ.BACK_LINK), roomId, epochCtx(epoch))

/** 0x01 0x08 epoch(u32) ciphertext: the previous epoch secret, encrypted under the new history key. */
export async function makeBackLink(roomId, secret, previous) {
  if (previous.epoch !== secret.epoch - 1 || !previous.hist) fail('bad-argument', 'back link needs the full previous epoch')
  const { key, nonce } = await backLinkKeys(roomId, secret)
  const ct = await gcmSeal(key, nonce, backLinkAad(roomId, secret.epoch), concat(previous.key, previous.hist))
  return concat(Uint8Array.of(VERSION, OBJ.BACK_LINK), epochCtx(secret.epoch), ct)
}
export async function openBackLink(state, secret, link) {
  const r = new R(link)
  header(r, OBJ.BACK_LINK)
  if (r.u32() !== secret.epoch) fail('wrong-epoch', 'back link belongs to another epoch')
  const { key, nonce } = await backLinkKeys(state.roomId, secret)
  const plain = await gcmOpen(key, nonce, backLinkAad(state.roomId, secret.epoch), r.take(r.left()))
  if (plain.length !== 64) fail('bad-format', 'back link')
  const previous = { epoch: secret.epoch - 1, key: plain.slice(0, 32), hist: plain.slice(32) }
  await checkCommits(state, previous)
  return previous
}

// ---- building log entries ------------------------------------------------------

const base = (state, type, signer, signerKind, time) => ({
  type, seq: state.head.seq + 1, prev: state.head.hash, time: time ?? Date.now(), signerKind, signer: signer.id,
})

/**
 * Found a room. Returns { entry, state, roomId, secret, wraps }.
 * `recovery` is the public half of the recovery key (see recoveryDevice).
 */
export async function createRoom({ device, recovery, time, _rng }) {
  if (recovery?.signPub?.length !== 32 || recovery?.kexPub?.length !== 32) fail('recovery-required', 'a room cannot be founded without a recovery code')
  const rng = rngOf({ _rng })
  const roomNonce = rng(16)
  const secret = newEpochSecret(1, { _rng })
  const entry = await signEntry({
    type: ENTRY.GENESIS, seq: 0, prev: ZERO32, time: time ?? Date.now(), signerKind: SIGNER.DEVICE, signer: device.id,
    roomNonce, member: { role: ROLE.HUMAN, signPub: device.signPub, kexPub: device.kexPub },
    recovery, epoch: 1, ...await epochCommits(secret),
  }, device)
  const state = await applyEntry(null, entry)
  return { entry, state, roomId: state.roomId, secret, wraps: await wrapForAll(state, secret, { _rng }) }
}

/**
 * Add a member directly (the invite flow calls this). Returns { entry, state }. Signed by the recovery key
 * (`signer` from recoveryDevice), it adds a human device without an invite: the passphrase sign-in.
 */
export async function addMember(state, signer, { member, inviteId = ZERO16, time }) {
  const kind = bytesEqual(signer.id, state.recovery.id) ? SIGNER.RECOVERY : SIGNER.DEVICE
  const entry = await signEntry({ ...base(state, ENTRY.ADD, signer, kind, time), member, inviteId }, signer)
  return { entry, state: await applyEntry(state, entry) }
}

async function rotated(state, entry, secret, previous, opts) {
  const next = await applyEntry(state, entry)
  return {
    entry, state: next, secret,
    wraps: await wrapForAll(next, secret, opts),
    backLink: previous?.hist ? await makeBackLink(next.roomId, secret, previous) : null,
  }
}

/**
 * Remove members and rotate the room key in the same entry: removal without a new epoch cannot be expressed.
 * `previous` is the current epoch secret (for the back link). `cuts`: { [hex id]: { seq, hash } }, per removed
 * device the last envelope of it the remover had seen (R3); missing means none.
 * Returns { entry, state, secret, wraps, backLink }; wraps go to the human devices who stay and the recovery key.
 */
export async function removeMembers(state, signer, { ids, cuts, previous, time, _rng }) {
  const secret = newEpochSecret(state.epoch + 1, { _rng })
  const entry = await signEntry({ ...base(state, ENTRY.REMOVE, signer, SIGNER.DEVICE, time), ids, cuts, epoch: secret.epoch, ...await epochCommits(secret) }, signer)
  return rotated(state, entry, secret, previous, { _rng })
}

// ---- recovery code -------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 256 bits as 52 Crockford base32 characters in groups of four. */
export function formatRecoveryCode(bytes) {
  need(bytes, 32, 'recovery code')
  let out = '', acc = 0, bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8
    while (bits >= 5) { bits -= 5; out += CROCKFORD[(acc >> bits) & 31] }
    acc &= (1 << bits) - 1
  }
  out += CROCKFORD[(acc << (5 - bits)) & 31]   // 256 = 51 * 5 + 1: one bit left, padded with four zero bits
  return out.match(/.{1,4}/g).join('-')
}
/** Accepts lower case, spaces and hyphens; O reads as 0, I and L as 1 (Crockford). Rejects everything else. */
export function parseRecoveryCode(text) {
  if (typeof text !== 'string') fail('bad-recovery-code', 'not a string')
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (clean.length !== 52) fail('bad-recovery-code', 'a recovery code has 52 characters')
  const out = new Uint8Array(32)
  let acc = 0, bits = 0, o = 0
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch)
    if (v < 0) fail('bad-recovery-code', 'foreign character')
    acc = (acc << 5) | v; bits += 5
    if (bits >= 8) { bits -= 8; if (o < 32) out[o++] = (acc >> bits) & 0xff; acc &= (1 << bits) - 1 }
  }
  if (acc !== 0) fail('bad-recovery-code', 'non-canonical last character')
  return out
}
export function generateRecoveryCode(opts) {
  return formatRecoveryCode(rngOf(opts)(32))
}
/** The recovery key pair (Ed25519 and X25519), derived from the code by HKDF. Shaped like a device. */
export async function recoveryDevice(code) {
  const raw = parseRecoveryCode(code)
  return deviceFromSeeds(await hkdf(raw, EMPTY, LABEL.recoverySign, EMPTY, 32), await hkdf(raw, EMPTY, LABEL.recoveryKex, EMPTY, 32))
}

/**
 * All devices lost, code at hand: enrol `newDevice`, remove every human device, KEEP every agent,
 * start a new epoch, and install the recovery key of `newCode`. `recoveryWrap` is the sealed copy of
 * the current epoch secret that the server keeps for the recovery key. The agents get the new room
 * key through `wraps`, like after any removal.
 * Returns { entry, state, secret, previous, wraps, backLink }.
 */
export async function recoverRoom({ state, code, newCode, newDevice, removeAgents = [], cuts, recoveryWrap, time, _rng }) {
  const rec = await recoveryDevice(code)
  if (!bytesEqual(rec.id, state.recovery.id)) fail('bad-recovery-code', 'this code does not belong to the room')
  const previous = await unwrapEpochKey(state, rec, recoveryWrap, state.epoch)
  const next = await recoveryDevice(newCode)
  const ids = [...activeMembers(state).filter(m => m.role === ROLE.HUMAN).map(m => m.id), ...removeAgents]
  const secret = newEpochSecret(state.epoch + 1, { _rng })
  const entry = await signEntry({
    ...base(state, ENTRY.RECOVER, rec, SIGNER.RECOVERY, time),
    member: { role: ROLE.HUMAN, signPub: newDevice.signPub, kexPub: newDevice.kexPub }, ids, cuts,
    epoch: secret.epoch, ...await epochCommits(secret), recovery: { signPub: next.signPub, kexPub: next.kexPub },
  }, rec)
  return { ...await rotated(state, entry, secret, previous, { _rng }), previous }
}

// ---- invites -------------------------------------------------------------------

export const INVITE_TTL_MS = 10 * 60 * 1000
export const INVITE_CONFIRM_MS = 5 * 60 * 1000
const HUB_MAX = 512

async function inviteKeys(secret, roomId) {
  return {
    inviteId: await hkdf(secret, roomId, LABEL.inviteId, EMPTY, 16),
    macKey: await subtle.importKey('raw', await hkdf(secret, roomId, LABEL.inviteMac, EMPTY, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
  }
}

/**
 * The canonical hub address (R9): https:// + lowercase host [+ :port], no path, no trailing slash. Plain
 * http only for localhost and 127.0.0.1 (development). Anything else is refused, never normalised.
 */
export function checkHubAddress(hub) {
  if (typeof hub !== 'string' || !/^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|http:\/\/(localhost|127\.0\.0\.1))(:[1-9][0-9]{0,4})?$/.test(hub)) fail('bad-argument', 'hub address: https://host[:port], lowercase, no path')
  return hub
}

/** `<app>#v1.<hub>.<roomId>.<secret>`, each part base64url; the hub part is the UTF-8 hub address. */
export function inviteLink(app, hub, roomId, secret) {
  return `${app}#v${VERSION}.${b64u(te.encode(hub))}.${b64u(roomId)}.${b64u(secret)}`
}
export function parseInviteLink(link) {
  const at = String(link).indexOf('#')
  if (at < 0) fail('bad-invite', 'no fragment')
  const parts = String(link).slice(at + 1).split('.')
  if (parts[0] !== `v${VERSION}`) fail('bad-version', 'invite link version')
  if (parts.length !== 4) fail('bad-invite', 'malformed link')
  let hub
  try { hub = tdStrict.decode(unb64u(parts[1])) } catch { fail('bad-invite', 'hub address') }
  try { checkHubAddress(hub) } catch { fail('bad-invite', 'the hub address in the link is not canonical') }
  const roomId = unb64u(parts[2]), secret = unb64u(parts[3])
  if (roomId.length !== 32 || secret.length !== 32) fail('bad-invite', 'malformed link')
  return { hub, roomId, secret }
}

/**
 * Step 1 and 2, on the inviter. Returns { link, offer, invite }.
 * `offer` goes to the hub (public, signed). `link` goes to the invitee by hand. `invite` is the
 * inviter's private record; keep it (it holds the secret and enforces expiry and single use).
 */
export async function createInvite({ state, inviter, hub, role, app = 'https://app.invalid/join', ttlMs = INVITE_TTL_MS, now = Date.now(), _rng }) {
  const me = memberAt(state, inviter.id)
  if (!me || me.role !== ROLE.HUMAN) fail('not-human', 'only a human device can invite')
  if (role !== ROLE.HUMAN && role !== ROLE.AGENT) fail('bad-argument', 'role')
  checkHubAddress(hub)
  const rng = rngOf({ _rng })
  const secret = rng(32), nonce = rng(32)
  const { inviteId } = await inviteKeys(secret, state.roomId)
  const expiresAt = now + ttlMs
  const w = new W().u8(VERSION).u8(OBJ.INVITE_OFFER).raw(state.roomId, 32).raw(inviteId, 16).u8(role).u64(expiresAt)
    .raw(await hash(LABEL.inviteCommit, inviteId, nonce), 32).raw(inviter.id, 32).u32(state.head.seq).raw(state.head.hash, 32)
  const body = w.done()
  const offer = concat(body, await sign(inviter, LABEL.inviteOfferSig, body))
  return {
    link: inviteLink(app, hub, state.roomId, secret),
    offer,
    invite: { roomId: state.roomId, hub, role, secret, nonce, inviteId, expiresAt, offer, used: false, finalized: false, request: null, acceptedAt: null },
  }
}

/** Parse an offer without judging it (a hub reads the invite id, role and expiry from it). */
export function decodeInviteOffer(bytes) { return decodeOffer(bytes) }
/** Parse a request without judging it. Only the inviter, who holds the link secret, can check its MAC. */
export function decodeInviteRequest(bytes) { return decodeRequest(bytes) }

/** An offer is good if an active human member of this room signed it and it has not run out. Returns the parsed offer. */
export async function verifyInviteOffer(state, offer, now = Date.now()) {
  const o = decodeOffer(offer)
  if (!bytesEqual(o.roomId, state.roomId)) fail('bad-invite', 'the offer belongs to another room')
  const inviter = memberAt(state, o.inviterId)
  if (!inviter || inviter.role !== ROLE.HUMAN) fail('bad-invite', 'the offer is not from a human member of this room')
  if (!await verify(inviter.signPub, LABEL.inviteOfferSig, o.body, o.signature)) fail('bad-signature', 'invite offer')
  if (o.role !== ROLE.HUMAN && o.role !== ROLE.AGENT) fail('bad-format', 'unknown role')
  if (now > o.expiresAt) fail('invite-expired', 'this invite has run out')
  return o
}
/** What anyone can check of a request: it is well-formed and signed by the key it carries. Returns it parsed, with the device id. */
export async function verifyInviteRequest(request) {
  const q = decodeRequest(request)
  if (q.role !== ROLE.HUMAN && q.role !== ROLE.AGENT) fail('bad-format', 'unknown role')
  if (!await verify(q.signPub, LABEL.inviteRequestSig, concat(q.body, q.mac), q.signature)) fail('bad-signature', 'invite request')
  return { ...q, id: await deviceId(q.signPub, q.kexPub) }
}
/** A reveal is good if an active human member signed it. Returns { inviteId, nonce, requestHash, inviterId }. */
export async function verifyInviteReveal(state, reveal, inviterId) {
  const inviter = memberAt(state, inviterId)
  if (!inviter || inviter.role !== ROLE.HUMAN) fail('bad-invite', 'the inviter is no longer a member')
  if (!(reveal instanceof Uint8Array) || reveal.length < 64) fail('bad-format', 'reveal')
  const body = reveal.slice(0, reveal.length - 64)
  if (!await verify(inviter.signPub, LABEL.inviteRevealSig, body, reveal.slice(reveal.length - 64))) fail('bad-signature', 'invite reveal')
  const r = new R(body)
  header(r, OBJ.INVITE_REVEAL)
  const out = { inviteId: r.take(16), nonce: r.take(32), requestHash: r.take(32), inviterId }
  r.end()
  return out
}

function decodeOffer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) fail('bad-format', 'offer')
  const body = bytes.slice(0, bytes.length - 64)
  const r = new R(body)
  header(r, OBJ.INVITE_OFFER)
  const o = { roomId: r.take(32), inviteId: r.take(16), role: r.u8(), expiresAt: r.u64(), commit: r.take(32), inviterId: r.take(32), logSeq: r.u32(), logHash: r.take(32) }
  r.end()
  return { ...o, body, signature: bytes.slice(bytes.length - 64) }
}

function decodeRequest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 96) fail('bad-format', 'request')
  const body = bytes.slice(0, bytes.length - 96)
  const r = new R(body)
  header(r, OBJ.INVITE_REQUEST)
  const q = { roomId: r.take(32), inviteId: r.take(16), hub: r.str16(HUB_MAX), role: r.u8(), name: '', signPub: r.take(32), kexPub: r.take(32), offerHash: r.take(32) }
  r.end()
  return { ...q, body, mac: bytes.slice(bytes.length - 96, bytes.length - 64), signature: bytes.slice(bytes.length - 64) }
}

/** The signing key a join request names (hex), unverified; null for junk. For counting distinct answering devices. */
export function joinRequestSigner(bytes) { try { return hex(decodeRequest(bytes).signPub) } catch { return null } }

// Hashes over the signed bodies, not over the Ed25519 signatures (R9): offer body; request body ‖ MAC.
const offerBodyOf = offer => decodeOffer(offer).body
const requestSignedOf = request => request.slice(0, request.length - 64)
export const inviteOfferHash = offer => hash(LABEL.inviteOffer, offerBodyOf(offer))
export const inviteRequestHash = request => hash(LABEL.inviteRequest, requestSignedOf(request))
async function inviteCode(offer, request, nonce) {
  const h = await hash(LABEL.inviteCode, offerBodyOf(offer), requestSignedOf(request), nonce)
  const n = new DataView(h.buffer).getBigUint64(0) % 1000000n
  return n.toString().padStart(6, '0')
}

/**
 * Step 3, on the joining device. Verifies the log against the room id in the link and the offer
 * against the log, then builds the request. Returns { request, join } (keep `join`).
 */
export async function createJoinRequest({ link, offer, log, device, now = Date.now() }) {
  const { hub, roomId, secret } = parseInviteLink(link)
  const state = await verifyLog(log, roomId)
  const { inviteId, macKey } = await inviteKeys(secret, roomId)
  if (!bytesEqual(decodeOffer(offer).inviteId, inviteId)) fail('bad-invite', 'the offer does not belong to this link')
  const o = await verifyInviteOffer(state, offer, now)
  // The offer names the log head the inviter knew; it must be in the log served here (C13).
  if (o.logSeq > state.head.seq || !bytesEqual(state.hashes[o.logSeq], o.logHash)) fail('bad-invite', 'the offer names a member list this hub does not show')
  const offerHash = await inviteOfferHash(offer)
  const w = new W().u8(VERSION).u8(OBJ.INVITE_REQUEST).raw(roomId, 32).raw(inviteId, 16)
  str16(w, hub, HUB_MAX).u8(o.role)
  w.raw(device.signPub, 32).raw(device.kexPub, 32).raw(offerHash, 32)
  const body = w.done()
  const mac = new Uint8Array(await subtle.sign('HMAC', macKey, concat(labelBytes(LABEL.inviteMac), body)))
  const request = concat(body, mac, await sign(device, LABEL.inviteRequestSig, concat(body, mac)))
  return { request, join: { roomId, hub, role: o.role, inviteId, inviterId: o.inviterId, commit: o.commit, offer, request } }
}

/**
 * Step 4, on the inviter: check the request, burn the invite, reveal the nonce.
 * Returns { reveal, code, member }. Throws 'invite-used', 'invite-expired', 'bad-mac', 'bad-signature', 'bad-invite'.
 * Only a request with a valid MAC burns the invite, so the hub cannot burn it with junk.
 */
export async function acceptJoinRequest({ invite, request, inviter, now = Date.now() }) {
  // Claimed before the first await, so two requests at once cannot both get a reveal (C20). Junk releases the claim.
  if (invite.used || invite.claimed) fail('invite-used', 'this invite was already answered')
  if (now > invite.expiresAt) fail('invite-expired', 'this invite has run out')
  invite.claimed = true
  let q
  try {
    q = decodeRequest(request)
    const { macKey } = await inviteKeys(invite.secret, invite.roomId)
    if (!await subtle.verify('HMAC', macKey, q.mac, concat(labelBytes(LABEL.inviteMac), q.body))) fail('bad-mac', 'the request was not made with this invite link')
    if (!bytesEqual(q.roomId, invite.roomId) || !bytesEqual(q.inviteId, invite.inviteId) || q.hub !== invite.hub || q.role !== invite.role ||
        !bytesEqual(q.offerHash, await inviteOfferHash(invite.offer))) fail('bad-invite', 'the request does not match the invite')
    if (!await verify(q.signPub, LABEL.inviteRequestSig, concat(q.body, q.mac), q.signature)) fail('bad-signature', 'invite request')
  } catch (err) { invite.claimed = false; throw err }
  invite.used = true
  invite.acceptedAt = now
  invite.request = request
  const requestHash = await inviteRequestHash(request)
  const body = new W().u8(VERSION).u8(OBJ.INVITE_REVEAL).raw(invite.inviteId, 16).raw(invite.nonce, 32).raw(requestHash, 32).done()
  return {
    reveal: concat(body, await sign(inviter, LABEL.inviteRevealSig, body)),
    code: await inviteCode(invite.offer, request, invite.nonce),
    member: { id: await deviceId(q.signPub, q.kexPub), role: q.role, signPub: q.signPub, kexPub: q.kexPub },
    requestHash,
  }
}

/** On the joining device: check the reveal and return the six-digit code to show. */
export async function checkReveal({ join, reveal, log }) {
  const state = await verifyLog(log, join.roomId)
  const { inviteId, nonce, requestHash } = await verifyInviteReveal(state, reveal, join.inviterId)
  if (!bytesEqual(inviteId, join.inviteId)) fail('bad-invite', 'reveal for another invite')
  if (!bytesEqual(requestHash, await inviteRequestHash(join.request))) fail('bad-invite', 'the inviter answered a different request (someone else used this link)')
  if (!bytesEqual(join.commit, await hash(LABEL.inviteCommit, inviteId, nonce))) fail('bad-invite', 'the revealed number does not match the commitment')
  return inviteCode(join.offer, join.request, nonce)
}

/**
 * Step 5, on the inviter, after the human compared the codes.
 * Human invites always need `codeConfirmed` (the check code is mandatory for humans). An agent that
 * joins by a link pasted into its prompt has nobody to read a code: pass `skipCheckCode` for it.
 * Returns { entry, state, wrap } where `wrap` is the current epoch secret sealed to the new member.
 */
export async function finalizeInvite({ invite, state, inviter, secret, requestHash = null, codeConfirmed = false, skipCheckCode = false, now = Date.now(), time, _rng }) {
  if (!invite.used || !invite.request) fail('bad-invite', 'no request was accepted for this invite')
  if (invite.finalized || invite.finalizing) fail('invite-used', 'this invite already produced a member')
  if (now > invite.acceptedAt + INVITE_CONFIRM_MS) fail('invite-expired', 'the confirmation came too late')
  if (!codeConfirmed && !(skipCheckCode && invite.role === ROLE.AGENT)) fail('code-not-confirmed', 'the check code was not confirmed')
  invite.finalizing = true
  try {
    // Bound to the request whose code the human confirmed (C20).
    if (requestHash && !bytesEqual(requestHash, await inviteRequestHash(invite.request))) fail('bad-invite', 'the confirmed request is not the accepted one')
    const human = invite.role === ROLE.HUMAN
    if (human && secret?.epoch !== state.epoch) fail('wrong-epoch', 'pass the current epoch secret')
    const q = decodeRequest(invite.request)
    const added = await addMember(state, inviter, {
      member: { role: invite.role, signPub: q.signPub, kexPub: q.kexPub }, inviteId: invite.inviteId, time: time ?? now,
    })
    const id = await deviceId(q.signPub, q.kexPub)
    // A human gets the room key; an agent gets none (R6): its session keys come with a session grant.
    const wrap = human ? await wrapEpochKey(added.state, secret, id, { _rng }) : null
    invite.finalized = true
    return { ...added, wrap }
  } finally { invite.finalizing = false }
}

/** On the joining device: verify the log up to the room id, find itself in it, open the room key. */
export async function completeJoin({ join, device, log, wrap }) {
  const state = await verifyLog(log, join.roomId)
  const me = memberAt(state, device.id)
  if (!me) fail('not-member', 'the log does not list this device')
  if (me.role !== join.role) fail('bad-invite', 'enrolled with a different role than invited')
  // The entry that added this device names this invite and was signed by the inviter (C13).
  const added = state.entries[me.addedSeq]
  if (!bytesEqual(added.inviteId, join.inviteId) || !bytesEqual(added.signer, join.inviterId)) fail('bad-invite', 'this device was added by another invite or another device')
  if (me.role === ROLE.AGENT) return { state, secret: null }
  return { state, secret: await unwrapEpochKey(state, device, wrap, epochAt(state, me.addedSeq)) }
}

// ---- signing in to the hub -----------------------------------------------------
//
// The hub hands out 32 random bytes; the device signs them together with the room and the hub address.
// Members sign with their device key, a human who is recovering signs with the recovery key.

/** 0x01 0x0d roomId(32) hub str16 deviceId(32) challenge(32) || signature(64) */
export async function signHubAuth({ device, roomId, hub, challenge }) {
  checkHubAddress(hub)
  const w = new W().u8(VERSION).u8(OBJ.HUB_AUTH).raw(roomId, 32, 'roomId')
  const body = str16(w, hub, HUB_MAX).raw(device.id, 32, 'device id').raw(challenge, 32, 'challenge').done()
  return concat(body, await sign(device, LABEL.hubAuth, body))
}
/** Returns { id, kind: 'member' | 'recovery', member, challenge }. Whether the challenge is the hub's own and unused is the hub's check. */
export async function verifyHubAuth(bytes, { state, hub }) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) fail('bad-format', 'hub auth')
  const body = bytes.slice(0, bytes.length - 64)
  const r = new R(body)
  header(r, OBJ.HUB_AUTH)
  const a = { roomId: r.take(32), hub: r.str16(HUB_MAX), id: r.take(32), challenge: r.take(32) }
  r.end()
  if (!bytesEqual(a.roomId, state.roomId)) fail('wrong-room', 'signed for another room')
  if (a.hub !== hub) fail('wrong-hub', 'signed for another hub')
  const recovery = bytesEqual(a.id, state.recovery.id)
  const member = recovery ? null : memberAt(state, a.id)
  if (!recovery && !member) fail('not-member', 'this device is not a member (or was removed)')
  if (!await verify(recovery ? state.recovery.signPub : member.signPub, LABEL.hubAuth, body, bytes.slice(bytes.length - 64))) fail('bad-signature', 'hub auth')
  return { id: a.id, kind: recovery ? 'recovery' : 'member', member, challenge: a.challenge }
}

// ---- message envelope ----------------------------------------------------------

export const KIND = Object.freeze({
  TIMELINE_ITEM: 1, OBJECT_VERSION: 2, ANSWER: 3, PERMISSION_REQUEST: 4, VERDICT: 5, STATUS: 6, DECIDE_AGAIN: 7,
  // Older names of the same numbers.
  CHAT: 1, CARD: 2, REDECIDE: 7,
})
const KIND_MAX = 7
/** Kinds whose header carries the object block (object id, state, urgency, answer time). */
const OBJECT_KINDS = new Set([KIND.OBJECT_VERSION, KIND.ANSWER, KIND.PERMISSION_REQUEST, KIND.VERDICT, KIND.DECIDE_AGAIN])
/** The only thread kind: a timeline item. Every other kind is a head. */
export const isThreadKind = kind => kind === KIND.TIMELINE_ITEM
/** timeline_kind values known today; others (1 to 255) are accepted so a new timeline kind needs no hub change. */
export const TIMELINE = Object.freeze({ CHAT: 1, CANVAS: 2 })
/** timeline scope byte and its text prefix: card/<object_id>, session/<session_id>, desk/<desk_id>, each 16 bytes as 32 hex. */
export const TIMELINE_SCOPE = Object.freeze({ CARD: 1, SESSION: 2, DESK: 3 })
const SCOPE_NAMES = { 1: 'card', 2: 'session', 3: 'desk' }
export const TIMELINE_ID_MAX = 40
/** Key scope: 0 the room key (humans only), 1 a session key (that session's agents and every human). */
export const KEY_SCOPE = Object.freeze({ ROOM: 0, SESSION: 1 })
export const SEEN_MAX = 64
const FLAG_PUSH = 1, FLAG_OBJECT = 2

/** Parse the canonical text form `card/<32 hex>` (also session/, desk/) into { scope, ref }; anything else is refused. */
export function parseTimelineId(text) {
  const m = /^(card|session|desk)\/([0-9a-f]{32})$/.exec(typeof text === 'string' ? text : '')
  if (!m) fail('bad-argument', 'timeline id: card/, session/ or desk/ and 32 lowercase hex characters')
  return { scope: { card: 1, session: 2, desk: 3 }[m[1]], ref: unhex(m[2]) }
}
export const timelineIdOf = (scope, ref) => `${SCOPE_NAMES[scope]}/${hex(ref)}`

/** Card status and urgency the hub can read (and nobody can change: they are signed). */
export const CARD_STATE = Object.freeze({ OPEN: 1, ANSWERED: 2, CLOSED: 3 })
export const URGENCY = Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 })
const cardFields = (c, bad) => {
  if (!Number.isInteger(c.state) || c.state < 1 || c.state > 3) bad('card state')
  if (!Number.isInteger(c.urgency) || c.urgency < 0 || c.urgency > 3) bad('urgency')
  return c
}
const NONCE_LEN = 12

/** object_id = first 16 bytes of H("trommi/v1/object-id", creator device id ‖ sender_sequence of version 1). */
export async function objectIdOf(creatorId, senderSequence) {
  return (await hash(LABEL.objectId, need(creatorId, 32, 'creator id'), new W().u64(senderSequence).done())).slice(0, 16)
}

const scopeCtx = (keyScope, sessionId) => (keyScope === KEY_SCOPE.SESSION ? concat(Uint8Array.of(1), need(sessionId, 16, 'session id')) : Uint8Array.of(0))
/**
 * HKDF(scope key, salt = room id, info = label ‖ scope ‖ [session id] ‖ epoch ‖ device id): the AES-256-GCM key
 * of one sender in one key epoch of one scope. The scope key is the room key or a session key.
 */
export async function deriveSenderKey(roomId, secret, senderId, { keyScope = KEY_SCOPE.ROOM, sessionId = null } = {}) {
  return hkdf(secret.key, roomId, LABEL.senderKey, concat(scopeCtx(keyScope, sessionId), epochCtx(secret.epoch), need(senderId, 32, 'sender id')), 32)
}
const senderKeyCache = new WeakMap()   // secret object -> Map(epoch+key+scope+room+sender -> CryptoKey)
async function senderKey(roomId, secret, senderId, scope) {
  let cache = senderKeyCache.get(secret)
  if (!cache) senderKeyCache.set(secret, cache = new Map())
  // C23: the epoch and the key bytes are part of the cache key, so a secret changed in place never reuses an old key.
  const k = `${secret.epoch}.${b64u(secret.key)}.${scope.keyScope}${scope.sessionId ? b64u(scope.sessionId) : ''}${b64u(roomId)}${b64u(senderId)}`
  let key = cache.get(k)
  if (!key) cache.set(k, key = await aesKey(await deriveSenderKey(roomId, secret, senderId, scope)))
  return key
}

function checkGrammar(h, bad) {
  if (!Number.isInteger(h.kind) || h.kind < 1 || h.kind > KIND_MAX) bad(`unknown envelope kind ${h.kind}`)
  if (h.keyScope !== KEY_SCOPE.ROOM && h.keyScope !== KEY_SCOPE.SESSION) bad('unknown key scope')
  const thread = isThreadKind(h.kind)
  if (OBJECT_KINDS.has(h.kind) !== !!h.card) bad(OBJECT_KINDS.has(h.kind) ? 'this kind needs the object block' : 'this kind has no object block')
  if (thread !== (h.timelineId != null)) bad(thread ? 'a timeline item needs a timeline' : 'only timeline items have a timeline')
  if (thread) {
    if (!Number.isInteger(h.timelineKind) || h.timelineKind < 1 || h.timelineKind > 255) bad('timeline kind')
    const t = parseTimelineId(h.timelineId)
    // A session's timelines are under that session's key, a desk's under the room key.
    if (t.scope === TIMELINE_SCOPE.SESSION && (h.keyScope !== KEY_SCOPE.SESSION || !bytesEqual(t.ref, h.sessionId))) bad("a session's timeline is sent under that session's key")
    if (t.scope === TIMELINE_SCOPE.DESK && h.keyScope !== KEY_SCOPE.ROOM) bad('a desk is sent under the room key')
  }
  if (h.seen.length > SEEN_MAX) bad(`seen lists at most ${SEEN_MAX} senders`)
}

function encodeHeader(h) {
  checkGrammar(h, what => fail('bad-argument', what))
  const flags = (h.push ? FLAG_PUSH : 0) | (h.card ? FLAG_OBJECT : 0)
  const w = new W().u8(VERSION).u8(flags).raw(h.roomId, 32, 'roomId').u32(h.epoch).u8(h.keyScope)
  if (h.keyScope === KEY_SCOPE.SESSION) w.raw(h.sessionId, 16, 'session id')
  w.raw(h.sender, 32, 'sender').u64(h.seq).raw(h.prev, 32, 'prev').u32(h.logSeq).raw(h.logHash, 32, 'logHash').raw(h.recipient, 32, 'recipient').u64(h.time).u8(h.kind)
  const seen = [...h.seen].sort((a, b) => compareBytes(a.sender, b.sender))
  w.u16(seen.length)
  for (let i = 0; i < seen.length; i++) {
    if (i && compareBytes(seen[i - 1].sender, seen[i].sender) === 0) fail('bad-argument', 'duplicate sender in seen')
    w.raw(seen[i].sender, 32, 'seen sender').u64(seen[i].seq).raw(seen[i].hash, 32, 'seen hash')
  }
  if (h.card) {
    const c = cardFields({ ...h.card, urgency: h.card.urgency ?? URGENCY.NORMAL }, what => fail('bad-argument', what))
    w.raw(c.id, 16, 'object id').u8(c.state).u8(c.urgency).u64(c.answeredAt ?? 0)
  }
  if (h.timelineId != null) {
    const t = parseTimelineId(h.timelineId)
    w.u8(h.timelineKind).u8(t.scope).raw(t.ref, 16, 'timeline ref')
  }
  if (h.blobs.length > 255) fail('bad-argument', 'too many attachments')
  w.u8(h.blobs.length)
  for (const b of h.blobs) w.raw(b, 16, 'blob id')
  return w.done()
}
function decodeHeader(bytes) {
  const r = new R(bytes)
  const v = r.u8()
  if (v !== VERSION) fail('bad-version', `envelope header version ${v}`)
  const flags = r.u8()
  if (flags & ~(FLAG_PUSH | FLAG_OBJECT)) fail('bad-format', 'unknown header flags')
  const h = { push: !!(flags & FLAG_PUSH), roomId: r.take(32), epoch: r.u32(), keyScope: r.u8(), sessionId: null }
  if (h.keyScope > 1) fail('bad-format', 'unknown key scope')
  if (h.keyScope === KEY_SCOPE.SESSION) h.sessionId = r.take(16)
  Object.assign(h, { sender: r.take(32), seq: r.u64(), prev: r.take(32), logSeq: r.u32(), logHash: r.take(32), recipient: r.take(32), time: r.u64(), kind: r.u8(), seen: [], card: null, timelineKind: null, timelineId: null, blobs: [] })
  const n = r.u16()
  if (n > SEEN_MAX) fail('bad-format', `seen lists at most ${SEEN_MAX} senders`)
  for (let i = 0; i < n; i++) {
    const s = { sender: r.take(32), seq: r.u64(), hash: r.take(32) }
    if (i && compareBytes(h.seen[i - 1].sender, s.sender) >= 0) fail('bad-format', 'seen not strictly ascending')
    h.seen.push(s)
  }
  if (flags & FLAG_OBJECT) h.card = cardFields({ id: r.take(16), state: r.u8(), urgency: r.u8(), answeredAt: r.u64() }, what => fail('bad-format', `unknown ${what}`))
  if (isThreadKind(h.kind)) {
    h.timelineKind = r.u8()
    const scope = r.u8()
    if (!SCOPE_NAMES[scope]) fail('bad-format', 'unknown timeline scope')
    h.timelineId = timelineIdOf(scope, r.take(16))
  }
  const blobs = r.u8()
  for (let i = 0; i < blobs; i++) h.blobs.push(r.take(16))
  r.end()
  if (h.seq < 1) fail('bad-format', 'sequence numbers start at 1')
  checkGrammar(h, what => fail('bad-format', what))
  h.isHead = !isThreadKind(h.kind)
  return h
}

/** Padded plaintext size: powers of two from 256 bytes to 64 KiB, then multiples of 64 KiB. */
export function paddedLength(n) {
  if (n > 65536) return Math.ceil(n / 65536) * 65536
  let size = 256
  while (size < n) size *= 2
  return size
}
const BOM = [0xef, 0xbb, 0xbf]
// The body has no kind of its own (v1.1): the kind is in the signed header, which is the associated data.
function encodeBody(bind, payload) {
  if (payload.length >= 3 && BOM.every((b, i) => payload[i] === b)) fail('bad-argument', 'the payload starts with a byte order mark')
  const raw = new W().u8(VERSION).var16(bind).var32(payload).done()
  const out = new Uint8Array(paddedLength(raw.length))
  out.set(raw)
  return out
}
function decodeBody(bytes) {
  const r = new R(bytes)
  const v = r.u8()
  if (v !== VERSION) fail('bad-version', `envelope body version ${v}`)
  const body = { bind: r.var16(), payload: r.var32() }
  const used = bytes.length - r.left()
  if (paddedLength(used) !== bytes.length) fail('bad-format', 'wrong padding length')
  if (!isZero(r.take(r.left()))) fail('bad-format', 'padding is not zero')
  if (body.payload.length >= 3 && BOM.every((b, i) => body.payload[i] === b)) fail('bad-format', 'the payload starts with a byte order mark')
  return body
}

function splitEnvelope(bytes) {
  const r = new R(bytes)
  const v = r.u8()
  if (v !== VERSION) fail('bad-version', `envelope version ${v}`)
  const type = r.u8()
  if (type !== OBJ.ENVELOPE && type !== OBJ.ENVELOPE_PRUNED) fail('bad-format', 'not an envelope')
  const headerBytes = r.var16()
  const nonce = r.take(NONCE_LEN)
  const pruned = type === OBJ.ENVELOPE_PRUNED
  const ct = pruned ? null : r.var32()
  const ctHash = pruned ? r.take(32) : null
  const signature = r.take(64)
  r.end()
  if (ct && ct.length < 16) fail('bad-format', 'ciphertext shorter than its tag')
  return { headerBytes, nonce, ct, ctHash, signature, pruned }
}

/** The hub's form of an answered card 30 days after the answer: header, nonce, hash of the ciphertext, signature. Still verifiable. */
export async function pruneEnvelope(bytes) {
  const e = splitEnvelope(bytes)
  if (e.pruned) return bytes
  return concat(Uint8Array.of(VERSION, OBJ.ENVELOPE_PRUNED), new W().var16(e.headerBytes).done(), e.nonce, await sha256(e.ct), e.signature)
}

/** Read the cleartext header without verifying anything (what a hub does to route and expire). */
export function peekEnvelope(bytes) {
  const e = splitEnvelope(bytes)
  return { header: decodeHeader(e.headerBytes), headerBytes: e.headerBytes, nonce: e.nonce, ciphertext: e.ct, ciphertextHash: e.ctHash, signature: e.signature, pruned: e.pruned }
}

/** Per-sender chain state of one device: Map(sender id -> { seq, hash, hashes: Map(seq -> hash) }). Includes its own chain. */
export const newChains = () => new Map()

// One seal or open at a time per chain set (C7, C8): both read a chain, await, then write it.
const chainLocks = new WeakMap()
function withChains(chains, fn) {
  const prev = chainLocks.get(chains) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chainLocks.set(chains, run.catch(() => {}))
  return run
}

/**
 * The bounded `seen` (R5): senders active at the author's log state whose head changed since the
 * author's own previous envelope, at most SEEN_MAX. Receivers carry earlier values forward.
 */
function seenFrom(chains, self, state) {
  const own = chains.get(idKey(self.id))
  const told = own?.told ?? new Map()
  const out = []
  for (const [k, c] of chains) {
    if (k === idKey(self.id) || !c.hash) continue
    const id = unb64u(k)
    if (!memberAt(state, id)) continue
    if (told.get(k) === c.seq) continue
    out.push({ sender: id, seq: c.seq, hash: c.hash })
  }
  out.sort((a, b) => compareBytes(a.sender, b.sender))
  return out.slice(0, SEEN_MAX)
}
function advance(chains, sender, seq, hashBytes, told) {
  const k = idKey(sender)
  const c = chains.get(k) ?? { seq: 0, hash: ZERO32, hashes: new Map() }
  c.seq = seq; c.hash = hashBytes; c.hashes.set(seq, hashBytes)
  if (told) { c.told ??= new Map(); for (const s of told) c.told.set(idKey(s.sender), s.seq) }
  chains.set(k, c)
}

/**
 * Encrypt and sign one message. Advances the sender's own chain in `chains`, once the bytes are complete.
 * keyScope 0 (room, `secret` = the room's epoch secret, humans only) or 1 (session: `sessionId`, `secret` =
 * that session's key epoch secret { epoch, key, hist }, checked by its grant chain, not by the member list).
 * `recipient`: a device id, or null for everyone. Thread items (kind 1) name `timelineKind` and `timelineId`.
 * Returns { bytes, hash, seq, header }.
 */
export function sealEnvelope(args) {
  return withChains(args.chains, () => sealLocked(args))
}
async function sealLocked({ device, state, secret, chains, kind, keyScope = KEY_SCOPE.ROOM, sessionId = null, bind = EMPTY, payload = EMPTY, recipient = null, time = Date.now(), card = null, timelineKind = null, timelineId = null, blobs = [], push = false, seen, _rng }) {
  const me = memberAt(state, device.id)
  if (!me) fail('not-member', 'this device is not a member')
  if (keyScope === KEY_SCOPE.ROOM) {
    if (me.role !== ROLE.HUMAN) fail('forbidden', 'agents hold no room key: they send under a session key')
    if (secret.epoch !== state.epoch) fail('wrong-epoch', 'send with the current epoch')
    await checkCommits(state, { ...secret, hist: null })
  }
  const own = chains.get(idKey(device.id))
  const told = seen ?? seenFrom(chains, device, state)
  const h = {
    push, keyScope, sessionId: keyScope === KEY_SCOPE.SESSION ? sessionId : null, roomId: state.roomId, epoch: secret.epoch, sender: device.id,
    seq: (own?.seq ?? 0) + 1, prev: own?.hash ?? ZERO32, logSeq: state.head.seq, logHash: state.head.hash, recipient: recipient ?? ZERO32, time, kind,
    seen: told, card, timelineKind: timelineId != null ? timelineKind : null, timelineId, blobs,
  }
  const headerBytes = encodeHeader(h)
  const nonce = rngOf({ _rng })(NONCE_LEN)
  const ct = await gcmSeal(await senderKey(state.roomId, secret, device.id, h), nonce, headerBytes, encodeBody(bind, payload))
  const envHash = await hash(LABEL.envelope, headerBytes, nonce, await sha256(ct))
  const signature = await sign(device, LABEL.envelopeSig, envHash)
  const bytes = concat(Uint8Array.of(VERSION, OBJ.ENVELOPE), new W().var16(headerBytes).done(), nonce, new W().var32(ct).done(), signature)
  advance(chains, device.id, h.seq, envHash, told)   // only now: nothing above can fail after the chain moved (C21)
  return { bytes, hash: envHash, seq: h.seq, header: decodeHeader(headerBytes) }
}

/**
 * Check everything about an envelope that needs no key: format and grammar, room, the sender's view of
 * the member list, membership, signature, the sender's chain, and what the sender has seen of others.
 * Works on full and pruned envelopes. With `commit` (default) the chain in `chains` advances.
 * `freshness: { now, currentEpoch, currentSince }` (live acceptance, R3): an envelope in an older key epoch
 * of its scope is refused once `currentSince` (when this device learned of the current epoch) is more
 * than EPOCH_GRACE_MS ago. A removed sender is refused, or with `allowRemovedSender` (reading history)
 * accepted up to the cut its removal entry names.
 *
 * Throws: bad-format, bad-version, wrong-room, log-behind, log-fork, not-member, removed-sender,
 * wrong-epoch, forbidden, bad-signature, replay, equivocation, gap, chain-break.
 */
export async function verifyEnvelope(bytes, { state, chains, allowChainStart = false, allowRemovedSender = false, commit = true, freshness = null }) {
  const e = splitEnvelope(bytes)
  const h = decodeHeader(e.headerBytes)
  if (!bytesEqual(h.roomId, state.roomId)) fail('wrong-room', 'envelope of another room')

  // The sender names the log head it knows. Same number with another hash means the server showed us different logs.
  if (h.logSeq > state.head.seq) fail('log-behind', `the sender knows log entry ${h.logSeq}, this device only ${state.head.seq}`, { logSeq: h.logSeq })
  if (!bytesEqual(state.hashes[h.logSeq], h.logHash)) fail('log-fork', `the sender has a different log entry ${h.logSeq}`, { logSeq: h.logSeq })
  const member = memberAt(state, h.sender, h.logSeq)
  if (!member) fail('not-member', 'the sender was not a member at the log state it names')
  if (h.keyScope === KEY_SCOPE.ROOM) {
    if (member.role !== ROLE.HUMAN) fail('forbidden', 'agents hold no room key')
    if (epochAt(state, h.logSeq) !== h.epoch) fail('wrong-epoch', 'the epoch does not match the log state the sender names')
  }
  if (freshness && h.epoch < freshness.currentEpoch && freshness.now - freshness.currentSince > EPOCH_GRACE_MS) fail('wrong-epoch', 'sent in an outdated key epoch: the sender is on an old member list')
  const now = state.members.get(idKey(h.sender))
  const removedNow = now.removedSeq !== null
  if (removedNow) {
    if (!allowRemovedSender) fail('removed-sender', 'the sender has been removed since')
    if (now.cut && h.seq > now.cut.seq) fail('removed-sender', 'beyond the cut its removal names')
  }
  for (const s of h.seen) if (!memberAt(state, s.sender, h.logSeq)) fail('bad-format', 'seen names a sender that was not active at the named log state')

  const ctHash = e.pruned ? e.ctHash : await sha256(e.ct)
  const envHash = await hash(LABEL.envelope, e.headerBytes, e.nonce, ctHash)
  if (!await verify(member.signPub, LABEL.envelopeSig, envHash, e.signature)) fail('bad-signature', 'envelope')
  if (removedNow && now.cut && h.seq === now.cut.seq && !bytesEqual(now.cut.hash, envHash)) fail('equivocation', 'not the envelope the removal cut names')

  const chain = chains.get(idKey(h.sender))
  let chainStart = false
  if (!chain) {
    if (h.seq === 1) { if (!isZero(h.prev)) fail('chain-break', 'the first envelope names a predecessor') }
    else if (allowChainStart) chainStart = true
    else fail('gap', `first envelope seen from this sender has number ${h.seq}`, { have: 0, got: h.seq })
  } else if (h.seq <= chain.seq) {
    const known = chain.hashes.get(h.seq)
    if (known && !bytesEqual(known, envHash)) fail('equivocation', `two different envelopes with number ${h.seq} from one sender`)
    fail('replay', `envelope ${h.seq} was already accepted`)
  } else if (h.seq > chain.seq + 1) {
    fail('gap', `envelope ${h.seq} arrived, ${chain.seq + 1} is missing`, { have: chain.seq, got: h.seq })
  } else if (!bytesEqual(h.prev, chain.hash)) {
    fail('chain-break', 'the predecessor hash does not match the envelope accepted before')
  }

  // "Seen": what the sender knows of the other chains. A different hash for a number we hold is a fork;
  // a higher number than ours means the server is holding something back from us.
  const withheld = []
  for (const s of h.seen) {
    if (bytesEqual(s.sender, h.sender)) fail('bad-format', 'a sender cannot list itself as seen')
    const c = chains.get(idKey(s.sender))
    const known = c?.hashes.get(s.seq)
    if (known && !bytesEqual(known, s.hash)) fail('equivocation', 'the sender saw a different envelope than this device under the same number')
    if (s.seq > (c?.seq ?? 0)) withheld.push({ sender: s.sender, have: c?.seq ?? 0, seen: s.seq })
  }

  if (commit) advance(chains, h.sender, h.seq, envHash)
  return { header: h, hash: envHash, ciphertextHash: ctHash, member, pruned: e.pruned, withheld, chainStart, removedNow, epochCurrent: h.keyScope === KEY_SCOPE.ROOM ? h.epoch === state.epoch : null, _split: e }
}

const pickSecret = (secrets, h) => {
  if (typeof secrets === 'function') return secrets(h.epoch, h)
  if (!secrets) return null
  return h.keyScope === KEY_SCOPE.ROOM ? secrets.get(h.epoch) : secrets.get(`${hex(h.sessionId)}:${h.epoch}`)
}
const QUARANTINE = new Set(['decrypt-failed', 'bad-format', 'bad-version'])

/**
 * Verify, then decrypt. `secrets`: a function (epoch, header) -> secret, or a Map (room scope: epoch ->
 * secret; session scope: '<session id hex>:<epoch>' -> secret). Throws 'no-key' without advancing.
 * A body that fails to decrypt or decode under a valid signature and chain is quarantined (R4, C17):
 * the chain advances and the result carries `quarantined: '<code>'` with no payload. `quarantine: false` throws instead.
 * Returns { header, hash, kind, bind, payload, member, withheld, chainStart, removedNow, epochCurrent, forMe, quarantined }.
 */
export function openEnvelope(bytes, opts) {
  return withChains(opts.chains, () => openLocked(bytes, opts))
}
async function openLocked(bytes, { state, chains, secrets, self = null, quarantine = true, ...opts }) {
  const v = await verifyEnvelope(bytes, { state, chains, ...opts, commit: false })
  if (v.pruned) fail('pruned', 'the ciphertext of this envelope was deleted')
  const secret = pickSecret(secrets, v.header)
  if (!secret) fail('no-key', `no key for epoch ${v.header.epoch}`, { epoch: v.header.epoch, keyScope: v.header.keyScope, sessionId: v.header.sessionId })
  const e = v._split
  let body, quarantined = null
  try {
    body = decodeBody(await gcmOpen(await senderKey(state.roomId, secret, v.header.sender, v.header), e.nonce, e.headerBytes, e.ct))
  } catch (err) {
    if (!quarantine || !(err instanceof ZError) || !QUARANTINE.has(err.code)) throw err
    quarantined = err.code
    body = { bind: null, payload: null }
  }
  if (opts.commit !== false) advance(chains, v.header.sender, v.header.seq, v.hash)
  const { _split, ...rest } = v
  return { ...rest, kind: v.header.kind, ...body, quarantined, forMe: isZero(v.header.recipient) || (self !== null && bytesEqual(v.header.recipient, self)) }
}

/**
 * Open a full envelope whose pruned form (or full form) was already verified in the chain by verifyEnvelope:
 * a thread item fetched later. `envelopeHash` is the hash the chain accepted for it. Checks that this
 * envelope hashes to exactly that (header, nonce and the hash of the ciphertext) and that the sender's
 * signature holds, then decrypts. Chains are not touched: nothing is decrypted that the chain did not vouch for.
 * Throws: bad-format, wrong-room, hash-mismatch, not-member, bad-signature, no-key, decrypt-failed.
 * Returns { header, hash, kind, bind, payload, member, forMe }.
 */
export async function openVerifiedEnvelope(bytes, { state, secrets, envelopeHash, self = null }) {
  need(envelopeHash, 32, 'envelope hash')
  const e = splitEnvelope(bytes)
  if (e.pruned) fail('pruned', 'the ciphertext of this envelope was deleted')
  const h = decodeHeader(e.headerBytes)
  if (!bytesEqual(h.roomId, state.roomId)) fail('wrong-room', 'envelope of another room')
  const envHash = await hash(LABEL.envelope, e.headerBytes, e.nonce, await sha256(e.ct))
  if (!bytesEqual(envHash, envelopeHash)) fail('hash-mismatch', 'this envelope is not the one the chain verified')
  // The chain check already placed the sender in the log; a sender removed since still signed this one.
  const member = state.members.get(idKey(h.sender))
  if (!member) fail('not-member', 'the sender is not in the member list')
  if (!await verify(member.signPub, LABEL.envelopeSig, envHash, e.signature)) fail('bad-signature', 'envelope')
  const secret = pickSecret(secrets, h)
  if (!secret) fail('no-key', `no key for epoch ${h.epoch}`, { epoch: h.epoch, keyScope: h.keyScope, sessionId: h.sessionId })
  const body = decodeBody(await gcmOpen(await senderKey(state.roomId, secret, h.sender, h), e.nonce, e.headerBytes, e.ct))
  return { header: h, hash: envHash, member, kind: h.kind, ...body, forMe: isZero(h.recipient) || (self !== null && bytesEqual(h.recipient, self)) }
}

/** The wire form from its parts (what a hub stores in columns): full with `ciphertext`, pruned with only `ciphertextHash`. */
export function joinEnvelope({ headerBytes, nonce, ciphertext = null, ciphertextHash = null, signature }) {
  need(nonce, NONCE_LEN, 'nonce'); need(signature, 64, 'signature')
  if (ciphertext) return concat(Uint8Array.of(VERSION, OBJ.ENVELOPE), new W().var16(headerBytes).done(), nonce, new W().var32(ciphertext).done(), signature)
  return concat(Uint8Array.of(VERSION, OBJ.ENVELOPE_PRUNED), new W().var16(headerBytes).done(), nonce, need(ciphertextHash, 32, 'ciphertext hash'), signature)
}

// ---- commands: what an agent may act on ----------------------------------------

/** Answer: object id, hash of the version answered, every choice (each an option key; R7). */
export function encodeAnswerBind({ objectId, versionHash, choices, cardId, cardHash, choice }) {
  const list = choices ?? (choice != null ? [choice] : [])
  if (!Array.isArray(list) || list.length > 64) fail('bad-argument', 'choices')
  const w = new W().u8(VERSION).raw(objectId ?? cardId, 16, 'object id').raw(versionHash ?? cardHash, 32, 'version hash').u8(list.length)
  for (const c of list) str16(w, c, 256)
  return w.done()
}
/** Verdict on a permission request: request id (= the request's object id), its version hash, its expiry, allow or deny. */
export function encodeVerdictBind({ requestId, requestHash, expiresAt, allow }) {
  return new W().u8(VERSION).raw(requestId, 16, 'request id').raw(requestHash, 32, 'request hash').u64(expiresAt).u8(allow ? 1 : 2).done()
}
/** Decide again (take an answer back, the card is open again): object id, the answer taken back, the current version (R7). */
export function encodeDecideAgainBind({ objectId, previousHash, versionHash, cardId, cardHash }) {
  return new W().u8(VERSION).raw(objectId ?? cardId, 16, 'object id').raw(previousHash, 32, 'previous hash').raw(versionHash ?? cardHash, 32, 'version hash').done()
}
export const encodeRedecideBind = encodeDecideAgainBind
/** What an agent puts into its permission request, so that the envelope hash covers id and expiry. requestId = object id. */
export function encodeRequestBind({ requestId, expiresAt }) {
  return new W().u8(VERSION).raw(requestId, 16, 'request id').u64(expiresAt).done()
}
export function decodeBind(kind, bind) {
  const r = new R(bind)
  const v = r.u8()
  if (v !== VERSION) fail('bad-version', 'bind version')
  let out
  switch (kind) {
    case KIND.ANSWER: {
      out = { objectId: r.take(16), versionHash: r.take(32), choices: [] }
      const n = r.u8()
      for (let i = 0; i < n; i++) out.choices.push(r.str16(256))
      out.cardId = out.objectId; out.cardHash = out.versionHash; out.choice = out.choices[0] ?? null
      break
    }
    case KIND.DECIDE_AGAIN: out = { objectId: r.take(16), previousHash: r.take(32), versionHash: r.take(32) }; out.cardId = out.objectId; break
    case KIND.PERMISSION_REQUEST: out = { requestId: r.take(16), expiresAt: r.u64() }; break
    case KIND.VERDICT: {
      out = { requestId: r.take(16), requestHash: r.take(32), expiresAt: r.u64() }
      const a = r.u8()
      if (a !== 1 && a !== 2) fail('bad-format', 'verdict')
      out.allow = a === 1
      break
    }
    default: fail('bad-format', 'this kind carries no bind')
  }
  r.end()
  return out
}

export const EPOCH_GRACE_MS = 2 * 60 * 1000

/**
 * The agent's gate, after openEnvelope succeeded (which already covers signature, membership at the
 * named log state, and "next number of this sender"). Throws unless the command may be executed.
 *
 * ctx: { state, agentId, now, epochChangedAt, ownSeq, maxAgeMs, seenOfMe (carried forward from this sender's earlier envelopes),
 *        sessionEpoch                                         the session's current key epoch, for session-scope envelopes
 *        card:     { id, hash, open, options: [keys] }       for ANSWER and DECIDE_AGAIN
 *        decision: { hash }                                  the answer currently in force, for DECIDE_AGAIN
 *        request:  { id, hash, expiresAt, pending } }        for VERDICT
 * Returns { kind, bind, late }. `late` (chat): the human had not seen the agent's latest envelope.
 * A timeline item counts only on a chat timeline; the caller still checks content_type "message".
 *
 * Throws: not-human, not-for-me, stale-epoch, stale, not-a-command, card-mismatch, card-closed,
 * card-changed, bad-choice, decision-mismatch, request-mismatch, request-not-pending, request-changed, request-expired.
 */
export function authoriseCommand(opened, ctx) {
  const { header: h, kind } = opened
  const now = ctx.now ?? Date.now()
  if (opened.quarantined) fail('not-a-command', 'the body was quarantined')
  const sender = memberAt(ctx.state, h.sender)
  if (!sender || sender.role !== ROLE.HUMAN) fail('not-human', 'commands are accepted from active human devices only')
  if (!bytesEqual(h.recipient, ctx.agentId)) fail('not-for-me', 'the command is addressed to someone else')
  const currentEpoch = h.keyScope === KEY_SCOPE.SESSION ? ctx.sessionEpoch : ctx.state.epoch
  if (currentEpoch == null) fail('stale-epoch', 'the current session key epoch is not known')
  const current = h.epoch === currentEpoch
  const grace = h.epoch === currentEpoch - 1 && ctx.epochChangedAt != null && now - ctx.epochChangedAt <= (ctx.graceMs ?? EPOCH_GRACE_MS)
  if (!current && !grace) fail('stale-epoch', 'the command was sent in an outdated epoch')
  if (ctx.maxAgeMs != null && now - h.time > ctx.maxAgeMs) fail('stale', 'the command is older than allowed')

  // seen is bounded (R5): an absent entry means "unchanged since the sender's previous envelope", so the caller
  // passes what this sender last said it had seen of the agent (ctx.seenOfMe), carried forward.
  const seenOfMe = h.seen.find(s => bytesEqual(s.sender, ctx.agentId))?.seq ?? ctx.seenOfMe ?? 0
  const late = ctx.ownSeq != null && seenOfMe < ctx.ownSeq

  if (kind === KIND.TIMELINE_ITEM) {
    if (h.timelineKind !== TIMELINE.CHAT) fail('not-a-command', 'only chat items reach the agent as messages')
    return { kind, bind: null, late }
  }
  if (kind !== KIND.ANSWER && kind !== KIND.VERDICT && kind !== KIND.DECIDE_AGAIN) fail('not-a-command', 'this kind is not a command')
  const bind = decodeBind(kind, opened.bind)

  if (kind === KIND.VERDICT) {
    const q = ctx.request
    if (!q || !bytesEqual(q.id, bind.requestId)) fail('request-mismatch', 'verdict for another request')
    if (!h.card || !bytesEqual(h.card.id, bind.requestId)) fail('request-mismatch', 'the request id is the object id in the header')
    if (!q.pending) fail('request-not-pending', 'the request is no longer waiting')
    if (!bytesEqual(q.hash, bind.requestHash) || q.expiresAt !== bind.expiresAt) fail('request-changed', 'the human approved something else than what was asked')
    if (now > q.expiresAt) fail('request-expired', 'the request has run out')
    return { kind, bind, late }
  }

  const card = ctx.card
  if (!card || !bytesEqual(card.id, bind.objectId)) fail('card-mismatch', 'answer to another card')
  if (!h.card || !bytesEqual(h.card.id, bind.objectId)) fail('card-mismatch', 'header and body name different cards')
  if (!bytesEqual(card.hash, bind.versionHash)) fail('card-changed', 'the human saw a different version of the card')
  if (kind === KIND.ANSWER) {
    if (!card.open) fail('card-closed', 'the card is not open')
    if (!bind.choices.length && card.options?.length) fail('bad-choice', 'an answer names at least one option')
    if (card.options && bind.choices.some(c => !card.options.includes(c))) fail('bad-choice', 'the card has no such option')
  } else {
    if (!ctx.decision || !bytesEqual(ctx.decision.hash, bind.previousHash)) fail('decision-mismatch', 'this is not the decision in force')
  }
  return { kind, bind, late }
}

// ---- assets --------------------------------------------------------------------

export const ASSET_CHUNK = 65536
const assetNonce = (index, last) => { const n = new Uint8Array(12); new DataView(n.buffer).setBigUint64(3, BigInt(index)); n[11] = last ? 1 : 0; return n }
const assetHeader = blobId => new W().u8(VERSION).u8(OBJ.ASSET).raw(blobId, 16, 'blob id').u32(ASSET_CHUNK).done()
const ASSET_HEAD = 22

/**
 * Encrypt a blob under a fresh random key, in 64 KiB chunks (STREAM: chunk number and a last-chunk
 * mark in the nonce). Returns { blob, key, blobId, sha256, size }; key, hash, name and type belong
 * into the encrypted message, only blobId into the envelope header.
 */
export async function encryptAsset(data, opts) {
  const rng = rngOf(opts)
  const key = rng(32), blobId = rng(16)
  const k = await aesKey(key)
  const head = assetHeader(blobId)
  const parts = [head]
  const chunks = Math.max(1, Math.ceil(data.length / ASSET_CHUNK))
  for (let i = 0; i < chunks; i++) {
    parts.push(await gcmSeal(k, assetNonce(i, i === chunks - 1), head, data.subarray(i * ASSET_CHUNK, (i + 1) * ASSET_CHUNK)))
  }
  const blob = concat(...parts)
  return { blob, key, blobId, sha256: await sha256(blob), size: data.length }
}
function assetLayout(blob) {
  const r = new R(blob)
  header(r, OBJ.ASSET)
  const blobId = r.take(16)
  if (r.u32() !== ASSET_CHUNK) fail('bad-format', 'unsupported chunk size')
  const body = blob.length - ASSET_HEAD
  const full = ASSET_CHUNK + 16
  const chunks = Math.ceil(body / full)
  if (chunks < 1 || body - (chunks - 1) * full < 16) fail('bad-format', 'asset is cut off')
  return { blobId, chunks, head: blob.subarray(0, ASSET_HEAD), full }
}
/** Decrypt one chunk (for seeking and partial fetches). */
export async function decryptAssetChunk(blob, key, index) {
  const { chunks, head, full } = assetLayout(blob)
  if (!Number.isInteger(index) || index < 0 || index >= chunks) fail('bad-argument', 'no such chunk')
  const from = ASSET_HEAD + index * full
  return gcmOpen(await aesKey(key), assetNonce(index, index === chunks - 1), head, blob.subarray(from, Math.min(from + full, blob.length)))
}
/** Decrypt a whole blob. Pass `expectedSha256` from the message to bind the blob to it. */
export async function decryptAsset(blob, key, expectedSha256) {
  if (expectedSha256 && !bytesEqual(await sha256(blob), expectedSha256)) fail('decrypt-failed', 'this is not the blob the message names')
  const { chunks } = assetLayout(blob)
  const out = []
  for (let i = 0; i < chunks; i++) out.push(await decryptAssetChunk(blob, key, i))
  return concat(...out)
}

async function assetWrapKey(roomId, secret, blobId) {
  return aesKey(await hkdf(secret.key, roomId, LABEL.assetWrap, concat(epochCtx(secret.epoch), need(blobId, 16, 'blob id')), 32))
}
const assetWrapAad = (roomId, epoch, blobId) => concat(Uint8Array.of(VERSION, OBJ.ASSET_WRAP), roomId, epochCtx(epoch), blobId)

/** 0x01 0x0a epoch(u32) blobId(16) nonce(12) ciphertext(48): an asset key under the room key, random nonce (R9, C12). */
export async function wrapAssetKey(roomId, secret, blobId, assetKey, opts) {
  const nonce = rngOf(opts)(12)
  const ct = await gcmSeal(await assetWrapKey(roomId, secret, blobId), nonce, assetWrapAad(roomId, secret.epoch, blobId), need(assetKey, 32, 'asset key'))
  return concat(Uint8Array.of(VERSION, OBJ.ASSET_WRAP), epochCtx(secret.epoch), blobId, nonce, ct)
}
export async function unwrapAssetKey(roomId, secrets, wrapped) {
  const r = new R(wrapped)
  header(r, OBJ.ASSET_WRAP)
  const epoch = r.u32(), blobId = r.take(16), nonce = r.take(12), ct = r.take(r.left())
  const secret = typeof secrets === 'function' ? secrets(epoch) : secrets?.get(epoch)
  if (!secret) fail('no-key', `no key for epoch ${epoch}`, { epoch })
  return { blobId, epoch, key: await gcmOpen(await assetWrapKey(roomId, secret, blobId), nonce, assetWrapAad(roomId, epoch, blobId), ct) }
}

/** `<url>#a1.<blobId>.<key>`: whoever has the link can read the asset. The fragment never reaches a server. */
export function assetLink(url, blobId, key) {
  return `${url}#a${VERSION}.${b64u(need(blobId, 16, 'blob id'))}.${b64u(need(key, 32, 'asset key'))}`
}
export function parseAssetLink(link) {
  const at = String(link).indexOf('#')
  const parts = at < 0 ? [] : String(link).slice(at + 1).split('.')
  if (parts[0] !== `a${VERSION}`) fail('bad-version', 'asset link version')
  if (parts.length !== 3) fail('bad-format', 'asset link')
  const blobId = unb64u(parts[1]), key = unb64u(parts[2])
  if (blobId.length !== 16 || key.length !== 32) fail('bad-format', 'asset link')
  return { url: String(link).slice(0, at), blobId, key }
}
