// session-grants.mjs: per-session keys (README "Security rules" R6). A session's key lives in a small signed
// chain of grants, one per change: who holds the key (assigned agents; every human device and the recovery key
// always), which key epoch, whether the agents may read back (with_history). Built only on zcrypto exports.
//
// Bytes (agreed with stream A, 4 October 2026):
//   session secret = { epoch, key(32), hist(32) }   (the same shape as a room epoch secret)
//   keyCommit  = KDF(key,  salt empty, "trommi/v1/session-commit/key",  ctx sessionId(16) || epoch u32, 32)
//   histCommit = KDF(hist, salt empty, "trommi/v1/session-commit/hist", ctx sessionId(16) || epoch u32, 32)
//   grant body = 0x01 0x0e || roomId(32) || sessionId(16) || grantNumber u32 || previousGrantHash(32) || sessionKeyEpoch u32
//                || flags u8 (bit 0 with_history) || agentCount u16 || agentId(32) x n (ascending) || keyCommit(32) || histCommit(32)
//                || manifestHash(32) || logSeq u32 || logHash(32) || time u64 || signerId(32)
//   grant      = body || Sign(signer, "trommi/v1/session-grant-sig", body);  grantHash = H("trommi/v1/session-grant", body)
//   wrap       = seal(recipient kexPub, 0x01 || key  (agent without history)  |  0x02 || key || hist  (humans, recovery key, agents with history),
//                     aad "trommi/v1/session-wrap" 0x00 || roomId || sessionId || epoch u32 || recipientId)
//   manifest   = H("trommi/v1/session-manifest", for each recipient ascending: recipientId(32) || SHA-256(wrap))
//   back link n = 0x01 0x0f || sessionId(16) || n u32 || AES-256-GCM(KDF(hist_n, salt roomId || sessionId, "trommi/v1/session-back-link", ctx n u32, 44)
//                 -> key(32) || nonce(12), aad 0x01 0x0f || roomId || sessionId || n u32, key_{n-1} || hist_{n-1})
// Rules (applyGrant): signer an active human at logSeq (or the recovery key); grantNumber/previousGrantHash chain from 0 /
// zeros; first epoch 1; later epoch equal (re-seal, e.g. handover with history) or previous + 1 (rotation); assigned
// agents active agents at logSeq; logSeq/logHash in the verifier's log.
import * as z from './zcrypto.mjs'

const { ZError, concat, bytesEqual, hex, ROLE } = z
const fail = (code, message, extra) => { throw new ZError(code, message, extra) }
const subtle = globalThis.crypto.subtle
const VERSION = 1
export const OBJ_GRANT = 0x0e, OBJ_SESSION_BACK_LINK = 0x0f
export const LABEL = Object.freeze({
  commitKey: 'trommi/v1/session-commit/key', commitHist: 'trommi/v1/session-commit/hist', grantSig: 'trommi/v1/session-grant-sig',
  grant: 'trommi/v1/session-grant', wrap: 'trommi/v1/session-wrap', manifest: 'trommi/v1/session-manifest', backLink: 'trommi/v1/session-back-link',
})
const ZERO32 = new Uint8Array(32)
const FLAG_HISTORY = 1

const u8 = v => Uint8Array.of(v)
const u16 = v => Uint8Array.of(v >> 8, v & 0xff)
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b }
const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b }
const need = (b, n, what) => { if (!(b instanceof Uint8Array) || b.length !== n) fail('bad-argument', `${what} must be ${n} bytes`); return b }
const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length }
const labelBytes = l => concat(new TextEncoder().encode(l), u8(0))

class Reader {
  constructor(b) { this.b = b; this.o = 0; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength) }
  need(n) { if (this.o + n > this.b.length) fail('bad-format', 'truncated grant') }
  u8() { this.need(1); return this.b[this.o++] }
  u16() { this.need(2); const v = this.v.getUint16(this.o); this.o += 2; return v }
  u32() { this.need(4); const v = this.v.getUint32(this.o); this.o += 4; return v }
  u64() { this.need(8); const v = this.v.getBigUint64(this.o); this.o += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('bad-format', 'integer above 2^53-1'); return Number(v) }
  take(n) { this.need(n); const out = this.b.slice(this.o, this.o + n); this.o += n; return out }
  end() { if (this.o !== this.b.length) fail('bad-format', 'trailing bytes') }
}

// ---- secrets and commitments ---------------------------------------------------------------

export function newSessionSecret(epoch) {
  return { epoch, key: globalThis.crypto.getRandomValues(new Uint8Array(32)), hist: globalThis.crypto.getRandomValues(new Uint8Array(32)) }
}
export async function sessionCommits(sessionId, secret) {
  const ctx = concat(need(sessionId, 16, 'session id'), u32(secret.epoch))
  return {
    keyCommit: await z.hkdf(secret.key, new Uint8Array(0), LABEL.commitKey, ctx, 32),
    histCommit: secret.hist ? await z.hkdf(secret.hist, new Uint8Array(0), LABEL.commitHist, ctx, 32) : null,
  }
}

// ---- wraps --------------------------------------------------------------------------------------

const wrapAad = (roomId, sessionId, epoch, recipientId) => concat(labelBytes(LABEL.wrap), roomId, sessionId, u32(epoch), recipientId)

/** recipients: [{ id, kexPub, withHist }] -> [{ id, sealed }] sorted by id. */
export async function wrapSessionKey({ roomId, sessionId, secret, recipients }) {
  const out = []
  for (const r of [...recipients].sort((a, b) => cmp(a.id, b.id))) {
    const plain = r.withHist ? concat(u8(2), secret.key, secret.hist) : concat(u8(1), secret.key)
    out.push({ id: r.id, sealed: await z.seal(r.kexPub, plain, wrapAad(roomId, sessionId, secret.epoch, r.id)) })
  }
  return out
}

/** The hash a grant carries over its wrap set: which recipients got a wrap, and exactly which bytes. */
export async function grantManifestHash(wraps) {
  const parts = []
  for (const w of [...wraps].sort((a, b) => cmp(a.id, b.id))) parts.push(need(w.id, 32, 'recipient id'), await z.sha256(w.sealed))
  return z.hash(LABEL.manifest, ...parts)
}

/** Open the session key sealed to `device` and check it against the grant chain's commitments for that epoch. */
export async function unwrapSessionKey({ roomId, sessionState, device, sealed, epoch }) {
  const plain = await z.openSealed(device, sealed, wrapAad(roomId, z.unhex(sessionState.sessionId), epoch, device.id))
  let secret
  if (plain.length === 33 && plain[0] === 1) secret = { epoch, key: plain.slice(1), hist: null }
  else if (plain.length === 65 && plain[0] === 2) secret = { epoch, key: plain.slice(1, 33), hist: plain.slice(33) }
  else fail('bad-format', 'wrapped session key')
  await checkSessionCommits(sessionState, secret)
  return secret
}
async function checkSessionCommits(sessionState, secret) {
  const info = sessionState.epochs?.get(secret.epoch)
  if (!info) fail('wrong-epoch', `the grants know no session key epoch ${secret.epoch}`)
  const c = await sessionCommits(z.unhex(sessionState.sessionId), secret)
  if (!bytesEqual(c.keyCommit, info.keyCommit)) fail('key-mismatch', 'session key does not match the grant')
  if (secret.hist && !bytesEqual(c.histCommit, info.histCommit)) fail('key-mismatch', 'session history key does not match the grant')
}

// ---- back links ---------------------------------------------------------------------------------

async function backLinkKey(roomId, sessionId, secret) {
  if (!secret.hist) fail('no-key', 'no history key for this session')
  const okm = await z.hkdf(secret.hist, concat(roomId, sessionId), LABEL.backLink, u32(secret.epoch), 44)
  return { key: await subtle.importKey('raw', okm.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']), nonce: okm.slice(32) }
}
const backLinkAad = (roomId, sessionId, epoch) => concat(u8(VERSION), u8(OBJ_SESSION_BACK_LINK), roomId, sessionId, u32(epoch))

export async function makeSessionBackLink({ roomId, sessionId, secret, previous }) {
  if (previous.epoch !== secret.epoch - 1 || !previous.hist) fail('bad-argument', 'a back link needs the full previous session secret')
  const { key, nonce } = await backLinkKey(roomId, sessionId, secret)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: backLinkAad(roomId, sessionId, secret.epoch) }, key, concat(previous.key, previous.hist)))
  return concat(u8(VERSION), u8(OBJ_SESSION_BACK_LINK), sessionId, u32(secret.epoch), ct)
}
export async function openSessionBackLink({ roomId, sessionState, secret, link }) {
  const r = new Reader(link)
  if (r.u8() !== VERSION || r.u8() !== OBJ_SESSION_BACK_LINK) fail('bad-format', 'not a session back link')
  const sessionId = r.take(16)
  if (hex(sessionId) !== sessionState.sessionId) fail('bad-format', 'back link of another session')
  if (r.u32() !== secret.epoch) fail('wrong-epoch', 'back link of another epoch')
  const { key, nonce } = await backLinkKey(roomId, sessionId, secret)
  let plain
  try { plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: backLinkAad(roomId, sessionId, secret.epoch) }, key, r.take(link.length - r.o))) }
  catch { fail('decrypt-failed', 'session back link') }
  if (plain.length !== 64) fail('bad-format', 'session back link')
  const previous = { epoch: secret.epoch - 1, key: plain.slice(0, 32), hist: plain.slice(32) }
  await checkSessionCommits(sessionState, previous)
  return previous
}

// ---- grants -------------------------------------------------------------------------------------

export function decodeGrant(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) fail('bad-format', 'grant too short')
  const body = bytes.slice(0, bytes.length - 64), signature = bytes.slice(bytes.length - 64)
  const r = new Reader(body)
  if (r.u8() !== VERSION) fail('bad-version', 'grant version')
  if (r.u8() !== OBJ_GRANT) fail('bad-format', 'not a session grant')
  const g = { roomId: r.take(32), sessionId: r.take(16), grantNumber: r.u32(), previousGrantHash: r.take(32), epoch: r.u32() }
  const flags = r.u8()
  if (flags & ~FLAG_HISTORY) fail('bad-format', 'unknown grant flags')
  g.withHistory = !!(flags & FLAG_HISTORY)
  const n = r.u16()
  g.agentIds = []
  for (let i = 0; i < n; i++) {
    const id = r.take(32)
    if (i && cmp(g.agentIds[i - 1], id) >= 0) fail('bad-format', 'agent ids not strictly ascending')
    g.agentIds.push(id)
  }
  Object.assign(g, { keyCommit: r.take(32), histCommit: r.take(32), manifestHash: r.take(32), logSeq: r.u32(), logHash: r.take(32), time: r.u64(), signerId: r.take(32) })
  r.end()
  return { ...g, body, signature }
}

/**
 * Make the next grant of a session (or its first: sessionState null). Returns { grant, secret, wraps, backLink, sessionState }.
 * rotate: a new session key epoch (removal, unassigning, "may not read the history"); else the current key is re-sealed.
 * `current`: the session secret of the current epoch (needed to re-seal and for the back link).
 */
export async function createSessionGrant({ state, signer, sessionState = null, sessionId = null, current = null, agentIds = [], withHistory = false, rotate = false, time = Date.now() }) {
  const signerKind = z.memberAt(state, signer.id)
  const isRecovery = bytesEqual(signer.id, state.recovery.id)
  if (!isRecovery && (!signerKind || signerKind.role !== ROLE.HUMAN)) fail('not-human', 'only a human device (or the recovery key) grants session keys')
  const sid = sessionState ? z.unhex(sessionState.sessionId) : need(sessionId ?? globalThis.crypto.getRandomValues(new Uint8Array(16)), 16, 'session id')
  let secret
  if (!sessionState) secret = newSessionSecret(1)
  else if (rotate) secret = newSessionSecret(sessionState.epoch + 1)
  else { if (!current || current.epoch !== sessionState.epoch || !current.hist) fail('bad-argument', 'pass the full current session secret to re-seal it'); secret = current }
  const ids = [...agentIds].map(id => typeof id === 'string' ? z.unhex(id) : id).sort(cmp)
  for (const id of ids) { const m = z.memberAt(state, id); if (!m || m.role !== ROLE.AGENT) fail('bad-argument', 'only active agents can be assigned to a session') }
  const recipients = [
    ...z.activeMembers(state).filter(m => m.role === ROLE.HUMAN).map(m => ({ id: m.id, kexPub: m.kexPub, withHist: true })),
    { id: state.recovery.id, kexPub: state.recovery.kexPub, withHist: true },
    ...ids.map(id => ({ id, kexPub: z.memberAt(state, id).kexPub, withHist: withHistory })),
  ]
  const wraps = await wrapSessionKey({ roomId: state.roomId, sessionId: sid, secret, recipients })
  const commits = await sessionCommits(sid, secret)
  const body = concat(u8(VERSION), u8(OBJ_GRANT), state.roomId, sid, u32(sessionState ? sessionState.grantNumber + 1 : 0), sessionState ? sessionState.grantHash : ZERO32,
    u32(secret.epoch), u8(withHistory ? FLAG_HISTORY : 0), u16(ids.length), ...ids, commits.keyCommit, commits.histCommit, await grantManifestHash(wraps),
    u32(state.head.seq), state.head.hash, u64(time), signer.id)
  const grant = concat(body, await z.sign(signer, LABEL.grantSig, body))
  const backLink = sessionState && rotate && current?.hist ? await makeSessionBackLink({ roomId: state.roomId, sessionId: sid, secret, previous: current }) : null
  return { grant, secret, wraps, backLink, sessionState: await applyGrant(sessionState, grant, state) }
}

/**
 * Verify one grant against the session's state before it (null for the first) and the room's verified member list.
 * Returns the new session state; never mutates. sessionState = { sessionId (hex), grantNumber, grantHash (bytes), epoch,
 * agentIds: [hex], withHistory, keyCommit, histCommit, manifestHash, logSeq, signerId (hex), epochs: Map(epoch -> { keyCommit, histCommit, withHistory }) }.
 */
export async function applyGrant(sessionState, grantBytes, roomState) {
  const g = decodeGrant(grantBytes)
  const bad = why => fail('bad-grant', `grant ${g.grantNumber}: ${why}`)
  if (!bytesEqual(g.roomId, roomState.roomId)) fail('wrong-room', 'grant of another room')
  if (g.logSeq > roomState.head.seq) fail('log-behind', `the grant names member list entry ${g.logSeq}`, { logSeq: g.logSeq })
  if (!bytesEqual(roomState.hashes[g.logSeq], g.logHash)) fail('log-fork', `the grant names another member list entry ${g.logSeq}`)
  const isRecovery = bytesEqual(g.signerId, roomState.recovery.id)
  const signer = isRecovery ? null : z.memberAt(roomState, g.signerId, g.logSeq)
  if (!isRecovery && (!signer || signer.role !== ROLE.HUMAN)) bad('the signer is not an active human device')
  if (!await z.verify(isRecovery ? roomState.recovery.signPub : signer.signPub, LABEL.grantSig, g.body, g.signature)) fail('bad-signature', 'session grant')
  if (!sessionState) {
    if (g.grantNumber !== 0 || !bytesEqual(g.previousGrantHash, ZERO32) || g.epoch !== 1) bad('the first grant has number 0, no predecessor and epoch 1')
  } else {
    if (hex(g.sessionId) !== sessionState.sessionId) bad('another session')
    if (g.grantNumber !== sessionState.grantNumber + 1) bad(`number ${g.grantNumber} does not follow ${sessionState.grantNumber}`)
    if (!bytesEqual(g.previousGrantHash, sessionState.grantHash)) bad('predecessor hash does not match')
    if (g.epoch !== sessionState.epoch && g.epoch !== sessionState.epoch + 1) bad(`epoch ${g.epoch} after ${sessionState.epoch}`)
    if (g.epoch === sessionState.epoch && (!bytesEqual(g.keyCommit, sessionState.keyCommit) || !bytesEqual(g.histCommit, sessionState.histCommit))) bad('same epoch, different key')
  }
  for (const id of g.agentIds) { const m = z.memberAt(roomState, id, g.logSeq); if (!m || m.role !== ROLE.AGENT) bad('an assigned device is not an active agent') }
  const epochs = new Map(sessionState?.epochs ?? [])
  const prevInfo = epochs.get(g.epoch)
  epochs.set(g.epoch, { keyCommit: g.keyCommit, histCommit: g.histCommit, withHistory: g.withHistory || !!prevInfo?.withHistory })
  return {
    sessionId: hex(g.sessionId), grantNumber: g.grantNumber, grantHash: await z.hash(LABEL.grant, g.body), epoch: g.epoch, agentIds: g.agentIds.map(hex),
    withHistory: g.withHistory, keyCommit: g.keyCommit, histCommit: g.histCommit, manifestHash: g.manifestHash, logSeq: g.logSeq, signerId: hex(g.signerId), time: g.time, epochs,
  }
}

/** Verify a whole grant chain. */
export async function verifyGrants(grants, roomState) {
  let s = null
  for (const g of grants) s = await applyGrant(s, g, roomState)
  return s
}
