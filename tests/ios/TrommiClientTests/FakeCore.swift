// FakeCore: a core that seals nothing, for testing the client layer on Linux without the Rust library. It keeps the
// CONTRACT of Core.swift, not the protocol: every operation writes its state and what it wants sent in one batch of
// the store, the outbox survives a restart unchanged, a device that meets a conflict stops being the owner, log
// entries and envelopes are taken in the hub's order and refused out of it, and a Commit of its own is merged only
// when the log hands it back, never by the hub's answer. Its "envelopes" and "Commits" are
// readable JSON; nothing here is a security claim. FakeHub answers the routes of spec/hub-api.md the same way.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient

func j(_ v: Any) -> Bytes { Bytes(try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])) }
func parse(_ b: Bytes) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(b))) as? [String: Any] ?? [:] }

final class FakeDevice: CoreDevice {
  struct State: Codable {
    var id: String; var room: String?; var cursor: UInt64 = 0; var nextOutbox: UInt64 = 1
    var epoch: UInt64 = 0
    var sessions: [String: [String]] = [:]         // session id (hex) -> agent devices (hex)
    var seqs: [String: UInt64] = [:]               // "<group>/<sender>" -> last accepted number
    var registers: [String: String] = [:]          // "<group>/<name>" -> value (JSON text)
    var pending: String?                           // an own Commit of the room group that the log has not handed back (hex)
  }
  let store: CoreStorage
  var state: State
  var revision: UInt64
  var box: [UInt64: OutboxEntry] = [:]
  var isOwner = true
  static let stateKey: Bytes = [1]

  init(store: CoreStorage, create: Bool) throws {
    self.store = store
    let loaded = try store.load()
    revision = loaded.revision
    if create {
      guard loaded.entries.isEmpty else { throw TrommiError("storage", "not empty") }
      state = State(id: hex(systemRandom(32)))
      try write([])
    } else {
      guard let e = loaded.entries.first(where: { $0.key == Self.stateKey }) else { throw TrommiError("storage", "no device") }
      state = try JSONDecoder().decode(State.self, from: Data(e.value))
      for e in loaded.entries where e.key.first == 9 {
        let o = parse(e.value)
        let entry = OutboxEntry(id: (o["id"] as! NSNumber).uint64Value, kind: OutboxKind(rawValue: (o["kind"] as! NSNumber).uint8Value)!, group: (o["group"] as? String).map { try! unhex($0) },
                                epoch: (o["epoch"] as! NSNumber).uint64Value, parts: (o["parts"] as! [String]).map { try! unhex($0) })
        box[entry.id] = entry
      }
    }
  }
  /** State and outbox changes in one batch, as the core does. */
  private func write(_ put: [OutboxEntry], drop: [UInt64] = []) throws {
    guard isOwner else { throw TrommiError("storage", "not the owner") }
    var batch = StoreBatch(put: [StoreEntry(key: Self.stateKey, value: Bytes(try JSONEncoder().encode(state)))], delete: drop.map { [9] + be64($0) })
    for e in put { batch.put.append(StoreEntry(key: [9] + be64(e.id), value: j(["id": e.id, "kind": e.kind.rawValue, "group": e.group.map(hex) as Any, "epoch": e.epoch, "parts": e.parts.map(hex)]))) }
    do { try store.apply(expectedRevision: revision, batch: batch) }
    catch StoreError.conflict { isOwner = false; throw TrommiError("storage", "another owner wrote to this state") }
    revision += 1
    for e in put { box[e.id] = e }
    for d in drop { box[d] = nil }
  }
  private func queue(_ kind: OutboxKind, group: GroupId?, parts: [Bytes]) throws -> UInt64 {
    let id = state.nextOutbox; state.nextOutbox += 1
    try write([OutboxEntry(id: id, kind: kind, group: group, epoch: state.epoch, parts: parts)])
    return id
  }
  static func sessionGroup(_ room: String, _ session: String) -> GroupId { try! unhex(room + session) }

  var id: DeviceId { try! unhex(state.id) }
  var room: RoomId? { state.room.map { try! unhex($0) } }
  var cursor: UInt64 { state.cursor }
  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) { (j(["device": state.id, "room": hex(room), "hub": hub, "challenge": hex(challenge)]), [1]) }
  func groups() throws -> [GroupSummary] {
    guard isOwner, let r = state.room else { return [] }
    return [GroupSummary(group: try unhex(r), session: nil, epoch: state.epoch, leaves: [id], archived: false, pending: state.pending != nil)] + state.sessions.keys.sorted().map { s in
      GroupSummary(group: Self.sessionGroup(r, s), session: SessionInfo(session: try! unhex(s), parent: nil, agents: state.sessions[s]!.map { try! unhex($0) }), epoch: 1, leaves: [id] + state.sessions[s]!.map { try! unhex($0) }, archived: false, pending: false)
    }
  }
  func holdsKey(group: GroupId, epoch: UInt64) throws -> Bool { true }
  func keyPackagesToUpload(unusedAtHub: Int, nowMs: UInt64) throws -> UInt64? { nil }
  func keyPackage(nowMs: UInt64) throws -> Bytes { j(["key_package": state.id]) }
  func foundRoom(recoveryCode: Bytes, nowMs: UInt64) throws -> RoomId {
    state.room = hex(systemRandom(32))
    _ = try queue(.roomFounding, group: room, parts: [j(["room": state.room!, "founder": state.id]), [0]])
    return room!
  }
  func foundSession(agent: DeviceId, keyPackages: [Bytes], nowMs: UInt64) throws -> SessionId { throw TrommiError("not-built") }
  func addToSession(group: GroupId, device: DeviceId, keyPackage: Bytes, nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
  func removeAgents(_ remove: [DeviceId], nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
  func removeHumanDevices(_ cuts: [Cut], nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
  func cleanSession(group: GroupId, cuts: [Cut], replacement: (device: DeviceId, keyPackage: Bytes)?, nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
  /** A Commit that only moves the room group's epoch, and only when forced. `busy` while one is pending. */
  func update(group: GroupId, forced: Bool, nowMs: UInt64) throws -> UInt64? {
    guard forced else { return nil }
    guard state.pending == nil else { throw TrommiError("busy") }
    let commit = j(["update": hex(systemRandom(8)), "by": state.id])
    state.pending = hex(commit)
    return try queue(.commit, group: group, parts: [commit, [0], [], [0]])
  }
  func archive(group: GroupId) throws {}
  func joinWelcome(_ welcome: Bytes, room: RoomId, committer: DeviceId?, nowMs: UInt64) throws -> Joined { throw TrommiError("not-built") }

  /** A "Commit" here is JSON: { session, agent } founds a session group; anything else only moves the epoch. */
  func processLogEntry(_ entry: LogEntry) throws -> Processed {
    guard entry.change > state.cursor else { throw TrommiError("wrong-epoch", "a change at or below the cursor") }
    state.cursor = entry.change
    switch entry.kind {
    case .commit(let bytes, _):
      // The device's own Commit, at its place in the log: merged here, with or without the hub's answer before it.
      if state.pending == hex(bytes) {
        state.pending = nil
        state.epoch += 1
        try write([], drop: box.values.filter { $0.kind == .commit && $0.parts.first == bytes }.map(\.id))
        return .ownCommit
      }
      let c = parse(bytes)
      if let s = c["session"] as? String, let a = c["agent"] as? String { state.sessions[s] = [a] } else { state.epoch += 1 }
      try write([])
      return .commit(group: entry.group, epoch: state.epoch, superseded: nil, removed: false)
    case .message(let bytes):
      try write([])
      let m = parse(bytes)
      guard let from = (m["from"] as? String).flatMap({ try? unhex($0) }) else { return .message(.dropped) }
      return .message(.workTrail(from: from, turn: [1, 2], number: (m["number"] as? NSNumber)?.uint32Value ?? 1, time: 5, step: j(["text": m["text"] as? String ?? "", "tool": "Bash"])))
    }
  }
  /** Nothing to learn: this fake holds every group from its founding. */
  func learnHistory(group: GroupId, founding: Bytes, commits: [PastCommit]) throws -> UInt64 { 0 }
  func logFinding(_ error: Error) -> LogFinding {
    switch (error as? TrommiError)?.code { case "storage": return .local; case "wrong-epoch": return .duplicate; case "group-behind": return .early; default: return .badGroup }
  }
  func sendHandover(group: GroupId, recipient: DeviceId) throws -> [UInt64] { [] }
  func sendStrokePiece(board: BoardId, piece: Bytes) throws -> UInt64 { try queue(.relayMessage, group: room, parts: [piece]) }
  func outbox() -> [OutboxEntry] { isOwner ? box.keys.sorted().map { box[$0]! } : [] }
  /** The entry goes; a Commit stays pending until the log hands it back. `not-found` for an entry that is gone. */
  func outboxAccepted(_ id: UInt64, change: UInt64?) throws {
    guard box[id] != nil else { throw TrommiError("not-found") }
    try write([], drop: [id])
  }
  /** An envelope's entry stays whatever the code (9.0.8); every other entry goes. */
  func outboxRefused(_ id: UInt64, code: String) throws { if box[id]?.kind != .envelope { try write([], drop: [id]) } }
  func outboxVoided(_ id: UInt64) throws { try write([], drop: [id]) }
  func envelopeAbandon(_ id: UInt64) throws { try write([], drop: [id]) }
  func close() { isOwner = false }
  func receiveRelay(group: GroupId, message: Bytes, nowMs: UInt64) throws -> ReceivedMessage? { .strokePiece(from: id, board: ALL_DESKS_BOARD, piece: message) }

  /** An "envelope" here is JSON of its header and its body in the clear. */
  func seal(_ draft: EnvelopeDraft, files: [FileId], nowMs: UInt64) throws -> Sealed {
    guard let r = state.room else { throw TrommiError("no-key") }
    var h: [String: Any] = ["sender": state.id, "time": nowMs]
    var payload = Bytes(), group = try unhex(r)
    switch draft {
    case let .sessionChat(session, p):
      guard state.sessions[hex(session)] != nil else { throw TrommiError("no-key", "not in that session") }
      group = Self.sessionGroup(r, hex(session)); payload = p
      h["kind"] = KIND.TIMELINE_ITEM; h["tk"] = TIMELINE.CHAT; h["ts"] = TIMELINE_SCOPE.SESSION; h["tr"] = hex(session); h["recipient"] = state.sessions[hex(session)]![0]
    case let .boardItem(board, p):
      payload = p; h["kind"] = KIND.TIMELINE_ITEM; h["tk"] = TIMELINE.CANVAS; h["ts"] = TIMELINE_SCOPE.DESK; h["tr"] = hex(board)
    case let .register(g, name, value):
      group = g
      let lamport = (state.registers.count + 1)
      payload = j(["name": name, "value": value.map { try! JSONSerialization.jsonObject(with: Data($0), options: [.fragmentsAllowed]) } ?? NSNull(), "lamport": lamport])
      state.registers["\(hex(g))/\(name)"] = value.map { String(decoding: $0, as: UTF8.self) }
      h["kind"] = KIND.STATUS; h["reg"] = hex(Bytes(name.utf8).prefix(16) + Bytes(repeating: 0, count: max(0, 16 - name.utf8.count)))
    case let .noteFirst(p):
      payload = p; h["kind"] = KIND.OBJECT_VERSION; h["otype"] = OBJECT_TYPE.NOTE; h["ostate"] = CARD_STATE.OPEN; h["oid"] = hex(systemRandom(16))
    case let .noteVersion(object, closed, p):
      payload = p; h["kind"] = KIND.OBJECT_VERSION; h["otype"] = OBJECT_TYPE.NOTE; h["ostate"] = closed ? CARD_STATE.CLOSED : CARD_STATE.OPEN; h["oid"] = hex(object)
    default: throw TrommiError("not-built")
    }
    let key = "\(hex(group))/\(state.id)"
    let seq = (state.seqs[key] ?? 0) + 1
    state.seqs[key] = seq
    h["group"] = hex(group); h["seq"] = seq; h["files"] = files.map(hex)
    let bytes = j(["h": h, "p": hex(payload)])
    let id = try queue(.envelope, group: group, parts: [bytes])
    return Sealed(outboxId: id, hash: FakeDevice.hash(bytes), seq: seq, group: group, objectId: (h["oid"] as? String).map { try! unhex($0) }, time: nowMs)
  }
  /** Not a hash anyone should trust: enough to tell two fake envelopes apart. */
  static func hash(_ b: Bytes) -> Hash32 { var h = Bytes(repeating: 0, count: 32); for (i, x) in b.enumerated() { h[i % 32] = h[i % 32] &* 31 &+ x }; return h }

  /**
   * As Core.swift says of the real one: at its place an envelope moves the cursor, also when it is refused for its
   * chain (`gap`, `replay`); one whose group this device does not hold yet is refused with `group-behind` and the
   * cursor stays. Out of order nothing is touched: applied if the chain holds that number, else provisional.
   */
  func receiveEnvelope(_ bytes: Bytes, change: UInt64, ordered: Bool, voidCode: String?, nowMs: UInt64) throws -> ReceivedEnvelope {
    let e = parse(bytes)
    guard let h = e["h"] as? [String: Any], let group = (h["group"] as? String).flatMap({ try? unhex($0) }), let sender = h["sender"] as? String, let seq = (h["seq"] as? NSNumber)?.uint64Value else { throw TrommiError("bad-format") }
    func n(_ k: String) -> Int? { (h[k] as? NSNumber)?.intValue }
    func b(_ k: String) -> Bytes? { (h[k] as? String).flatMap { try? unhex($0) } }
    let kinds: [Int: EnvelopeKind] = [KIND.TIMELINE_ITEM: .item, KIND.OBJECT_VERSION: .version, KIND.ANSWER: .answer, KIND.PERMISSION_REQUEST: .request, KIND.VERDICT: .verdict, KIND.STATUS: .register, KIND.DECIDE_AGAIN: .takeBack]
    var timeline: TimelineRef? = nil
    if let ref = b("tr") { timeline = n("tk") == TIMELINE.CANVAS ? .board(ref) : n("ts") == TIMELINE_SCOPE.CARD ? .cardChat(ref) : .sessionChat(ref) }
    let object = b("oid").map { ObjectHeader(objectId: $0, type: n("otype") == OBJECT_TYPE.NOTE ? .note : .card, state: n("ostate") == CARD_STATE.CLOSED ? .closed : .open) }
    let header = EnvelopeHeader(group: group, sessionId: group.count == 48 ? Bytes(group.suffix(16)) : nil, epoch: group.count == 32 ? state.epoch : 1, sender: try unhex(sender), seq: seq,
                                recipient: b("recipient"), time: (h["time"] as? NSNumber)?.uint64Value ?? 0, kind: kinds[n("kind") ?? 0] ?? .reserved(UInt8(n("kind") ?? 255)),
                                timeline: timeline, registerId: b("reg"), object: object, fileIds: (h["files"] as? [String] ?? []).map { try! unhex($0) })
    func made(_ outcome: EnvelopeOutcome, code: String? = nil) -> ReceivedEnvelope {
      let payload = outcome == .applied || outcome == .provisional ? (e["p"] as? String).flatMap { try? unhex($0) } : nil
      let name = header.kind == .register ? payload.flatMap { parse($0)["name"] as? String } : nil
      return ReceivedEnvelope(change: change, hash: Self.hash(bytes), header: header, outcome: outcome, code: code, payload: payload, register: name.map { RegisterChange(name: $0, current: true) })
    }
    if group.count == 48, state.sessions[hex(group.suffix(16))] == nil { return made(.refused, code: "group-behind") }
    let key = "\(hex(group))/\(sender)"
    let have = state.seqs[key] ?? 0
    guard ordered else { return made(voidCode != nil ? .void : have >= seq ? .applied : .provisional, code: voidCode) }
    guard change > state.cursor else { return made(.refused, code: "replay") }
    state.cursor = change
    let own = sender == state.id
    if !own && seq != have + 1 { try write([]); return made(.refused, code: seq <= have ? "replay" : "gap") }
    state.seqs[key] = max(have, seq)
    try write([])
    return made(voidCode != nil ? .void : .applied, code: voidCode)
  }
  func register(group: GroupId, name: String) throws -> Bytes? { state.registers["\(hex(group))/\(name)"].map { Bytes($0.utf8) } }
  func cutOf(group: GroupId, device: DeviceId) throws -> Cut { Cut(device: device, seq: state.seqs["\(hex(group))/\(hex(device))"] ?? 0, hash: ZERO32) }
  func headsDue(group: GroupId, nowMs: UInt64) throws -> Bytes? { nil }
  func compareHeads(group: GroupId, writer: DeviceId) throws -> [(sender: DeviceId, standing: HeadStanding)] { [] }
  func findings() throws -> [ChainFinding] { [] }
  func findingsRead() throws {}
  func boardLoad(board: BoardId, served: [WriterHead]) throws -> BoardLoaded { throw TrommiError("not-found") }
  func inviteOpen(role: InviteRole, session: SessionId?, app: String, hub: String, nowMs: UInt64) throws -> InviteOpened { throw TrommiError("not-built") }
  func inviteAccept(invite: Bytes, request: SignedRequest, nowMs: UInt64) throws -> InviteAccepted { throw TrommiError("not-built") }
  func inviteConfirm(invite: Bytes, numbers: [UInt8], requestHash: Hash32, matches: Bool, nowMs: UInt64) throws -> InviteConfirmed? { throw TrommiError("not-built") }
  func inviteSteps() throws -> [InviteStep] { [] }
  func inviteHandover(invite: Bytes) throws -> [UInt64] { throw TrommiError("not-built") }
  func inviteRecommit(invite: Bytes, nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
  func inviteForget(invite: Bytes) throws {}
  func inviteChecked(invite: Bytes, helpers: [GroupId]) throws {}
  func joinRequest(link: String, offer: SignedOffer, nowMs: UInt64) throws -> JoinRequest { throw TrommiError("not-built") }
  func joinReveal(_ reveal: SignedReveal) throws -> CheckCode { throw TrommiError("not-built") }
  func joinObserve(groupInfo: Bytes) throws { throw TrommiError("not-built") }
  func joinInvited(_ welcome: Bytes, nowMs: UInt64) throws -> Joined { throw TrommiError("not-built") }
  func holdsRecoveryMac() throws -> Bool { true }
  func keyIsConfirmed(group: GroupId, epoch: UInt64) throws -> Bool { true }
  func sendRecoveryAuth(recipient: DeviceId?) throws -> UInt64? { throw TrommiError("not-built") }
  func newRecoveryCode(current: Bytes) throws -> Bytes { throw TrommiError("not-built") }
  func replaceCode(current: Bytes, account: Bytes, nowMs: UInt64) throws -> UInt64 { throw TrommiError("not-built") }
}

/** A store in memory, for a FakeDevice a test asks something without a room around it. */
final class MemoryStore: CoreStorage {
  var revision: UInt64 = 0, entries: [Bytes: Bytes] = [:]
  func load() throws -> StoreLoaded { StoreLoaded(revision: revision, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) }) }
  func apply(expectedRevision: UInt64, batch: StoreBatch) throws {
    guard expectedRevision == revision else { throw StoreError.conflict }
    for k in batch.delete { entries[k] = nil }
    for e in batch.put { entries[e.key] = e.value }
    revision += 1
  }
}

final class FakeTools: CoreTools {
  var version: String { "fake" }
  func selfTest() -> [SelfTestStep] { [SelfTestStep(suite: "fake", name: "nothing", ok: true, micros: 1)] }
  func createDevice(store: CoreStorage) throws -> CoreDevice { try FakeDevice(store: store, create: true) }
  func openDevice(store: CoreStorage) throws -> CoreDevice { try FakeDevice(store: store, create: false) }
  func normaliseEmail(_ email: String) throws -> String { email.lowercased() }
  func checkPassword(_ password: String) throws { if password.count < 12 { throw TrommiError("weak-password") } }
  func passwordKeys(email: String, password: String, kdf: String?) throws -> PasswordKeys { PasswordKeys(authKey: "auth:" + hex(Bytes((email + password).utf8)), wrapKey: Bytes(password.utf8)) }
  func kitKeysFor(_ name: AccountName, words: String) throws -> PasswordKeys { PasswordKeys(authKey: "kit:" + hex(Bytes(words.utf8)), wrapKey: Bytes(words.utf8)) }
  func accountIdParse(_ text: String) throws -> String { text.lowercased() }
  func generateKitWords() throws -> String { "one two three four five six seven eight nine ten eleven twelve" }
  func parseKitWords(_ text: String) throws -> String { text }
  func generateRecoveryCode() throws -> Bytes { systemRandom(32) }
  func formatRecoveryCode(_ code: Bytes) -> String { hex(code) }
  func parseRecoveryCode(_ text: String) throws -> Bytes { try unhex(text) }
  func sealCode(_ code: Bytes, room: RoomId, way: AccountWay) throws -> Bytes { code.reversed() }
  func openCode(_ sealed: Bytes, room: RoomId, way: AccountWay) throws -> Bytes { sealed.reversed() }
  func isFinalRefusal(_ code: String) -> Bool { !["internal", "overloaded", "rate-limited", "unauthorised"].contains(code) && !code.hasPrefix("http-") }
  func canonicalHub(_ text: String) throws -> String { text }
  func parseInviteLink(_ text: String) throws -> InviteLinkParts { throw TrommiError("not-built") }
  func checkEmoji() -> [(emoji: String, word: String)] { (0..<64).map { ("#", String($0)) } }
  func boardReduce(snapshot: Bytes?, snapshotFrontier: [WriterHead], items: [BoardItemBody], frontier: [WriterHead]) throws -> Bytes { throw TrommiError("not-built") }
  func encryptFile(_ plain: Bytes) throws -> SealedFile { SealedFile(fileId: systemRandom(16), fileKey: [1], sha256: [2], stored: plain.reversed()) }
  func decryptFile(fileId: FileId, fileKey: Bytes, sha256: Bytes, stored: Bytes) throws -> Bytes { stored.reversed() }
  func createShareLink(app: String, fileId: FileId, fileKey: Bytes, sha256: Bytes) throws -> ShareLinkParts { ShareLinkParts(link: app + "/a/x", shareId: systemRandom(16), secretHash: [3]) }
  func generatePushKey() throws -> Bytes { systemRandom(32) }
  func recoverySigner(code: Bytes) throws -> CoreSigner { throw TrommiError("not-built") }
  func joinWithRecoveryCode(device: CoreDevice, code: Bytes, hub: HubClient, nowMs: UInt64) async throws -> (missingLink: Bytes?, notJoined: [(group: GroupId, code: String)]) { throw TrommiError("not-built") }
}

/** The hub's routes, answered in the process: one room, a change counter, what was posted in order. */
final class FakeHub: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var shared = Hub()
  final class Hub: @unchecked Sendable {
    let lock = NSLock()
    var change: UInt64 = 0
    var items: [[String: Any]] = []            // as GET /v2/changes gives them
    var posted: [(path: String, body: [String: Any])] = []
    var envelopePosts: [String] = []           // every envelope as it was posted, repeats included
    var refuse: [String: (status: Int, code: String, voided: Bool)] = [:]   // path -> refusal; `voided`: the hub kept the envelope's number as a void record
    var offline = false
    var rooms = 0
    /** Set: the answer to a posted Commit waits for a signal, while the Commit is in the changes already. */
    var holdCommitAnswer: DispatchSemaphore?
    func add(_ item: [String: Any]) -> UInt64 { change += 1; var i = item; i["change"] = change; items.append(i); return change }
    /** A Commit in the log of a group. */
    func commit(group: Bytes, _ body: [String: Any]) { lock.withLock { _ = add(["kind": "commit", "group_id": b64u(group), "bytes": b64u(j(body))]) } }
    func message(group: Bytes, _ body: [String: Any]) { lock.withLock { _ = add(["kind": "message", "group_id": b64u(group), "bytes": b64u(j(body))]) } }
    /** An envelope another device posted. */
    func envelope(_ h: [String: Any], payload: [String: Any]) { lock.withLock { _ = add(["kind": "envelope", "envelope": b64u(j(["h": h, "p": hex(j(payload))]))]) } }

    func answer(_ method: String, _ path: String, _ query: [String: String], _ body: [String: Any]) -> (Int, Any) {
      lock.lock(); defer { lock.unlock() }
      if let r = refuse[path] { return (r.status, ["error": r.code, "message": "refused", "voided": r.voided]) }
      posted.append((path, body))
      switch (method, path) {
      case ("POST", "/v2/rooms"):
        rooms += 1
        let room = parse(try! unb64u(body["group_info"] as! String))["room"] as! String
        return (200, ["room_id": b64u(try! unhex(room))])
      case ("GET", _) where path.hasSuffix("/challenge"): return (200, ["challenge": b64u(Bytes(repeating: 9, count: 32))])
      case ("POST", _) where path.hasSuffix("/tokens"): return (200, ["token": "t", "expires_at": nowMs() + 600_000, "role": "human"])
      case ("GET", "/v2/welcomes"): return (200, [Any]())
      case ("PUT", "/v2/key-packages"): return (200, ["unused": 100])
      case ("GET", "/v2/changes"):
        let after = UInt64(query["after"] ?? "0") ?? 0
        let limit = Int(query["limit"] ?? "500") ?? 500
        let page = Array(items.filter { ($0["change"] as! UInt64) > after }.prefix(limit))
        let upTo = page.last.map { $0["change"] as! UInt64 } ?? change
        return (200, ["items": page, "change": upTo, "more": upTo < change])
      case ("POST", "/v2/envelopes"):
        let e = body["envelope"] as! String
        envelopePosts.append(e)
        if let had = items.first(where: { $0["envelope"] as? String == e }) { return (200, ["change": had["change"]!]) }   // the first answer again
        return (200, ["change": add(["kind": "envelope", "envelope": e])])
      case ("POST", _) where path.hasSuffix("/commits"):
        // As POST /v2/groups/{group}/commits: the Commit takes its place in the log, the answer names it.
        let group = String(path.dropFirst("/v2/groups/".count).dropLast("/commits".count))
        let epoch = (body["epoch"] as? NSNumber)?.uint64Value ?? 0
        return (200, ["epoch": epoch + 1, "change": add(["kind": "commit", "group_id": group, "bytes": body["commit"] as! String])])
      case ("POST", _) where path.hasSuffix("/messages"): return (200, ["n": 1])
      case ("PUT", _) where path.hasPrefix("/v2/files/"), ("GET", _) where path.hasPrefix("/v2/files/"): return (200, [:] as [String: Any])
      default: return (404, ["error": "not-found", "message": path])
      }
    }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    let hub = FakeHub.shared
    guard !hub.offline, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
    var query = [String: String]()
    for q in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { query[q.name] = q.value }
    var data = request.httpBody ?? Data()
    if data.isEmpty, let s = request.httpBodyStream { s.open(); var buf = [UInt8](repeating: 0, count: 65536); while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }; s.close() }
    let (status, answer) = hub.answer(request.httpMethod ?? "GET", url.path, query, parse(Bytes(data)))
    let res = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
    let deliver = { [self] in
      client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: answer))
      client?.urlProtocolDidFinishLoading(self)
    }
    // A held answer waits on a thread of its own: the loading thread serves the other requests meanwhile.
    if url.path.hasSuffix("/commits"), let hold = hub.lock.withLock({ hub.holdCommitAnswer }) { Thread.detachNewThread { hold.wait(); deliver() } }
    else { deliver() }
  }
}
