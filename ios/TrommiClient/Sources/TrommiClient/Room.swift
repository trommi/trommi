// Room.swift: one room on this device: the device (trommi-core, through Core.swift), its store, the hub, and the
// board the views read (Board.swift). This file holds what the room is and how it keeps up with the hub:
//
//   catch up   GET /v2/changes after the cursor: Commits, messages and envelopes in the hub's order, each handed to
//              the core, which checks it and keeps the keys, chains and object state; what it opened becomes a record
//              (Records.swift) and is applied to the board by the same reducer as ever.
//   live       GET /v2/stream (server-sent events) with the same items, resumed by change number.
//   outbox     everything this device wants sent is in the core's outbox, stored with the state it implies; it is
//              posted in order and the hub's answer reported back. After a crash the same bytes go out again.
//
// What a human does is in RoomActions.swift, devices and invites in RoomDevices.swift, signing in and recovery in
// RoomAccount.swift, the record cache in RoomCache.swift.
//
// Threads: the room is used from the main actor; its operations run one after the other (`serial`). The core is not
// thread-safe and is only called inside `onCore`, which runs on one queue of its own, so a long catch-up does not
// hold the main thread.
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
}

public struct SyncReport { public var envelopes = 0, opened = 0, headerOnly = 0, undecryptable = 0, voids = 0, refused = 0; public var warnings: [String] = [] }

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
      guard !s.hasRecord, let state = try? DeviceStore(directory: s.stateDir, key: Bytes(repeating: 0, count: 32)) else { continue }
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
  /** Which session an envelope of a group belongs to: group id (hex) to session id (hex). */
  var sessionIdOfGroup: [String: String] = [:]
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
    hub.forgetToken()
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
    do { _ = try await noted { try await hub.signIn() } } catch { _ = await restoring?.value; throw error }
    _ = await restoring?.value
    var change = Change()
    try await takeWelcomes(&change)
    try await readChanges(&report, &change)
    // (stocking KeyPackages is upkeep: a failure there does not keep the board from showing; the next sync tries again)
    try? await publishKeyPackages()
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
      do { _ = try await onCore { try $0.joinWelcome(bytes, room: room, committer: nil, nowMs: nowMs()) } }
      catch let e as TrommiError where e.code == "wrong-epoch" { continue }   // (joined before: the hub still had it)
      catch { board.pushAlert(&change, code: "welcome", message: "a Welcome was refused: \(Self.codeOf(error))") }
    }
    try await refreshGroups(&change)
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
      try await process(items, source: .catchUp, report: &report, change: &change)
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
    case envelope(ReceivedEnvelope, change: UInt64)
    case refused(change: UInt64, code: String)
    /** The run ends before this item; the cursor stays in front of it. */
    case stopped(code: String)
  }

  /**
   * A run of items in the hub's order: each to the core (off the main thread), then what it gave to the board. An
   * item the core refuses changes nothing and is counted; a local failure (the store, a lost owner) stops the run
   * with the cursor before it, so it is read again.
   */
  func process(_ parsed: [Item], source: EnvelopeSource, report: inout SyncReport, change: inout Change) async throws {
    guard !parsed.isEmpty else { return }
    let (outcomes, coreAt): ([Outcome], UInt64) = try await onCore { device in
      var out = [Outcome]()
      // What the core processed already and the board's cache has not (the app ended before the cache was written):
      // an envelope is read again without touching any state, a log entry is done with.
      let done = device.cursor
      for item in parsed {
        do {
          switch item {
          case .log(_, let entry): out.append(entry.change <= done ? .processed(.skipped) : .processed(try device.processLogEntry(entry)))
          case .envelope(let c, let bytes, let void):
            out.append(.envelope(try device.receiveEnvelope(bytes, change: c, source: c <= done ? .page : source, voidCode: void, nowMs: nowMs()), change: c))
          }
        } catch {
          // A local failure is not the item's fault: stop here, nothing after it is processed out of order.
          if !device.isOwner { throw error }
          switch device.logFinding(error) {
          // The store failed: not the item's fault. Stop here; nothing after it is processed out of order.
          case .local: out.append(.stopped(code: Room.codeOf(error))); return (out, device.cursor)
          // Something this item builds on has not come yet (its group is behind): stop before it, so that it is
          // read again with what it needs, instead of being passed over.
          case .early: out.append(.stopped(code: Room.codeOf(error))); return (out, device.cursor)
          // Processed before: nothing to do.
          case .duplicate: out.append(.processed(.skipped))
          // It does not verify or cannot be merged (13.4): the device keeps its last good state, the finding is
          // shown and, for a Commit, reported to the hub (14.7). Later items of other groups go on.
          case .badGroup: out.append(.refused(change: item.change, code: Room.codeOf(error)))
          }
        }
      }
      return (out, device.cursor)
    }
    coreCursor = coreAt
    // The groups are read again from the core after a Commit and before the next item is shown: an envelope right
    // behind the Commit that founded its session must find that session on the board.
    var groupsStale = false, groupsChanged = false
    func freshGroups() async throws { if groupsStale { groupsStale = false; groupsChanged = true; try await refreshGroups(&change) } }
    var stopped: String? = nil
    for (i, o) in outcomes.enumerated() {
      if case .stopped(let code) = o { stopped = code; break }
      cursor = max(cursor, parsed[i].change)
      board.lastEnvelopeNumber = max(board.lastEnvelopeNumber, Int(cursor))
      switch o {
      case .processed(let p):
        switch p {
        case .commit(_, _, _, let removed):
          groupsStale = true
          if removed { board.pushAlert(&change, code: "removed", message: "this device was removed from a group") }
        case .ownCommit, .observed: groupsStale = true
        case .message(let m):
          try await freshGroups()
          if case .log(_, let entry) = parsed[i] { applyMessage(m, group: entry.group, change: entry.change, &change) }
        case .skipped: break
        }
      case .envelope(let e, let c):
        try await freshGroups()
        apply(e, change: c, report: &report, &change)
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
    if groupsChanged { notifyKeysChanged?() }
    if let code = stopped { throw TrommiError(code, "the catch-up stopped before a change it could not take yet") }
  }
  /** Tells the hub that a Commit of its log cannot be merged (14.7); the hub withdraws nothing, it notes it. */
  private func reportBadCommit(_ group: GroupId, _ n: UInt64) {
    Task { _ = try? await hub.request("POST", "/groups/\(b64u(group))/reject", body: ["n": n]) }
  }
  /** Called when the groups or their epochs changed: the app hands the notification extension its new keys. */
  public var notifyKeysChanged: (() -> Void)?

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
    case .keys, .recoveryAuth, .recoveryAuthConflict, .dropped: break
    }
  }
  /** A piece of a stroke another device is drawing (relayed, never stored): sender, board timeline id, the piece's JSON. */
  public var onStrokePiece: ((String, String, Bytes) -> Void)?

  /** One received envelope into the board. */
  func apply(_ e: ReceivedEnvelope, change n: UInt64, report: inout SyncReport, _ change: inout Change) {
    report.envelopes += 1
    if case .notApplied(let code) = e.standing, code != "pruned" {
      // Chained and never applied. Why is a finding (a void of another sender the core could not re-check, an
      // equivocation, a body that does not open): shown, never swallowed (section 16).
      board.pushAlert(&change, code: code, message: "an item was not applied", envelopeNumber: Int(n), sender: hex(e.header.sender))
      if e.payload == nil, code != "no-key", code != "decrypt-failed" { report.voids += 1; return }
    }
    guard var rec = Records.record(e, change: n, sessionId: sessionIdOfGroup[hex(e.header.group)]) else { return }
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
    if e.standing == .accepted, let sid = rec.sessionId {
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
        if let i = item, i.change > self.cursor { do { try await self.process([i], source: .live, report: &report, change: &change); return } catch {} }
        try await self.readChanges(&report, &change)
      }
    case "relay":
      // A message the hub only passes on (a piece of a stroke being drawn): no change number, not in the log.
      guard let group = data["group_id"].string.flatMap({ try? unb64u($0) }), let bytes = data["message"].string.flatMap({ try? unb64u($0) }) else { return }
      _ = try? await serial { [self] in
        if case let .strokePiece(from, boardId, piece) = try await self.onCore({ try $0.processRelay(group: group, bytes: bytes) }) { self.onStrokePiece?(hex(from), "desk/\(hex(boardId))", piece) }
      }
    case "welcome":
      _ = try? await serial { [self] in var ch = Change(); try await self.takeWelcomes(&ch); self.board.project(); self.emit(ch) }
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
    while !Task.isCancelled {
      let reader = SSEReader()
      var unauthorised = false
      do {
        if !synced { _ = try await sync() }
        let req = try await hub.streamRequest(after: cursor)
        for await ev in reader.start(req) {
          if Task.isCancelled { break }
          switch ev {
          case .status(let status):
            if status == 426 { upgrade = UpgradeNotice(minimumVersion: nil, message: "Please update Trommi."); var ch = Change(); ch.room = true; emit(ch); reader.stop(); return }
            if status == 401 { unauthorised = true; reader.stop(); break }
            if status != 200 { reader.stop(); break }
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
   * pause (the entry stays stored); a refusal is the hub's last word on those bytes and goes to the core, which
   * drops the entry or holds it back until the log decided (an own Commit that lost its epoch).
   */
  func pumpOutbox() {
    if pumping { return }
    pumping = true
    Task { @MainActor in
      defer { pumping = false }
      var backoff: UInt64 = 300_000_000, unknown = 0
      while !Task.isCancelled && !closed {
        guard let entry = try? await onCore({ $0.outbox().first }) else { return }
        do {
          let r = try await noted { try await hub.post(entry) }
          // Only an answer of the documented shape is the hub's "taken": anything else (an empty 200, a page of
          // HTML) says nothing, and the entry is sent again.
          guard let answer = Self.accepted(entry.kind, r) else { throw HubError(status: 0, code: "offline", message: "the hub's answer to an outbox entry does not read") }
          if entry.kind == .keyPackages { keyPackagesAtHub = Wire.int(r["unused"]) }
          try await onCore { try $0.outboxAccepted(entry.id, change: answer) }
          outcome[entry.id] = .success(())
          backoff = 300_000_000; unknown = 0
          if entry.kind != .envelope && entry.kind != .message && entry.kind != .relayMessage { var ch = Change(); try? await refreshGroups(&ch); emit(ch) }
        } catch let e as HubError {
          // TROMMI_DEBUG: which kind of entry met which status and code (never its bytes).
          if ProcessInfo.processInfo.environment["TROMMI_DEBUG"] != nil { FileHandle.standardError.write(Data("[outbox] \(entry.kind) -> \(e.status) \(e.code)\n".utf8)) }
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
            try? await Task.sleep(nanoseconds: backoff); backoff = min(backoff * 2, 30_000_000_000); continue
          }
          do { try await onCore { try $0.outboxRefused(entry.id, code: e.code, voided: e.extra["voided"] as? Bool == true) } }
          catch { var ch = Change(); board.pushAlert(&ch, code: Room.codeOf(error), message: "a refusal of the hub could not be taken: sending stopped"); emit(ch); return }
          outcome[entry.id] = .failure(e)
          var ch = Change()
          board.pushAlert(&ch, code: e.code, message: entry.kind == .envelope ? "the hub refused an item: \(e.message)" : "the hub refused a change to a group: \(e.message)")
          emit(ch)
        } catch { return }   // the store failed or this device is no longer the owner: nothing more is sent
      }
    }
  }
  /** What the hub's answer to an outbox entry must hold to count as "taken"; the change number the core wants. */
  static func accepted(_ kind: OutboxKind, _ r: JSON) -> UInt64?? {
    switch kind {
    case .envelope, .commit, .externalCommit, .recoveryCode: return Wire.uint(r["change"]).map { .some($0) }
    case .message: return Wire.uint(r["n"]) != nil ? .some(nil) : nil
    case .relayMessage: return r["n"] != nil ? .some(nil) : nil   // (passed on, not stored: `n` is null)
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
  /** Waits until the hub has taken everything in the outbox. */
  public func flush(timeoutMs: UInt64 = 30_000) async throws {
    _ = try? await serial { }
    let until = nowMs() + timeoutMs
    while let n = try? await onCore({ $0.outbox().count }), n > 0 {
      if nowMs() > until { throw TrommiError("timeout", "the hub has not taken \(n) item(s)") }
      if !pumping { pumpOutbox() }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  /** The open cards (decisions and infos) in stack order. */
  public var openCards: [Card] { board.stack.compactMap { board.cards[$0] } }

  /**
   * What the notification extension may get (PushNotify): of every live session group the content key of its
   * current epoch and the one before, and its agent devices. Never the room group's key.
   */
  public func notifyKeys() -> [(group: Bytes, session: Bytes, epoch: UInt64, key: Bytes, agents: [Bytes])] {
    var out = [(group: Bytes, session: Bytes, epoch: UInt64, key: Bytes, agents: [Bytes])]()
    let list = groups.values.filter { $0.session != nil && !$0.archived }
    coreQueue.sync {
      for g in list {
        guard let s = g.session else { continue }
        for epoch in [g.epoch, g.epoch &- 1] where epoch <= g.epoch {
          if let key = try? device.contentKey(group: g.group, epoch: epoch) { out.append((g.group, s.session, epoch, key, s.agents)) }
        }
      }
    }
    return out
  }
}

/** Signs hub challenges as the room's device, on the queue the core is called from; gone once the room is closed. */
final class QueueSigner: CoreSigner {
  let id: DeviceId
  private let sign: (RoomId, String, Bytes) throws -> (auth: Bytes, signature: Bytes)
  init(id: DeviceId, sign: @escaping (RoomId, String, Bytes) throws -> (auth: Bytes, signature: Bytes)) { self.id = id; self.sign = sign }
  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) { try sign(room, hub, challenge) }
}
