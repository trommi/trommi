// Room.swift: a human device in a room, the part of shared/room.mjs and shared/client.mjs a reader needs: join by an
// invite link (check code as emoji), sign in, verify the member list against the pinned room id, open the room and
// session keys, catch up every envelope with full chain verification, and the open cards; answer one.
// Joining is the human's act: this code joins only with a link handed to it, and nothing is added before the human
// confirms the six emoji in the app.
import Foundation
import TrommiCore

// ---- storage -----------------------------------------------------------------------------

public struct SecretJSON: Codable { public let epoch: Int; public let key: String; public let hist: String?
  init(_ s: EpochSecret) { epoch = s.epoch; key = b64u(s.key); hist = s.hist.map(b64u) }
  var secret: EpochSecret { EpochSecret(epoch: epoch, key: (try? unb64u(key)) ?? [], hist: hist.flatMap { try? unb64u($0) }) }
}
public struct OwnSent: Codable { public let seq: UInt64; public let hash: String }
public struct RoomRecord: Codable {
  public var hubURL: String
  public var roomId: String
  public var myDeviceId: String
  public var role: String
  public var entries: [String]               // b64u, the verified member list
  public var pin: Pin
  public var roomSecrets: [SecretJSON]
  public var ownSent: OwnSent?               // the newest envelope this device signed (never sign a number twice)
  public var deviceRegisterSent: Bool
}

/** One directory per room: device.key (0600, the 66-byte key file) and room.json. The app keeps the key in the Keychain instead. */
public struct Store {
  public let dir: URL
  public init(base: URL, roomId: String) { dir = base.appendingPathComponent(roomId, isDirectory: true) }
  public static func defaultBase() -> URL {
    if let x = ProcessInfo.processInfo.environment["TROMMI_SWIFT_HOME"] { return URL(fileURLWithPath: x, isDirectory: true) }
    #if os(Linux)
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/trommi-swift", isDirectory: true)
    #else
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("trommi", isDirectory: true)
    #endif
  }
  public static func rooms(base: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? []).filter { $0.utf8.count == 64 && FileManager.default.fileExists(atPath: base.appendingPathComponent($0).appendingPathComponent("room.json").path) }.sorted()
  }
  func ensure() throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }
  public func saveDevice(_ d: Device) throws {
    try ensure()
    let url = dir.appendingPathComponent("device.key")
    FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    try Data(d.exportSecret()).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  public func loadDevice() throws -> Device { try Device.importSecret(Array(try Data(contentsOf: dir.appendingPathComponent("device.key")))) }
  public func save(_ r: RoomRecord) throws {
    try ensure()
    let url = dir.appendingPathComponent("room.json")
    try JSONEncoder().encode(r).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  public func load() throws -> RoomRecord { try JSONDecoder().decode(RoomRecord.self, from: Data(contentsOf: dir.appendingPathComponent("room.json"))) }
}

// ---- the board, as far as cards go ---------------------------------------------------------------

public struct CardOption: Equatable { public let key: String; public let label: String; public let final: Bool }
public struct Card {
  public let id: String
  public var creator: String
  public var sessionId: String?
  public var keyScope: Int
  public var title: String = ""
  public var cardType: String = "decision"
  public var body: String? = nil
  public var options: [CardOption] = []
  public var urgency: Int = 1
  public var state: Int = CARD_STATE.OPEN
  public var versionHash: Bytes = []
  public var objectVersion: Int = 0
  public var envelopeNumber: Int = 0
  public var readable = true
  public var isCard = false
  public var stateName: String { [1: "open", 2: "answered", 3: "closed"][state] ?? "?" }
  public var urgencyName: String { [0: "low", 1: "normal", 2: "high", 3: "critical"][urgency] ?? "?" }
}

public struct SyncReport { public var envelopes = 0, opened = 0, headerOnly = 0, undecryptable = 0, voids = 0, refused = 0; public var warnings: [String] = [] }

// ---- the room ------------------------------------------------------------------------------------

public final class Room {
  public let store: Store
  public var record: RoomRecord
  public let device: Device
  public let hub: HubClient
  public private(set) var state: RoomState
  public private(set) var roomSecrets: [Int: EpochSecret] = [:]
  public private(set) var sessions: [String: SessionState] = [:]
  public private(set) var sessionSecrets: [String: EpochSecret] = [:]          // "<sid>:<epoch>"
  public private(set) var chains = Chains()
  public private(set) var cards: [String: Card] = [:]
  public private(set) var cardOrder: [String] = []
  public private(set) var cursor = 0

  init(store: Store, record: RoomRecord, device: Device) throws {
    self.store = store; self.record = record; self.device = device
    hub = try HubClient(hubURL: record.hubURL, roomId: record.roomId, signer: device)
    state = try verifyLog(try record.entries.map { try unb64u($0) }, roomId: try unhex(record.roomId))
    if !bytesEqual(device.id, try unhex(record.myDeviceId)) { throw ZError("bad-device", "the key file does not belong to this room record") }
    for s in record.roomSecrets { roomSecrets[s.epoch] = s.secret }
  }

  public static func open(base: URL = Store.defaultBase(), roomId: String) throws -> Room {
    let store = Store(base: base, roomId: roomId)
    return try Room(store: store, record: try store.load(), device: try store.loadDevice())
  }

  // ---- joining -----------------------------------------------------------------------------

  public enum JoinEvent { case requested, checkCode(String), joined }

  /**
   * Join with an invite link the human made in the app (for a human device). `onEvent` gets the check code to show as
   * emoji; the human compares it with the app and confirms there. Returns once the inviter added this device.
   */
  public static func join(link: String, base: URL = Store.defaultBase(), pollMs: UInt64 = 800, timeoutMs: UInt64 = 15 * 60_000, onEvent: (JoinEvent) -> Void) async throws -> Room {
    let l = try parseInviteLink(link)
    let roomId = hex(l.roomId)
    let store = Store(base: base, roomId: roomId)
    if FileManager.default.fileExists(atPath: store.dir.appendingPathComponent("room.json").path) { throw ZError("room-exists", "this device is already in that room") }
    let hub = try HubClient(hubURL: l.hub, roomId: roomId)
    let inviteId = hex(inviteKeys(secret: l.secret, roomId: l.roomId).inviteId)
    let inv = try await hub.getInvite(inviteId)
    let log = try (inv["signed_entries"] as? [String] ?? []).map { try unb64u($0) }
    let device = try Device.generate()
    let (request, join) = try createJoinRequest(link: link, offer: try unb64u(inv["signed_offer"] as? String ?? ""), log: log, device: device)
    if join.role != ROLE.HUMAN { throw ZError("bad-invite", "this is an invite for an agent: make one for a device in the app") }
    // The key reaches the disk before the human can confirm it: a crash after the confirmation must not lose the device.
    try store.saveDevice(device)
    let r = try await hub.postRequest(inviteId, signedRequest: request)
    let requestHash = r["request_hash"] as? String ?? hex(inviteRequestHash(request))
    onEvent(.requested)
    let until = nowMs() + timeoutMs
    var shown = false
    while nowMs() < until {
      let s: JSON
      do { s = try await hub.joinStatus(inviteId, requestHash: requestHash) }
      catch let e as HubError where e.code == "invite-burned" { throw ZError("code-mismatch", "the app said the emoji do not match: nobody was added") }
      let status = s["join_status"] as? String ?? ""
      if status == "taken" { throw ZError("invite-used", "this invite was answered for another device") }
      let entries = try (s["signed_entries"] as? [String])?.map { try unb64u($0) } ?? log
      if (status == "revealed" || status == "joined"), !shown, let rv = s["signed_reveal"] as? String {
        shown = true
        onEvent(.checkCode(try checkReveal(join: join, reveal: try unb64u(rv), log: entries)))
      }
      if status == "joined" {
        let done = try completeJoin(join: join, device: device, log: entries, wrap: try (s["key_sealed"] as? String).map { try unb64u($0) })
        let record = RoomRecord(hubURL: l.hub, roomId: roomId, myDeviceId: hex(device.id), role: "human", entries: entries.map(b64u), pin: pinOf(done.state),
                                roomSecrets: done.secret.map { [SecretJSON($0)] } ?? [], ownSent: nil, deviceRegisterSent: false)
        try store.save(record)
        onEvent(.joined)
        return try Room(store: store, record: record, device: device)
      }
      try await Task.sleep(nanoseconds: pollMs * 1_000_000)
    }
    throw ZError("invite-expired", "the invite ran out before it was confirmed")
  }

  // ---- keys --------------------------------------------------------------------------------

  /** The member list again, verified against the room id this device pinned; refuses rollback and forks. */
  public func refreshMembers() async throws -> [String] {
    var warnings = [String]()
    let m = try await hub.members(after: -1)
    let entries = try (m["signed_entries"] as? [String] ?? []).map { try unb64u($0) }
    let next = try verifyLog(entries, roomId: try unhex(record.roomId))
    switch try checkLogAgainstPin(next, record.pin) {
    case .recoveryOverride(let at): warnings.append("the room was recovered with its recovery code (entry \(at)): check with the human that this was them")
    default: break
    }
    if next.memberAt(device.id) == nil { throw ZError("not-member", "this device is no longer a member of the room") }
    state = next
    record.entries = entries.map(b64u)
    record.pin = pinOf(next)
    try store.save(record)
    return warnings
  }

  /** This device's room keys (every epoch it was sealed one), the older ones through the back links. */
  public func refreshRoomKeys() async throws {
    let r = try await hub.sealedRoomKeys(after: 0)
    for w in r["sealed_room_keys"] as? [JSON] ?? [] {
      guard let e = (w["key_epoch"] as? NSNumber)?.intValue, roomSecrets[e] == nil, let sealed = w["key_sealed"] as? String else { continue }
      if let s = try? unwrapEpochKey(state, device, try unb64u(sealed), epoch: e) { roomSecrets[e] = s }
    }
    let links = try await hub.keyBackLinks()
    var byEpoch = [Int: Bytes]()
    for l in links["key_back_links"] as? [JSON] ?? [] { if let e = (l["key_epoch"] as? NSNumber)?.intValue, let b = l["key_back_link"] as? String { byEpoch[e] = try unb64u(b) } }
    var e = roomSecrets.keys.max() ?? 0
    while e > 1 {
      if roomSecrets[e - 1] == nil, let s = roomSecrets[e], let link = byEpoch[e], let prev = try? openBackLink(state, s, link) { roomSecrets[e - 1] = prev }
      e -= 1
    }
    record.roomSecrets = roomSecrets.values.sorted { $0.epoch < $1.epoch }.map(SecretJSON.init)
    try store.save(record)
  }

  /** Every session's grant chain, verified; this device's session keys (a human holds every session key), older epochs by back links. */
  public func refreshSessions() async throws {
    let r = try await hub.sessionBundle()
    for s in r["sessions"] as? [JSON] ?? [] {
      guard let sid = s["session_id"] as? String, sid.utf8.count == 32, let grants = s["signed_grants"] as? [String], !grants.isEmpty else { continue }
      guard let ss = try verifyGrants(try grants.map { try unb64u($0) }, state) else { continue }
      sessions[sid] = ss
      for w in s["sealed_session_keys"] as? [JSON] ?? [] {
        guard let e = (w["session_key_epoch"] as? NSNumber)?.intValue, let sealed = w["key_sealed"] as? String, sessionSecrets["\(sid):\(e)"] == nil else { continue }
        if let k = try? unwrapSessionKey(roomId: state.roomId, sessionState: ss, device: device, sealed: try unb64u(sealed), epoch: e) { sessionSecrets["\(sid):\(e)"] = k }
      }
      var links = [Int: Bytes]()
      for l in s["key_back_links"] as? [JSON] ?? [] { if let e = (l["session_key_epoch"] as? NSNumber)?.intValue, let b = l["key_back_link"] as? String { links[e] = try unb64u(b) } }
      var e = ss.epoch
      while e > 1 {
        if sessionSecrets["\(sid):\(e - 1)"] == nil, let k = sessionSecrets["\(sid):\(e)"], let link = links[e],
           let prev = try? openSessionBackLink(roomId: state.roomId, sessionState: ss, secret: k, link: link) { sessionSecrets["\(sid):\(e - 1)"] = prev }
        e -= 1
      }
    }
  }

  private func secretFor(_ h: Header) -> EpochSecret? {
    h.keyScope == KEY_SCOPE.SESSION ? sessionSecrets["\(hex(h.sessionId ?? [])):\(h.epoch)"] : roomSecrets[h.epoch]
  }

  // ---- catching up ---------------------------------------------------------------------------

  /** Sign in, refresh the member list and keys, and read every envelope from the start, verifying every sender's chain. */
  @discardableResult public func sync() async throws -> SyncReport {
    var report = SyncReport()
    try await hub.signIn()
    report.warnings += try await refreshMembers()
    try await refreshRoomKeys()
    try await refreshSessions()
    chains = Chains(); cards = [:]; cardOrder = []; cursor = 0
    while true {
      let page = try await hub.envelopes(after: cursor)
      let list = page["envelopes"] as? [JSON] ?? []
      if list.isEmpty { break }
      for rec in list {
        guard let n = (rec["envelope_number"] as? NSNumber)?.intValue, let b = rec["envelope"] as? String else { continue }
        do { try await apply(number: n, bytes: try unb64u(b), isVoid: rec["void"] as? Bool ?? false, report: &report) }
        catch let e as ZError {
          // Refused (a broken chain, a forged signature, …): never applied, and said. The sender's later envelopes then
          // stop at a gap too; the app would resync, this reader reports it.
          report.refused += 1
          if report.refused <= 5 { report.warnings.append("envelope \(n) refused: \(e)") }
        }
        cursor = n
      }
      if list.count < 1000 { break }
    }
    if let own = record.ownSent, (chains[hex(device.id)]?.seq ?? 0) < own.seq {
      report.warnings.append("the hub shows fewer of this device's envelopes (\(chains[hex(device.id)]?.seq ?? 0)) than it sent (\(own.seq))")
    }
    return report
  }

  private func apply(number: Int, bytes: Bytes, isVoid: Bool, report: inout SyncReport, retried: Bool = false) async throws {
    report.envelopes += 1
    do {
      let (h, split) = try peekEnvelope(bytes)
      if isVoid || split.pruned {
        _ = try verifyEnvelope(bytes, state: state, chains: &chains, allowRemovedSender: true)
        if isVoid { report.voids += 1; return }
        report.headerOnly += 1
        if h.isHead { applyHead(number: number, header: h, hash: try envelopeHash(split), payload: nil) }
        return
      }
      do {
        let o = try openEnvelope(bytes, state: state, chains: &chains, secrets: secretFor, selfId: device.id, allowRemovedSender: true)
        if o.quarantined != nil { report.undecryptable += 1 } else { report.opened += 1 }
        if h.isHead { applyHead(number: number, header: o.header, hash: o.hash, payload: o.payload) }
      } catch let e as ZError where e.code == "no-key" {
        let v = try verifyEnvelope(bytes, state: state, chains: &chains, allowRemovedSender: true)
        report.undecryptable += 1
        if h.isHead { applyHead(number: number, header: v.header, hash: v.hash, payload: nil) }
      }
    } catch let e as ZError where e.code == "log-behind" && !retried {
      report.warnings += try await refreshMembers()
      try await refreshSessions()
      try await apply(number: number, bytes: bytes, isVoid: isVoid, report: &report, retried: true)
    }
  }
  private func envelopeHash(_ s: SplitEnvelope) throws -> Bytes { hash(LABEL.envelope, s.headerBytes, s.nonce, s.ciphertextHash ?? sha256(s.ciphertext!)) }

  /** The heads that make a card: its versions (from its creator) and the answers and take-backs that move its state. */
  private func applyHead(number: Int, header h: Header, hash: Bytes, payload: Bytes?) {
    guard let block = h.card else { return }
    let id = hex(block.id)
    let content = payload.flatMap { try? JSONSerialization.jsonObject(with: Data($0)) as? JSON }
    switch h.kind {
    case KIND.OBJECT_VERSION:
      if let c = cards[id], c.creator != hex(h.sender) { return }               // only the creator writes versions (R1)
      var c = cards[id] ?? Card(id: id, creator: hex(h.sender), sessionId: h.sessionId.map(hex), keyScope: h.keyScope)
      if cards[id] == nil { cardOrder.append(id) }
      c.state = block.state; c.urgency = block.urgency; c.versionHash = hash; c.envelopeNumber = number
      if let content = content {
        c.readable = true
        c.isCard = content["object_type"] as? String == "card"
        c.title = content["title"] as? String ?? ""
        c.cardType = content["card_type"] as? String ?? "decision"
        c.body = content["body"] as? String
        c.objectVersion = (content["object_version"] as? NSNumber)?.intValue ?? c.objectVersion + 1
        c.options = (content["options"] as? [Any] ?? []).compactMap { o in
          if let o = o as? JSON, let k = o["key"] as? String { return CardOption(key: k, label: o["label"] as? String ?? k, final: o["final"] as? Bool ?? false) }
          if let s = o as? String { return CardOption(key: s, label: s, final: false) }
          return nil
        }
      } else { c.readable = false }
      cards[id] = c
    case KIND.ANSWER, KIND.DECIDE_AGAIN:
      guard var c = cards[id], state.member(h.sender)?.role == ROLE.HUMAN else { return }
      c.state = block.state
      cards[id] = c
    default: break
    }
  }

  /** The open cards (decisions and infos), oldest first, as the Desk stacks them. */
  public var openCards: [Card] { cardOrder.compactMap { cards[$0] }.filter { $0.isCard && $0.state == CARD_STATE.OPEN } }

  // ---- sending -------------------------------------------------------------------------------

  /** Seal under the right key, store the own chain before the hub sees it, post. */
  private func send(kind: Int, payload: JSON, bind: Bytes = [], recipient: Bytes? = nil, keyScope: Int, sessionId: String?, card: ObjectBlock? = nil) async throws -> (number: Int, hash: String) {
    if let own = record.ownSent, (chains[hex(device.id)]?.seq ?? 0) != own.seq { throw ZError("chain-behind", "catch up first: this device's chain is not where it left it") }
    let secret: EpochSecret
    if keyScope == KEY_SCOPE.SESSION {
      guard let sid = sessionId, let ss = sessions[sid], let k = sessionSecrets["\(sid):\(ss.epoch)"] else { throw ZError("no-key", "no key for this session") }
      if grantIsStale(ss, state) { throw ZError("stale-session-key", "this session waits for a re-key after a removal (open the app once)") }
      secret = k
    } else {
      guard let k = roomSecrets[state.epoch] else { throw ZError("no-key", "no room key for the current epoch") }
      secret = k
    }
    let body = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let sealed = try sealEnvelope(device: device, state: state, secret: secret, chains: &chains, kind: kind, keyScope: keyScope, sessionId: try sessionId.map { try unhex($0) },
                                  bind: bind, payload: Array(body), recipient: recipient, card: card)
    record.ownSent = OwnSent(seq: sealed.seq, hash: hex(sealed.hash))
    try store.save(record)
    let r = try await hub.postEnvelope(sealed.bytes)
    return ((r["envelope_number"] as? NSNumber)?.intValue ?? 0, hex(sealed.hash))
  }

  /** Answer an open card with one or more of its options (README "answer"). */
  public func answer(cardId: String, choices: [String]) async throws -> (number: Int, hash: String) {
    guard let c = cards[cardId] ?? cards.values.first(where: { $0.id.hasPrefix(cardId) }), c.isCard else { throw ZError("not-found", "no such card") }
    if c.state != CARD_STATE.OPEN { throw ZError("card-closed", "the card is not open") }
    if !c.readable { throw ZError("card-pruned", "this device holds only the header of this card") }
    for ch in choices where !c.options.contains(where: { $0.key == ch }) { throw ZError("bad-choice", "the card has no option \(ch)") }
    if choices.isEmpty && !c.options.isEmpty { throw ZError("bad-choice", "name at least one option") }
    let settles = !choices.isEmpty && choices.allSatisfy { k in c.options.first { $0.key == k }?.final == true }
    let bind = try encodeAnswerBind(objectId: try unhex(c.id), versionHash: c.versionHash, choices: choices)
    let holder = sessions[c.sessionId ?? ""].flatMap { s in s.agentIds.isEmpty || s.agentIds.contains(c.creator) ? nil : s.agentIds[0] } ?? c.creator
    return try await send(kind: KIND.ANSWER, payload: ["schema_version": 1, "answer_action": "answer", "choices": choices], bind: bind, recipient: try unhex(holder),
                          keyScope: c.keyScope, sessionId: c.sessionId,
                          card: ObjectBlock(id: try unhex(c.id), state: settles ? CARD_STATE.CLOSED : CARD_STATE.ANSWERED, urgency: c.urgency, answeredAt: nowMs()))
  }

  /** The device's name for the other devices (register device/<id>, encrypted under the room key), once after joining. */
  public func sendDeviceRegister(name: String, platform: String) async throws {
    if record.deviceRegisterSent { return }
    _ = try await send(kind: KIND.STATUS, payload: ["schema_version": 1, "values": ["device/\(hex(device.id))": ["device_name": name, "platform": platform]], "lamport": 1], keyScope: KEY_SCOPE.ROOM, sessionId: nil)
    record.deviceRegisterSent = true
    try store.save(record)
  }
}
