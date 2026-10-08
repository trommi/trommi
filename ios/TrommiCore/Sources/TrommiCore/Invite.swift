// Invite.swift: recovery code (FORMAT.md section 12), invite and pairing (section 8), hub sign-in (section 17).
import Foundation

// ---- recovery code ------------------------------------------------------------------

private let CROCKFORD: [Character] = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

/** 256 bits as 52 Crockford base32 characters in groups of four. */
public func formatRecoveryCode(_ bytes: Bytes) throws -> String {
  _ = try need(bytes, 32, "recovery code")
  var out = [Character](), acc = 0, bits = 0
  for b in bytes {
    acc = (acc << 8) | Int(b); bits += 8
    while bits >= 5 { bits -= 5; out.append(CROCKFORD[(acc >> bits) & 31]) }
    acc &= (1 << bits) - 1
  }
  out.append(CROCKFORD[(acc << (5 - bits)) & 31])
  return stride(from: 0, to: out.count, by: 4).map { String(out[$0..<min($0 + 4, out.count)]) }.joined(separator: "-")
}
/** Accepts lower case, spaces and hyphens; O reads as 0, I and L as 1. */
public func parseRecoveryCode(_ text: String) throws -> Bytes {
  let clean = text.uppercased().filter { !$0.isWhitespace && $0 != "-" }.map { $0 == "O" ? "0" : ($0 == "I" || $0 == "L") ? "1" : $0 }
  if clean.count != 52 { throw fail("bad-recovery-code", "a recovery code has 52 characters") }
  var out = Bytes(), acc = 0, bits = 0
  for ch in clean {
    guard let v = CROCKFORD.firstIndex(of: ch) else { throw fail("bad-recovery-code", "foreign character") }
    acc = (acc << 5) | v; bits += 5
    if bits >= 8 { bits -= 8; if out.count < 32 { out.append(UInt8((acc >> bits) & 0xff)) }; acc &= (1 << bits) - 1 }
  }
  if acc != 0 { throw fail("bad-recovery-code", "non-canonical last character") }
  return out
}
/** The recovery key pair, derived from the code by HKDF. Shaped like a device. */
public func recoveryDevice(_ code: String) throws -> Device {
  let raw = try parseRecoveryCode(code)
  return try Device(signSeed: hkdf(raw, salt: [], label: LABEL.recoverySign, length: 32), kexPriv: hkdf(raw, salt: [], label: LABEL.recoveryKex, length: 32))
}

// ---- hub address and invite link ------------------------------------------------------

private let HUB_MAX = 512

/** The canonical hub address (R9): https:// + lowercase host [+ :port]; plain http only for localhost and 127.0.0.1. */
public func checkHubAddress(_ hub: String) throws -> String {
  func bad() -> ZError { fail("bad-argument", "hub address: https://host[:port], lowercase, no path") }
  var rest: Substring
  var host: Substring
  if hub.hasPrefix("https://") {
    rest = hub.dropFirst(8)
    host = rest.prefix { $0 != ":" }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.isEmpty { throw bad() }
    for l in labels {
      let u = Array(l.utf8)
      if u.isEmpty { throw bad() }
      let ok = u.allSatisfy { (48...57).contains($0) || (97...122).contains($0) || $0 == 45 }
      if !ok || u.first == 45 || u.last == 45 { throw bad() }
    }
  } else if hub.hasPrefix("http://") {
    rest = hub.dropFirst(7)
    host = rest.prefix { $0 != ":" }
    if host != "localhost" && host != "127.0.0.1" { throw bad() }
  } else { throw bad() }
  let port = rest.dropFirst(host.count)
  if !port.isEmpty {
    let digits = Array(port.dropFirst().utf8)
    if port.first != ":" || digits.isEmpty || digits.count > 5 || digits.first == 48 || !digits.allSatisfy({ (48...57).contains($0) }) { throw bad() }
  }
  return hub
}

public struct InviteLink { public let hub: String, roomId: Bytes, secret: Bytes }

public func inviteLink(app: String, hub: String, roomId: Bytes, secret: Bytes) -> String {
  "\(app)#v\(VERSION).\(b64u(utf8(hub))).\(b64u(roomId)).\(b64u(secret))"
}
public func parseInviteLink(_ link: String) throws -> InviteLink {
  guard let at = link.firstIndex(of: "#") else { throw fail("bad-invite", "no fragment") }
  let parts = link[link.index(after: at)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
  if parts[0] != "v\(VERSION)" { throw fail("bad-version", "invite link version") }
  if parts.count != 4 { throw fail("bad-invite", "malformed link") }
  guard let hubBytes = try? unb64u(parts[1]), let hub = String(validating: hubBytes, as: UTF8.self) else { throw fail("bad-invite", "hub address") }
  do { _ = try checkHubAddress(hub) } catch { throw fail("bad-invite", "the hub address in the link is not canonical") }
  let roomId = try unb64u(parts[2]), secret = try unb64u(parts[3])
  if roomId.count != 32 || secret.count != 32 { throw fail("bad-invite", "malformed link") }
  return InviteLink(hub: hub, roomId: roomId, secret: secret)
}

public func inviteKeys(secret: Bytes, roomId: Bytes) -> (inviteId: Bytes, macKey: Bytes) {
  (hkdf(secret, salt: roomId, label: LABEL.inviteId, length: 16), hkdf(secret, salt: roomId, label: LABEL.inviteMac, length: 32))
}

// ---- offer, request, reveal -------------------------------------------------------------

public struct Offer { public let roomId, inviteId: Bytes; public let role: Int; public let expiresAt: UInt64; public let commit, inviterId: Bytes; public let logSeq: Int; public let logHash, body, signature: Bytes }
public struct Request { public let roomId, inviteId: Bytes; public let hub: String; public let role: Int; public let signPub, kexPub, offerHash, body, mac, signature: Bytes }

public func decodeOffer(_ bytes: Bytes) throws -> Offer {
  if bytes.count < 64 { throw fail("bad-format", "offer") }
  let body = Array(bytes[0..<(bytes.count - 64)])
  var r = R(body)
  try header(&r, OBJ.INVITE_OFFER)
  let o = Offer(roomId: try r.take(32), inviteId: try r.take(16), role: try r.u8(), expiresAt: try r.u64(), commit: try r.take(32), inviterId: try r.take(32),
                logSeq: try r.u32(), logHash: try r.take(32), body: body, signature: Array(bytes[(bytes.count - 64)...]))
  try r.end()
  return o
}
public func decodeRequest(_ bytes: Bytes) throws -> Request {
  if bytes.count < 96 { throw fail("bad-format", "request") }
  let body = Array(bytes[0..<(bytes.count - 96)])
  var r = R(body)
  try header(&r, OBJ.INVITE_REQUEST)
  let q = Request(roomId: try r.take(32), inviteId: try r.take(16), hub: try r.str16(HUB_MAX), role: try r.u8(), signPub: try r.take(32), kexPub: try r.take(32), offerHash: try r.take(32),
                  body: body, mac: Array(bytes[(bytes.count - 96)..<(bytes.count - 64)]), signature: Array(bytes[(bytes.count - 64)...]))
  try r.end()
  return q
}

public func inviteOfferHash(_ offer: Bytes) throws -> Bytes { hash(LABEL.inviteOffer, try decodeOffer(offer).body) }
public func inviteRequestHash(_ request: Bytes) -> Bytes { hash(LABEL.inviteRequest, Array(request[0..<(request.count - 64)])) }

/** An offer is good if an active human member of this room signed it and it has not run out. */
public func verifyInviteOffer(_ state: RoomState, _ offer: Bytes, now: UInt64 = nowMs()) throws -> Offer {
  let o = try decodeOffer(offer)
  if !bytesEqual(o.roomId, state.roomId) { throw fail("bad-invite", "the offer belongs to another room") }
  guard let inviter = state.memberAt(o.inviterId), inviter.role == ROLE.HUMAN else { throw fail("bad-invite", "the offer is not from a human member of this room") }
  if !verify(inviter.signPub, LABEL.inviteOfferSig, o.body, o.signature) { throw fail("bad-signature", "invite offer") }
  if o.role != ROLE.HUMAN && o.role != ROLE.AGENT { throw fail("bad-format", "unknown role") }
  if now > o.expiresAt { throw fail("invite-expired", "this invite has run out") }
  return o
}
public func verifyInviteRequest(_ request: Bytes) throws -> (request: Request, id: Bytes) {
  let q = try decodeRequest(request)
  if q.role != ROLE.HUMAN && q.role != ROLE.AGENT { throw fail("bad-format", "unknown role") }
  if !verify(q.signPub, LABEL.inviteRequestSig, q.body + q.mac, q.signature) { throw fail("bad-signature", "invite request") }
  return (q, try deviceId(q.signPub, q.kexPub))
}
public func verifyInviteReveal(_ state: RoomState, _ reveal: Bytes, inviterId: Bytes) throws -> (inviteId: Bytes, nonce: Bytes, requestHash: Bytes) {
  guard let inviter = state.memberAt(inviterId), inviter.role == ROLE.HUMAN else { throw fail("bad-invite", "the inviter is no longer a member") }
  if reveal.count < 64 { throw fail("bad-format", "reveal") }
  let body = Array(reveal[0..<(reveal.count - 64)])
  if !verify(inviter.signPub, LABEL.inviteRevealSig, body, Array(reveal[(reveal.count - 64)...])) { throw fail("bad-signature", "invite reveal") }
  var r = R(body)
  try header(&r, OBJ.INVITE_REVEAL)
  let out = (try r.take(16), try r.take(32), try r.take(32))
  try r.end()
  return out
}

public let CHECK_CODE_SYMBOLS = 6
/** Six numbers 0–63 from the first 36 bits of H("trommi/v1/invite-code", offer body ‖ request body ‖ mac ‖ nonce). */
public func inviteCode(offer: Bytes, request: Bytes, nonce: Bytes) throws -> String {
  let h = hash(LABEL.inviteCode, try decodeOffer(offer).body, Array(request[0..<(request.count - 64)]), nonce)
  var n: UInt64 = 0
  for i in 0..<8 { n = n << 8 | UInt64(h[i]) }
  n >>= 28
  var out = [String]()
  for _ in 0..<CHECK_CODE_SYMBOLS { out.insert(String(format: "%02d", Int(n & 63)), at: 0); n >>= 6 }
  return out.joined(separator: "-")
}

/** What the joining device keeps between its request and the reveal. */
public struct Join: Codable {
  public let roomId: Bytes, hub: String, role: Int, inviteId: Bytes, inviterId: Bytes, commit: Bytes, offer: Bytes, request: Bytes
}

/** Step 3, on the joining device: verify the log against the link's room id and the offer against the log, build the request. */
public func createJoinRequest(link: String, offer: Bytes, log: [Bytes], device: Device, now: UInt64 = nowMs()) throws -> (request: Bytes, join: Join) {
  let l = try parseInviteLink(link)
  let state = try verifyLog(log, roomId: l.roomId)
  let k = inviteKeys(secret: l.secret, roomId: l.roomId)
  if !bytesEqual(try decodeOffer(offer).inviteId, k.inviteId) { throw fail("bad-invite", "the offer does not belong to this link") }
  let o = try verifyInviteOffer(state, offer, now: now)
  if o.logSeq > state.head.seq || !bytesEqual(state.hashes[o.logSeq], o.logHash) { throw fail("bad-invite", "the offer names a member list this hub does not show") }
  let offerHash = try inviteOfferHash(offer)
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.INVITE_REQUEST)).raw(l.roomId, 32).raw(k.inviteId, 16).str16(l.hub, max: HUB_MAX).u8(o.role)
  try w.raw(device.signPub, 32).raw(device.kexPub, 32).raw(offerHash, 32)
  let body = w.out
  let mac = hmacSHA256(key: k.macKey, labelBytes(LABEL.inviteMac) + body)
  let request = body + mac + (try device.sign(LABEL.inviteRequestSig, body + mac))
  return (request, Join(roomId: l.roomId, hub: l.hub, role: o.role, inviteId: k.inviteId, inviterId: o.inviterId, commit: o.commit, offer: offer, request: request))
}

/** On the joining device: check the reveal and return the check code to show. */
public func checkReveal(join: Join, reveal: Bytes, log: [Bytes]) throws -> String {
  let state = try verifyLog(log, roomId: join.roomId)
  let v = try verifyInviteReveal(state, reveal, inviterId: join.inviterId)
  if !bytesEqual(v.inviteId, join.inviteId) { throw fail("bad-invite", "reveal for another invite") }
  if !bytesEqual(v.requestHash, inviteRequestHash(join.request)) { throw fail("bad-invite", "the inviter answered a different request (someone else used this link)") }
  if !bytesEqual(join.commit, hash(LABEL.inviteCommit, v.inviteId, v.nonce)) { throw fail("bad-invite", "the revealed number does not match the commitment") }
  return try inviteCode(offer: join.offer, request: join.request, nonce: v.nonce)
}

/** On the joining device: verify the log up to the room id, find itself in it, open the room key. */
public func completeJoin(join: Join, device: Device, log: [Bytes], wrap: Bytes?) throws -> (state: RoomState, secret: EpochSecret?) {
  let state = try verifyLog(log, roomId: join.roomId)
  guard let me = state.memberAt(device.id) else { throw fail("not-member", "the log does not list this device") }
  if me.role != join.role { throw fail("bad-invite", "enrolled with a different role than invited") }
  let added = state.entries[me.addedSeq]
  if !bytesEqual(added.inviteId, join.inviteId) || !bytesEqual(added.signer, join.inviterId) { throw fail("bad-invite", "this device was added by another invite or another device") }
  if me.role == ROLE.AGENT { return (state, nil) }
  guard let wrap = wrap else { throw fail("no-key", "a human device is added with the room key") }
  return (state, try unwrapEpochKey(state, device, wrap, epoch: state.epochAt(me.addedSeq)))
}

// ---- the inviter's side (tests and parity; the app does this in JS today) ---------------------

public struct InviteRecord { public let roomId: Bytes, hub: String, role: Int, secret: Bytes, nonce: Bytes, inviteId: Bytes, expiresAt: UInt64, offer: Bytes }

public func createInvite(state: RoomState, inviter: Device, hub: String, role: Int, app: String = "https://app.invalid/join", ttlMs: UInt64 = 600_000, now: UInt64 = nowMs(), rng: RNG = systemRandom) throws -> (link: String, offer: Bytes, invite: InviteRecord) {
  guard let me = state.memberAt(inviter.id), me.role == ROLE.HUMAN else { throw fail("not-human", "only a human device can invite") }
  if role != ROLE.HUMAN && role != ROLE.AGENT { throw fail("bad-argument", "role") }
  _ = try checkHubAddress(hub)
  let secret = rng(32), nonce = rng(32)
  let inviteId = inviteKeys(secret: secret, roomId: state.roomId).inviteId
  let expiresAt = now + ttlMs
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.INVITE_OFFER)).raw(state.roomId, 32).raw(inviteId, 16).u8(role).u64(expiresAt)
  try w.raw(hash(LABEL.inviteCommit, inviteId, nonce), 32).raw(inviter.id, 32).u32(state.head.seq).raw(state.head.hash, 32)
  let offer = w.out + (try inviter.sign(LABEL.inviteOfferSig, w.out))
  return (inviteLink(app: app, hub: hub, roomId: state.roomId, secret: secret), offer,
          InviteRecord(roomId: state.roomId, hub: hub, role: role, secret: secret, nonce: nonce, inviteId: inviteId, expiresAt: expiresAt, offer: offer))
}
public func acceptJoinRequest(invite: InviteRecord, request: Bytes, inviter: Device, now: UInt64 = nowMs()) throws -> (reveal: Bytes, code: String, requestHash: Bytes, member: Member) {
  if now > invite.expiresAt { throw fail("invite-expired", "this invite has run out") }
  let q = try decodeRequest(request)
  let macKey = inviteKeys(secret: invite.secret, roomId: invite.roomId).macKey
  if !hmacVerify(key: macKey, mac: q.mac, labelBytes(LABEL.inviteMac) + q.body) { throw fail("bad-mac", "the request was not made with this invite link") }
  let offerHash = try inviteOfferHash(invite.offer)
  if !bytesEqual(q.roomId, invite.roomId) || !bytesEqual(q.inviteId, invite.inviteId) || q.hub != invite.hub || q.role != invite.role || !bytesEqual(q.offerHash, offerHash) {
    throw fail("bad-invite", "the request does not match the invite")
  }
  if !verify(q.signPub, LABEL.inviteRequestSig, q.body + q.mac, q.signature) { throw fail("bad-signature", "invite request") }
  let requestHash = inviteRequestHash(request)
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.INVITE_REVEAL)).raw(invite.inviteId, 16).raw(invite.nonce, 32).raw(requestHash, 32)
  return (w.out + (try inviter.sign(LABEL.inviteRevealSig, w.out)), try inviteCode(offer: invite.offer, request: request, nonce: invite.nonce), requestHash,
          Member(role: q.role, signPub: q.signPub, kexPub: q.kexPub))
}

// ---- signing in to the hub ---------------------------------------------------------------

/** 0x01 0x0d roomId(32) hub str16 deviceId(32) challenge(32) ‖ signature(64) */
public func signHubAuth(device: Device, roomId: Bytes, hub: String, challenge: Bytes) throws -> Bytes {
  _ = try checkHubAddress(hub)
  let w = W()
  try w.u8(Int(VERSION)).u8(Int(OBJ.HUB_AUTH)).raw(roomId, 32, "roomId").str16(hub, max: HUB_MAX).raw(device.id, 32, "device id").raw(challenge, 32, "challenge")
  return w.out + (try device.sign(LABEL.hubAuth, w.out))
}
public func decodeHubAuth(_ bytes: Bytes) throws -> (roomId: Bytes, hub: String, id: Bytes, challenge: Bytes, body: Bytes, signature: Bytes) {
  if bytes.count < 64 { throw fail("bad-format", "hub auth") }
  let body = Array(bytes[0..<(bytes.count - 64)])
  var r = R(body)
  try header(&r, OBJ.HUB_AUTH)
  let out = (try r.take(32), try r.str16(HUB_MAX), try r.take(32), try r.take(32), body, Array(bytes[(bytes.count - 64)...]))
  try r.end()
  return out
}
