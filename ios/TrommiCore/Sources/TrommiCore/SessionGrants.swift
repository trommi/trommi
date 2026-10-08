// SessionGrants.swift: per-session keys (FORMAT.md section 19), as session-grants.mjs: grant chain, wraps,
// manifest, back links, staleness.
import Foundation

private let FLAG_HISTORY = 1

public struct SessionEpochInfo: Equatable { public let keyCommit: Bytes, histCommit: Bytes, withHistory: Bool }
public struct SessionState {
  public let sessionId: String               // hex
  public let grantNumber: Int
  public let grantHash: Bytes
  public let epoch: Int
  public let agentIds: [String]               // hex
  public let withHistory: Bool
  public let keyCommit: Bytes
  public let histCommit: Bytes
  public let manifestHash: Bytes
  public let logSeq: Int
  public let signerId: String
  public let time: UInt64
  public let epochs: [Int: SessionEpochInfo]
  public let creatorId: String
  public let createdByAgent: Bool
  public let stale: Bool
}

public func sessionCommits(sessionId: Bytes, _ s: EpochSecret) throws -> (keyCommit: Bytes, histCommit: Bytes?) {
  let ctx = (try need(sessionId, 16, "session id")) + u32Bytes(s.epoch)
  return (hkdf(s.key, salt: [], label: LABEL.sessionCommitKey, context: ctx, length: 32), s.hist.map { hkdf($0, salt: [], label: LABEL.sessionCommitHist, context: ctx, length: 32) })
}
private func sessionWrapAad(_ roomId: Bytes, _ sessionId: Bytes, _ epoch: Int, _ recipientId: Bytes) -> Bytes {
  labelBytes(LABEL.sessionWrap) + roomId + sessionId + u32Bytes(epoch) + recipientId
}
public struct SessionRecipient { public let id: Bytes, kexPub: Bytes, withHist: Bool; public init(id: Bytes, kexPub: Bytes, withHist: Bool) { self.id = id; self.kexPub = kexPub; self.withHist = withHist } }
public func wrapSessionKey(roomId: Bytes, sessionId: Bytes, secret: EpochSecret, recipients: [SessionRecipient], rng: RNG = systemRandom) throws -> [(id: Bytes, sealed: Bytes)] {
  try recipients.sorted { compareBytes($0.id, $1.id) < 0 }.map { r in
    let plain: Bytes = r.withHist ? [2] + secret.key + (secret.hist ?? []) : [1] + secret.key
    return (r.id, try seal(r.kexPub, plain, aad: sessionWrapAad(roomId, sessionId, secret.epoch, r.id), rng: rng))
  }
}
public func grantManifestHash(_ wraps: [(id: Bytes, sealed: Bytes)]) throws -> Bytes {
  var parts = [Bytes]()
  for w in wraps.sorted(by: { compareBytes($0.id, $1.id) < 0 }) { parts.append(try need(w.id, 32, "recipient id")); parts.append(sha256(w.sealed)) }
  return hash(LABEL.sessionManifest, parts: parts)
}
private func checkSessionCommits(_ ss: SessionState, _ s: EpochSecret) throws {
  guard let info = ss.epochs[s.epoch] else { throw fail("wrong-epoch", "the grants know no session key epoch \(s.epoch)") }
  let c = try sessionCommits(sessionId: try unhex(ss.sessionId), s)
  if !bytesEqual(c.keyCommit, info.keyCommit) { throw fail("key-mismatch", "session key does not match the grant") }
  if s.hist != nil && !bytesEqual(c.histCommit, info.histCommit) { throw fail("key-mismatch", "session history key does not match the grant") }
}
/** Open the session key sealed to `device` and check it against the grant chain's commitments for that epoch. */
public func unwrapSessionKey(roomId: Bytes, sessionState: SessionState, device: Device, sealed: Bytes, epoch: Int) throws -> EpochSecret {
  let plain = try openSealed(device, sealed, aad: sessionWrapAad(roomId, try unhex(sessionState.sessionId), epoch, device.id))
  let s: EpochSecret
  if plain.count == 33 && plain[0] == 1 { s = EpochSecret(epoch: epoch, key: Array(plain[1...]), hist: nil) }
  else if plain.count == 65 && plain[0] == 2 { s = EpochSecret(epoch: epoch, key: Array(plain[1..<33]), hist: Array(plain[33...])) }
  else { throw fail("bad-format", "wrapped session key") }
  try checkSessionCommits(sessionState, s)
  return s
}

private func sessionBackLinkKey(_ roomId: Bytes, _ sessionId: Bytes, _ s: EpochSecret) throws -> (key: Bytes, nonce: Bytes) {
  guard let hist = s.hist else { throw fail("no-key", "no history key for this session") }
  let okm = hkdf(hist, salt: roomId + sessionId, label: LABEL.sessionBackLink, context: u32Bytes(s.epoch), length: 44)
  return (Array(okm[0..<32]), Array(okm[32...]))
}
private func sessionBackLinkAad(_ roomId: Bytes, _ sessionId: Bytes, _ epoch: Int) -> Bytes { [VERSION, OBJ.SESSION_BACK_LINK] + roomId + sessionId + u32Bytes(epoch) }
public func makeSessionBackLink(roomId: Bytes, sessionId: Bytes, secret: EpochSecret, previous: EpochSecret) throws -> Bytes {
  guard previous.epoch == secret.epoch - 1, let ph = previous.hist else { throw fail("bad-argument", "a back link needs the full previous session secret") }
  let k = try sessionBackLinkKey(roomId, sessionId, secret)
  return [VERSION, OBJ.SESSION_BACK_LINK] + sessionId + u32Bytes(secret.epoch) + (try gcmSeal(key: k.key, nonce: k.nonce, aad: sessionBackLinkAad(roomId, sessionId, secret.epoch), previous.key + ph))
}
public func openSessionBackLink(roomId: Bytes, sessionState: SessionState, secret: EpochSecret, link: Bytes) throws -> EpochSecret {
  var r = R(link)
  if try r.u8() != Int(VERSION) || r.u8() != Int(OBJ.SESSION_BACK_LINK) { throw fail("bad-format", "not a session back link") }
  let sid = try r.take(16)
  if hex(sid) != sessionState.sessionId { throw fail("bad-format", "back link of another session") }
  if try r.u32() != secret.epoch { throw fail("wrong-epoch", "back link of another epoch") }
  let k = try sessionBackLinkKey(roomId, sid, secret)
  let plain = try gcmOpen(key: k.key, nonce: k.nonce, aad: sessionBackLinkAad(roomId, sid, secret.epoch), try r.take(r.left))
  if plain.count != 64 { throw fail("bad-format", "session back link") }
  let prev = EpochSecret(epoch: secret.epoch - 1, key: Array(plain[0..<32]), hist: Array(plain[32...]))
  try checkSessionCommits(sessionState, prev)
  return prev
}

public struct Grant { public let roomId, sessionId: Bytes; public let grantNumber: Int; public let previousGrantHash: Bytes; public let epoch: Int; public let withHistory: Bool
  public let agentIds: [Bytes]; public let keyCommit, histCommit, manifestHash: Bytes; public let logSeq: Int; public let logHash: Bytes; public let time: UInt64; public let signerId, body, signature: Bytes }

public func decodeGrant(_ bytes: Bytes) throws -> Grant {
  if bytes.count < 64 { throw fail("bad-format", "grant too short") }
  let body = Array(bytes[0..<(bytes.count - 64)])
  var r = R(body)
  if try r.u8() != Int(VERSION) { throw fail("bad-version", "grant version") }
  if try r.u8() != Int(OBJ.GRANT) { throw fail("bad-format", "not a session grant") }
  let roomId = try r.take(32), sid = try r.take(16), num = try r.u32(), prev = try r.take(32), epoch = try r.u32()
  let flags = try r.u8()
  if flags & ~FLAG_HISTORY != 0 { throw fail("bad-format", "unknown grant flags") }
  let n = try r.u16()
  var ids = [Bytes]()
  for i in 0..<n {
    let id = try r.take(32)
    if i > 0 && compareBytes(ids[i - 1], id) >= 0 { throw fail("bad-format", "agent ids not strictly ascending") }
    ids.append(id)
  }
  let g = Grant(roomId: roomId, sessionId: sid, grantNumber: num, previousGrantHash: prev, epoch: epoch, withHistory: flags & FLAG_HISTORY != 0, agentIds: ids,
                keyCommit: try r.take(32), histCommit: try r.take(32), manifestHash: try r.take(32), logSeq: try r.u32(), logHash: try r.take(32), time: try r.u64(),
                signerId: try r.take(32), body: body, signature: Array(bytes[(bytes.count - 64)...]))
  try r.end()
  return g
}

private func memberChanges(_ s: RoomState) -> [Int] { s.entries.filter { $0.type == ENTRY.REMOVE || $0.type == ENTRY.RECOVER }.map { $0.seq } }
private func changeBetween(_ s: RoomState, _ a: Int, _ b: Int) -> Bool { memberChanges(s).contains { $0 > a && $0 <= b } }
public func grantIsStale(_ ss: SessionState?, _ s: RoomState) -> Bool { ss.map { changeBetween(s, $0.logSeq, s.head.seq) } ?? false }
private func recoveryIdAt(_ s: RoomState, _ logSeq: Int) throws -> PublicDevice? {
  var rec: (signPub: Bytes, kexPub: Bytes)? = nil
  for e in s.entries { if e.seq > logSeq { break }; if e.type == ENTRY.GENESIS || e.type == ENTRY.RECOVER { rec = e.recovery } }
  return try rec.map { try PublicDevice(signPub: $0.signPub, kexPub: $0.kexPub) }
}

/** Verify one grant against the session's state before it (nil for the first) and the verified member list. */
public func applyGrant(_ ss: SessionState?, _ grantBytes: Bytes, _ room: RoomState) throws -> SessionState {
  let g = try decodeGrant(grantBytes)
  func bad(_ why: String) -> ZError { fail("bad-grant", "grant \(g.grantNumber): \(why)") }
  if !bytesEqual(g.roomId, room.roomId) { throw fail("wrong-room", "grant of another room") }
  if g.logSeq > room.head.seq { throw fail("log-behind", "the grant names member list entry \(g.logSeq)") }
  if !bytesEqual(room.hashes[g.logSeq], g.logHash) { throw fail("log-fork", "the grant names another member list entry \(g.logSeq)") }
  let rec = try recoveryIdAt(room, g.logSeq)
  let isRecovery = rec.map { bytesEqual(g.signerId, $0.id) } ?? false
  let signer = isRecovery ? nil : room.memberAt(g.signerId, g.logSeq)
  let agentOwn = !isRecovery && signer?.role == ROLE.AGENT && ss == nil && g.agentIds.count == 1 && bytesEqual(g.agentIds[0], g.signerId) && !g.withHistory
  if !isRecovery && !agentOwn && (signer == nil || signer!.role != ROLE.HUMAN) {
    throw bad(signer?.role == ROLE.AGENT ? "an agent signs only the first grant of a session of its own, assigned to itself alone" : "the signer is not an active human device")
  }
  if !verify(isRecovery ? rec!.signPub : signer!.signPub, LABEL.sessionGrantSig, g.body, g.signature) { throw fail("bad-signature", "session grant") }
  if let ss = ss {
    if hex(g.sessionId) != ss.sessionId { throw bad("another session") }
    if g.grantNumber != ss.grantNumber + 1 { throw bad("number \(g.grantNumber) does not follow \(ss.grantNumber)") }
    if !bytesEqual(g.previousGrantHash, ss.grantHash) { throw bad("predecessor hash does not match") }
    if g.epoch != ss.epoch && g.epoch != ss.epoch + 1 { throw bad("epoch \(g.epoch) after \(ss.epoch)") }
    if g.epoch == ss.epoch && (!bytesEqual(g.keyCommit, ss.keyCommit) || !bytesEqual(g.histCommit, ss.histCommit)) { throw bad("same epoch, different key") }
    if changeBetween(room, min(g.logSeq, ss.logSeq), max(g.logSeq, ss.logSeq)) {
      if g.logSeq < ss.logSeq { throw bad("names a member list entry before a removal its predecessor already saw") }
      if g.epoch == ss.epoch { throw bad("after a removal or recovery the session key must change") }
    }
    if g.epoch == ss.epoch && !ss.agentIds.allSatisfy({ a in g.agentIds.contains { hex($0) == a } }) { throw bad("an agent loses the session: the key must change") }
  } else if g.grantNumber != 0 || !isZero(g.previousGrantHash) || g.epoch != 1 {
    throw bad("the first grant has number 0, no predecessor and epoch 1")
  }
  for id in g.agentIds { guard let m = room.memberAt(id, g.logSeq), m.role == ROLE.AGENT else { throw bad("an assigned device is not an active agent") } }
  var epochs = ss?.epochs ?? [:]
  let prevInfo = epochs[g.epoch]
  epochs[g.epoch] = SessionEpochInfo(keyCommit: g.keyCommit, histCommit: g.histCommit, withHistory: g.withHistory || (prevInfo?.withHistory ?? false))
  return SessionState(sessionId: hex(g.sessionId), grantNumber: g.grantNumber, grantHash: hash(LABEL.sessionGrant, g.body), epoch: g.epoch, agentIds: g.agentIds.map(hex),
                      withHistory: g.withHistory, keyCommit: g.keyCommit, histCommit: g.histCommit, manifestHash: g.manifestHash, logSeq: g.logSeq, signerId: hex(g.signerId),
                      time: g.time, epochs: epochs, creatorId: ss?.creatorId ?? hex(g.signerId), createdByAgent: ss.map { $0.createdByAgent } ?? agentOwn,
                      stale: changeBetween(room, g.logSeq, room.head.seq))
}
public func verifyGrants(_ grants: [Bytes], _ room: RoomState) throws -> SessionState? {
  var s: SessionState? = nil
  for g in grants { s = try applyGrant(s, g, room) }
  return s
}

/**
 * The next grant of a session (a human device re-seals or rotates). Returns the grant, its wraps and back link.
 * Used by a new human device that must re-seal nothing (the inviter does that); kept for parity tests.
 */
public func createSessionGrant(state: RoomState, signer: Device, sessionState: SessionState?, sessionId: Bytes? = nil, current: EpochSecret? = nil, agentIds: [Bytes] = [],
                               withHistory: Bool = false, rotate: Bool = false, time: UInt64 = nowMs(), rng: RNG = systemRandom) throws -> (grant: Bytes, secret: EpochSecret, wraps: [(id: Bytes, sealed: Bytes)], backLink: Bytes?, sessionState: SessionState) {
  let isRecovery = bytesEqual(signer.id, state.recovery.id)
  if !isRecovery && state.memberAt(signer.id)?.role != ROLE.HUMAN { throw fail("not-human", "only a human device (or the recovery key) grants session keys") }
  let sid = try sessionState.map { try unhex($0.sessionId) } ?? (try need(sessionId ?? rng(16), 16, "session id"))
  let secret: EpochSecret
  if sessionState == nil { secret = newEpochSecret(1, rng: rng) }
  else if rotate { secret = newEpochSecret(sessionState!.epoch + 1, rng: rng) }
  else { guard let c = current, c.epoch == sessionState!.epoch, c.hist != nil else { throw fail("bad-argument", "pass the full current session secret to re-seal it") }; secret = c }
  let ids = agentIds.sorted { compareBytes($0, $1) < 0 }
  for id in ids { guard state.memberAt(id)?.role == ROLE.AGENT else { throw fail("bad-argument", "only active agents can be assigned to a session") } }
  let recipients = state.activeMembers.filter { $0.role == ROLE.HUMAN }.map { SessionRecipient(id: $0.id, kexPub: $0.kexPub, withHist: true) }
    + [SessionRecipient(id: state.recovery.id, kexPub: state.recovery.kexPub, withHist: true)]
    + ids.map { SessionRecipient(id: $0, kexPub: state.memberAt($0)!.kexPub, withHist: withHistory) }
  let wraps = try wrapSessionKey(roomId: state.roomId, sessionId: sid, secret: secret, recipients: recipients, rng: rng)
  let c = try sessionCommits(sessionId: sid, secret)
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.GRANT)).raw(state.roomId, 32).raw(sid, 16).u32(sessionState.map { $0.grantNumber + 1 } ?? 0).raw(sessionState?.grantHash ?? ZERO32, 32)
  try w.u32(secret.epoch).u8(withHistory ? FLAG_HISTORY : 0).u16(ids.count)
  for id in ids { try w.raw(id, 32) }
  try w.raw(c.keyCommit, 32).raw(c.histCommit!, 32).raw(try grantManifestHash(wraps), 32).u32(state.head.seq).raw(state.head.hash, 32).u64(time).raw(signer.id, 32)
  let grant = w.out + (try signer.sign(LABEL.sessionGrantSig, w.out))
  let backLink = (sessionState != nil && rotate && current?.hist != nil) ? try makeSessionBackLink(roomId: state.roomId, sessionId: sid, secret: secret, previous: current!) : nil
  return (grant, secret, wraps, backLink, try applyGrant(sessionState, grant, state))
}
