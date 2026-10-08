// Log.swift: the membership log (FORMAT.md section 6) and room key epochs (section 7), as zcrypto.mjs
// applyEntry / verifyLog / epoch wraps / back links.
import Foundation

public enum ENTRY { public static let GENESIS = 1, ADD = 2, REMOVE = 3, RECOVER = 5 }
public enum SIGNER { public static let DEVICE = 1, RECOVERY = 2 }

public struct Member: Equatable {
  public let role: Int
  public let signPub: Bytes
  public let kexPub: Bytes
  public init(role: Int, signPub: Bytes, kexPub: Bytes) { self.role = role; self.signPub = signPub; self.kexPub = kexPub }
}
public struct Removed: Equatable {
  public let id: Bytes, seq: UInt64, hash: Bytes
  public init(id: Bytes, seq: UInt64, hash: Bytes) { self.id = id; self.seq = seq; self.hash = hash }
}
public struct Cut: Equatable { public let seq: UInt64, hash: Bytes; public init(seq: UInt64, hash: Bytes) { self.seq = seq; self.hash = hash } }

public struct Entry {
  public var type: Int
  public var seq: Int
  public var prev: Bytes
  public var time: UInt64
  public var signerKind: Int
  public var signer: Bytes
  public var roomNonce: Bytes? = nil
  public var member: Member? = nil
  public var recovery: (signPub: Bytes, kexPub: Bytes)? = nil
  public var epoch: Int? = nil
  public var keyCommit: Bytes? = nil
  public var histCommit: Bytes? = nil
  public var inviteId: Bytes? = nil
  public var removed: [Removed] = []
  public var body: Bytes = []
  public var signature: Bytes = []
  public var ids: [Bytes] { removed.map { $0.id } }
}

public struct MemberState {
  public let id: Bytes
  public let role: Int
  public let signPub: Bytes
  public let kexPub: Bytes
  public let addedSeq: Int
  public var removedSeq: Int?
  public var cut: Cut?
}
public struct EpochInfo { public let seq: Int, keyCommit: Bytes, histCommit: Bytes }

public struct RoomState {
  public var roomId: Bytes
  public var head: (seq: Int, hash: Bytes)
  public var hashes: [Bytes]
  public var entries: [Entry]
  public var members: [String: MemberState]          // hex id -> member
  public var memberOrder: [String]                    // insertion order (JS Map order)
  public var epoch: Int
  public var epochs: [Int: EpochInfo]
  public var recovery: PublicDevice
  public var inviteIds: Set<String>
  public var lastRecoverSeq: Int

  public func member(_ id: Bytes) -> MemberState? { members[hex(id)] }
  /** The member with this id if it was active once entry `logSeq` had been applied, else nil. */
  public func memberAt(_ id: Bytes, _ logSeq: Int? = nil) -> MemberState? {
    let at = logSeq ?? head.seq
    guard let m = members[hex(id)], m.addedSeq <= at else { return nil }
    if let r = m.removedSeq, r <= at { return nil }
    return m
  }
  public var activeMembers: [MemberState] { memberOrder.compactMap { members[$0] }.filter { $0.removedSeq == nil } }
  public func epochAt(_ logSeq: Int? = nil) -> Int {
    let at = logSeq ?? head.seq
    return epochs.filter { $0.value.seq <= at }.map { $0.key }.max() ?? 0
  }
}

// ---- encoding ----------------------------------------------------------------------

private func writeMember(_ w: W, _ m: Member) throws {
  if m.role != ROLE.HUMAN && m.role != ROLE.AGENT { throw fail("bad-argument", "role") }
  try w.u8(m.role).raw(m.signPub, 32, "signPub").raw(m.kexPub, 32, "kexPub")
}
private func readMember(_ r: inout R) throws -> Member {
  let role = try r.u8()
  if role != ROLE.HUMAN && role != ROLE.AGENT { throw fail("bad-format", "unknown role") }
  return Member(role: role, signPub: try r.take(32), kexPub: try r.take(32))
}
private func writeRemoved(_ w: W, _ removed: [Removed]) throws {
  let sorted = removed.sorted { compareBytes($0.id, $1.id) < 0 }
  for i in sorted.indices.dropFirst() where compareBytes(sorted[i - 1].id, sorted[i].id) == 0 { throw fail("bad-argument", "duplicate id") }
  try w.u16(sorted.count)
  for x in sorted { try w.raw(x.id, 32, "id").u64(x.seq).raw(x.hash, 32, "cut hash") }
}
private func readRemoved(_ r: inout R) throws -> [Removed] {
  let n = try r.u16()
  var out = [Removed]()
  for i in 0..<n {
    let x = Removed(id: try r.take(32), seq: try r.u64(), hash: try r.take(32))
    if i > 0 && compareBytes(out[i - 1].id, x.id) >= 0 { throw fail("bad-format", "ids not strictly ascending") }
    if x.seq == 0 && !isZero(x.hash) { throw fail("bad-format", "a cut without an envelope has a zero hash") }
    out.append(x)
  }
  return out
}

public func encodeEntryBody(_ e: Entry) throws -> Bytes {
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.LOG_ENTRY)).u8(e.type).u32(e.seq).raw(e.prev, 32, "prev").u64(e.time).u8(e.signerKind).raw(e.signer, 32, "signer")
  func epoch(_ w: W) throws {
    guard let ep = e.epoch, let k = e.keyCommit, let h = e.histCommit else { throw fail("bad-argument", "epoch") }
    try w.u32(ep).raw(k, 32, "keyCommit").raw(h, 32, "histCommit")
  }
  func recovery(_ w: W) throws {
    guard let rc = e.recovery else { throw fail("bad-argument", "recovery") }
    try w.raw(rc.signPub, 32, "recovery signPub").raw(rc.kexPub, 32, "recovery kexPub")
  }
  switch e.type {
  case ENTRY.GENESIS:
    try w.raw(e.roomNonce ?? [], 16, "roomNonce"); try writeMember(w, e.member!); try recovery(w); try epoch(w)
  case ENTRY.ADD:
    try writeMember(w, e.member!); try w.raw(e.inviteId ?? ZERO16, 16, "inviteId")
  case ENTRY.REMOVE:
    try writeRemoved(w, e.removed); try epoch(w)
  case ENTRY.RECOVER:
    try writeMember(w, e.member!); try writeRemoved(w, e.removed); try epoch(w); try recovery(w)
  default: throw fail("bad-argument", "entry type")
  }
  return w.out
}

/** Parse an entry without judging it. Wire form: body ‖ signature(64). */
public func decodeEntry(_ bytes: Bytes) throws -> Entry {
  if bytes.count < 64 { throw fail("bad-format", "entry too short") }
  let body = Array(bytes[0..<(bytes.count - 64)])
  var r = R(body)
  try header(&r, OBJ.LOG_ENTRY)
  var e = Entry(type: try r.u8(), seq: try r.u32(), prev: try r.take(32), time: try r.u64(), signerKind: try r.u8(), signer: try r.take(32))
  func epoch(_ r: inout R) throws { e.epoch = try r.u32(); e.keyCommit = try r.take(32); e.histCommit = try r.take(32) }
  func recovery(_ r: inout R) throws { e.recovery = (try r.take(32), try r.take(32)) }
  switch e.type {
  case ENTRY.GENESIS: e.roomNonce = try r.take(16); e.member = try readMember(&r); try recovery(&r); try epoch(&r)
  case ENTRY.ADD: e.member = try readMember(&r); e.inviteId = try r.take(16)
  case ENTRY.REMOVE: e.removed = try readRemoved(&r); try epoch(&r)
  case ENTRY.RECOVER: e.member = try readMember(&r); e.removed = try readRemoved(&r); try epoch(&r); try recovery(&r)
  default: throw fail("bad-format", "unknown entry type")
  }
  try r.end()
  if e.signerKind != SIGNER.DEVICE && e.signerKind != SIGNER.RECOVERY { throw fail("bad-format", "unknown signer kind") }
  e.body = body
  e.signature = Array(bytes[(bytes.count - 64)...])
  return e
}

public func signEntry(_ e: Entry, _ signer: Device) throws -> Bytes {
  let body = try encodeEntryBody(e)
  return body + (try signer.sign(LABEL.logSig, body))
}

/** X25519 ignores bit 255: exchange keys are compared with that bit cleared (C24). */
private func kexCanon(_ k: Bytes) -> Bytes { var c = k; if c.count == 32 { c[31] &= 0x7f }; return c }
private func keysClash(_ aSign: Bytes, _ aKex: Bytes, _ bSign: Bytes, _ bKex: Bytes) -> Bool {
  bytesEqual(aSign, bSign) || bytesEqual(kexCanon(aKex), kexCanon(bKex))
}

/** Verify one entry against the state before it (nil for genesis) and return the state after it. */
public func applyEntry(_ state: RoomState?, _ entryBytes: Bytes) throws -> RoomState {
  let e = try decodeEntry(entryBytes)
  let entryHash = hash(LABEL.logEntry, e.body)
  func bad(_ why: String) -> ZError { fail("bad-entry", "entry \(e.seq): \(why)") }
  func checkSig(_ pub: Bytes) throws { if !verify(pub, LABEL.logSig, e.body, e.signature) { throw fail("bad-signature", "entry \(e.seq)") } }

  guard let state = state else {
    if e.type != ENTRY.GENESIS { throw bad("a log starts with a genesis entry") }
    if e.seq != 0 || !isZero(e.prev) { throw bad("genesis must have number 0 and no predecessor") }
    guard let m = e.member, e.signerKind == SIGNER.DEVICE, m.role == ROLE.HUMAN else { throw bad("genesis must be signed by a human device") }
    let id = try deviceId(m.signPub, m.kexPub)
    if !bytesEqual(id, e.signer) { throw bad("signer is not the founding device") }
    if e.epoch != 1 { throw bad("the first epoch is 1") }
    try checkSig(m.signPub)
    let rec = try PublicDevice(signPub: e.recovery!.signPub, kexPub: e.recovery!.kexPub)
    if bytesEqual(rec.id, id) || keysClash(rec.signPub, rec.kexPub, m.signPub, m.kexPub) { throw bad("recovery key equals the device key") }
    return RoomState(roomId: entryHash, head: (0, entryHash), hashes: [entryHash], entries: [e],
                     members: [hex(id): MemberState(id: id, role: m.role, signPub: m.signPub, kexPub: m.kexPub, addedSeq: 0, removedSeq: nil, cut: nil)],
                     memberOrder: [hex(id)], epoch: 1, epochs: [1: EpochInfo(seq: 0, keyCommit: e.keyCommit!, histCommit: e.histCommit!)],
                     recovery: rec, inviteIds: [], lastRecoverSeq: -1)
  }

  if e.type == ENTRY.GENESIS { throw bad("a second genesis entry") }
  if e.seq != state.head.seq + 1 { throw bad("number \(e.seq) does not follow \(state.head.seq)") }
  if !bytesEqual(e.prev, state.head.hash) { throw bad("predecessor hash does not match") }

  if e.type == ENTRY.RECOVER {
    if e.signerKind != SIGNER.RECOVERY || !bytesEqual(e.signer, state.recovery.id) { throw bad("only the recovery key may sign a recovery") }
    try checkSig(state.recovery.signPub)
  } else if e.signerKind == SIGNER.RECOVERY {
    if e.type != ENTRY.ADD || e.member?.role != ROLE.HUMAN || !isZero(e.inviteId ?? []) { throw bad("the recovery key signs recoveries and the add of a human device without an invite only") }
    if !bytesEqual(e.signer, state.recovery.id) { throw bad("not the recovery key of this room") }
    try checkSig(state.recovery.signPub)
  } else {
    if e.signerKind != SIGNER.DEVICE { throw bad("the recovery key signs recovery entries only") }
    guard let m = state.member(e.signer), m.removedSeq == nil else { throw bad("signer is not a member") }
    if m.role != ROLE.HUMAN { throw bad("agents may not change the membership") }
    try checkSig(m.signPub)
  }

  var next = state
  func addMember(_ member: Member) throws {
    let id = try deviceId(member.signPub, member.kexPub)
    if next.members[hex(id)] != nil { throw bad("this device was already a member (removed devices cannot return)") }
    if bytesEqual(id, state.recovery.id) || keysClash(state.recovery.signPub, state.recovery.kexPub, member.signPub, member.kexPub) { throw bad("the recovery key cannot be a member") }
    for m in next.members.values where keysClash(m.signPub, m.kexPub, member.signPub, member.kexPub) { throw bad("key already in use by another member") }
    next.members[hex(id)] = MemberState(id: id, role: member.role, signPub: member.signPub, kexPub: member.kexPub, addedSeq: e.seq, removedSeq: nil, cut: nil)
    next.memberOrder.append(hex(id))
  }
  func removeMembers(_ removed: [Removed]) throws {
    for x in removed {
      guard var m = next.members[hex(x.id)], m.removedSeq == nil else { throw bad("removing someone who is not a member") }
      m.removedSeq = e.seq
      m.cut = Cut(seq: x.seq, hash: x.hash)
      next.members[hex(x.id)] = m
    }
  }
  func newEpoch() throws {
    if e.epoch != state.epoch + 1 { throw bad("epoch \(e.epoch ?? -1) does not follow \(state.epoch)") }
    next.epoch = e.epoch!
    next.epochs[e.epoch!] = EpochInfo(seq: e.seq, keyCommit: e.keyCommit!, histCommit: e.histCommit!)
  }
  switch e.type {
  case ENTRY.ADD:
    try addMember(e.member!)
    if let inv = e.inviteId, !isZero(inv) {
      if next.inviteIds.contains(hex(inv)) { throw bad("this invite already produced a member") }
      next.inviteIds.insert(hex(inv))
    }
  case ENTRY.REMOVE:
    if e.removed.isEmpty { throw bad("nothing to remove") }
    try removeMembers(e.removed); try newEpoch()
  case ENTRY.RECOVER:
    if e.member?.role != ROLE.HUMAN { throw bad("recovery enrols a human device") }
    let humans = state.activeMembers.filter { $0.role == ROLE.HUMAN }
    if !humans.allSatisfy({ m in e.ids.contains { bytesEqual($0, m.id) } }) { throw bad("a recovery removes every human device") }
    try removeMembers(e.removed)
    try addMember(e.member!)
    try newEpoch()
    let rec = try PublicDevice(signPub: e.recovery!.signPub, kexPub: e.recovery!.kexPub)
    if bytesEqual(rec.id, state.recovery.id) { throw bad("recovery must install a new recovery key") }
    if next.members[hex(rec.id)] != nil || next.members.values.contains(where: { keysClash($0.signPub, $0.kexPub, rec.signPub, rec.kexPub) }) { throw bad("recovery key equals a device key") }
    next.recovery = rec
    next.lastRecoverSeq = e.seq
  default: throw bad("unknown entry type")
  }
  next.head = (e.seq, entryHash)
  next.hashes.append(entryHash)
  next.entries.append(e)
  return next
}

/** Verify a whole log. `roomId` (from the invite link or from local storage) is what makes it trustworthy. */
public func verifyLog(_ entries: [Bytes], roomId: Bytes?) throws -> RoomState {
  if entries.isEmpty { throw fail("bad-entry", "empty log") }
  var state: RoomState? = nil
  for b in entries { state = try applyEntry(state, b) }
  if let roomId = roomId, !bytesEqual(state!.roomId, roomId) { throw fail("wrong-room", "the genesis entry does not hash to this room id") }
  return state!
}

/** What a device stores to refuse rollbacks and forks. */
public struct Pin: Codable { public let seq: Int; public let hash: String; public let hashes: [String]; public let lastRecoverSeq: Int }
public func pinOf(_ s: RoomState) -> Pin { Pin(seq: s.head.seq, hash: hex(s.head.hash), hashes: s.hashes.map(hex), lastRecoverSeq: s.lastRecoverSeq) }
public enum PinStatus: Equatable { case same, extended, recoveryOverride(Int) }
public func checkLogAgainstPin(_ state: RoomState, _ pin: Pin?) throws -> PinStatus {
  guard let pin = pin else { return .extended }
  let n = min(state.hashes.count, pin.seq + 1)
  var fork = -1
  for i in 0..<n where hex(state.hashes[i]) != pin.hashes[i] { fork = i; break }
  if fork < 0 {
    if state.head.seq < pin.seq { throw fail("log-rollback", "the log ends at \(state.head.seq), this device already saw \(pin.seq)") }
    return state.head.seq == pin.seq ? .same : .extended
  }
  if state.entries[fork].type == ENTRY.RECOVER && fork > pin.lastRecoverSeq { return .recoveryOverride(fork) }
  throw fail("log-fork", "entry \(fork) differs from the one this device already accepted")
}

// ---- room key epochs ----------------------------------------------------------------

public struct EpochSecret: Equatable, Codable {
  public let epoch: Int
  public let key: Bytes
  public let hist: Bytes?
  public init(epoch: Int, key: Bytes, hist: Bytes?) { self.epoch = epoch; self.key = key; self.hist = hist }
}
public func newEpochSecret(_ epoch: Int, rng: RNG = systemRandom) -> EpochSecret { EpochSecret(epoch: epoch, key: rng(32), hist: rng(32)) }
func epochCtx(_ epoch: Int) -> Bytes { u32Bytes(epoch) }
public func epochCommits(_ s: EpochSecret) -> (keyCommit: Bytes, histCommit: Bytes?) {
  (hkdf(s.key, salt: [], label: LABEL.keyCommit, context: epochCtx(s.epoch), length: 32),
   s.hist.map { hkdf($0, salt: [], label: LABEL.histCommit, context: epochCtx(s.epoch), length: 32) })
}
func checkCommits(_ state: RoomState, _ s: EpochSecret) throws {
  guard let info = state.epochs[s.epoch] else { throw fail("wrong-epoch", "the log knows no epoch \(s.epoch)") }
  let c = epochCommits(s)
  if !bytesEqual(c.keyCommit, info.keyCommit) { throw fail("key-mismatch", "room key does not match the commitment in the log") }
  if s.hist != nil && !bytesEqual(c.histCommit, info.histCommit) { throw fail("key-mismatch", "history key does not match the commitment in the log") }
}
private func wrapAad(_ roomId: Bytes, _ epoch: Int, _ recipientId: Bytes) -> Bytes { labelBytes(LABEL.epochWrap) + roomId + epochCtx(epoch) + recipientId }

/** Seal an epoch secret to one active human device or the recovery key. */
public func wrapEpochKey(_ state: RoomState, _ secret: EpochSecret, _ recipientId: Bytes, rng: RNG = systemRandom) throws -> Bytes {
  let kexPub: Bytes
  if bytesEqual(recipientId, state.recovery.id) { kexPub = state.recovery.kexPub }
  else {
    guard let m = state.memberAt(recipientId) else { throw fail("not-member", "cannot wrap a key for someone who is not a member") }
    if m.role != ROLE.HUMAN { throw fail("bad-argument", "agents hold no room key: they get session keys") }
    kexPub = m.kexPub
  }
  guard let hist = secret.hist else { throw fail("bad-argument", "no history key to pass on") }
  return try seal(kexPub, [2] + secret.key + hist, aad: wrapAad(state.roomId, secret.epoch, recipientId), rng: rng)
}
/** Open a wrapped epoch secret and check it against the commitments in the verified log. */
public func unwrapEpochKey(_ state: RoomState, _ device: Device, _ sealed: Bytes, epoch: Int) throws -> EpochSecret {
  let plain = try openSealed(device, sealed, aad: wrapAad(state.roomId, epoch, device.id))
  let s: EpochSecret
  if plain.count == 33 && plain[0] == 1 { s = EpochSecret(epoch: epoch, key: Array(plain[1...]), hist: nil) }
  else if plain.count == 65 && plain[0] == 2 { s = EpochSecret(epoch: epoch, key: Array(plain[1..<33]), hist: Array(plain[33...])) }
  else { throw fail("bad-format", "wrapped epoch secret") }
  try checkCommits(state, s)
  return s
}

private func backLinkKeys(_ roomId: Bytes, _ s: EpochSecret) throws -> (key: Bytes, nonce: Bytes) {
  guard let hist = s.hist else { throw fail("no-key", "agents hold no history key") }
  let okm = hkdf(hist, salt: roomId, label: LABEL.backLink, context: epochCtx(s.epoch), length: 44)
  return (Array(okm[0..<32]), Array(okm[32...]))
}
private func backLinkAad(_ roomId: Bytes, _ epoch: Int) -> Bytes { [VERSION, OBJ.BACK_LINK] + roomId + epochCtx(epoch) }

public func makeBackLink(_ roomId: Bytes, _ secret: EpochSecret, previous: EpochSecret) throws -> Bytes {
  guard previous.epoch == secret.epoch - 1, let ph = previous.hist else { throw fail("bad-argument", "back link needs the full previous epoch") }
  let k = try backLinkKeys(roomId, secret)
  return [VERSION, OBJ.BACK_LINK] + epochCtx(secret.epoch) + (try gcmSeal(key: k.key, nonce: k.nonce, aad: backLinkAad(roomId, secret.epoch), previous.key + ph))
}
public func openBackLink(_ state: RoomState, _ secret: EpochSecret, _ link: Bytes) throws -> EpochSecret {
  var r = R(link)
  try header(&r, OBJ.BACK_LINK)
  if try r.u32() != secret.epoch { throw fail("wrong-epoch", "back link belongs to another epoch") }
  let k = try backLinkKeys(state.roomId, secret)
  let plain = try gcmOpen(key: k.key, nonce: k.nonce, aad: backLinkAad(state.roomId, secret.epoch), try r.take(r.left))
  if plain.count != 64 { throw fail("bad-format", "back link") }
  let prev = EpochSecret(epoch: secret.epoch - 1, key: Array(plain[0..<32]), hist: Array(plain[32...]))
  try checkCommits(state, prev)
  return prev
}

// ---- building entries (the passphrase / account sign-in adds itself with the recovery key) ----

public func addMember(_ state: RoomState, signer: Device, member: Member, inviteId: Bytes = ZERO16, time: UInt64 = nowMs()) throws -> (entry: Bytes, state: RoomState) {
  let kind = bytesEqual(signer.id, state.recovery.id) ? SIGNER.RECOVERY : SIGNER.DEVICE
  var e = Entry(type: ENTRY.ADD, seq: state.head.seq + 1, prev: state.head.hash, time: time, signerKind: kind, signer: signer.id)
  e.member = member; e.inviteId = inviteId
  let entry = try signEntry(e, signer)
  return (entry, try applyEntry(state, entry))
}

/**
 * Remove members and rotate the room key in the same entry (zcrypto.mjs removeMembers): `cuts` names, per removed
 * device, the last envelope of it the remover saw (R3; none: seq 0). Returns the entry, the new state, the new epoch's
 * secret, its wraps for the human devices who stay and the recovery key, and the back link to `previous`.
 */
public func removeMembers(_ state: RoomState, signer: Device, ids: [Bytes], cuts: [String: (seq: UInt64, hash: Bytes)], previous: EpochSecret?,
                          time: UInt64 = nowMs(), rng: RNG = systemRandom) throws -> (entry: Bytes, state: RoomState, secret: EpochSecret, wraps: [(id: Bytes, sealed: Bytes)], backLink: Bytes?) {
  let secret = newEpochSecret(state.epoch + 1, rng: rng)
  let commits = epochCommits(secret)
  var e = Entry(type: ENTRY.REMOVE, seq: state.head.seq + 1, prev: state.head.hash, time: time, signerKind: SIGNER.DEVICE, signer: signer.id)
  e.removed = ids.map { id in let c = cuts[hex(id)]; return Removed(id: id, seq: c?.seq ?? 0, hash: c?.hash ?? ZERO32) }
  e.epoch = secret.epoch; e.keyCommit = commits.keyCommit; e.histCommit = commits.histCommit
  let entry = try signEntry(e, signer)
  let next = try applyEntry(state, entry)
  var wraps = [(id: Bytes, sealed: Bytes)]()
  for m in next.activeMembers where m.role == ROLE.HUMAN { wraps.append((m.id, try wrapEpochKey(next, secret, m.id, rng: rng))) }
  wraps.append((next.recovery.id, try wrapEpochKey(next, secret, next.recovery.id, rng: rng)))
  let backLink = previous?.hist != nil ? try makeBackLink(next.roomId, secret, previous: previous!) : nil
  return (entry, next, secret, wraps, backLink)
}

public func nowMs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }
