// Room.swift: a human device in a room, the part of shared/room.mjs and shared/client.mjs a reader needs: join by an
// invite link (check code as emoji), sign in, verify the member list against the pinned room id, open the room and
// session keys, catch up every envelope with full chain verification, and the open cards; answer one.
// Joining is the human's act: this code joins only with a link handed to it, and nothing is added before the human
// confirms the six emoji in the app.
import Foundation
import TrommiCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

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
  public var outbox: [OutboxItem]? = nil    // sealed, not yet taken by the hub
  public var lamport: Int? = nil
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

// ---- the room ------------------------------------------------------------------------------------

/** One envelope after verification and opening (no board yet): what a background pass hands to the main thread. */
struct Pre {
  var number: Int
  var header: Header
  var hash: Bytes
  var payload: Bytes?
  var bind: Bytes?
  var contentState: String
  var isVoid: Bool
}

public struct SyncReport { public var envelopes = 0, opened = 0, headerOnly = 0, undecryptable = 0, voids = 0, refused = 0; public var warnings: [String] = [] }

/** The hub asks for a newer app (426 client-too-old, or the stream's upgrade_required). */
public struct UpgradeNotice: Equatable { public var minimumVersion: String?; public var message: String }

/** A sealed envelope on its way to the hub, kept until the hub took it (a crash must not reuse its number). */
public struct OutboxItem: Codable { public var bytes: String; public var seq: UInt64; public var hash: String; public var localId: String }

@MainActor
public final class Room {
  public let store: Store
  public var record: RoomRecord
  public let device: Device
  public let hub: HubClient
  public private(set) var state: RoomState
  public private(set) var roomSecrets: [Int: EpochSecret] = [:]
  public private(set) var sessionStates: [String: SessionState] = [:]
  private var sessionGrants: [String: [Bytes]] = [:]
  public private(set) var sessionSecrets: [String: EpochSecret] = [:]          // "<sid>:<epoch>"
  public private(set) var chains = Chains()
  /** The board: cards, sessions, conversations, registers, notes: the same rules as the web app (Board.swift). */
  public let board = Board()
  public private(set) var cursor = 0
  /** The highest lamport this device has seen or written (R2). */
  public private(set) var lamport = 0
  public private(set) var upgrade: UpgradeNotice?
  /** Called after every batch that changed the board (on the main actor). */
  public var onChange: ((Change) -> Void)?
  /** Live: the stream is open. */
  public private(set) var live = false
  private var own: [String: (header: Header, payload: Bytes, bind: Bytes, localId: String)] = [:]   // hash hex -> what this device sealed
  private var outbox: [OutboxItem] = []
  private var queueTail: Task<Void, Never>?
  private var synced = false
  private var echoSeq = 0
  private var token401 = false

  init(store: Store, record: RoomRecord, device: Device) throws {
    self.store = store; self.record = record; self.device = device
    hub = try HubClient(hubURL: record.hubURL, roomId: record.roomId, signer: device)
    state = try verifyLog(try record.entries.map { try unb64u($0) }, roomId: try unhex(record.roomId))
    if !bytesEqual(device.id, try unhex(record.myDeviceId)) { throw ZError("bad-device", "the key file does not belong to this room record") }
    for s in record.roomSecrets { roomSecrets[s.epoch] = s.secret }
    lamport = record.lamport ?? 0
    outbox = record.outbox ?? []
    board.roomId = record.roomId; board.hubURL = record.hubURL; board.myDeviceId = record.myDeviceId; board.myRole = record.role
    var ch = Change()
    applyMemberList(&ch)
  }

  public static func open(base: URL = Store.defaultBase(), roomId: String) throws -> Room {
    let store = Store(base: base, roomId: roomId)
    return try Room(store: store, record: try store.load(), device: try store.loadDevice())
  }

  /** Run strictly after everything queued before (catch-up, live records, sends), as the JS core's serial(). */
  func serial<T>(_ op: @escaping @MainActor () async throws -> T) async throws -> T {
    let prev = queueTail
    let t = Task { @MainActor () throws -> T in
      _ = await prev?.value
      return try await op()
    }
    queueTail = Task { _ = try? await t.value }
    return try await t.value
  }

  private func emit(_ c: Change) { if !c.isEmpty { onChange?(c) } }
  private func saveRecord() { try? store.save(record) }

  /** A hub error that says this app is too old: remembered (the app shows it), and rethrown. */
  private func noted<T>(_ op: () async throws -> T) async throws -> T {
    do { return try await op() }
    catch let e as HubError where e.status == 426 || e.code == "client-too-old" {
      upgrade = UpgradeNotice(minimumVersion: e.extra["minimum_version"] as? String, message: e.message)
      var ch = Change(); ch.room = true; emit(ch)
      throw e
    }
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

  // ---- email + password (shared/account.mjs loginWithPassword, room.mjs joinWithRecoveryCode) --------------------

  /**
   * Log in on this device with the account's email and password: the hub hands back the room's recovery code sealed
   * under the password (it never sees either), the device opens it and adds ITSELF as a human device with the
   * recovery key. One error for unknown email and wrong password: "wrong-login". Every other human device then
   * shows the alert "recovery-add".
   */
  public static func loginWithPassword(hubURL: String, email: String, password: String, base: URL = Store.defaultBase()) async throws -> Room {
    switch try await signInWithPassword(hubURL: hubURL, email: email, password: password, base: base) {
    case .joined(let room): return room
    }
  }

  /**
   * What an email + password sign-in led to. Today the hub always answers with the sealed code, so the device is in.
   * A later step of the hub (a link mailed per new device, an optional one-time code) becomes a case here
   * ("check your email"), handled in loginAnswer alone.
   */
  public enum LoginOutcome { case joined(Room) }

  /** One password: auth_key (for the hub) and wrap_key (opens the code, never leaves the device), both from it. */
  public static func signInWithPassword(hubURL: String, email: String, password: String, base: URL = Store.defaultBase()) async throws -> LoginOutcome {
    let email = try normaliseEmail(email)
    let k = try accountPasswordKeys(email: email, password: password)
    let r: JSON
    do { r = try await HubClient(hubURL: hubURL).accountLogin(email: email, authKey: k.authKey) }
    catch let e as HubError where e.code == "wrong-login" { throw ZError("wrong-login", "email or password is wrong") }
    return try await loginAnswer(r, hubURL: hubURL, wrapKey: k.wrapKey, base: base)
  }

  /** The hub's answer to POST accounts/login, the one place it is read: { room_id, key_wrapped, kdf, challenge }. */
  static func loginAnswer(_ r: JSON, hubURL: String, wrapKey: Bytes, base: URL) async throws -> LoginOutcome {
    guard let roomId = r["room_id"] as? String, let wrapped = r["key_wrapped"] as? String else { throw ZError("bad-format", "the login answer") }
    let code = try accountUnwrapCode(wrapKey: wrapKey, roomId: roomId, blob: wrapped, what: "password")
    return .joined(try await joinWithRecoveryCode(hubURL: hubURL, roomId: roomId, code: code, base: base, challenge: r["challenge"] as? String))
  }

  /**
   * A fresh device that holds the room's recovery code: sign in as the recovery key, add itself as a human device
   * (entry signed by the recovery key; nobody is removed), seal the room key for itself, and re-seal every session's
   * current key for everyone who holds it (itself included), as the JS core does (client._resealSessions).
   */
  public static func joinWithRecoveryCode(hubURL: String, roomId: String, code: String, base: URL = Store.defaultBase(), challenge: String? = nil) async throws -> Room {
    let hubURL = try checkHubAddress(hubURL)
    let store = Store(base: base, roomId: roomId)
    if FileManager.default.fileExists(atPath: store.dir.appendingPathComponent("room.json").path) { throw ZError("room-exists", "this device is already in that room") }
    let rec = try recoveryDevice(code)
    let hub = try HubClient(hubURL: hubURL, roomId: roomId, signer: rec)
    try await hub.signIn(challenge: challenge)
    async let m = hub.members(after: -1)
    async let keys = hub.sealedRoomKeys(after: 0)
    async let bundle = hub.sessionBundle()
    let entries = try (try await m)["signed_entries"] as? [String] ?? []
    let state = try verifyLog(try entries.map { try unb64u($0) }, roomId: try unhex(roomId))
    if !bytesEqual(rec.id, state.recovery.id) { throw ZError("bad-recovery-code", "an old recovery code (a recovery happened since)") }
    guard let wrap = (try await keys)["sealed_room_keys"].flatMap({ $0 as? [JSON] })?.first(where: { ($0["key_epoch"] as? NSNumber)?.intValue == state.epoch }),
          let sealedRoom = wrap["key_sealed"] as? String else { throw ZError("no-key", "the hub holds no sealed room key for the recovery key") }
    let secret = try unwrapEpochKey(state, rec, try unb64u(sealedRoom), epoch: state.epoch)
    // Every session's grants and current key, as the recovery key holds them (R6).
    var held: [(sid: String, state: SessionState, current: EpochSecret)] = []
    for s in (try await bundle)["sessions"] as? [JSON] ?? [] {
      guard let sid = s["session_id"] as? String, sid.utf8.count == 32, let grants = s["signed_grants"] as? [String], !grants.isEmpty,
            let ss = try verifyGrants(try grants.map { try unb64u($0) }, state) else { continue }
      guard let w = (s["sealed_session_keys"] as? [JSON] ?? []).first(where: { ($0["session_key_epoch"] as? NSNumber)?.intValue == ss.epoch }),
            let sealed = w["key_sealed"] as? String else { continue }
      held.append((sid, ss, try unwrapSessionKey(roomId: state.roomId, sessionState: ss, device: rec, sealed: try unb64u(sealed), epoch: ss.epoch)))
    }
    let device = try Device.generate()
    let added = try addMember(state, signer: rec, member: Member(role: ROLE.HUMAN, signPub: device.signPub, kexPub: device.kexPub))
    let sealed = try wrapEpochKey(added.state, secret, device.id)
    try store.saveDevice(device)                         // before the entry that makes it a member
    _ = try await hub.postMember(signedEntry: added.entry, sealedRoomKeys: [(device.id, sealed)])
    let record = RoomRecord(hubURL: hubURL, roomId: roomId, myDeviceId: hex(device.id), role: "human", entries: entries + [b64u(added.entry)], pin: pinOf(added.state),
                            roomSecrets: [SecretJSON(secret)], ownSent: nil, deviceRegisterSent: false)
    try store.save(record)
    let room = try Room(store: store, record: record, device: device)
    // The re-seal: the same grant for each session (agents still in the room; one dropped means a new key epoch), signed
    // by the new device, posted together (POST session_grants, 64 per request). The history entitlement of the agents
    // is not known yet at this point, as in the JS core (session_history register unread): none in these grants.
    var items: [JSON] = []
    for h in held {
      let agents = h.state.agentIds.compactMap { try? unhex($0) }
      let active = agents.filter { added.state.memberAt($0)?.role == ROLE.AGENT }
      let g = try createSessionGrant(state: added.state, signer: device, sessionState: h.state, current: h.current, agentIds: active, withHistory: false, rotate: active.count != agents.count)
      var item: JSON = ["session_id": h.sid, "signed_grant": b64u(g.grant), "sealed_session_keys": g.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]
      if let bl = g.backLink { item["key_back_link"] = b64u(bl) }
      items.append(item)
    }
    var i = 0
    while i < items.count {
      _ = try await hub.postSessionGrants(Array(items[i..<min(i + 64, items.count)]))
      i += 64
    }
    return room
  }

  // ---- members and keys -------------------------------------------------------------------

  private func applyMemberList(_ ch: inout Change) {
    let list = state.memberOrder.compactMap { state.members[$0] }.map { m in
      (id: hex(m.id), role: m.role == ROLE.HUMAN ? "human" : "agent", active: m.removedSeq == nil, added: m.addedSeq, removed: m.removedSeq)
    }
    board.applyMembers(list, change: &ch)
    board.keyEpoch = state.epoch
    board.lastEntryNumber = state.head.seq
  }

  /** The member list again, verified against the room id this device pinned; refuses rollback and forks. */
  @discardableResult public func refreshMembers() async throws -> [String] {
    var warnings = [String]()
    let m = try await noted { try await hub.members(after: -1) }
    let entries = try (m["signed_entries"] as? [String] ?? []).map { try unb64u($0) }
    let next = try verifyLog(entries, roomId: try unhex(record.roomId))
    switch try checkLogAgainstPin(next, record.pin) {
    case .recoveryOverride(let at): warnings.append("the room was recovered with its recovery code (entry \(at)): check with the human that this was them")
    default: break
    }
    if next.memberAt(device.id) == nil { throw ZError("not-member", "this device is no longer a member of the room") }
    let added = next.head.seq > state.head.seq
    state = next
    record.entries = entries.map(b64u)
    record.pin = pinOf(next)
    saveRecord()
    var ch = Change()
    applyMemberList(&ch)
    if added { ch.room = true }
    emit(ch)
    return warnings
  }

  /** Online state and the agents' links (GET devices). */
  public func refreshDevices() async {
    guard let d = try? await hub.devices() else { return }
    var ch = Change()
    board.applyDevices((d["devices"] as? [Any] ?? []).map { JV(any: $0) }, change: &ch)
    emit(ch)
  }

  /** This device's room keys (every epoch it was sealed one), the older ones through the back links. */
  public func refreshRoomKeys() async throws {
    let r = try await noted { try await hub.sealedRoomKeys(after: 0) }
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
    saveRecord()
  }

  /** Every session's grant chain, verified; this device's session keys (a human holds every session key), older epochs by back links. */
  public func refreshSessions() async throws {
    let r = try await noted { try await hub.sessionBundle() }
    var ch = Change()
    for s in r["sessions"] as? [JSON] ?? [] {
      guard let sid = s["session_id"] as? String, sid.utf8.count == 32, let grants = s["signed_grants"] as? [String], !grants.isEmpty else { continue }
      let raw = try grants.map { try unb64u($0) }
      guard let ss = try verifyGrants(raw, state) else { continue }
      sessionStates[sid] = ss
      sessionGrants[sid] = raw
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
      // Who was assigned in which key epoch (B03/A7), and who ever was (model.mjs everAgents, epochAgents).
      var byEpoch = [Int: [String]](), ever = [String]()
      for g in raw { if let d = try? decodeGrant(g) { for id in d.agentIds.map(hex) { if !(byEpoch[d.epoch] ?? []).contains(id) { byEpoch[d.epoch, default: []].append(id) }; if !ever.contains(id) { ever.append(id) } } } }
      board.applySessionGrant(ss, everAgentIds: ever, epochAgentIds: byEpoch, change: &ch)
    }
    board.project()
    emit(ch)
  }

  nonisolated private static func secretLookup(room: [Int: EpochSecret], sessions: [String: EpochSecret]) -> SecretLookup {
    { h in h.keyScope == KEY_SCOPE.SESSION ? sessions["\(hex(h.sessionId ?? [])):\(h.epoch)"] : room[h.epoch] }
  }

  // ---- catching up ---------------------------------------------------------------------------

  /**
   * Verify (and open where a key is at hand) a page of envelopes in order, off the main thread. Stops before the first
   * envelope that needs the member list or a session key this device has not fetched yet (`stop`), so the caller
   * refreshes and goes on from there.
   */
  nonisolated static func check(_ list: [(n: Int, bytes: Bytes, isVoid: Bool)], state: RoomState, chains: Chains, secrets: SecretLookup, me: Bytes,
                                ownHashes: Set<String>) -> (pres: [Pre], refused: [(Int, String)], chains: Chains, stop: (index: Int, code: String)?) {
    var chains = chains
    var pres = [Pre](), refused = [(Int, String)]()
    for (i, x) in list.enumerated() {
      do {
        let (h, split) = try peekEnvelope(x.bytes)
        if bytesEqual(h.sender, me), let hh = try? hash(LABEL.envelope, split.headerBytes, split.nonce, split.ciphertextHash ?? sha256(split.ciphertext!)), ownHashes.contains(hex(hh)) {
          // An envelope this device sealed in this run: its own chain moved on when it was sealed.
          pres.append(Pre(number: x.n, header: h, hash: hh, payload: nil, bind: nil, contentState: "own", isVoid: x.isVoid))
          continue
        }
        if x.isVoid || split.pruned {
          let v = try verifyEnvelope(x.bytes, state: state, chains: &chains, allowChainStart: true, allowRemovedSender: true)
          pres.append(Pre(number: x.n, header: v.header, hash: v.hash, payload: nil, bind: nil, contentState: x.isVoid ? "void" : (h.isHead ? "pruned" : "header"), isVoid: x.isVoid))
          continue
        }
        do {
          let o = try openEnvelope(x.bytes, state: state, chains: &chains, secrets: secrets, selfId: me, allowChainStart: true, allowRemovedSender: true)
          pres.append(Pre(number: x.n, header: o.header, hash: o.hash, payload: o.quarantined == nil ? o.payload : nil, bind: o.quarantined == nil ? o.bind : nil,
                          contentState: o.quarantined == nil ? "ok" : "undecryptable", isVoid: false))
        } catch let e as ZError where e.code == "no-key" {
          if h.keyScope == KEY_SCOPE.SESSION { return (pres, refused, chains, (i, "no-key")) }
          let v = try verifyEnvelope(x.bytes, state: state, chains: &chains, allowChainStart: true, allowRemovedSender: true)
          pres.append(Pre(number: x.n, header: v.header, hash: v.hash, payload: nil, bind: nil, contentState: "undecryptable", isVoid: false))
        }
      } catch let e as ZError where e.code == "log-behind" {
        return (pres, refused, chains, (i, "log-behind"))
      } catch let e as ZError {
        refused.append((x.n, e.description))
      } catch {
        refused.append((x.n, "\(error)"))
      }
    }
    return (pres, refused, chains, nil)
  }

  /** Sign in, refresh the member list and keys, and read every envelope after the cursor, verifying every sender's chain. */
  @discardableResult public func sync() async throws -> SyncReport {
    try await serial { [self] in try await self.catchUp() }
  }

  private func catchUp() async throws -> SyncReport {
    var report = SyncReport()
    try await noted { try await hub.signIn() }
    report.warnings += try await refreshMembers()
    try await refreshRoomKeys()
    try await refreshSessions()
    Task { await self.refreshDevices() }
    var change = Change()
    while true {
      let page = try await noted { try await hub.envelopes(after: cursor) }
      let list = (page["envelopes"] as? [JSON] ?? []).compactMap { rec -> (n: Int, bytes: Bytes, isVoid: Bool)? in
        guard let n = (rec["envelope_number"] as? NSNumber)?.intValue, let b = rec["envelope"] as? String, let bytes = try? unb64u(b) else { return nil }
        return (n, bytes, rec["void"] as? Bool ?? false)
      }
      if list.isEmpty { break }
      try await process(list, report: &report, change: &change)
      if list.count < 1000 { break }
    }
    if let own = record.ownSent, (chains[hex(device.id)]?.seq ?? 0) < own.seq, outbox.isEmpty {
      report.warnings.append("the hub shows fewer of this device's envelopes (\(chains[hex(device.id)]?.seq ?? 0)) than it sent (\(own.seq))")
    }
    synced = true
    board.project()
    change.stack = true
    emit(change)
    pumpOutbox()
    return report
  }

  /** Verify a run of envelopes (off the main thread), refreshing the member list or session keys where one needs it, and apply them. */
  private func process(_ list: [(n: Int, bytes: Bytes, isVoid: Bool)], report: inout SyncReport, change: inout Change) async throws {
    var rest = list[...]
    var retried = Set<Int>()
    while !rest.isEmpty {
      let st = state, ch = chains, me = device.id
      let secrets = Room.secretLookup(room: roomSecrets, sessions: sessionSecrets)
      let ownHashes = Set(own.keys)
      let batch = Array(rest)
      let out = await Task.detached(priority: .userInitiated) { Room.check(batch, state: st, chains: ch, secrets: secrets, me: me, ownHashes: ownHashes) }.value
      chains = out.chains
      for (n, why) in out.refused {
        report.refused += 1
        if report.refused <= 5 { report.warnings.append("envelope \(n) refused: \(why)") }
        cursor = max(cursor, n)
      }
      for p in out.pres { applyPre(p, report: &report, change: &change) }
      guard let stop = out.stop else { break }
      let at = rest.startIndex + stop.index
      let n = rest[at].n
      if retried.contains(n) {
        // Refreshed already and still not readable: verify it without a body (it stays undecryptable).
        var c = chains
        if let v = try? verifyEnvelope(rest[at].bytes, state: state, chains: &c, allowChainStart: true, allowRemovedSender: true) {
          chains = c
          applyPre(Pre(number: n, header: v.header, hash: v.hash, payload: nil, bind: nil, contentState: "undecryptable", isVoid: false), report: &report, change: &change)
        } else { report.refused += 1 }
        cursor = max(cursor, n)
        rest = rest[(at + 1)...]
        continue
      }
      retried.insert(n)
      if stop.code == "log-behind" { report.warnings += try await refreshMembers(); try await refreshRoomKeys() }
      try await refreshSessions()
      rest = rest[at...]
    }
  }

  /** One checked envelope into the board. */
  private func applyPre(_ p: Pre, report: inout SyncReport, change: inout Change) {
    report.envelopes += 1
    cursor = max(cursor, p.number)
    board.lastEnvelopeNumber = max(board.lastEnvelopeNumber, p.number)
    if p.isVoid { report.voids += 1; return }
    var payload = p.payload, bind = p.bind, contentState = p.contentState
    var localId: String? = nil
    if contentState == "own", let o = own.removeValue(forKey: hex(p.hash)) {
      payload = o.payload; bind = o.bind; contentState = "ok"; localId = o.localId
    } else if contentState == "own" { contentState = "header" }
    switch contentState {
    case "ok": report.opened += 1
    case "pruned", "header": report.headerOnly += 1
    default: report.undecryptable += 1
    }
    guard var rec = record(p, payload: payload, bind: bind, contentState: contentState) else { return }
    rec.localId = localId
    if rec.object != nil && (rec.kind == KIND.OBJECT_VERSION || rec.kind == KIND.PERMISSION_REQUEST) {
      rec.objectIdOk = (try? objectIdOf(p.header.sender, p.header.seq)).map(hex) == rec.object?.objectId
    }
    board.apply(rec, change: &change)
  }

  /** The record of an envelope (client.mjs _record): header values by name, the body decoded, the bind to hex. */
  private func record(_ p: Pre, payload: Bytes?, bind: Bytes?, contentState: String) -> Rec? {
    let h = p.header
    var content: JV? = nil
    var cs = contentState
    if let payload = payload, cs == "ok" {
      let d = Room.decodePayload(payload, header: h)
      content = d.content; cs = d.state
    }
    var lam = lamportOf(content)
    if let c = content, let claimed = c["lamport"].double, claimed > 0, !(lam > 0 && lamportAccepted(lam, lamport)) {
      var ch = Change()
      board.pushAlert(&ch, code: "lamport-inflated", message: "a write claims lamport \(Int(claimed)), far above \(lamport): ignored", envelopeNumber: p.number, sender: hex(h.sender))
      lam = 0
    }
    if lam > lamport { lamport = lam }
    var b: DecodedBind? = nil
    if let bind = bind, !bind.isEmpty, let d = try? decodeBind(kind: h.kind, bind) {
      switch d {
      case let .answer(o, vh, choices): b = .answer(cardId: hex(o), versionHash: hex(vh), choices: choices)
      case let .decideAgain(o, prev, vh): b = .decideAgain(cardId: hex(o), previousHash: hex(prev), versionHash: hex(vh))
      case let .permissionRequest(r, exp): b = .permissionRequest(requestId: hex(r), expiresAt: exp)
      case let .verdict(r, rh, exp, allow): b = .verdict(requestId: hex(r), requestHash: hex(rh), expiresAt: exp, allow: allow)
      }
    }
    let sender = hex(h.sender)
    let role = state.member(h.sender).map { $0.role == ROLE.HUMAN ? "human" : "agent" } ?? "unknown"
    return Rec(envelopeNumber: p.number, envelopeHash: hex(p.hash), senderDeviceId: sender, senderRole: role, recipientDeviceId: isZero(h.recipient) ? nil : hex(h.recipient),
               sentAt: h.time, kind: h.kind, isHead: h.isHead,
               object: h.card.map { ObjectHead(objectId: hex($0.id), objectState: $0.state, urgency: $0.urgency, answeredAt: $0.answeredAt) },
               timelineKind: h.timelineKind.map { TIMELINE_KIND_NAME[$0] ?? String($0) }, timelineId: h.timelineId,
               sessionId: h.keyScope == KEY_SCOPE.SESSION ? h.sessionId.map(hex) : nil, attachmentIds: h.blobs.map(hex), content: content, contentState: cs,
               bind: b, causal: Causal(senderDeviceId: sender, senderSequence: h.seq, sentAt: h.time, lamport: lam), senderSequence: h.seq, epoch: h.epoch)
  }

  /**
   * codec.mjs decodePayload: UTF-8 JSON object, no BOM; a newer schema is kept as it is ("newer_schema": shown as "needs a
   * newer app"); every attachment id is hex and in the signed header's blob list, else the body counts as undecryptable.
   */
  nonisolated public static func decodePayload(_ bytes: Bytes, header h: Header) -> (content: JV?, state: String) {
    if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { return (nil, "undecryptable") }
    guard String(bytes: bytes, encoding: .utf8) != nil, var c = JV.parse(bytes), c.object != nil else { return (nil, "undecryptable") }
    let blobs = Set(h.blobs.map(hex))
    var ok = true
    func walk(_ v: JV, _ depth: Int) {
      if depth > 32 { ok = false; return }
      switch v {
      case .arr(let a): a.forEach { walk($0, depth + 1) }
      case .obj(let o):
        for (k, x) in o {
          if k == "attachment_id" || k == "poster_attachment_id", !x.isNull {
            guard let s = x.string, s.utf8.count == 32, s.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { ok = false; return }
          }
          walk(x, depth + 1)
        }
      default: break
      }
    }
    walk(c, 0)
    if !ok { return (nil, "undecryptable") }
    for a in (c["attachments"].array ?? []) {
      for k in ["attachment_id", "poster_attachment_id"] { if let id = a[k].string, !blobs.contains(id) { return (nil, "undecryptable") } }
    }
    if (c["schema_version"].int ?? 1) > 1 { return (c, "newer_schema") }
    if c["content_type"].string == "message", c.has("note"), !Room.noteRefValid(c["note"]) { c = c.with("note", nil) }
    if c["object_type"].string == "card", let t = c["teaser"].string, !Room.teaserValid(t) { c = c.with("teaser", nil) }
    if c["object_type"].string == "card", let opts = c["options"].array {
      c = c.with("options", .arr(opts.map { o in o.has("final") && o["final"] != .bool(true) ? o.with("final", nil) : o }))
    }
    return (c, "ok")
  }
  nonisolated static func noteRefValid(_ m: JV) -> Bool {
    guard let o = m.object, o.keys.allSatisfy({ $0 == "object_id" || $0 == "written_at" }), let id = o["object_id"]?.string, id.utf8.count == 32 else { return false }
    if let w = o["written_at"], !w.isNull { return (w.int ?? -1) >= 0 }
    return true
  }
  nonisolated static func teaserValid(_ t: String) -> Bool {
    !t.isEmpty && t == t.trimmingCharacters(in: .whitespacesAndNewlines) && t.count <= 160 && !t.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
  }

  // ---- live ----------------------------------------------------------------------------------

  /** One event of the hub's stream (README "the stream"). */
  public func handleStreamEvent(_ event: String, _ data: JV) async {
    switch event {
    case "envelope":
      guard let n = data["envelope_number"].int, let b = data["envelope"].string, let bytes = try? unb64u(b) else { return }
      if n <= cursor { return }
      _ = try? await serial { [self] in
        var report = SyncReport(), change = Change()
        if n > self.cursor + 1 {
          // H1: a hole: read what is missing from GET envelopes first.
          _ = try await self.catchUpQuietly(&report, &change)
          if n <= self.cursor { self.board.project(); self.emit(change); return }
        }
        try await self.process([(n, bytes, data["void"].truthy)], report: &report, change: &change)
        self.board.project()
        self.emit(change)
      }
    case "member_entry":
      _ = try? await serial { [self] in _ = try await self.refreshMembers(); try await self.refreshRoomKeys(); try await self.refreshSessions() }
    case "session_grant":
      _ = try? await serial { [self] in try await self.refreshSessions() }
    case "presence":
      var ch = Change()
      board.applyPresence(data, change: &ch)
      emit(ch)
    case "join_request":
      var ch = Change(); ch.invites.insert(data["invite_id"].string ?? ""); emit(ch)
    case "upgrade_required":
      upgrade = UpgradeNotice(minimumVersion: data["minimum_version"].string, message: data["message"].string ?? "Please update Trommi.")
      var ch = Change(); ch.room = true; emit(ch)
    default: break   // ping, and events a newer hub adds
    }
  }
  private func catchUpQuietly(_ report: inout SyncReport, _ change: inout Change) async throws -> Int {
    while true {
      let page = try await noted { try await hub.envelopes(after: cursor) }
      let list = (page["envelopes"] as? [JSON] ?? []).compactMap { rec -> (n: Int, bytes: Bytes, isVoid: Bool)? in
        guard let n = (rec["envelope_number"] as? NSNumber)?.intValue, let b = rec["envelope"] as? String, let bytes = try? unb64u(b) else { return nil }
        return (n, bytes, rec["void"] as? Bool ?? false)
      }
      if list.isEmpty { return cursor }
      try await process(list, report: &report, change: &change)
      if list.count < 1000 { return cursor }
    }
  }

  /**
   * The live stream (GET stream, server-sent events) while the app is in front: every envelope as it is posted, presence,
   * member entries and grants, applied at once. Returns when the task is cancelled; reconnects with a growing pause after
   * a drop, and when nothing (not even a ping) came for 70 s; catches up from GET envelopes before each new stream.
   */
  public func runLive() async {
    var pause: UInt64 = 1_000_000_000
    while !Task.isCancelled {
      let reader = SSEReader()
      do {
        if !synced { _ = try await sync() }
        let token = try await hub.accessToken()
        var comps = URLComponents(string: "\(hub.hubURL)/v1/rooms/\(record.roomId)/stream")!
        comps.queryItems = [URLQueryItem(name: "after_envelope_number", value: String(cursor))]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(HubClient.clientName, forHTTPHeaderField: "trommi-client")
        req.setValue("1", forHTTPHeaderField: "trommi-protocol")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.timeoutInterval = 3600
        let events = reader.start(req)
        for await ev in events {
          if Task.isCancelled { break }
          switch ev {
          case .status(let status):
            if status == 426 { upgrade = UpgradeNotice(minimumVersion: nil, message: "Please update Trommi."); var ch = Change(); ch.room = true; emit(ch); reader.stop(); return }
            if status == 401 { token401 = true; reader.stop(); break }
            if status != 200 { reader.stop(); break }
            live = true; board.connection = "live"
            var ch = Change(); ch.room = true; emit(ch)
            pause = 1_000_000_000
          case .event(let name, let data):
            if let v = JV.parse(Array(data.utf8)) { await handleStreamEvent(name, v) }
          }
        }
      } catch {}
      reader.stop()
      if Task.isCancelled { break }
      if token401 { token401 = false; _ = try? await hub.signIn() }
      live = false; board.connection = "offline"
      var ch = Change(); ch.room = true; emit(ch)
      if upgrade != nil { return }
      try? await Task.sleep(nanoseconds: pause)
      pause = min(pause * 2, 30_000_000_000)
      // Whatever came meanwhile: GET envelopes (the stream resumes after the cursor too).
      _ = try? await serial { [self] in var r = SyncReport(), c = Change(); _ = try await self.catchUpQuietly(&r, &c); self.board.project(); self.emit(c) }
    }
    live = false
  }

  // ---- reading older items -------------------------------------------------------------------------

  /**
   * The next older page of a conversation into the window ("Earlier"; the catch-up holds only the headers of thread
   * items): GET threads, each body checked against the hash the chain verified, then opened (openVerifiedEnvelope).
   */
  @discardableResult public func loadOlder(_ key: String, limit: Int = 50) async throws -> (loaded: Int, hasMore: Bool) {
    let t = board.timelineOf(key)
    t.windowOpen = true
    let p = parseTimelineKey(key)
    // Below the oldest item whose body is here.
    let loadedNumbers = t.items.values.filter { $0.itemState != "header" }.compactMap { $0.envelopeNumber }
    let before = min(t.loadedDownTo, loadedNumbers.min() ?? (board.lastEnvelopeNumber + 1))
    let r = try await noted { try await hub.threads(kind: p.kind, timelineId: p.timelineId, before: before, limit: limit) }
    var loaded = 0
    let secrets = Room.secretLookup(room: roomSecrets, sessions: sessionSecrets)
    var ch = Change()
    for e in r["envelopes"] as? [JSON] ?? [] {
      guard let n = (e["envelope_number"] as? NSNumber)?.intValue, let b = e["envelope"] as? String, let bytes = try? unb64u(b) else { continue }
      guard var item = t.items[n], item.itemState == "header" || item.itemState == "undecryptable", let hh = item.envelopeHash, let vh = try? unhex(hh) else { continue }
      do {
        let o = try openVerifiedEnvelope(bytes, state: state, secrets: secrets, envelopeHash: vh)
        let d = Room.decodePayload(o.payload, header: o.header)
        item.content = d.content; item.contentType = d.content?["content_type"].string
        item.itemState = d.content == nil ? "undecryptable" : d.state == "ok" ? "loaded" : d.state
        loaded += 1
      } catch let e as ZError {
        item.itemState = e.code == "pruned" ? "pruned" : "undecryptable"
        if e.code == "hash-mismatch" || e.code == "bad-signature" { board.pushAlert(&ch, code: "timeline", message: e.description, envelopeNumber: n) }
      }
      t.items[n] = item
      ch.timelines.insert(key)
    }
    t.loadedDownTo = min(t.loadedDownTo, (r["envelopes"] as? [JSON] ?? []).compactMap { ($0["envelope_number"] as? NSNumber)?.intValue }.min() ?? t.loadedDownTo)
    t.hasMore = r["has_more"] as? Bool ?? false
    ch.timelines.insert(key)
    emit(ch)
    return (loaded, t.hasMore)
  }

  // ---- attachments -------------------------------------------------------------------------------

  private var attachmentCache: [String: Bytes] = [:]
  private var attachmentOrder: [String] = []
  /** An attachment's bytes, fetched and decrypted (checked against its sha256), kept for a while. */
  public func fetchAttachment(_ ref: JV) async throws -> Bytes {
    guard let id = ref["attachment_id"].string, let key = ref["file_key"].string else { throw ZError("bad-argument", "attachment reference") }
    if let hit = attachmentCache[id] { return hit }
    let blob = try await noted { try await hub.getAttachment(id) }
    let bytes = try decryptAsset(blob, key: try unb64u(key), expectedSha256: try ref["sha256"].string.map { try unb64u($0) })
    attachmentCache[id] = bytes
    attachmentOrder.append(id)
    if attachmentOrder.count > 48 { attachmentCache.removeValue(forKey: attachmentOrder.removeFirst()) }
    return bytes
  }
  /** Encrypt and upload a file; returns the README attachment reference for a body. */
  public func uploadAttachment(_ bytes: Bytes, fileName: String, mediaType: String, width: Int? = nil, height: Int? = nil) async throws -> JV {
    let a = try encryptAsset(bytes)
    try await noted { try await hub.putAttachment(hex(a.blobId), a.blob) }
    var ref: [String: JV] = ["attachment_id": .str(hex(a.blobId)), "file_key": .str(b64u(a.key)), "sha256": .str(b64u(a.sha256)), "total_size": .n(a.size),
                             "file_name": .str(fileName), "media_type": .str(mediaType)]
    if let w = width { ref["width"] = .n(w) }
    if let h = height { ref["height"] = .n(h) }
    attachmentCache[hex(a.blobId)] = bytes
    return .obj(ref)
  }

  // ---- sending -----------------------------------------------------------------------------------

  /** A local id for an own echo (shown at once, replaced when the hub has it). */
  private func newLocalId() -> String { echoSeq += 1; return "local-\(nowMs())-\(echoSeq)" }

  /**
   * Seal under the right key (keyFor: a session's key for its cards, chat and registers, the room key for the rest),
   * keep the own chain and the outbox before the hub sees it, post.
   */
  @discardableResult
  private func send(kind: Int, content: JV, bind: Bytes = [], recipient: String? = nil, object: ObjectBlock? = nil, timeline: (kind: String, id: String)? = nil,
                    sessionId: String? = nil, localId: String? = nil,
                    build: ((UInt64) throws -> (JV, ObjectBlock))? = nil) async throws -> (localId: String, hash: String, seq: UInt64) {
    if let u = upgrade { throw ZError("client-too-old", u.message) }
    return try await serial { [self] in
      if !self.synced { _ = try await self.catchUpInner() }
      if let own = self.record.ownSent, (self.chains[hex(self.device.id)]?.seq ?? 0) < own.seq, self.outbox.isEmpty {
        throw ZError("chain-behind", "catch up first: this device's chain is not where it left it")
      }
      var content = content
      var object = object
      if let build = build { let b = try build((self.chains[hex(self.device.id)]?.seq ?? 0) + 1); content = b.0; object = b.1 }
      // R2: registers and notes carry a lamport one above every one this device has seen.
      if kind == KIND.STATUS || (kind == KIND.OBJECT_VERSION && content["object_type"].string == "note") {
        self.lamport += 1
        content = content.with("lamport", .n(self.lamport))
      }
      if (content["schema_version"].int ?? 0) == 0 { content = content.with("schema_version", 1) }
      let payload = content.encoded()
      if payload.count > 60_000 { throw ZError("too-large", "body over 60 KB: put it into an attachment") }
      if kind == KIND.STATUS && payload.count + bind.count + 16 > 4096 { throw ZError("too-large", "a status body is at most 4 KiB") }
      var blobs = [Bytes]()
      for a in content["attachments"].array ?? [] { for k in ["attachment_id", "poster_attachment_id"] { if let id = a[k].string, let b = try? unhex(id), !blobs.contains(b) { blobs.append(b) } } }
      let secret: EpochSecret
      var keyScope = KEY_SCOPE.ROOM
      if let sid = sessionId {
        guard let ss = self.sessionStates[sid], let k = self.sessionSecrets["\(sid):\(ss.epoch)"] else { throw ZError("no-key", "no key for this session") }
        if grantIsStale(ss, self.state) { throw ZError("stale-session-key", "this session waits for a re-key after a removal (open the web app once)") }
        secret = k; keyScope = KEY_SCOPE.SESSION
      } else {
        guard let k = self.roomSecrets[self.state.epoch] else { throw ZError("no-key", "no room key for the current epoch") }
        secret = k
      }
      let sealed = try sealEnvelope(device: self.device, state: self.state, secret: secret, chains: &self.chains, kind: kind, keyScope: keyScope,
                                    sessionId: try sessionId.map { try unhex($0) }, bind: bind, payload: payload, recipient: try recipient.map { try unhex($0) },
                                    card: object, timelineKind: timeline.map { $0.kind == "chat" ? TIMELINE.CHAT : TIMELINE.CANVAS }, timelineId: timeline?.id, blobs: blobs)
      let lid = localId ?? self.newLocalId()
      self.own[hex(sealed.hash)] = (sealed.header, payload, bind, lid)
      self.record.ownSent = OwnSent(seq: sealed.seq, hash: hex(sealed.hash))
      self.outbox.append(OutboxItem(bytes: b64u(sealed.bytes), seq: sealed.seq, hash: hex(sealed.hash), localId: lid))
      self.record.outbox = self.outbox
      self.record.lamport = self.lamport
      try self.store.save(self.record)
      self.pumpOutbox()
      return (lid, hex(sealed.hash), sealed.seq)
    }
  }
  private func catchUpInner() async throws -> SyncReport { try await catchUp() }

  private var pumping = false
  private var lastPosted: (number: Int, hash: String) = (0, "")
  /** Wait until the hub has taken everything sealed so far; the last one's number and hash. */
  @discardableResult public func flush(timeoutMs: UInt64 = 30_000) async throws -> (number: Int, hash: String) {
    _ = try? await serial { }
    let until = nowMs() + timeoutMs
    while !outbox.isEmpty {
      if nowMs() > until { throw ZError("timeout", "the hub has not taken \(outbox.count) envelope(s)") }
      if !pumping { pumpOutbox() }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    return lastPosted
  }
  /** Post the outbox in order; a network failure is retried, a refusal for good marks the item failed (never re-signed). */
  private func pumpOutbox() {
    if pumping || outbox.isEmpty { return }
    pumping = true
    Task { @MainActor in
      var backoff: UInt64 = 300_000_000
      while let item = outbox.first {
        do {
          let r = try await noted { try await hub.postEnvelope(try unb64u(item.bytes)) }
          lastPosted = ((r["envelope_number"] as? NSNumber)?.intValue ?? 0, item.hash)
          acked(item)
          backoff = 300_000_000
        } catch let e as HubError {
          if e.code == "replay" { acked(item); continue }
          if e.status == 0 || e.status >= 500 || e.status == 429 || e.code == "unauthorised" || e.code == "stale-session-key" || e.code == "gap" {
            try? await Task.sleep(nanoseconds: backoff); backoff = min(backoff * 2, 10_000_000_000); continue
          }
          if e.status == 426 { break }
          // Refused for good: its number is used (void) or the hub keeps refusing; the echo goes, an alert says it.
          var ch = Change()
          board.pushAlert(&ch, code: e.code, message: "the hub refused an envelope: \(e.message)")
          dropEcho(item.localId, &ch)
          if e.extra["voided"] as? Bool == true { acked(item) } else { acked(item) }
          emit(ch)
        } catch {
          try? await Task.sleep(nanoseconds: backoff); backoff = min(backoff * 2, 10_000_000_000)
        }
      }
      pumping = false
    }
  }
  private func acked(_ item: OutboxItem) {
    if let i = outbox.firstIndex(where: { $0.hash == item.hash }) { outbox.remove(at: i) }
    record.outbox = outbox
    saveRecord()
  }
  private func dropEcho(_ localId: String, _ ch: inout Change) {
    for t in board.timelines.values where t.echoes[localId] != nil { t.echoes.removeValue(forKey: localId); ch.timelines.insert(t.key) }
    for c in board.cards.values where c.answer?.pending == true && c.answer?.envelopeHash == localId {
      c.answer = c.answers.last(where: { !$0.pending && $0.takenBackAt == nil }); c.answers.removeAll { $0.pending }
      c.objectState = c.answer == nil ? "open" : c.objectState; ch.cards.insert(c.objectId)
    }
  }

  // ---- what a human does (client.mjs human actions) -----------------------------------------------

  /** The session a message to this card or session goes to, and its recipient (the holder of the card, or the session's agent). */
  public func sendMessage(sessionId: String? = nil, cardId: String? = nil, text: String, fields: [String: JV] = [:]) async throws {
    let card = cardId.flatMap { board.cards[$0] }
    if cardId != nil && card == nil { throw ZError("not-found", "no card \(cardId!)") }
    guard let sid = card?.sessionId ?? sessionId else { throw ZError("bad-argument", "a message names a session or a card") }
    guard let recipient = card.map({ board.holderOf($0) }) ?? sessionStates[sid]?.agentIds.first ?? board.sessions[sid]?.agentDeviceId else {
      throw ZError("bad-argument", "this session has no agent to write to")
    }
    var content: [String: JV] = ["content_type": "message", "text": .str(text)]
    for (k, v) in fields { content[k] = v }
    let timeline = (kind: "chat", id: cardId.map { "card/\($0)" } ?? "session/\(sid)")
    // The echo: in the conversation at once, replaced by the real item when the hub has it.
    let lid = newLocalId()
    let key = timelineKeyOf("chat", timeline.id)
    let t = board.timelineOf(key)
    t.echoes[lid] = TimelineItem(envelopeNumber: nil, localId: lid, pending: true, senderDeviceId: hex(device.id), recipientDeviceId: recipient, sentAt: nowMs(),
                                 itemState: "loaded", contentType: "message", content: .obj(content))
    var ch = Change(); ch.timelines.insert(key); ch.sessions.insert(sid); emit(ch)
    do { try await send(kind: KIND.TIMELINE_ITEM, content: .obj(content), recipient: recipient, timeline: timeline, sessionId: sid, localId: lid) }
    catch { var c = Change(); t.echoes.removeValue(forKey: lid); c.timelines.insert(key); emit(c); throw error }
  }

  /** Answer an open card (README "answer"): choices, a note, notes per option, files; read (an info) and shred are answers too. */
  public func answer(cardId: String, choices: [String] = [], note: String? = nil, optionNotes: [String: String] = [:], attachments: [JV] = [],
                     marks: [JV] = [], trusted: Bool = false, action: String = "answer") async throws {
    guard let card = board.cards[cardId] else { throw ZError("not-found", "no such card") }
    if card.objectState != "open" { throw ZError("card-closed", "the card is not open") }
    if card.unsupported { throw ZError("needs-update", Compat.UPDATE_MESSAGE) }
    if card.contentState != "ok" { throw ZError("card-pruned", "this device holds only the header of this card (retention); answer it on a device that shows it") }
    guard let vh = card.versionHash else { throw ZError("card-pruned", "no version") }
    if action == "answer" && !trusted {
      for ch in choices where !card.options.contains(where: { $0.key == ch }) { throw ZError("bad-choice", "the card has no option \(ch)") }
    }
    var content: [String: JV] = ["answer_action": .str(action), "choices": .arr(choices.map { .str($0) })]
    if let n = note { content["note"] = .str(n) }
    if !optionNotes.isEmpty { content["option_notes"] = .obj(optionNotes.mapValues { .str($0) }) }
    if !attachments.isEmpty { content["attachments"] = .arr(attachments) }
    if !marks.isEmpty { content["marks"] = .arr(marks) }
    if trusted { content["trusted"] = true }
    let bind = try encodeAnswerBind(objectId: try unhex(cardId), versionHash: try unhex(vh), choices: choices)
    let plain = (note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !optionNotes.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } && attachments.isEmpty && marks.isEmpty
    let settles = action == "answer" && !trusted && plain && choicesFinal(card, choices)
    let st = action == "answer" && !settles ? CARD_STATE.ANSWERED : CARD_STATE.CLOSED
    let at = nowMs()
    // The echo: the card is answered at once (the hub's copy replaces it).
    let lid = newLocalId()
    var a = Answer(answerAction: action, choices: choices, note: note, optionNotes: optionNotes, attachments: attachments, marks: marks, trusted: trusted,
                   boundObjectVersion: card.objectVersion, envelopeNumber: nil, envelopeHash: lid, byDeviceId: hex(device.id), answeredAt: at)
    a.pending = true
    let was = (card.objectState, card.closedHow, card.answer)
    card.answer = a; card.answers.append(a)
    card.objectState = st == CARD_STATE.ANSWERED ? "answered" : "closed"
    card.closedHow = action == "read" ? "read" : action == "shred" ? "shredded" : settles ? "settled" : "answered"
    board.project()
    var ch = Change(); ch.cards.insert(cardId); ch.stack = true; if let s = card.sessionId { ch.sessions.insert(s) }; emit(ch)
    do {
      try await send(kind: KIND.ANSWER, content: .obj(content), bind: bind, recipient: board.holderOf(card), object: ObjectBlock(id: try unhex(cardId), state: st, urgency: URGENCY_CODE[card.urgency] ?? 1, answeredAt: at),
                     sessionId: card.sessionId, localId: lid)
    } catch {
      card.objectState = was.0; card.closedHow = was.1; card.answer = was.2; card.answers.removeAll { $0.pending }
      board.project(); var c = Change(); c.cards.insert(cardId); c.stack = true; emit(c)
      throw error
    }
  }
  /** "I don't give a duck": the agent's own recommendation, its call. */
  public func trust(cardId: String, note: String? = nil) async throws {
    guard let c = board.cards[cardId] else { throw ZError("not-found", "no such card") }
    try await answer(cardId: cardId, choices: c.recommended, note: note, trusted: true)
  }
  public func markRead(cardId: String) async throws { try await answer(cardId: cardId, action: "read") }
  public func shred(cardId: String, note: String? = nil) async throws { try await answer(cardId: cardId, note: note, action: "shred") }

  /** Take an answer back (README "decide again"): the card is open again. */
  public func decideAgain(cardId: String) async throws {
    guard let card = board.cards[cardId], let a = card.answer, let h = a.envelopeHash, !a.pending, let vh = card.versionHash else { throw ZError("decision-mismatch", "no answer in force to take back") }
    let bind = try encodeDecideAgainBind(objectId: try unhex(cardId), previousHash: try unhex(h), versionHash: try unhex(vh))
    try await send(kind: KIND.DECIDE_AGAIN, content: .obj([:]), bind: bind, recipient: board.holderOf(card),
                   object: ObjectBlock(id: try unhex(cardId), state: CARD_STATE.OPEN, urgency: URGENCY_CODE[card.urgency] ?? 1), sessionId: card.sessionId)
  }

  /** Allow or deny a permission request. */
  public func verdict(requestId: String, allow: Bool) async throws {
    guard let p = board.permissions[requestId] else { throw ZError("not-found", "no such permission request") }
    let bind = try encodeVerdictBind(requestId: try unhex(requestId), requestHash: try unhex(p.versionHash), expiresAt: p.expiresAt, allow: allow)
    try await send(kind: KIND.VERDICT, content: .obj([:]), bind: bind, recipient: p.agentDeviceId, object: ObjectBlock(id: try unhex(requestId), state: CARD_STATE.ANSWERED, urgency: 3, answeredAt: nowMs()),
                   sessionId: p.sessionId)
  }

  /** Human registers (drafts, snoozes, ducks, the crown, desks, a session's settings, archived/…): shown at once. */
  public func setRegisters(_ values: [String: JV]) async throws {
    for k in values.keys where k.hasPrefix("device/") && k != "device/\(hex(device.id))" { throw ZError("forbidden", "a device writes only its own device register") }
    for k in values.keys where Board.isAgentKey(k) { throw ZError("forbidden", "\(k) is not a human key") }
    var ch = Change()
    for (k, v) in values where !k.hasPrefix("device/") {
      var echo = Rec(envelopeNumber: 0, envelopeHash: "", senderDeviceId: hex(device.id), senderRole: "human", sentAt: nowMs(), kind: KIND.STATUS, isHead: true,
                     contentState: "ok", causal: Causal(senderDeviceId: hex(device.id), senderSequence: 0, sentAt: nowMs(), lamport: lamport + 1), senderSequence: 0, epoch: 0)
      echo.pending = true
      board.setHumanRegister(k, v, echo, &ch)
    }
    board.project(); ch.stack = true; emit(ch)
    try await send(kind: KIND.STATUS, content: .obj(["values": .obj(values)]))
  }
  public func setDraft(cardId: String, _ draft: JV?) async throws { try await setRegisters(["draft/\(cardId)": draft ?? .null]) }
  public func snooze(cardId: String, until: UInt64?) async throws { try await setRegisters(["snooze/\(cardId)": until.map { .obj(["until": .n($0)]) } ?? .null]) }
  public func setCrown(_ v: JV?) async throws { try await setRegisters(["crown": v ?? .null]) }
  public func setDesk(_ id: String, _ v: JV?) async throws { try await setRegisters(["desk/\(id)": v ?? .null]) }
  /** A session's settings (register session/<id>): name, icon, desk, archived, parent, position… merged into what is there. */
  public func editSession(_ sid: String, _ fields: [String: JV]) async throws {
    var cur = board.human.sessionSettings[sid]?.object ?? [:]
    for (k, v) in fields { cur[k] = v }
    try await setRegisters(["session/\(sid)": .obj(cur)])
  }

  /** The device's name for the other devices (register device/<id>, encrypted under the room key), once after joining. */
  public func sendDeviceRegister(name: String, platform: String) async throws {
    if record.deviceRegisterSent { return }
    try await send(kind: KIND.STATUS, content: .obj(["values": .obj(["device/\(hex(device.id))": .obj(["device_name": .str(name), "platform": .str(platform)])])]))
    record.deviceRegisterSent = true
    saveRecord()
  }

  // ---- notes (objects of type note, any human device writes a version) ------------------------------

  private var noteHeads: [String: (version: Int, hash: String, content: [String: JV])] = [:]
  private func noteHead(_ id: String) -> (version: Int, hash: String, content: [String: JV])? {
    let m = board.notes[id]
    let base = m?.pending == true ? m?.base?.value : m
    if let l = noteHeads[id], base == nil || l.version >= base!.objectVersion { return l }
    guard let b = base else { return nil }
    var c = b.extra; c["text"] = .str(b.text)
    return (b.objectVersion, b.versionHash, c)
  }
  /** A new note (objectId nil) or a new version of one; close: delete it. Returns its object id. */
  @discardableResult public func saveNote(objectId: String? = nil, fields: [String: JV], close: Bool = false) async throws -> String {
    var made = objectId ?? ""
    var content: [String: JV] = [:]
    let r = try await send(kind: KIND.OBJECT_VERSION, content: .obj([:]), build: { [self] nextSeq in
      // The object id of a new note is H(creator, sequence of its first version): known only now, in the queue.
      let id = try objectId ?? hex(objectIdOf(self.device.id, nextSeq))
      let head = objectId.flatMap { self.noteHead($0) }
      var c = head?.content ?? [:]
      for (k, v) in fields { c[k] = v }
      c["object_type"] = "note"
      c["object_version"] = .n((head?.version ?? 0) + 1)
      c["previous_version_hash"] = .str(head?.hash ?? String(repeating: "0", count: 64))
      made = id; content = c
      return (.obj(c), ObjectBlock(id: try unhex(id), state: close ? CARD_STATE.CLOSED : CARD_STATE.OPEN, urgency: 1))
    })
    // The echo: the note shows at once (the hub's copy replaces it).
    let prev = board.notes[made]
    var extra = content
    for k in ["object_type", "object_version", "previous_version_hash", "lamport", "schema_version"] { extra.removeValue(forKey: k) }
    var echo = Note(objectId: made, byDeviceId: hex(device.id), text: content["text"]?.string ?? "", extra: extra, objectVersion: content["object_version"]?.int ?? 1, versionHash: r.hash,
                    versionHashes: prev?.versionHashes ?? [], causal: nil, envelopeNumber: prev?.envelopeNumber ?? 0, objectState: close ? "closed" : "open")
    echo.pending = true; echo.localId = r.localId
    echo.base = prev?.pending == true ? prev?.base : prev.map { Box($0) }
    board.notes[made] = echo
    noteHeads[made] = (content["object_version"]?.int ?? 1, r.hash, extra)
    var ch = Change(); ch.notes.insert(made); emit(ch)
    return made
  }
  public func deleteNote(_ id: String) async throws { try await saveNote(objectId: id, fields: [:], close: true) }

  // ---- pairing a device from here (client.mjs createInvite, _checkInvite, confirmInvite, _finalizeInvite) ------------

  public struct Pairing {
    public let inviteId: String
    public let link: String
    public let expiresAt: UInt64
    let invite: InviteRecord
    var request: Bytes? = nil
    var requestHash: Bytes? = nil
    var member: Member? = nil
    var acceptedAt: UInt64 = 0
    public var code: String? = nil
    public var newcomerId: String? = nil
  }
  /** An invite link for a new human device (the QR code of "Pair a device"). */
  public func createPairing(app: String = "https://app.trommi.com/join", ttlMs: UInt64 = 600_000) async throws -> Pairing {
    try await serial { [self] in
      if !self.synced { _ = try await self.catchUpInner() }
      let made = try createInvite(state: self.state, inviter: self.device, hub: self.hub.hubURL, role: ROLE.HUMAN, app: app, ttlMs: ttlMs)
      let r = try await self.noted { try await self.hub.postInvite(signedOffer: made.offer) }
      return Pairing(inviteId: r["invite_id"] as? String ?? hex(made.invite.inviteId), link: made.link, expiresAt: made.invite.expiresAt, invite: made.invite)
    }
  }
  /** Look for the newcomer's request; on one: reveal, and the check code to compare (as emoji). */
  public func checkPairing(_ p: inout Pairing) async throws -> Bool {
    if p.code != nil { return true }
    let r = try await noted { try await hub.getRequests(p.inviteId) }
    for q in r["signed_requests"] as? [String] ?? [] {
      guard let bytes = try? unb64u(q) else { continue }
      let accepted: (reveal: Bytes, code: String, requestHash: Bytes, member: Member)
      do { accepted = try acceptJoinRequest(invite: p.invite, request: bytes, inviter: device) }
      catch let e as ZError where e.code == "invite-expired" { throw e }
      catch { continue }
      _ = try await noted { try await hub.postReveal(p.inviteId, signedReveal: accepted.reveal) }
      p.request = bytes; p.requestHash = accepted.requestHash; p.member = accepted.member; p.acceptedAt = nowMs()
      p.code = accepted.code; p.newcomerId = hex(try deviceId(accepted.member.signPub, accepted.member.kexPub))
      return true
    }
    if nowMs() > p.expiresAt { throw ZError("invite-expired", "the invite has expired") }
    return false
  }
  /** The human compared the emoji: a match adds the device (and seals it the room key and every session key); no match burns the invite. */
  public func confirmPairing(_ p: Pairing, matches: Bool) async throws {
    if !matches {
      try? await hub.deleteInvite(p.inviteId)
      throw ZError("code-mismatch", "the check codes do not match: nobody was added, the invite is spent")
    }
    guard let member = p.member, let newId = p.newcomerId else { throw ZError("bad-invite", "this invite waits for no code") }
    if nowMs() > p.acceptedAt + 10 * 60_000 { throw ZError("invite-expired", "the confirmation came too late") }
    try await serial { [self] in
      _ = try await self.refreshMembers()
      if self.state.memberAt(try unhex(newId)) == nil {
        guard let secret = self.roomSecrets[self.state.epoch] else { throw ZError("no-key", "no room key for the current epoch") }
        let added = try addMember(self.state, signer: self.device, member: member, inviteId: p.invite.inviteId)
        let wrap = try wrapEpochKey(added.state, secret, try unhex(newId))
        _ = try await self.noted { try await self.hub.postMember(signedEntry: added.entry, sealedRoomKeys: [(try unhex(newId), wrap)]) }
      }
      _ = try await self.refreshMembers()
      try await self.refreshSessions()
      try await self.resealSessions()
    }
  }
  /** Re-seal every session's current key for everyone who holds it now (a new human device): the same grant, posted together. */
  func resealSessions() async throws {
    var items: [JSON] = []
    for (sid, ss) in sessionStates {
      guard let cur = sessionSecrets["\(sid):\(ss.epoch)"] else { continue }
      let agents = ss.agentIds.compactMap { try? unhex($0) }
      let active = agents.filter { state.memberAt($0)?.role == ROLE.AGENT }
      // the agents that were given the history keep it (register session_history/<sid>, room scope: humans only)
      let entitled = (board.human.raw["session_history/\(sid)"]?.value["agents"].array ?? []).compactMap { $0.string }
      let g = try createSessionGrant(state: state, signer: device, sessionState: ss, current: cur, agentIds: active,
                                     withHistory: active.contains { entitled.contains(hex($0)) }, rotate: active.count != agents.count)
      var item: JSON = ["session_id": sid, "signed_grant": b64u(g.grant), "sealed_session_keys": g.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]
      if let bl = g.backLink { item["key_back_link"] = b64u(bl) }
      items.append(item)
    }
    var i = 0
    while i < items.count { _ = try await noted { try await hub.postSessionGrants(Array(items[i..<min(i + 64, items.count)])) }; i += 64 }
    if !items.isEmpty { try await refreshSessions() }
  }

  // ---- grants, removal, leaving (client.mjs _makeGrant, _postGrants, removeDevices, _healStaleSessions, leaveRoom) ------

  /** The agents of a session that were given its history (register session_history/<sid>). */
  func historyAgents(_ sid: String) -> [String] { (board.human.raw["session_history/\(sid)"]?.value["agents"].array ?? []).compactMap { $0.string } }

  /** The next grant of a session for these agents (only active agents; dropping one rotates the key). */
  func makeGrant(_ sid: String, agents: [String], withHistory: Bool = false, rotate: Bool = false) throws -> (item: JSON, historyAgents: [String], agents: [String]) {
    guard let ss = sessionStates[sid] else { throw ZError("not-found", "no session \(sid)") }
    let current = sessionSecrets["\(sid):\(ss.epoch)"]
    let active = agents.filter { a in (try? unhex(a)).flatMap { state.memberAt($0) }?.role == ROLE.AGENT }
    let rot = rotate || ss.agentIds.contains { !active.contains($0) } || current == nil
    let entitled = historyAgents(sid)
    let hist = active.filter { (withHistory && !ss.agentIds.contains($0)) || entitled.contains($0) }
    let g = try createSessionGrant(state: state, signer: device, sessionState: ss, current: current, agentIds: active.compactMap { try? unhex($0) },
                                   historyAgentIds: hist.compactMap { try? unhex($0) }, rotate: rot)
    var item: JSON = ["session_id": sid, "signed_grant": b64u(g.grant), "sealed_session_keys": g.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]
    if let bl = g.backLink { item["key_back_link"] = b64u(bl) }
    return (item, hist, active)
  }
  func postGrants(_ items: [JSON]) async throws {
    var i = 0
    while i < items.count { _ = try await noted { try await hub.postSessionGrants(Array(items[i..<min(i + 64, items.count)])) }; i += 64 }
    if !items.isEmpty { try await refreshSessions() }
  }
  /** After a grant: who holds the history now (a dropped agent loses it), in the human register every human device reads. */
  func noteHistoryAgents(_ sid: String, agents: [String], history: [String]) async {
    let next = Array(Set(history)).filter { agents.contains($0) }.sorted()
    if next == historyAgents(sid).sorted() { return }
    try? await setRegisters(["session_history/\(sid)": .obj(["agents": .arr(next.map { .str($0) })])])
  }

  /** A1: every session whose newest grant predates a removal is re-keyed now (agents no longer members dropped). */
  func healStaleSessions() async throws {
    for _ in 0..<3 {
      let stale = sessionStates.filter { grantIsStale($0.value, state) && sessionSecrets["\($0.key):\($0.value.epoch)"] != nil }
      if stale.isEmpty { return }
      var items = [JSON]()
      for (sid, ss) in stale { items.append(try makeGrant(sid, agents: ss.agentIds, rotate: true).item) }
      do { try await postGrants(items); return }
      catch let e as HubError where e.status >= 400 && e.status < 500 { try await refreshSessions() }
    }
  }

  /**
   * Remove devices: one member entry with the cut (R3: the last envelope of each removed device this device verified),
   * a new room key for the humans who stay, and a new session key for every session without the removed ones.
   */
  public func removeDevices(_ ids: [String]) async throws {
    try await serial { [self] in
      if !self.synced { _ = try await self.catchUpInner() }
      _ = try await self.refreshMembers()
      try await self.refreshSessions()
      var cuts = [String: (seq: UInt64, hash: Bytes)]()
      for id in ids { if let c = self.chains[id] { cuts[id] = (c.seq, c.hash) } }
      let r = try removeMembers(self.state, signer: self.device, ids: try ids.map { try unhex($0) }, cuts: cuts, previous: self.roomSecrets[self.state.epoch])
      var body: JSON = ["signed_entry": b64u(r.entry), "sealed_room_keys": r.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]
      if let bl = r.backLink { body["key_back_link"] = b64u(bl) }
      _ = try await self.noted { try await self.hub.request("POST", "/rooms/\(self.record.roomId)/members", body: body, auth: false) }
      self.roomSecrets[r.secret.epoch] = r.secret
      self.record.roomSecrets = self.roomSecrets.values.sorted { $0.epoch < $1.epoch }.map(SecretJSON.init)
      self.saveRecord()
      _ = try await self.refreshMembers()
      try await self.refreshSessions()
      try await self.healStaleSessions()
    }
  }

  /**
   * Log out: this device removes itself (its own cut, a new room key for the humans who stay and the recovery key), then
   * its key file and room record are deleted here. The next start of a human device re-keys the sessions.
   */
  public func leaveRoom() async throws {
    _ = try? await flush(timeoutMs: 3000)
    try await serial { [self] in
      _ = try await self.refreshMembers()
      let me = hex(self.device.id)
      var cuts = [String: (seq: UInt64, hash: Bytes)]()
      if let c = self.chains[me] { cuts[me] = (c.seq, c.hash) }
      let r = try removeMembers(self.state, signer: self.device, ids: [self.device.id], cuts: cuts, previous: self.roomSecrets[self.state.epoch])
      var body: JSON = ["signed_entry": b64u(r.entry), "sealed_room_keys": r.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]
      if let bl = r.backLink { body["key_back_link"] = b64u(bl) }
      _ = try await self.noted { try await self.hub.request("POST", "/rooms/\(self.record.roomId)/members", body: body, auth: false) }
    }
    try? FileManager.default.removeItem(at: store.dir)
  }
  /** Forget this room on this device only (when the hub cannot be reached to log out properly). */
  public func forgetHere() { try? FileManager.default.removeItem(at: store.dir) }

  // ---- inviting an agent from here (createInvite role agent, finalize: its own new session) -----------------------

  public struct AgentInvite {
    public var pairing: Pairing
    public var label: String?
    public var desk: String?
  }
  /** An invite link for an agent (the connector's command); a new session on `desk` once the emoji were confirmed. */
  public func createAgentInvite(app: String = "https://app.trommi.com/join", label: String? = nil, desk: String? = nil) async throws -> AgentInvite {
    try await serial { [self] in
      if !self.synced { _ = try await self.catchUpInner() }
      let made = try createInvite(state: self.state, inviter: self.device, hub: self.hub.hubURL, role: ROLE.AGENT, app: app)
      let r = try await self.noted { try await self.hub.postInvite(signedOffer: made.offer) }
      return AgentInvite(pairing: Pairing(inviteId: r["invite_id"] as? String ?? hex(made.invite.inviteId), link: made.link, expiresAt: made.invite.expiresAt, invite: made.invite), label: label, desk: desk)
    }
  }
  /** The human confirmed the agent's emoji: it is added and gets a new session of its own. Returns the session id. */
  @discardableResult public func confirmAgent(_ inv: AgentInvite, matches: Bool) async throws -> String {
    let p = inv.pairing
    if !matches {
      try? await hub.deleteInvite(p.inviteId)
      throw ZError("code-mismatch", "the check codes do not match: nobody was added, the invite is spent")
    }
    guard let member = p.member, let newId = p.newcomerId else { throw ZError("bad-invite", "this invite waits for no code") }
    let sid: String = try await serial { [self] in
      _ = try await self.refreshMembers()
      if self.state.memberAt(try unhex(newId)) == nil {
        let added = try addMember(self.state, signer: self.device, member: member, inviteId: p.invite.inviteId)
        _ = try await self.noted { try await self.hub.postMember(signedEntry: added.entry, sealedRoomKeys: []) }
      }
      _ = try await self.refreshMembers()
      // R6: the new agent's own session (a first grant: a new session key epoch 1)
      let g = try createSessionGrant(state: self.state, signer: self.device, sessionState: nil, agentIds: [try unhex(newId)])
      let sid = g.sessionState.sessionId
      try await self.postGrants([["session_id": sid, "signed_grant": b64u(g.grant), "sealed_session_keys": g.wraps.map { ["device_id": hex($0.id), "key_sealed": b64u($0.sealed)] }]])
      return sid
    }
    var place: [String: JV] = [:]
    if let l = inv.label, !l.isEmpty { place["name"] = .str(l) }
    if let d = inv.desk { place["desk"] = .str(d) }
    if !place.isEmpty { try? await editSession(sid, place) }
    return sid
  }

  // ---- canvases (the Scribble Board: shared/canvas.mjs, whiteboard.mjs openCanvas) ----------------------------------------

  /** Every item of a timeline after an envelope number with its body: GET threads, each checked against the verified hash. */
  public func loadAfter(_ key: String, after: Int) async throws {
    let t = board.timelineOf(key)
    t.windowOpen = true
    let p = parseTimelineKey(key)
    let secrets = Room.secretLookup(room: roomSecrets, sessions: sessionSecrets)
    var from = after
    var ch = Change()
    while true {
      let r = try await noted { try await hub.threadsAfter(kind: p.kind, timelineId: p.timelineId, after: from) }
      let list = r["envelopes"] as? [JSON] ?? []
      for e in list {
        guard let n = (e["envelope_number"] as? NSNumber)?.intValue, let b = e["envelope"] as? String, let bytes = try? unb64u(b) else { continue }
        from = max(from, n)
        guard var item = t.items[n], item.content == nil, let hh = item.envelopeHash, let vh = try? unhex(hh) else { continue }
        do {
          let o = try openVerifiedEnvelope(bytes, state: state, secrets: secrets, envelopeHash: vh)
          let d = Room.decodePayload(o.payload, header: o.header)
          item.content = d.content; item.contentType = d.content?["content_type"].string
          item.itemState = d.content == nil ? "undecryptable" : d.state == "ok" ? "loaded" : d.state
        } catch let e as ZError { item.itemState = e.code == "pruned" ? "pruned" : "undecryptable" }
        t.items[n] = item
      }
      if list.isEmpty || !(r["has_more"] as? Bool ?? false) { break }
    }
    ch.timelines.insert(key)
    emit(ch)
  }

  /** A canvas as it stands: the newest snapshot (register canvas_snapshot/<timeline>), then every item after it. */
  public func loadCanvas(_ timelineId: String) async throws -> CanvasState {
    let st = CanvasState()
    let key = timelineKeyOf("canvas", timelineId)
    var after = 0
    if let snap = board.human.canvasSnapshots[timelineId], !snap["attachment"].isNull,
       let bytes = try? await fetchAttachment(snap["attachment"]), let json = gunzip(bytes).flatMap({ JV.parse($0) }) {
      st.load(snapshot: json)
      after = st.lastEnvelopeNumber
    }
    try await loadAfter(key, after: after)
    applyCanvasItems(st, key)
    return st
  }
  /** The loaded items of a canvas timeline into a canvas state (in hub order; the frontier skips what it holds). */
  @discardableResult public func applyCanvasItems(_ st: CanvasState, _ key: String) -> Set<String> {
    var changed = Set<String>()
    guard let t = board.timelines[key] else { return changed }
    for n in t.items.keys.sorted() {
      guard let it = t.items[n], it.itemState == "loaded", let c = it.content, let seq = it.senderSequence else { continue }
      let role = board.members[it.senderDeviceId]?.deviceRole ?? "human"
      if let got = st.apply(sender: it.senderDeviceId, seq: seq, hash: it.envelopeHash, envelopeNumber: n, content: c, senderRole: role) { changed.formUnion(got) }
    }
    return changed
  }
  /** One canvas item (strokes, erase, move, send_away) into a canvas timeline: a desk's under the room key. */
  public func sendCanvas(_ timelineId: String, _ content: JV) async throws {
    let p = parseTimelineKey("x:\(timelineId)")
    let sid: String? = p.scope == "session" ? p.scopeId : p.scope == "card" ? board.cards[p.scopeId]?.sessionId : nil
    try await send(kind: KIND.TIMELINE_ITEM, content: content, timeline: (kind: "canvas", id: timelineId), sessionId: sid)
  }
  /** A selection of the board to a session: its picture and words as selection_sent; what was sent leaves the canvas. */
  public func sendSelection(sessionId: String, canvas timelineId: String, text: String, picture: JV, strokeIds: [String]) async throws {
    guard let to = sessionStates[sessionId]?.agentIds.first ?? board.sessions[sessionId]?.agentDeviceId else { throw ZError("bad-argument", "this session has no agent") }
    var c: [String: JV] = ["content_type": "selection_sent", "attachments": [picture], "stroke_ids": .arr(strokeIds.map { .str($0) })]
    if !text.isEmpty { c["text"] = .str(text) }
    try await send(kind: KIND.TIMELINE_ITEM, content: .obj(c), recipient: to, timeline: (kind: "chat", id: "session/\(sessionId)"), sessionId: sessionId)
    if !strokeIds.isEmpty { try await sendCanvas(timelineId, .obj(["content_type": "send_away", "stroke_ids": .arr(strokeIds.map { .str($0) })])) }
  }

  // ---- links for people outside the room (client.mjs shareAttachment) ------------------------------------------------

  /** A link to one file for someone outside the room: `<app>/a/<share_id>#<secret>.<file_key>.<sha256>`; the hub keeps only H(secret). */
  public func shareAttachment(_ ref: JV, days: Int = 7, app: String = "https://app.trommi.com") async throws -> (link: String, shareId: String, expiresAt: UInt64) {
    guard let id = ref["attachment_id"].string, let key = ref["file_key"].string, let sha = ref["sha256"].string else { throw ZError("bad-argument", "attachment reference") }
    let secret = systemRandom(32)
    let shareId = hex(systemRandom(16))
    let expires = nowMs() + UInt64(min(30, max(1, days))) * 86_400_000 - 60_000
    let r = try await noted { try await hub.request("POST", "/rooms/\(record.roomId)/attachments/\(id)/shares", body: ["share_id": shareId, "share_secret_hash": b64u(sha256(secret)), "expires_at": expires]) }
    return ("\(app)/a/\(shareId)#\(b64u(secret)).\(key).\(sha)", shareId, (r["expires_at"] as? NSNumber)?.uint64Value ?? expires)
  }
  public func revokeShare(attachmentId: String, shareId: String) async throws {
    _ = try await noted { try await hub.request("DELETE", "/rooms/\(record.roomId)/attachments/\(attachmentId)/shares/\(shareId)") }
  }

  // ---- the open cards (the spike's list; the app reads the board) -----------------------------------

  /** The open cards (decisions and infos) in stack order. */
  public var openCards: [Card] { board.stack.compactMap { board.cards[$0] } }
}
