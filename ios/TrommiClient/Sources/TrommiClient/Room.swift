// Room.swift: one room on this device: the device (trommi-core, through Core.swift), its store, the hub, and the
// board the views read (Board.swift). This file holds what the room is and how it keeps up with the hub:
//
//   catch up   GET /v2/changes after the cursor: Commits, messages and envelopes in the hub's order, each handed to
//              the core, which checks it and keeps the keys, chains and object state; what it opened becomes a record
//              (Records.swift) and is applied to the board by the same reducer as ever.
//   live       GET /v2/stream (server-sent events) with the same items, resumed by change number.
//   outbox     everything this device wants sent is in the core's outbox, stored with the state it implies; it is
//              posted in order and the hub's answer reported back. After a crash the same bytes go out again.
//              The hub's "taken" merges no Commit of this device: the core merges it when it comes back among the
//              changes, at its place in the hub's order, so the changes are read right after such an answer.
//
// What a human does is in RoomActions.swift, devices and invites in RoomDevices.swift, signing in and recovery in
// RoomAccount.swift, the record cache in RoomCache.swift.
//
// Threads: the room is used from the main actor; its operations run one after the other (`serial`). The core is
// only called inside `onCore`, which runs on one queue of its own: that keeps the order of its operations, and a
// long catch-up does not hold the main thread.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/** What the room is, kept beside the state as room.json. No secret in it. */
public struct RoomRecord: Codable {
  public var hubURL: String
  public var roomId: String        // hex
  public var myDeviceId: String    // hex
  public var role: String          // "human": the app is always a human device
  public var deviceRegisterSent: Bool
  /** What is left to do for what was written before this device came (RoomPast.swift); nil: nothing. */
  public var past: PastWork? = nil
  /** A sign-in with the recovery code has session groups left to join (RoomAccount.swift `finishCodeJoin`); nil: none. */
  public var codeJoin: Bool? = nil
  /** When this device's core confirmed that it was removed from the room (ms); nil: it is in (Room.removedAt). */
  public var removedAt: UInt64? = nil
}

/** `beforeJoining`: envelopes of an epoch before this device came into their group, which it cannot take until it learned that group's past (RoomPast.swift): passed over. */
public struct SyncReport { public var envelopes = 0, opened = 0, headerOnly = 0, undecryptable = 0, voids = 0, refused = 0, beforeJoining = 0; public var warnings: [String] = [] }

/** A mark set from the core's queue and read after it. */
final class Flag: @unchecked Sendable { var on = false }

/** The hub said this app is too old to be served. */
public struct UpgradeNotice: Equatable { public var minimumVersion: String?; public var message: String }

/**
 * A device's folder: room.json (which room, which hub; no secret), the device's state (DeviceStore), the record
 * cache. In the app's own container, left out of backups. The folder's name is random and never changes: the keys in
 * the Keychain are named by it, and a room gets its id only from its founding, after the state exists.
 */
public struct Store {
  public let dir: URL
  init(dir: URL) { self.dir = dir }
  /** The folder of the room this device is in; nil when it is in no such room. */
  public init?(base: URL, roomId: String) {
    guard let d = Store.folders(base).first(where: { (try? Store(dir: $0).load())?.roomId == roomId }) else { return nil }
    dir = d
  }
  /** A new, empty folder. */
  static func new(base: URL) throws -> Store { Store(dir: base.appendingPathComponent("d-\(hex(try LocalKey.random(8)))", isDirectory: true)) }
  public static func defaultBase() -> URL {
    if let x = ProcessInfo.processInfo.environment["TROMMI_SWIFT_HOME"] { return URL(fileURLWithPath: x, isDirectory: true) }
    #if os(Linux)
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/trommi-swift", isDirectory: true)
    #else
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("trommi", isDirectory: true)
    #endif
  }
  static func folders(_ base: URL) -> [URL] {
    ((try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? []).filter { $0.hasPrefix("d-") }.sorted().map { base.appendingPathComponent($0, isDirectory: true) }
  }
  /** The rooms this device is in (hex ids). */
  public static func rooms(base: URL) -> [String] { folders(base).compactMap { (try? Store(dir: $0).load())?.roomId }.sorted() }
  var stateDir: URL { dir.appendingPathComponent("state", isDirectory: true) }
  var hasRecord: Bool { FileManager.default.fileExists(atPath: dir.appendingPathComponent("room.json").path) }
  /** Forgets the device: its folder and its items in the Keychain. Only its owner calls this, with the state closed. */
  public func wipe() {
    try? FileManager.default.removeItem(at: dir)
    LocalKey.wipe(dir: dir)
  }
  public func save(_ r: RoomRecord) throws {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    #if os(iOS)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var d = dir; try d.setResourceValues(values)
    #endif
    try JSONEncoder().encode(r).write(to: dir.appendingPathComponent("room.json"), options: .atomic)
  }
  /**
   * A sign-in with the recovery code whose room join the hub may have taken without its answer arriving: the room
   * (hex) it was for. Such a folder is kept (never swept) until the next sign-in to that room settles it.
   */
  var unsureJoin: String? {
    (try? Data(contentsOf: dir.appendingPathComponent("join-unsure"))).map { String(decoding: $0, as: UTF8.self) }
  }
  func markUnsureJoin(_ roomId: String?) {
    let file = dir.appendingPathComponent("join-unsure")
    if let id = roomId { try? Data(id.utf8).write(to: file, options: .atomic) } else { try? FileManager.default.removeItem(at: file) }
  }
  public func load() throws -> RoomRecord { try JSONDecoder().decode(RoomRecord.self, from: Data(contentsOf: dir.appendingPathComponent("room.json"))) }
  /**
   * The device's state under its lock; throws `StoreError.failed("busy")` when it is open already. The lock is
   * taken before the key is asked for, so two openers never both make a key. `create`: a new device.
   */
  func openState(create: Bool = false) throws -> DeviceStore {
    let fresh = create && !FileManager.default.fileExists(atPath: stateDir.path)
    // A throwaway key until the lock is held; the store is then opened again with the real one.
    let probe = try DeviceStore(directory: stateDir, key: Bytes(repeating: 0, count: 32))
    let key: Bytes
    do { key = try LocalKey.get("state", dir: dir, create: fresh) } catch { probe.close(); throw error }
    return try probe.rekeyed(key, anchor: LocalAnchor(dir: dir))
  }
  /** The key of the record cache and the share links: lost, it is made again and the cache starts empty. */
  func cacheKey() throws -> Bytes { try LocalKey.get("cache", dir: dir, create: true) }

  /**
   * Folders a join or a founding left behind without a room (the app was ended in between): removed, unless
   * someone holds their lock. Called under `lifecycle`.
   */
  static func sweep(base: URL) {
    for d in folders(base) {
      let s = Store(dir: d)
      guard !s.hasRecord, s.unsureJoin == nil, let state = try? DeviceStore(directory: s.stateDir, key: Bytes(repeating: 0, count: 32)) else { continue }
      state.close()
      s.wipe()
    }
  }
  /** Creating, abandoning and removing device folders happen one at a time in this process. */
  static let lifecycle = NSLock()
}

public final class Room {
  public let store: Store
  public var record: RoomRecord
  public let hub: HubClient
  /** The board: cards, sessions, conversations, registers, notes (Board.swift). */
  public let board = Board()
  /** The room's change number up to which the board holds everything. */
  public internal(set) var cursor: UInt64 = 0
  public internal(set) var upgrade: UpgradeNotice?
  /** Called after every batch that changed the board (on the main actor). */
  public var onChange: ((Change) -> Void)?
  /** Live: the stream is open. */
  public internal(set) var live = false
  /**
   * When this device learned that it was removed from the room (ms); nil: it is in. Set only on the word of the
   * room group's own Commits, which the device checked itself (`checkRemoval`), never on the hub's word alone. The
   * room then sends and reads nothing more; forgetting what is stored here is the app's act, after it said so.
   */
  public internal(set) var removedAt: UInt64?
  /** Whether the board came from the cache (shown before the first catch-up). */
  public internal(set) var restored = false

  public let roomId: RoomId
  public var roomIdHex: String { record.roomId }
  public var deviceIdHex: String { record.myDeviceId }
  public var hubURL: String { record.hubURL }
  /** What the views show of the room group: its epoch. */
  public internal(set) var state: (epoch: Int, humans: Int) = (0, 0)

  let device: CoreDevice
  let deviceStore: DeviceStore
  private let coreQueue = DispatchQueue(label: "trommi.core")
  /** The groups as the core last told them, by group id (hex). */
  var groups: [String: GroupSummary] = [:]
  var roomGroup: GroupId?
  /** The hub's last word on how many of this device's KeyPackages are unused; nil before it said so in this run. */
  var keyPackagesAtHub: Int?
  /** Which session a message of a group belongs to: group id (hex) to session id (hex). */
  var sessionIdOfGroup: [String: String] = [:]
  /** Findings about a sender's chain that were shown in this run ("<group>/<sender>/<code>"): each is said once. */
  var findingsSaid = Set<String>()
  var synced = false
  var queueTail: Task<Void, Never>?
  var echoSeq = 0
  /** Records applied since launch, by change number: what the cache appends at its next save. */
  var log: [UInt64: Rec] = [:]
  /** What this device sealed and has not seen back yet, by envelope hash (hex): the local id of its echo. */
  var ownEchoes: [String: String] = [:]
  /** What the hub said to an envelope this device sealed, by outbox id. */
  var outcome: [UInt64: Result<Void, HubError>] = [:]
  var pumping = false
  /** The changes are being read again from the start (RoomPast.swift): an envelope below the core's cursor is handed in as the next of its chain. */
  var readingBack = false
  /** Something came that the past waits for (a Welcome, keys): `tendPast` is due after what is being processed. */
  var pastDue = false
  /** The highest lamport this device has seen or written (9.3.2): what an echo of an own write is ordered by. */
  var lamport = 0
  // the record cache (RoomCache.swift)
  var recordStoreMemo: RecordStore?
  var dirtyRecs = Set<UInt64>()
  var cacheDirty = false
  var cacheTask: Task<Void, Never>?
  var saveTail: Task<Void, Never>?
  var restoring: Task<Bool, Never>?
  var restoredCount = 0
  var sinceSnapshot = 0
  // what a human does (RoomActions.swift)
  var noteHeads: [String: (version: Int, hash: String, content: [String: JV])] = [:]
  var attachmentCache: [String: Bytes] = [:]
  var attachmentOrder: [String] = []
  var shareStoreMemo: ShareStore?

  // ---- opening -------------------------------------------------------------------------------------------

  /** A room that is on this device already. Fails with `busy` when it is open elsewhere in this process. */
  public static func open(base: URL = Store.defaultBase(), roomId: String) throws -> Room {
    guard let store = Store(base: base, roomId: roomId) else { throw TrommiError("not-found", "this device is not in that room") }
    let record = try store.load()
    let state = try store.openState()
    do { return try Room(store: store, record: record, deviceStore: state, device: try Core.tools.openDevice(store: state)) }
    catch { state.close(); throw error }
  }

  init(store: Store, record: RoomRecord, deviceStore: DeviceStore, device: CoreDevice) throws {
    guard let room = try? unhex(record.roomId), room.count == 32 else { throw TrommiError("bad-argument", "room.json names no room") }
    guard hex(device.id) == record.myDeviceId else { throw TrommiError("bad-device", "the stored device does not belong to this room record") }
    if let r = device.room, r != room { throw TrommiError("wrong-room", "the stored device is in another room") }
    self.store = store; self.record = record; self.deviceStore = deviceStore; self.device = device
    roomId = room
    coreCursor = device.cursor
    hub = try HubClient(hubURL: record.hubURL, room: room)
    hub.signer = QueueSigner(id: device.id) { [coreQueue] room, hub, challenge in try coreQueue.sync { try device.signHubAuth(room: room, hub: hub, challenge: challenge) } }
    board.roomId = record.roomId; board.hubURL = record.hubURL; board.myDeviceId = record.myDeviceId; board.myRole = record.role
    removedAt = record.removedAt
    var ch = Change()
    try applyGroups(try device.groups(), &ch)
  }

  /**
   * Stops the room and gives the state's lock back (signing out, tests). First nothing new is taken (every later
   * call into the core fails with `closed`, the outbox pump and the timers end, the hub gets no more signatures),
   * then the lock is released. The room is unusable afterwards.
   */
  public func close() {
    closed = true
    liveTask?.cancel(); goalsTask?.cancel(); cacheTask?.cancel()
    hub.signer = nil
    hub.shutdown()
    // The core first (it wipes what it holds in memory and lets go of the store), then the store's lock.
    coreQueue.sync { device.close(); deviceStore.close() }
  }
  /** `close`, after what is running (queued operations, a cache save) has ended. */
  public func shutdown() async {
    closed = true
    _ = await queueTail?.value
    await saveTail?.value
    close()
  }
  public private(set) var closed = false
  /** The device's own cursor as last seen: what the core has processed, which the board's cache may lag behind. */
  var coreCursor: UInt64 = 0
  var liveTask: Task<Void, Never>?

  // ---- one after the other -------------------------------------------------------------------------------

  /** Runs strictly after everything queued before (catch-up, live items, sends). */
  func serial<T>(_ op: @escaping @MainActor () async throws -> T) async throws -> T {
    let prev = queueTail
    let t = Task { @MainActor () throws -> T in
      _ = await prev?.value
      return try await op()
    }
    queueTail = Task { _ = try? await t.value }
    return try await t.value
  }

  /** The one place the core is called from once the room is open. Only inside `serial`. */
  func onCore<T>(_ body: @escaping (CoreDevice) throws -> T) async throws -> T {
    guard !closed else { throw TrommiError("closed", "this room was closed") }
    let device = self.device
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
      coreQueue.async { cont.resume(with: Result { try body(device) }) }
    }
  }

  func emit(_ c: Change) {
    if c.isEmpty { return }
    onChange?(c)
    // (a desk, a session's settings, the sessions or the stream changed: the goals handed to the agents may be behind)
    if c.room || !c.sessions.isEmpty || c.registers.contains(where: { $0.hasPrefix("desk/") || $0.hasPrefix("session/") }) { goalsSoon() }
  }

  /** A hub error that says this app is too old: remembered (the app shows it), and rethrown. */
  func noted<T>(_ op: () async throws -> T) async throws -> T {
    do { return try await op() }
    catch let e as HubError where e.status == 426 || e.code == "client-too-old" {
      upgrade = UpgradeNotice(minimumVersion: e.extra["minimum_version"] as? String, message: e.message)
      var ch = Change(); ch.room = true; emit(ch)
      throw e
    }
  }

  // ---- desk goals for the agents (spec/v2.md 9.3.4, Goals.swift) -----------------------------------------

  var goalsTask: Task<Void, Never>?
  /** What this device last wrote to `goals` of a session, in this run. */
  private var goalsSaid: [String: JV] = [:]
  private func goalsSoon() {
    guard goalsTask == nil else { return }
    goalsTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 400_000_000)
      guard let self = self else { return }
      self.goalsTask = nil
      _ = await self.syncGoals()
    }
  }
  /** Whether this device is a leaf of that session's group now (it can write there). */
  func holdsSession(_ sid: String) -> Bool { sessionGroup(sid) != nil }
  /**
   * Keeps `goals` in each live main session's group equal to what its Desk says (9.3.4), writing where it differs.
   * Only while live; how many were written. Runs by itself 400 ms after a change of a desk, a session's settings or
   * the sessions (also a Commit that added an agent device).
   */
  @discardableResult public func syncGoals() async -> Int {
    guard live, upgrade == nil else { return 0 }
    var n = 0
    for w in GoalsSync.toWrite(board, holdsKey: holdsSession, said: goalsSaid) {
      do {
        try await setRegisters(["goals": w.value], sessionId: w.sessionId)
        goalsSaid[w.sessionId] = w.value
        n += 1
      } catch { continue }
    }
    return n
  }

  // ---- groups: who is in the room and which sessions there are -------------------------------------------

  /** The session group of a session (hex id), if this device is in it and it is not archived. */
  func sessionGroup(_ sid: String) -> GroupSummary? {
    groups.values.first { $0.session.map { hex($0.session) } == sid && !$0.archived }
  }
  /** The members and sessions of the board from the groups the core holds. No network: the core verified them. */
  func applyGroups(_ list: [GroupSummary], _ change: inout Change) throws {
    groups = Dictionary(list.map { (hex($0.group), $0) }, uniquingKeysWith: { a, _ in a })
    guard let room = list.first(where: { $0.session == nil }) else { return }   // not in a room yet (founding, joining)
    roomGroup = room.group
    let humans = Set(room.leaves.map(hex))
    state = (Int(room.epoch), humans.count)
    board.keyEpoch = Int(room.epoch)
    var agents = [String]()
    for g in list { for a in g.session?.agents ?? [] where !agents.contains(hex(a)) { agents.append(hex(a)) } }
    // A device that is no leaf any more stays in the list as removed, so that what it wrote keeps its name.
    var members = [(id: String, role: String, active: Bool, added: Int, removed: Int?)]()
    for id in humans.sorted() { members.append((id, "human", true, 0, nil)) }
    for id in agents { members.append((id, "agent", true, 0, nil)) }
    for (id, m) in board.members where !humans.contains(id) && !agents.contains(id) { members.append((id, m.deviceRole, false, m.addedEntryNumber, m.removedEntryNumber ?? Int(room.epoch))) }
    board.applyMembers(members, change: &change)
    for g in list {
      guard let s = g.session else { continue }
      let sid = hex(s.session)
      sessionIdOfGroup[hex(g.group)] = sid
      board.applySession(sessionId: sid, agentIds: s.agents.map(hex), epoch: Int(g.epoch), parentSessionId: s.parent.map(hex), archived: g.archived, change: &change)
    }
    change.room = true
  }
  func refreshGroups(_ change: inout Change) async throws {
    let list = try await onCore { try $0.groups() }
    try applyGroups(list, &change)
  }

  // ---- catching up ---------------------------------------------------------------------------------------

  /** Sign in, join what this device was welcomed to, and read everything after the cursor in the hub's order. */
  @discardableResult public func sync() async throws -> SyncReport {
    try await serial { [self] in try await self.catchUp() }
  }

  func catchUp() async throws -> SyncReport {
    // the cache is read while the hub is asked
    let restoring: Task<Bool, Never>? = cursor == 0 ? Task { @MainActor in await self.restore() } : nil
    var report = SyncReport()
    if removedAt != nil { _ = await restoring?.value; throw TrommiError("removed", "this device was removed from the room") }
    // A token is not membership: the hub names the role it gave it for. A removed device gets one that reads the
    // proof of its removal and nothing else (spec/hub-api.md point 42).
    let role: String
    do { role = try await noted { try await hub.signIn() } } catch { _ = await restoring?.value; throw error }
    _ = await restoring?.value
    if role == "removed" {
      try await checkRemoval()
      throw TrommiError("removed", "this device was removed from the room")
    }
    var change = Change()
    try await takeWelcomes(&change)
    await finishCodeJoin()
    try await readChanges(&report, &change)
    // (the log said that this device was removed: nothing more is written or read)
    if removedAt != nil { emit(change); throw TrommiError("removed", "this device was removed from the room") }
    // (what was written before this device came is upkeep too: what is left of it is noted and goes on next time)
    try? await tendPast(&report, &change)
    // (stocking KeyPackages and writing `heads` are upkeep: a failure there does not keep the board from showing;
    // the next sync tries again)
    try? await publishKeyPackages()
    await writeHeads()
    synced = true
    Task { await self.refreshPresence() }
    board.project()
    change.stack = true
    emit(change)
    pumpOutbox()
    return report
  }

  /** The Welcomes waiting for this device (a session group it was added to): joined, if the room's inviter made them. */
  func takeWelcomes(_ change: inout Change) async throws {
    let list = try await noted { try await hub.welcomes() }
    guard !list.isEmpty else { return }
    let room = roomId
    for w in list {
      guard let bytes = (w["welcome"] as? String).flatMap({ try? unb64u($0) }) else { continue }
      // A Welcome that does not check is left alone: the hub keeps it, an alert says so, nothing is joined.
      do {
        let joined = try await onCore { try $0.joinWelcome(bytes, room: room, committer: nil, nowMs: nowMs()) }
        // (this device holds the group from here on; what was written in it before is learned: RoomPast.swift)
        notePast { if !$0.toLearn.contains(hex(joined.group)) { $0.toLearn.append(hex(joined.group)) } }
        pastDue = true
      }
      catch let e as TrommiError where e.code == "wrong-epoch" { continue }   // (joined before: the hub still had it)
      catch { board.pushAlert(&change, code: "welcome", message: "a Welcome was refused: \(Self.codeOf(error))") }
    }
    try await refreshGroups(&change)
  }

  /**
   * The hub says this device was removed. It is believed only with the proof: the room group's Commits up to the
   * removing one (GET /v2/groups/{group}/removal), handed to the core in order from this device's place on. When
   * the core itself says that a Commit removed this device, the room is marked as removed: nothing more is sent
   * or read, and the alert says so. Commits that do not check, or that end without removing this device, prove
   * nothing: everything is kept, a finding is shown, `not-member` is thrown and the next sync asks again. (Such
   * Commits are still the room group's own, so the core keeps the ones it took.)
   */
  func checkRemoval() async throws {
    let room = roomId
    // (the core may have taken the removing Commit already, from the changes, before the hub cut this device off)
    var confirmed = try await onCore { device in try device.groups().first { $0.group == room }.map { !$0.leaves.contains(device.id) } ?? false }
    var after: UInt64 = 0
    reading: while !confirmed {
      let page = try await noted { try await hub.request("GET", "/groups/\(b64u(room))/removal", query: ["after": String(after)]) }
      let items = page["items"] as? [JSON] ?? []
      var entries = [LogEntry]()
      for item in items {
        guard let n = Wire.uint(item["n"]), n > after, let change = Wire.uint(item["change"]), let bytes = (item["bytes"] as? String).flatMap({ try? unb64u($0) }) else {
          throw finding("bad-format", "the hub's proof of a removal does not read")
        }
        after = n
        entries.append(LogEntry(change: change, group: room, kind: .commit(bytes: bytes, recoveryAuth: (item["recovery_auth"] as? String).flatMap { try? unb64u($0) })))
      }
      // true: removed. false: a Commit did not check, so nothing after it can. nil: read on.
      let word: Bool? = try await onCore { device in
        for entry in entries where entry.change > device.cursor {
          guard let done = try? device.processLogEntry(entry) else { return false }
          if case .commit(let group, _, _, true) = done, group == room { return true }
        }
        return nil
      }
      coreCursor = try await onCore { $0.cursor }
      if word == true { confirmed = true }
      if word != nil || page["more"] as? Bool != true || items.isEmpty { break reading }
    }
    guard confirmed else { throw finding("not-member", "the hub says this device was removed and showed no Commit that says so: nothing was forgotten") }
    var change = Change()
    markRemoved(&change)
    emit(change)
  }
  /** The core said that a Commit of the room group removed this device: nothing more is sent or read. */
  func markRemoved(_ change: inout Change) {
    guard removedAt == nil else { return }
    removedAt = nowMs()
    // (kept: an app that ends before it forgot the room knows at its next start, without asking the hub again)
    record.removedAt = removedAt
    try? store.save(record)
    live = false; board.connection = "offline"
    goalsTask?.cancel(); cacheTask?.cancel()
    board.pushAlert(&change, code: "removed", message: "this device was removed from the room")
    change.room = true
  }

  /**
   * `heads` (9.0.7): in each live group the last envelope of every chain this device accepted there, written when
   * the core says it is due (coming online with a changed head, then at most every ten minutes). Another device
   * that holds less than a head named here knows that the hub withholds something.
   */
  func writeHeads() async {
    for g in groups.values where !g.archived {
      let group = g.group
      _ = try? await onCore { device -> Void in
        guard let value = try device.headsDue(group: group, nowMs: nowMs()) else { return }
        _ = try device.seal(.register(group: group, name: "heads", value: value), files: [], nowMs: nowMs())
      }
    }
  }

  /** Keeps the hub stocked with this device's KeyPackages (spec 14.2). */
  func publishKeyPackages() async throws {
    // How many are unused at the hub comes with its answer to an upload (`unused`). Before the first answer of a
    // run the hub is asked with an upload of nothing: a device told "none" while the hub holds a full set would make
    // a batch the hub refuses (`too-many`).
    if keyPackagesAtHub == nil {
      let r = try await noted { try await hub.request("PUT", "/key-packages", body: ["single_use": [String]()]) }
      keyPackagesAtHub = Wire.int(r["unused"])
    }
    guard let unused = keyPackagesAtHub else { return }
    _ = try await onCore { try $0.keyPackagesToUpload(unusedAtHub: unused, nowMs: nowMs()) }
  }

  /**
   * GET /v2/changes from the cursor until the hub has no more. The hub's answer is not believed about its shape:
   * every item must carry a change number above the one before it, and the page's own `change` may only stand at
   * or behind its last item. A page that is out of order, or that says "more" without moving on, ends the catch-up
   * with a finding and the cursor where the last good item left it. (That the hub gave EVERYTHING it has is not
   * something numbers can show: that is the chains' and the `heads` registers' work in the core, 9.0.7.)
   */
  func readChanges(_ report: inout SyncReport, _ change: inout Change) async throws {
    for _ in 0..<10_000 {
      let before = cursor
      let page = try await noted { try await hub.changes(after: cursor) }
      let raw = page["items"] as? [JSON] ?? []
      let items = try Self.ordered(raw, after: cursor)
      try await process(items, report: &report, change: &change)
      // The hub moves the cursor over what this device may not see: forwards only, and only when the whole page
      // was taken (process throws otherwise).
      if let upTo = Wire.uint(page["change"]), upTo > cursor { cursor = upTo; board.lastEnvelopeNumber = max(board.lastEnvelopeNumber, Int(upTo)) }
      if page["more"] as? Bool != true { return }
      if cursor <= before { throw finding("bad-format", "the hub says there is more and gives nothing new") }
    }
    throw finding("bad-format", "the hub's changes do not end")
  }
  /** The items of a page as they must be: each readable, each with a change number above the one before. */
  static func ordered(_ raw: [JSON], after: UInt64) throws -> [Item] {
    var last = after
    return try raw.map { j in
      guard let item = Item(j) else {
        // (a kind a newer hub adds is passed over; anything else that does not read is not)
        if let k = j["kind"] as? String, !["envelope", "commit", "message"].contains(k), let n = Wire.uint(j["change"]), n > last { last = n; return nil }
        throw TrommiError("bad-format", "an item of the hub's changes does not read")
      }
      guard item.change > last else { throw TrommiError("bad-format", "the hub's changes are not in order") }
      last = item.change
      return item
    }.compactMap { $0 }
  }
  /** A finding about the hub: shown, and thrown. */
  func finding(_ code: String, _ message: String) -> TrommiError {
    var ch = Change()
    board.pushAlert(&ch, code: code, message: message)
    emit(ch)
    return TrommiError(code, message)
  }

  /** One item of GET /v2/changes or of the stream, as bytes for the core. */
  enum Item {
    /** `n`: the entry's number in its group's log, which a report to the hub names (14.7). */
    case log(n: UInt64?, LogEntry)
    case envelope(change: UInt64, bytes: Bytes, voidCode: String?)
    var change: UInt64 { switch self { case .log(_, let e): return e.change; case .envelope(let c, _, _): return c } }

    init?(_ j: JSON) {
      guard let change = Wire.uint(j["change"]), change > 0 else { return nil }
      if j["kind"] as? String == "envelope" {
        guard let bytes = (j["envelope"] as? String).flatMap({ try? unb64u($0) }) else { return nil }
        self = .envelope(change: change, bytes: bytes, voidCode: j["void_code"] as? String)
        return
      }
      guard let group = (j["group_id"] as? String).flatMap({ try? unb64u($0) }), let bytes = (j["bytes"] as? String).flatMap({ try? unb64u($0) }) else { return nil }
      switch j["kind"] as? String {
      case "commit": self = .log(n: Wire.uint(j["n"]), LogEntry(change: change, group: group, kind: .commit(bytes: bytes, recoveryAuth: (j["recovery_auth"] as? String).flatMap { try? unb64u($0) })))
      case "message": self = .log(n: Wire.uint(j["n"]), LogEntry(change: change, group: group, kind: .message(bytes: bytes)))
      default: return nil    // a kind a newer hub adds
      }
    }
  }

  /** What the core made of one item. */
  enum Outcome {
    case processed(Processed)
    /** `heads`: for a `heads` register of another device, how its heads compare with this device's chains. */
    case envelope(ReceivedEnvelope, heads: [(sender: DeviceId, standing: HeadStanding)])
    case refused(change: UInt64, code: String)
    /** The run ends before this item; the cursor stays in front of it. */
    case stopped(code: String)
  }

  /**
   * A run of items in the hub's order: each to the core (off the main thread), then what it gave to the board. An
   * item the core refuses changes nothing and is counted; a local failure (the store, a lost owner) stops the run
   * with the cursor before it, so it is read again.
   */
  func process(_ parsed: [Item], report: inout SyncReport, change: inout Change) async throws {
    guard !parsed.isEmpty else { return }
    let readingBack = self.readingBack
    let cutDropped = Flag()
    let (outcomes, coreAt, findings): ([Outcome], UInt64, [ChainFinding]) = try await onCore { device in
      var out = [Outcome]()
      var commits = false
      /// Per leaf of a group, the last envelope the core accepted of it: asked before and after a Commit, a number
      /// that went down says the core dropped what lay beyond a removed device's Cut (9.0.10).
      func heads(_ group: GroupId) -> [DeviceId: UInt64] {
        guard let held = (try? device.groups())?.first(where: { $0.group == group }) else { return [:] }
        var out = [DeviceId: UInt64]()
        for leaf in held.leaves { if let cut = try? device.cutOf(group: group, device: leaf) { out[leaf] = cut.seq } }
        return out
      }
      /// The findings the core made while it processed Commits (a Cut that names another envelope than the one
      /// accepted): taken once, then cleared there.
      func done() -> ([Outcome], UInt64, [ChainFinding]) {
        let found = commits ? ((try? device.findings()) ?? []) : []
        if !found.isEmpty { try? device.findingsRead() }
        return (out, device.cursor, found)
      }
      // What the core processed already and the board's cache has not (the app ended before the cache was written):
      // an envelope is read again without touching any state, a log entry is done with.
      let before = device.cursor
      for item in parsed {
        do {
          switch item {
          case .log(_, let entry):
            if entry.change <= before { out.append(.processed(.skipped)); continue }
            let isCommit: Bool = { if case .commit = entry.kind { return true }; return false }()
            let had = isCommit ? heads(entry.group) : [:]
            let p = try device.processLogEntry(entry)
            for (leaf, seq) in had where seq > 0 {
              if let now = try? device.cutOf(group: entry.group, device: leaf), now.seq < seq { cutDropped.on = true }
            }
            if case .message = p {} else { commits = true }
            out.append(.processed(p))
          case .envelope(let c, let bytes, let void):
            var e = try device.receiveEnvelope(bytes, change: c, ordered: c > before || readingBack, voidCode: void, nowMs: nowMs())
            // Reading back: `replay` says the chain holds this one already, so it is read again for display.
            if readingBack, c <= before, e.outcome == .refused, e.code == "replay" { e = try device.receiveEnvelope(bytes, change: c, ordered: false, voidCode: void, nowMs: nowMs()) }
            // Refused with `group-behind` and the cursor left where it was: the group's next Commits are still to
            // come. Stop before it, so that it is read again with what it needs, instead of being passed over.
            if e.outcome == .refused, c > before, device.cursor < c { out.append(.stopped(code: e.code ?? "group-behind")); return done() }
            var heads = [(sender: DeviceId, standing: HeadStanding)]()
            if e.outcome == .applied, e.register?.name == "heads", e.header.sender != device.id {
              heads = (try? device.compareHeads(group: e.header.group, writer: e.header.sender)) ?? []
            }
            out.append(.envelope(e, heads: heads))
          }
        } catch {
          // A local failure is not the item's fault: stop here, nothing after it is processed out of order.
          if !device.isOwner { throw error }
          switch device.logFinding(error) {
          // The store failed: not the item's fault. Stop here; nothing after it is processed out of order.
          case .local: out.append(.stopped(code: Room.codeOf(error))); return done()
          // Something this item builds on has not come yet (its group is behind): stop before it, so that it is
          // read again with what it needs, instead of being passed over.
          case .early: out.append(.stopped(code: Room.codeOf(error))); return done()
          // Processed before: nothing to do.
          case .duplicate: out.append(.processed(.skipped))
          // It does not verify or cannot be merged (13.4), or its bytes are no envelope: the device keeps its
          // last good state, the finding is shown and, for a Commit, reported to the hub (14.7). Later items go on.
          case .badGroup: out.append(.refused(change: item.change, code: Room.codeOf(error)))
          }
        }
      }
      return done()
    }
    coreCursor = coreAt
    // (the core dropped what a removed device had signed beyond its Cut: what was shown of it goes, the board and
    // its cache are built again from the hub's changes, which the core now judges without it: RoomPast.swift)
    if cutDropped.on && !readingBack { notePast { $0.readBack = true }; pastDue = true }
    for f in findings { board.pushAlert(&change, code: f.code, message: "a removal names another last item of a device than the one this device holds", sender: hex(f.sender)) }
    // The groups are read again from the core after a Commit and before the next item is shown: an envelope right
    // behind the Commit that founded its session must find that session on the board.
    var groupsStale = false
    func freshGroups() async throws { if groupsStale { groupsStale = false; try await refreshGroups(&change) } }
    var stopped: String? = nil
    for (i, o) in outcomes.enumerated() {
      if case .stopped(let code) = o { stopped = code; break }
      cursor = max(cursor, parsed[i].change)
      board.lastEnvelopeNumber = max(board.lastEnvelopeNumber, Int(cursor))
      switch o {
      case .processed(let p):
        switch p {
        case .commit(let group, _, _, let removed):
          groupsStale = true
          if removed && group == roomId { markRemoved(&change) }
          else if removed { board.pushAlert(&change, code: "removed", message: "this device was removed from a group") }
        case .ownCommit, .observed, .joinSuperseded: groupsStale = true
        case .message(let m):
          try await freshGroups()
          if case .log(_, let entry) = parsed[i] { applyMessage(m, group: entry.group, change: entry.change, &change) }
        case .skipped: break
        }
      case .envelope(let e, let heads):
        try await freshGroups()
        apply(e, report: &report, &change)
        for h in heads { applyHead(h.standing, of: h.sender, group: e.header.group, saidBy: e.header.sender, &change) }
      case .refused(let c, let code):
        report.refused += 1
        if report.refused <= 5 { report.warnings.append("change \(c) refused: \(code)") }
        // Never swallowed (section 16): shown on the board; a Commit that cannot be merged is reported (14.7).
        board.pushAlert(&change, code: code == "internal" ? "bad-group" : code, message: "an item from the hub was refused (change \(c))", envelopeNumber: Int(c))
        if case .log(let n?, let entry) = parsed[i], case .commit = entry.kind { reportBadCommit(entry.group, n) }
      case .stopped: break
      }
    }
    try await freshGroups()
    if let code = stopped { throw TrommiError(code, "the catch-up stopped before a change it could not take yet") }
  }
  /**
   * What another device's `heads` say of one sender's chain, against this device's own (9.0.7). Another envelope
   * under the same number is `equivocation`. Holding less than the head named is `withheld`: `heads` come in the
   * hub's order, behind everything their writer had accepted, so what they name should be here already. Not said
   * of a sender whose chain this device could not take from its start (it came into the group later): there the
   * core holds nothing to compare, and the `gap` shown for that sender says so.
   */
  private func applyHead(_ standing: HeadStanding, of sender: DeviceId, group: GroupId, saidBy: DeviceId, _ change: inout Change) {
    let code: String
    switch standing {
    case .held, .unknown: return
    case .equivocation: code = "equivocation"
    case .behind(let have):
      if have == 0 || findingsSaid.contains("\(hex(group))/\(hex(sender))/gap") { return }
      code = "withheld"
    }
    guard findingsSaid.insert("\(hex(group))/\(hex(sender))/\(code)").inserted else { return }
    board.pushAlert(&change, code: code, message: code == "withheld" ? "another device holds more items of a device than the hub gave this one" : "two different items under one number of a device's chain", sender: hex(sender))
  }
  /** Tells the hub that a Commit of its log cannot be merged (14.7); the hub withdraws nothing, it notes it. */
  private func reportBadCommit(_ group: GroupId, _ n: UInt64) {
    Task { _ = try? await hub.request("POST", "/groups/\(b64u(group))/reject", body: ["n": n]) }
  }
  /** An application message of a group: a step of a work trail, a piece of a stroke being drawn. */
  private func applyMessage(_ m: ReceivedMessage, group: GroupId, change n: UInt64, _ change: inout Change) {
    switch m {
    case let .workTrail(from, turn, number, time, step):
      // (which session: the group the message came in; the item is kept and folded like every chat item)
      guard let sid = sessionIdOfGroup[hex(group)], let rec = Records.workStep(session: sid, sender: hex(from), turn: hex(turn), number: Int(number), time: time, step: step, change: n) else { return }
      board.apply(rec, change: &change)
      log[n] = rec
      cacheSoon(n)
    case let .strokePiece(from, boardId, piece):
      onStrokePiece?(hex(from), "desk/\(hex(boardId))", piece)
    case .newerVersion(let from):
      board.pushAlert(&change, code: "newer-version", message: Compat.UPDATE_MESSAGE, sender: hex(from))
    case .keys(_, let taken, _):
      // Keys of older epochs came (a handover): items that took their place without a body can be opened now.
      if taken > 0, record.past?.closed == true { notePast { $0.readBack = true }; pastDue = true }
    case .recoveryAuth, .recoveryAuthConflict, .dropped: break
    }
  }
  /** A piece of a stroke another device is drawing (relayed, never stored): sender, board timeline id, the piece's JSON. */
  public var onStrokePiece: ((String, String, Bytes) -> Void)?

  /** "human" or "agent", as the room names a device: a leaf of the room group is a human device; one that was, stays one. */
  func roleOf(_ device: DeviceId) -> String {
    if let known = board.members[hex(device)]?.deviceRole { return known }
    return roomGroup.flatMap { groups[hex($0)] }?.leaves.contains(device) == true ? "human" : "agent"
  }

  /** One received envelope into the board. */
  func apply(_ e: ReceivedEnvelope, report: inout SyncReport, _ change: inout Change) {
    let n = e.change, sender = hex(e.header.sender)
    report.envelopes += 1
    if let f = e.finding { board.pushAlert(&change, code: f, message: "the hub set an item of another device aside for a reason this device cannot check", envelopeNumber: Int(n), sender: sender) }
    // What was shown of this place in the sender's chain before the chain came is another envelope: dropped.
    if e.confirmed == false { dropProvisional(sender: sender, seq: e.header.seq, keep: hex(e.hash), &change) }
    switch e.outcome {
    case .refused:
      // It consumed nothing. An epoch before this device came into the group is nothing it can take, and no
      // finding. Everything else is one (a forged or replayed item, a chain that does not link): shown, once
      // per sender and code, since every later item of a broken chain is refused the same way (section 16).
      let code = e.code ?? "bad-format"
      if code == "group-behind" { report.beforeJoining += 1; notePast { $0.passedOver = true }; return }
      report.refused += 1
      if report.refused <= 5 { report.warnings.append("change \(n) refused: \(code)") }
      if findingsSaid.insert("\(hex(e.header.group))/\(sender)/\(code)").inserted {
        board.pushAlert(&change, code: code, message: code == "gap" ? "items of a device cannot be read: its chain started before this device came" : "an item from the hub was refused", envelopeNumber: Int(n), sender: sender)
      }
      return
    case .void:
      report.voids += 1
      return
    case .chained:
      // Chained and never applied. A body that did not open still counts for its object's state (9.2.1) and goes
      // on as a header; a refusal by who may write it or by its epoch (checks 7 and 8) shows nothing.
      if e.code == "no-key" { notePast { $0.closed = true } }
      if e.code != "pruned" { board.pushAlert(&change, code: e.code ?? "forbidden", message: "an item was not applied", envelopeNumber: Int(n), sender: sender) }
    case .applied, .provisional: break
    }
    // `heads` is the devices' own bookkeeping (9.0.7), compared in the core: nothing of it is on the board.
    if e.header.kind == .register, e.register?.name == "heads" { return }
    guard var rec = Records.record(e, senderRole: roleOf(e.header.sender)) else { report.voids += 1; return }
    // A lamport far above every one seen is not counted (9.3.2: the core counts it as 0; so does the board).
    if rec.causal.lamport > 0, !lamportAccepted(rec.causal.lamport, lamport) {
      board.pushAlert(&change, code: "lamport-inflated", message: "a write claims a lamport far above every one seen: counted as 0", envelopeNumber: Int(n), sender: rec.senderDeviceId)
      rec.causal.lamport = 0
    }
    switch rec.contentState {
    case "ok": report.opened += 1
    case "pruned", "header": report.headerOnly += 1
    default: report.undecryptable += 1
    }
    rec.localId = ownEchoes.removeValue(forKey: rec.envelopeHash)
    // The core checked who may write what (9.2); the board's reducer checks again and needs to know the devices.
    if e.outcome == .applied, let sid = rec.sessionId {
      if rec.senderRole == "agent" { board.sawAgent(sid, rec.senderDeviceId, epoch: rec.epoch) }
      else if let to = rec.recipientDeviceId { board.sawAgent(sid, to, epoch: rec.epoch) }
    }
    lamport = max(lamport, rec.causal.lamport)
    board.apply(rec, change: &change)
    var kept = rec
    kept.localId = nil
    log[n] = kept
    sinceSnapshot += 1
    cacheSoon(n)
  }
  /** Takes out of every conversation what was shown as not yet confirmed under that number of a sender's chain, except the envelope `keep`. */
  private func dropProvisional(sender: String, seq: UInt64, keep: String, _ change: inout Change) {
    for t in board.timelines.values {
      for (n, item) in t.items where item.pending && item.senderDeviceId == sender && item.senderSequence == seq && item.envelopeHash != keep {
        t.items.removeValue(forKey: n)
        t.numbers.removeAll { $0 == n }
        change.timelines.insert(t.key)
      }
    }
  }

  static func codeOf(_ error: Error) -> String {
    if let e = error as? TrommiError { return e.code }
    if let e = error as? HubError { return e.code }
    if let e = error as? StoreError { if case .conflict = e { return "conflict" }; return "storage" }
    return "internal"
  }

  // ---- live ----------------------------------------------------------------------------------------------

  /** One event of the hub's stream. */
  public func handleStreamEvent(_ event: String, _ data: JV) async {
    switch event {
    case "envelope", "log":
      // The hub sends the item as GET /v2/changes gives it. A `log` event that only names its group and number
      // (spec/hub-api.md allows that), or anything else that does not read, is a hint: catch up from the cursor.
      // An item that is not the next one is taken by the same catch-up, in order.
      let item = (data.any as? JSON).flatMap(Item.init)
      if let i = item, i.change <= cursor { return }
      _ = try? await serial { [self] in
        var report = SyncReport(), change = Change()
        defer { self.board.project(change); self.emit(change); self.pumpOutbox() }
        var taken = false
        if let i = item, i.change > self.cursor { taken = (try? await self.process([i], report: &report, change: &change)) != nil }
        if !taken { try await self.readChanges(&report, &change) }
        if self.pastDue { try await self.tendPast(&report, &change) }
      }
    case "relay":
      // A message the hub only passes on (a piece of a stroke being drawn): no change number, not in the log.
      guard let group = data["group_id"].string.flatMap({ try? unb64u($0) }), let bytes = data["message"].string.flatMap({ try? unb64u($0) }) else { return }
      _ = try? await serial { [self] in
        if case let .strokePiece(from, boardId, piece)? = try await self.onCore({ try $0.receiveRelay(group: group, message: bytes, nowMs: nowMs()) }) { self.onStrokePiece?(hex(from), "desk/\(hex(boardId))", piece) }
      }
    case "welcome":
      _ = try? await serial { [self] in
        var report = SyncReport(), ch = Change()
        defer { self.board.project(); self.emit(ch) }
        try await self.takeWelcomes(&ch)
        if self.pastDue { try await self.tendPast(&report, &ch) }
      }
    case "presence":
      var ch = Change()
      board.applyPresence(Records.presence(data), change: &ch)
      emit(ch)
    case "request":
      // a wish of a signed-in device (readmit, handover, session) or a join request of an invite
      var ch = Change(); ch.invites.insert(data["invite_id"].string ?? ""); emit(ch)
    case "file_evicted": break
    default: break   // ping, and events a newer hub adds
    }
  }

  /**
   * The live stream while the app is in front: every item as the hub takes it, applied at once. Returns when the
   * task is cancelled; reconnects with a growing pause after a drop, and when nothing (not even a ping) came for
   * 40 s. The stream resumes after the cursor, so nothing between two streams is missed.
   */
  public func runLive() async {
    var pause: UInt64 = 300_000_000
    while !Task.isCancelled && removedAt == nil {
      let reader = SSEReader()
      var unauthorised = false, refused = false
      do {
        if !synced { _ = try await sync() }
        let req = try await hub.streamRequest(after: cursor)
        for await ev in reader.start(req) {
          if Task.isCancelled { break }
          switch ev {
          case .status(let status):
            if status == 426 { upgrade = UpgradeNotice(minimumVersion: nil, message: "Please update Trommi."); var ch = Change(); ch.room = true; emit(ch); reader.stop(); return }
            if status == 401 { unauthorised = true; reader.stop(); break }
            if status != 200 { refused = true; reader.stop(); break }
            live = true; board.connection = "live"
            var ch = Change(); ch.room = true; emit(ch)
          case .event(let name, let data):
            pause = 300_000_000   // (a stream that brought something was a real one: the next pause is short again)
            if let v = JV.parse(Array(data.utf8)) { await handleStreamEvent(name, v) }
          }
        }
      } catch {}
      reader.stop()
      if Task.isCancelled { break }
      if unauthorised { hub.forgetToken(); pause = max(pause, 2_000_000_000) }
      // (a stream the hub refused: the next round signs in again and reads the role it is given, `catchUp`)
      if unauthorised || refused { synced = false }
      live = false; board.connection = "offline"
      var ch = Change(); ch.room = true; emit(ch)
      if upgrade != nil { return }
      try? await Task.sleep(nanoseconds: pause + UInt64.random(in: 0...(pause / 4)))
      pause = min(pause * 2, 30_000_000_000)
      Task { await self.refreshPresence() }
    }
    live = false
  }

  /** Who is online and what the agents' links say. */
  public func refreshPresence() async {
    // The hub tells presence on the stream only (a `presence` event per device as it comes and goes): there is
    // nothing to ask. Kept because the views call it when they come to the front.
  }
  /** The old name of `refreshPresence`, which the views call. */
  public func refreshDevices() async { await refreshPresence() }

  // ---- the outbox ----------------------------------------------------------------------------------------

  /**
   * Posts the core's outbox in order and reports each answer back. A network failure is retried with a growing
   * pause (the entry stays stored). A refusal that is the hub's last word goes to the core, which undoes what the
   * entry was for or holds a Commit back until the log decided (an own Commit that lost its epoch).
   *
   * An accepted COMMIT of this device is not merged by the answer: the group stands in its old epoch until the core
   * is handed that Commit from the hub's log, at its place among the changes of every group. So after such an
   * answer the changes are read from the cursor (`readOwnChanges`) before the entry counts as done. The live stream
   * may bring the Commit before the answer arrives: the core merged it then and the entry is gone (`not-found`).
   *
   * An ENVELOPE is different (9.0.1, 9.0.8): this device signed its number and gives it to no other envelope. It
   * leaves the outbox when the hub took it, when the hub kept its number as a void record (`voided`), or when this
   * device is out of the group (`not-member`, `removed-sender`) by the group state its own core holds. After any
   * other refusal the same bytes are sent again, and an alert says that something waits.
   */
  func pumpOutbox() {
    if pumping || removedAt != nil { return }
    pumping = true
    Task { @MainActor in
      defer { pumping = false }
      var backoff: UInt64 = 300_000_000, unknown = 0, stuck: UInt64? = nil
      func pause() async { try? await Task.sleep(nanoseconds: backoff); backoff = min(backoff * 2, 30_000_000_000) }
      while !Task.isCancelled && !closed && removedAt == nil {
        guard let entry = try? await onCore({ $0.outbox().first }) else { return }
        do {
          let r = try await noted { try await hub.post(entry) }
          // Only an answer of the documented shape is the hub's "taken": anything else (an empty 200, a page of
          // HTML) says nothing, and the entry is sent again.
          guard let answer = Self.accepted(entry.kind, r) else { throw HubError(status: 0, code: "offline", message: "the hub's answer to an outbox entry does not read") }
          if entry.kind == .keyPackages { keyPackagesAtHub = Wire.int(r["unused"]) }
          let commits = Self.carriesCommit(entry.kind)
          do { try await onCore { try $0.outboxAccepted(entry.id, change: answer) } }
          catch let e as TrommiError where commits && e.code == "not-found" { _ = e }   // merged from the log before the answer came
          if commits { await readOwnChanges() }
          outcome[entry.id] = .success(())
          backoff = 300_000_000; unknown = 0
          if entry.kind != .envelope && entry.kind != .message && entry.kind != .relayMessage { var ch = Change(); try? await refreshGroups(&ch); emit(ch) }
        } catch let e as HubError {
          // TROMMI_DEBUG: which kind of entry met which status and code (never its bytes).
          if ProcessInfo.processInfo.environment["TROMMI_DEBUG"] != nil { FileHandle.standardError.write(Data("[outbox] \(entry.kind) -> \(loggable(e))\n".utf8)) }
          if e.status == 426 { return }
          if e.status == 401 { hub.forgetToken() }
          // Not the hub's last word: no answer, it could not answer, it asks to sign in again, or it names a code
          // the core does not know. The entry stays and goes out again unchanged; a code nobody knows is said once.
          // (by the code, not the status: the hub answers 429 both for "slow down" and for a limit that is final)
          if e.isOffline || e.status >= 500 || e.status == 401 || !Core.tools.isFinalRefusal(e.code) {
            if !e.isOffline && e.status < 500 && e.status != 401 && !["rate-limited", "overloaded", "internal", "unauthorised"].contains(e.code) {
              unknown += 1
              if unknown == 3 { var ch = Change(); board.pushAlert(&ch, code: "hub-answer", message: "the hub answers something this app does not know (\(e.status)): what was written waits to be sent"); emit(ch) }
            }
            await pause(); continue
          }
          let voided = e.extra["voided"] as? Bool == true
          // "Out of the group" is the core's word, not the hub's: an envelope is given up only when the group as
          // this device holds it has no leaf of it any more. Otherwise it waits, and the next sync signs in again
          // and reads the role the hub names (a removed device proves its removal itself: `checkRemoval`).
          let out = entry.kind == .envelope && (e.code == "not-member" || e.code == "removed-sender")
          let outHere = out ? await outOfGroup(entry.group) : false
          if out && !outHere && !voided { synced = false; await pause(); continue }
          let gone = entry.kind == .envelope && (voided || outHere)
          do {
            try await onCore { device in
              if entry.kind != .envelope { try device.outboxRefused(entry.id, code: e.code) }
              else if voided { try device.outboxVoided(entry.id) }
              else if gone { try device.envelopeAbandon(entry.id) }
              else { try device.outboxRefused(entry.id, code: e.code) }
            }
          } catch { var ch = Change(); board.pushAlert(&ch, code: Room.codeOf(error), message: "a refusal of the hub could not be taken: sending stopped"); emit(ch); return }
          if entry.kind == .envelope && !gone {
            // Said once per entry; then the same bytes again, with a growing pause. The writer is not told "refused":
            // what it wrote still waits and may yet be taken.
            if stuck != entry.id {
              stuck = entry.id
              var ch = Change(); board.pushAlert(&ch, code: e.code, message: "the hub refused an item and took no number for it: it waits and is sent again (\(e.message))"); emit(ch)
            }
            await pause(); continue
          }
          outcome[entry.id] = .failure(e)
          var ch = Change()
          board.pushAlert(&ch, code: e.code, message: entry.kind == .envelope ? "the hub refused an item: \(e.message)" : "the hub refused a change to a group: \(e.message)")
          emit(ch)
        } catch { return }   // the store failed or this device is no longer the owner: nothing more is sent
      }
    }
  }
  /** Whether this device's core holds no leaf of its own in that group (it was removed, or the group is gone). */
  func outOfGroup(_ group: GroupId?) async -> Bool {
    guard let group = group, let list = try? await onCore({ try $0.groups() }) else { return false }
    guard let held = list.first(where: { $0.group == group }) else { return true }
    return !held.leaves.contains(device.id)
  }
  /** Whether an entry of that kind carries a Commit of this device, which the core merges only from the hub's log. */
  static func carriesCommit(_ kind: OutboxKind) -> Bool { [.commit, .groupFounding, .externalCommit, .recoveryCode].contains(kind) }
  /**
   * Reads what the hub has after the cursor, in its order, and the groups as they stand then: this is where a
   * Commit of this device that the hub accepted takes effect. A failure is left to the next catch-up or the stream.
   */
  func readOwnChanges() async {
    if !synced { _ = try? await sync(); return }
    _ = try? await serial { [self] in
      var report = SyncReport(), ch = Change()
      defer { self.board.project(ch); self.emit(ch) }
      try? await self.readChanges(&report, &ch)
      try await self.refreshGroups(&ch)
    }
  }
  /** What the hub's answer to an outbox entry must hold to count as "taken"; the change number the core wants. */
  static func accepted(_ kind: OutboxKind, _ r: JSON) -> UInt64?? {
    switch kind {
    case .envelope, .commit, .externalCommit, .recoveryCode: return Wire.uint(r["change"]).flatMap { $0 > 0 ? .some(.some($0)) : nil }
    case .message: return Wire.uint(r["n"]) != nil ? .some(nil) : nil
    case .relayMessage: return r["n"] is NSNull ? .some(nil) : nil   // (passed on, not stored: `n` is null)
    case .keyPackages: return Wire.uint(r["unused"]) != nil ? .some(nil) : nil
    case .groupFounding: return r["group_id"] is String ? .some(nil) : nil
    case .roomFounding: return r["room_id"] is String ? .some(nil) : nil
    case .sealedKey: return .some(nil)
    case .recoveryCommit: return r["kept"] as? Bool == true ? .some(nil) : nil
    case .recoveryFinish: return Wire.uint(r["change"]).map { .some($0) }
    }
  }
  /**
   * Waits a moment for the hub's word on what was just put into the outbox: a refusal is thrown here; a network
   * delay is not waited out (the outbox keeps the entry and posts it later).
   */
  func awaitOutcome(_ id: UInt64, ms: UInt64 = 8_000, orThrow: Bool = false) async throws {
    let until = nowMs() + ms
    while nowMs() < until {
      if let o = outcome.removeValue(forKey: id) { if case .failure(let e) = o { throw e }; return }
      try? await Task.sleep(nanoseconds: 40_000_000)
    }
    // `orThrow`: the caller builds on the hub having taken it (a step of several): no word is not a yes.
    if orThrow { throw TrommiError("pending", "the hub has not answered yet: this waits in the outbox and is sent again") }
  }
  /** Waits until the hub has taken everything in the outbox and an own Commit among it was read back and merged. */
  public func flush(timeoutMs: UInt64 = 30_000) async throws {
    _ = try? await serial { }
    let until = nowMs() + timeoutMs
    while let n = try? await onCore({ $0.outbox().count }), n > 0 || pumping {
      if nowMs() > until { throw TrommiError("timeout", "the hub has not taken \(n) item(s)") }
      if !pumping { pumpOutbox() }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  /** The open cards (decisions and infos) in stack order. */
  public var openCards: [Card] { board.stack.compactMap { board.cards[$0] } }
}

/** Signs hub challenges as the room's device, on the queue the core is called from; gone once the room is closed. */
final class QueueSigner: CoreSigner {
  let id: DeviceId
  private let sign: (RoomId, String, Bytes) throws -> (auth: Bytes, signature: Bytes)
  init(id: DeviceId, sign: @escaping (RoomId, String, Bytes) throws -> (auth: Bytes, signature: Bytes)) { self.id = id; self.sign = sign }
  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) { try sign(room, hub, challenge) }
}
