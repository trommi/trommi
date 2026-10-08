// Envelope.swift: the envelope (FORMAT.md section 9), sender keys (section 7), binds, as zcrypto.mjs
// sealEnvelope / verifyEnvelope / openEnvelope / openVerifiedEnvelope.
import Foundation

public enum KIND {
  public static let TIMELINE_ITEM = 1, OBJECT_VERSION = 2, ANSWER = 3, PERMISSION_REQUEST = 4, VERDICT = 5, STATUS = 6, DECIDE_AGAIN = 7
  static let MAX = 7
  static let OBJECT_KINDS: Set<Int> = [2, 3, 4, 5, 7]
  /**
   * A kind of this format version. Kinds 8-255 are reserved for later versions: a READER accepts them (FORMAT.md section 9,
   * "Kinds a reader does not know": no timeline block, the object block iff flags bit 1, the bind opaque), checks
   * signature, chain and seen as for any envelope, and applies nothing. Writers and the hub refuse them (strictKinds).
   */
  public static func isKnown(_ kind: Int) -> Bool { kind >= 1 && kind <= MAX }
}
public enum KEY_SCOPE { public static let ROOM = 0, SESSION = 1 }
public enum TIMELINE { public static let CHAT = 1, SCRIBBLE = 2, CANVAS = 2 }
public enum TIMELINE_SCOPE { public static let CARD = 1, SESSION = 2, DESK = 3 }
public enum CARD_STATE { public static let OPEN = 1, ANSWERED = 2, CLOSED = 3 }
public let SEEN_MAX = 64
public let EPOCH_GRACE_MS: UInt64 = 2 * 60 * 1000
private let FLAG_PUSH = 1, FLAG_OBJECT = 2
private let NONCE_LEN = 12
private let SCOPE_NAMES = [1: "card", 2: "session", 3: "desk"]

public struct Seen: Equatable { public let sender: Bytes, seq: UInt64, hash: Bytes; public init(sender: Bytes, seq: UInt64, hash: Bytes) { self.sender = sender; self.seq = seq; self.hash = hash } }
public struct ObjectBlock: Equatable {
  public let id: Bytes, state: Int, urgency: Int, answeredAt: UInt64
  public init(id: Bytes, state: Int, urgency: Int = 1, answeredAt: UInt64 = 0) { self.id = id; self.state = state; self.urgency = urgency; self.answeredAt = answeredAt }
}

public struct Header: Equatable {
  public var push = false
  public var roomId: Bytes
  public var epoch: Int
  public var keyScope: Int
  public var sessionId: Bytes?
  public var sender: Bytes
  public var seq: UInt64
  public var prev: Bytes
  public var logSeq: Int
  public var logHash: Bytes
  public var recipient: Bytes
  public var time: UInt64
  public var kind: Int
  public var seen: [Seen] = []
  public var card: ObjectBlock? = nil
  public var timelineKind: Int? = nil
  public var timelineId: String? = nil
  public var blobs: [Bytes] = []
  public var isHead: Bool { kind != KIND.TIMELINE_ITEM }
  /** false: a kind of a newer format version (verified, never applied; the app shows "needs a newer Trommi"). */
  public var knownKind: Bool { KIND.isKnown(kind) }
}

/** A version byte above this format's is `newer-version` (this device is too old, the data is fine), anything else `bad-version`. */
private func checkVersion(_ v: Int, _ what: String) throws {
  if v != Int(VERSION) { throw fail(v > Int(VERSION) ? "newer-version" : "bad-version", "\(what) version \(v)") }
}

/** `card/<32 hex>`, `session/…`, `desk/…`; anything else is refused. */
public func parseTimelineId(_ text: String) throws -> (scope: Int, ref: Bytes) {
  let parts = text.split(separator: "/", omittingEmptySubsequences: false)
  guard parts.count == 2, let scope = ["card": 1, "session": 2, "desk": 3][String(parts[0])], parts[1].utf8.count == 32,
        let ref = try? unhex(String(parts[1])) else { throw fail("bad-argument", "timeline id: card/, session/ or desk/ and 32 lowercase hex characters") }
  return (scope, ref)
}
public func timelineIdOf(_ scope: Int, _ ref: Bytes) -> String { "\(SCOPE_NAMES[scope]!)/\(hex(ref))" }

private func checkGrammar(_ h: Header, strictKinds: Bool = true, _ bad: (String) -> ZError) throws {
  let known = KIND.isKnown(h.kind)
  if !known && (strictKinds || h.kind < 1 || h.kind > 255) { throw bad("unknown envelope kind \(h.kind)") }
  if h.keyScope != KEY_SCOPE.ROOM && h.keyScope != KEY_SCOPE.SESSION { throw bad("unknown key scope") }
  let thread = h.kind == KIND.TIMELINE_ITEM
  if known && KIND.OBJECT_KINDS.contains(h.kind) != (h.card != nil) { throw bad(KIND.OBJECT_KINDS.contains(h.kind) ? "this kind needs the object block" : "this kind has no object block") }
  if thread != (h.timelineId != nil) { throw bad(thread ? "a timeline item needs a timeline" : "only timeline items have a timeline") }
  if thread {
    guard let tk = h.timelineKind, tk >= 1, tk <= 255 else { throw bad("timeline kind") }
    let t = try parseTimelineId(h.timelineId!)
    if t.scope == TIMELINE_SCOPE.SESSION && (h.keyScope != KEY_SCOPE.SESSION || !bytesEqual(t.ref, h.sessionId)) { throw bad("a session's timeline is sent under that session's key") }
    if t.scope == TIMELINE_SCOPE.DESK && h.keyScope != KEY_SCOPE.ROOM { throw bad("a desk is sent under the room key") }
  }
  if h.seen.count > SEEN_MAX { throw bad("seen lists at most \(SEEN_MAX) senders") }
}

public func encodeHeader(_ h0: Header) throws -> Bytes {
  var h = h0
  try checkGrammar(h) { fail("bad-argument", $0) }
  let flags = (h.push ? FLAG_PUSH : 0) | (h.card != nil ? FLAG_OBJECT : 0)
  let w = W()
  try w.u8(Int(VERSION)).u8(flags).raw(h.roomId, 32, "roomId").u32(h.epoch).u8(h.keyScope)
  if h.keyScope == KEY_SCOPE.SESSION { try w.raw(h.sessionId ?? [], 16, "session id") }
  try w.raw(h.sender, 32, "sender").u64(h.seq).raw(h.prev, 32, "prev").u32(h.logSeq).raw(h.logHash, 32, "logHash").raw(h.recipient, 32, "recipient").u64(h.time).u8(h.kind)
  h.seen.sort { compareBytes($0.sender, $1.sender) < 0 }
  try w.u16(h.seen.count)
  for (i, s) in h.seen.enumerated() {
    if i > 0 && compareBytes(h.seen[i - 1].sender, s.sender) == 0 { throw fail("bad-argument", "duplicate sender in seen") }
    try w.raw(s.sender, 32, "seen sender").u64(s.seq).raw(s.hash, 32, "seen hash")
  }
  if let c = h.card {
    if c.state < 1 || c.state > 3 { throw fail("bad-argument", "card state") }
    if c.urgency < 0 || c.urgency > 3 { throw fail("bad-argument", "urgency") }
    try w.raw(c.id, 16, "object id").u8(c.state).u8(c.urgency).u64(c.answeredAt)
  }
  if let tid = h.timelineId {
    let t = try parseTimelineId(tid)
    try w.u8(h.timelineKind!).u8(t.scope).raw(t.ref, 16, "timeline ref")
  }
  if h.blobs.count > 255 { throw fail("bad-argument", "too many attachments") }
  try w.u8(h.blobs.count)
  for b in h.blobs { try w.raw(b, 16, "blob id") }
  return w.out
}

public func decodeHeader(_ bytes: Bytes, strictKinds: Bool = false) throws -> Header {
  var r = R(bytes)
  try checkVersion(try r.u8(), "envelope header")
  let flags = try r.u8()
  if flags & ~(FLAG_PUSH | FLAG_OBJECT) != 0 { throw fail("bad-format", "unknown header flags") }
  let roomId = try r.take(32), epoch = try r.u32(), keyScope = try r.u8()
  if keyScope > 1 { throw fail("bad-format", "unknown key scope") }
  let sessionId = keyScope == KEY_SCOPE.SESSION ? try r.take(16) : nil
  var h = Header(push: flags & FLAG_PUSH != 0, roomId: roomId, epoch: epoch, keyScope: keyScope, sessionId: sessionId, sender: try r.take(32), seq: try r.u64(), prev: try r.take(32),
                 logSeq: try r.u32(), logHash: try r.take(32), recipient: try r.take(32), time: try r.u64(), kind: try r.u8())
  let n = try r.u16()
  if n > SEEN_MAX { throw fail("bad-format", "seen lists at most \(SEEN_MAX) senders") }
  for i in 0..<n {
    let s = Seen(sender: try r.take(32), seq: try r.u64(), hash: try r.take(32))
    if i > 0 && compareBytes(h.seen[i - 1].sender, s.sender) >= 0 { throw fail("bad-format", "seen not strictly ascending") }
    h.seen.append(s)
  }
  if flags & FLAG_OBJECT != 0 {
    let c = ObjectBlock(id: try r.take(16), state: try r.u8(), urgency: try r.u8(), answeredAt: try r.u64())
    if c.state < 1 || c.state > 3 { throw fail("bad-format", "unknown card state") }
    if c.urgency > 3 { throw fail("bad-format", "unknown urgency") }
    h.card = c
  }
  if h.kind == KIND.TIMELINE_ITEM {
    h.timelineKind = try r.u8()
    let scope = try r.u8()
    guard SCOPE_NAMES[scope] != nil else { throw fail("bad-format", "unknown timeline scope") }
    h.timelineId = timelineIdOf(scope, try r.take(16))
  }
  let blobs = try r.u8()
  for _ in 0..<blobs { h.blobs.append(try r.take(16)) }
  try r.end()
  if h.seq < 1 { throw fail("bad-format", "sequence numbers start at 1") }
  try checkGrammar(h, strictKinds: strictKinds) { fail("bad-format", $0) }
  return h
}

// ---- body and padding ------------------------------------------------------------------

/** Padded plaintext size: powers of two from 256 bytes to 64 KiB, then multiples of 64 KiB. */
public func paddedLength(_ n: Int) -> Int {
  if n > 65536 { return (n + 65535) / 65536 * 65536 }
  var size = 256
  while size < n { size *= 2 }
  return size
}
private func startsWithBOM(_ p: Bytes) -> Bool { p.count >= 3 && p[0] == 0xef && p[1] == 0xbb && p[2] == 0xbf }
public func encodeBody(bind: Bytes, payload: Bytes) throws -> Bytes {
  if startsWithBOM(payload) { throw fail("bad-argument", "the payload starts with a byte order mark") }
  let w = W()
  try w.u8(Int(VERSION)).var16(bind).var32(payload)
  return w.out + Bytes(repeating: 0, count: paddedLength(w.out.count) - w.out.count)
}
public func decodeBody(_ bytes: Bytes) throws -> (bind: Bytes, payload: Bytes) {
  var r = R(bytes)
  try checkVersion(try r.u8(), "envelope body")
  let bind = try r.var16(), payload = try r.var32()
  if paddedLength(bytes.count - r.left) != bytes.count { throw fail("bad-format", "wrong padding length") }
  if !isZero(try r.take(r.left)) { throw fail("bad-format", "padding is not zero") }
  if startsWithBOM(payload) { throw fail("bad-format", "the payload starts with a byte order mark") }
  return (bind, payload)
}

// ---- split, join, prune ------------------------------------------------------------------

public struct SplitEnvelope { public let headerBytes: Bytes, nonce: Bytes, ciphertext: Bytes?, ciphertextHash: Bytes?, signature: Bytes; public var pruned: Bool { ciphertext == nil } }
public func splitEnvelope(_ bytes: Bytes) throws -> SplitEnvelope {
  var r = R(bytes)
  try checkVersion(try r.u8(), "envelope")
  let type = try r.u8()
  if type != Int(OBJ.ENVELOPE) && type != Int(OBJ.ENVELOPE_PRUNED) { throw fail("bad-format", "not an envelope") }
  let headerBytes = try r.var16(), nonce = try r.take(NONCE_LEN)
  let pruned = type == Int(OBJ.ENVELOPE_PRUNED)
  let ct = pruned ? nil : try r.var32()
  let ctHash = pruned ? try r.take(32) : nil
  let signature = try r.take(64)
  try r.end()
  if let ct = ct, ct.count < 16 { throw fail("bad-format", "ciphertext shorter than its tag") }
  return SplitEnvelope(headerBytes: headerBytes, nonce: nonce, ciphertext: ct, ciphertextHash: ctHash, signature: signature)
}
public func joinEnvelope(headerBytes: Bytes, nonce: Bytes, ciphertext: Bytes?, ciphertextHash: Bytes?, signature: Bytes) throws -> Bytes {
  let w = W()
  try w.var16(headerBytes)
  if let ct = ciphertext { let c = W(); try c.var32(ct); return [VERSION, OBJ.ENVELOPE] + w.out + nonce + c.out + signature }
  return [VERSION, OBJ.ENVELOPE_PRUNED] + w.out + nonce + (try need(ciphertextHash ?? [], 32, "ciphertext hash")) + signature
}
public func pruneEnvelope(_ bytes: Bytes) throws -> Bytes {
  let e = try splitEnvelope(bytes)
  if e.pruned { return bytes }
  return try joinEnvelope(headerBytes: e.headerBytes, nonce: e.nonce, ciphertext: nil, ciphertextHash: sha256(e.ciphertext!), signature: e.signature)
}
public func peekEnvelope(_ bytes: Bytes, strictKinds: Bool = false) throws -> (header: Header, split: SplitEnvelope) {
  let e = try splitEnvelope(bytes)
  return (try decodeHeader(e.headerBytes, strictKinds: strictKinds), e)
}

// ---- keys ----------------------------------------------------------------------------------

public func objectIdOf(_ creatorId: Bytes, _ senderSequence: UInt64) throws -> Bytes {
  Array(hash(LABEL.objectId, try need(creatorId, 32, "creator id"), be64(senderSequence))[0..<16])
}
/** HKDF(scope key, salt = room id, info = label ‖ scope ‖ [session id] ‖ epoch ‖ sender id). */
public func deriveSenderKey(roomId: Bytes, secret: EpochSecret, senderId: Bytes, keyScope: Int, sessionId: Bytes?) throws -> Bytes {
  let scope: Bytes = keyScope == KEY_SCOPE.SESSION ? [1] + (try need(sessionId ?? [], 16, "session id")) : [0]
  return hkdf(secret.key, salt: roomId, label: LABEL.senderKey, context: scope + epochCtx(secret.epoch) + (try need(senderId, 32, "sender id")), length: 32)
}

// ---- chains --------------------------------------------------------------------------------

/** One sender's chain as this device accepted it. */
public struct Chain: Codable, Equatable {
  public var seq: UInt64 = 0
  public var hash: Bytes = ZERO32
  public var hashes: [UInt64: Bytes] = [:]
  public var told: [String: UInt64] = [:]
  public init() {}
}
public typealias Chains = [String: Chain]
public let CHAIN_HASHES_KEPT = 256          // hex sender id -> chain

func advance(_ chains: inout Chains, _ sender: Bytes, _ seq: UInt64, _ h: Bytes, told: [Seen]? = nil) {
  var c = chains[hex(sender)] ?? Chain()
  c.seq = seq; c.hash = h; c.hashes[seq] = h
  // the newest CHAIN_HASHES_KEPT envelope hashes per sender (equivocation checks), as client.mjs trimChain
  if c.hashes.count > CHAIN_HASHES_KEPT * 2 { let keep = Set(c.hashes.keys.sorted().suffix(CHAIN_HASHES_KEPT)); c.hashes = c.hashes.filter { keep.contains($0.key) } }
  if let told = told { for s in told { c.told[hex(s.sender)] = s.seq } }
  chains[hex(sender)] = c
}
/** The bounded `seen` (R5): active senders whose head changed since the author's own previous envelope, at most 64. */
public func seenFrom(_ chains: Chains, selfId: Bytes, state: RoomState) -> [Seen] {
  let me = hex(selfId)
  let told = chains[me]?.told ?? [:]
  var out = [Seen]()
  for (k, c) in chains where k != me && c.seq > 0 {
    guard let id = try? unhex(k), state.memberAt(id) != nil, told[k] != c.seq else { continue }
    out.append(Seen(sender: id, seq: c.seq, hash: c.hash))
  }
  out.sort { compareBytes($0.sender, $1.sender) < 0 }
  return Array(out.prefix(SEEN_MAX))
}

// ---- seal ----------------------------------------------------------------------------------

public struct Sealed { public let bytes: Bytes, hash: Bytes, seq: UInt64, header: Header }

/**
 * Encrypt and sign one message, advancing the sender's own chain once the bytes are complete. keyScope 0: `secret` is the
 * room epoch secret (humans only); 1: that session's key epoch secret (checked by its grant chain, not here).
 */
public func sealEnvelope(device: Device, state: RoomState, secret: EpochSecret, chains: inout Chains, kind: Int, keyScope: Int = KEY_SCOPE.ROOM, sessionId: Bytes? = nil,
                         bind: Bytes = [], payload: Bytes = [], recipient: Bytes? = nil, time: UInt64 = nowMs(), card: ObjectBlock? = nil, timelineKind: Int? = nil,
                         timelineId: String? = nil, blobs: [Bytes] = [], push: Bool = false, seen: [Seen]? = nil, rng: RNG = systemRandom) throws -> Sealed {
  guard let me = state.memberAt(device.id) else { throw fail("not-member", "this device is not a member") }
  if keyScope == KEY_SCOPE.ROOM {
    if me.role != ROLE.HUMAN { throw fail("forbidden", "agents hold no room key: they send under a session key") }
    if secret.epoch != state.epoch { throw fail("wrong-epoch", "send with the current epoch") }
    try checkCommits(state, EpochSecret(epoch: secret.epoch, key: secret.key, hist: nil))
  }
  let own = chains[hex(device.id)]
  let told = seen ?? seenFrom(chains, selfId: device.id, state: state)
  let h = Header(push: push, roomId: state.roomId, epoch: secret.epoch, keyScope: keyScope, sessionId: keyScope == KEY_SCOPE.SESSION ? sessionId : nil, sender: device.id,
                 seq: (own?.seq ?? 0) + 1, prev: own?.hash ?? ZERO32, logSeq: state.head.seq, logHash: state.head.hash, recipient: recipient ?? ZERO32, time: time, kind: kind,
                 seen: told, card: card, timelineKind: timelineId != nil ? timelineKind : nil, timelineId: timelineId, blobs: blobs)
  let headerBytes = try encodeHeader(h)
  let nonce = rng(NONCE_LEN)
  let key = try deriveSenderKey(roomId: state.roomId, secret: secret, senderId: device.id, keyScope: keyScope, sessionId: h.sessionId)
  let ct = try gcmSeal(key: key, nonce: nonce, aad: headerBytes, try encodeBody(bind: bind, payload: payload))
  let envHash = hash(LABEL.envelope, headerBytes, nonce, sha256(ct))
  let signature = try device.sign(LABEL.envelopeSig, envHash)
  let bytes = try joinEnvelope(headerBytes: headerBytes, nonce: nonce, ciphertext: ct, ciphertextHash: nil, signature: signature)
  advance(&chains, device.id, h.seq, envHash, told: told)
  return Sealed(bytes: bytes, hash: envHash, seq: h.seq, header: try decodeHeader(headerBytes))
}

// ---- verify and open ----------------------------------------------------------------------

public struct Freshness { public let now: UInt64, currentEpoch: Int, currentSince: UInt64 }
public struct Withheld { public let sender: Bytes, have: UInt64, seen: UInt64 }
public struct Verified {
  public let header: Header
  public let hash: Bytes
  public let ciphertextHash: Bytes
  public let member: MemberState
  public let pruned: Bool
  public let withheld: [Withheld]
  public let chainStart: Bool
  public let removedNow: Bool
  public let split: SplitEnvelope
}

/** Everything about an envelope that needs no key (format, room, log view, membership, signature, chain, seen). */
public func verifyEnvelope(_ bytes: Bytes, state: RoomState, chains: inout Chains, allowChainStart: Bool = false, allowRemovedSender: Bool = false, commit: Bool = true, freshness: Freshness? = nil, strictKinds: Bool = false) throws -> Verified {
  let e = try splitEnvelope(bytes)
  let h = try decodeHeader(e.headerBytes, strictKinds: strictKinds)
  if !bytesEqual(h.roomId, state.roomId) { throw fail("wrong-room", "envelope of another room") }
  if h.logSeq > state.head.seq { throw fail("log-behind", "the sender knows log entry \(h.logSeq), this device only \(state.head.seq)") }
  if !bytesEqual(state.hashes[h.logSeq], h.logHash) { throw fail("log-fork", "the sender has a different log entry \(h.logSeq)") }
  guard let member = state.memberAt(h.sender, h.logSeq) else { throw fail("not-member", "the sender was not a member at the log state it names") }
  if h.keyScope == KEY_SCOPE.ROOM {
    if member.role != ROLE.HUMAN { throw fail("forbidden", "agents hold no room key") }
    if state.epochAt(h.logSeq) != h.epoch { throw fail("wrong-epoch", "the epoch does not match the log state the sender names") }
  }
  if let f = freshness, h.epoch < f.currentEpoch, f.now - f.currentSince > EPOCH_GRACE_MS { throw fail("wrong-epoch", "sent in an outdated key epoch: the sender is on an old member list") }
  let now = state.member(h.sender)!
  let removedNow = now.removedSeq != nil
  if removedNow {
    if !allowRemovedSender { throw fail("removed-sender", "the sender has been removed since") }
    if let cut = now.cut, h.seq > cut.seq { throw fail("removed-sender", "beyond the cut its removal names") }
  }
  for s in h.seen where state.memberAt(s.sender, h.logSeq) == nil { throw fail("bad-format", "seen names a sender that was not active at the named log state") }

  let ctHash = e.pruned ? e.ciphertextHash! : sha256(e.ciphertext!)
  let envHash = hash(LABEL.envelope, e.headerBytes, e.nonce, ctHash)
  if !verify(member.signPub, LABEL.envelopeSig, envHash, e.signature) { throw fail("bad-signature", "envelope") }
  if removedNow, let cut = now.cut, h.seq == cut.seq, !bytesEqual(cut.hash, envHash) { throw fail("equivocation", "not the envelope the removal cut names") }

  var chainStart = false
  if let chain = chains[hex(h.sender)] {
    if h.seq <= chain.seq {
      if let known = chain.hashes[h.seq], !bytesEqual(known, envHash) { throw fail("equivocation", "two different envelopes with number \(h.seq) from one sender") }
      throw fail("replay", "envelope \(h.seq) was already accepted")
    } else if h.seq > chain.seq + 1 {
      throw fail("gap", "envelope \(h.seq) arrived, \(chain.seq + 1) is missing")
    } else if !bytesEqual(h.prev, chain.hash) {
      throw fail("chain-break", "the predecessor hash does not match the envelope accepted before")
    }
  } else {
    if h.seq == 1 { if !isZero(h.prev) { throw fail("chain-break", "the first envelope names a predecessor") } }
    else if allowChainStart { chainStart = true }
    else { throw fail("gap", "first envelope seen from this sender has number \(h.seq)") }
  }
  var withheld = [Withheld]()
  for s in h.seen {
    if bytesEqual(s.sender, h.sender) { throw fail("bad-format", "a sender cannot list itself as seen") }
    let c = chains[hex(s.sender)]
    if let known = c?.hashes[s.seq], !bytesEqual(known, s.hash) { throw fail("equivocation", "the sender saw a different envelope than this device under the same number") }
    if s.seq > (c?.seq ?? 0) { withheld.append(Withheld(sender: s.sender, have: c?.seq ?? 0, seen: s.seq)) }
  }
  if commit { advance(&chains, h.sender, h.seq, envHash) }
  return Verified(header: h, hash: envHash, ciphertextHash: ctHash, member: member, pruned: e.pruned, withheld: withheld, chainStart: chainStart, removedNow: removedNow, split: e)
}

public struct Opened {
  public let verified: Verified
  public let bind: Bytes?
  public let payload: Bytes?
  public let quarantined: String?
  public let forMe: Bool
  public var header: Header { verified.header }
  public var hash: Bytes { verified.hash }
  public var kind: Int { verified.header.kind }
}
/** Which key opens a header: the room epoch secret (scope 0) or the session's (scope 1), or nil (no-key). */
public typealias SecretLookup = (Header) -> EpochSecret?

/** Verify, then decrypt. A body that fails to decrypt or decode under a valid signature and chain is quarantined (R4). */
public func openEnvelope(_ bytes: Bytes, state: RoomState, chains: inout Chains, secrets: SecretLookup, selfId: Bytes? = nil, quarantine: Bool = true,
                         allowChainStart: Bool = false, allowRemovedSender: Bool = false, commit: Bool = true, freshness: Freshness? = nil) throws -> Opened {
  let v = try verifyEnvelope(bytes, state: state, chains: &chains, allowChainStart: allowChainStart, allowRemovedSender: allowRemovedSender, commit: false, freshness: freshness)
  if v.pruned { throw fail("pruned", "the ciphertext of this envelope was deleted") }
  guard let secret = secrets(v.header) else { throw fail("no-key", "no key for epoch \(v.header.epoch)") }
  var body: (bind: Bytes, payload: Bytes)? = nil
  var quarantined: String? = nil
  do {
    let key = try deriveSenderKey(roomId: state.roomId, secret: secret, senderId: v.header.sender, keyScope: v.header.keyScope, sessionId: v.header.sessionId)
    body = try decodeBody(try gcmOpen(key: key, nonce: v.split.nonce, aad: v.split.headerBytes, v.split.ciphertext!))
  } catch let err as ZError where quarantine && ["decrypt-failed", "bad-format", "bad-version", "newer-version"].contains(err.code) {
    quarantined = err.code
  }
  if commit { advance(&chains, v.header.sender, v.header.seq, v.hash) }
  let forMe = isZero(v.header.recipient) || (selfId.map { bytesEqual(v.header.recipient, $0) } ?? false)
  return Opened(verified: v, bind: body?.bind, payload: body?.payload, quarantined: quarantined, forMe: forMe)
}

/** Open a full envelope whose (pruned or full) form the chain already verified: a thread item fetched later. */
public func openVerifiedEnvelope(_ bytes: Bytes, state: RoomState, secrets: SecretLookup, envelopeHash: Bytes) throws -> (header: Header, bind: Bytes, payload: Bytes) {
  _ = try need(envelopeHash, 32, "envelope hash")
  let e = try splitEnvelope(bytes)
  if e.pruned { throw fail("pruned", "the ciphertext of this envelope was deleted") }
  let h = try decodeHeader(e.headerBytes)
  if !bytesEqual(h.roomId, state.roomId) { throw fail("wrong-room", "envelope of another room") }
  let envHash = hash(LABEL.envelope, e.headerBytes, e.nonce, sha256(e.ciphertext!))
  if !bytesEqual(envHash, envelopeHash) { throw fail("hash-mismatch", "this envelope is not the one the chain verified") }
  guard let member = state.member(h.sender) else { throw fail("not-member", "the sender is not in the member list") }
  if !verify(member.signPub, LABEL.envelopeSig, envHash, e.signature) { throw fail("bad-signature", "envelope") }
  guard let secret = secrets(h) else { throw fail("no-key", "no key for epoch \(h.epoch)") }
  let key = try deriveSenderKey(roomId: state.roomId, secret: secret, senderId: h.sender, keyScope: h.keyScope, sessionId: h.sessionId)
  let body = try decodeBody(try gcmOpen(key: key, nonce: e.nonce, aad: e.headerBytes, e.ciphertext!))
  return (h, body.bind, body.payload)
}

// ---- binds ------------------------------------------------------------------------------------

public func encodeAnswerBind(objectId: Bytes, versionHash: Bytes, choices: [String]) throws -> Bytes {
  if choices.count > 64 { throw fail("bad-argument", "choices") }
  let w = W()
  try w.u8(Int(VERSION)).raw(objectId, 16, "object id").raw(versionHash, 32, "version hash").u8(choices.count)
  for c in choices { try w.str16(c, max: 256) }
  return w.out
}
public func encodeVerdictBind(requestId: Bytes, requestHash: Bytes, expiresAt: UInt64, allow: Bool) throws -> Bytes {
  let w = W(); try w.u8(Int(VERSION)).raw(requestId, 16, "request id").raw(requestHash, 32, "request hash").u64(expiresAt).u8(allow ? 1 : 2); return w.out
}
public func encodeDecideAgainBind(objectId: Bytes, previousHash: Bytes, versionHash: Bytes) throws -> Bytes {
  let w = W(); try w.u8(Int(VERSION)).raw(objectId, 16, "object id").raw(previousHash, 32, "previous hash").raw(versionHash, 32, "version hash"); return w.out
}
public func encodeRequestBind(requestId: Bytes, expiresAt: UInt64) throws -> Bytes {
  let w = W(); try w.u8(Int(VERSION)).raw(requestId, 16, "request id").u64(expiresAt); return w.out
}
public enum Bind: Equatable {
  case answer(objectId: Bytes, versionHash: Bytes, choices: [String])
  case decideAgain(objectId: Bytes, previousHash: Bytes, versionHash: Bytes)
  case permissionRequest(requestId: Bytes, expiresAt: UInt64)
  case verdict(requestId: Bytes, requestHash: Bytes, expiresAt: UInt64, allow: Bool)
}
public func decodeBind(kind: Int, _ bind: Bytes) throws -> Bind {
  var r = R(bind)
  try checkVersion(try r.u8(), "bind")
  let out: Bind
  switch kind {
  case KIND.ANSWER:
    let o = try r.take(16), vh = try r.take(32), n = try r.u8()
    var choices = [String]()
    for _ in 0..<n { choices.append(try r.str16(256)) }
    out = .answer(objectId: o, versionHash: vh, choices: choices)
  case KIND.DECIDE_AGAIN: out = .decideAgain(objectId: try r.take(16), previousHash: try r.take(32), versionHash: try r.take(32))
  case KIND.PERMISSION_REQUEST: out = .permissionRequest(requestId: try r.take(16), expiresAt: try r.u64())
  case KIND.VERDICT:
    let id = try r.take(16), h = try r.take(32), exp = try r.u64(), a = try r.u8()
    if a != 1 && a != 2 { throw fail("bad-format", "verdict") }
    out = .verdict(requestId: id, requestHash: h, expiresAt: exp, allow: a == 1)
  default: throw fail("bad-format", "this kind carries no bind")
  }
  try r.end()
  return out
}
