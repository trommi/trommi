// The engine on a core that seals nothing (FakeCore.swift) and a hub in the process: founding, catching up in the
// hub's order, the outbox across a restart, the board the views read, the cache, one owner.
import XCTest
@testable import TrommiClient

@MainActor
final class RoomTests: XCTestCase {
  var base: URL!
  let hubURL = "http://127.0.0.1:9"
  let agent = String(repeating: "ab", count: 32), session = String(repeating: "cd", count: 16)

  override func setUp() async throws {
    base = FileManager.default.temporaryDirectory.appendingPathComponent("trommi-room-\(UUID().uuidString)")
    Core.tools = FakeTools()
    HubClient.transportForTests = [FakeHub.self]
    FakeHub.shared = FakeHub.Hub()
  }
  override func tearDown() async throws { try? FileManager.default.removeItem(at: base) }

  func founded() async throws -> Room {
    let made = try await Room.foundRoom(hubURL: hubURL, base: base)
    return made.room
  }
  /** A session with one agent, as a Commit in the room's log. */
  func addSession(_ room: Room) { FakeHub.shared.commit(group: room.roomId, ["session": session, "agent": agent]) }
  func agentSays(_ room: Room, seq: Int, _ text: String) {
    FakeHub.shared.envelope(["sender": agent, "group": hex(FakeDevice.sessionGroup(room.roomIdHex, session)), "seq": seq, "time": 1000 + seq, "kind": KIND.TIMELINE_ITEM,
                             "tk": TIMELINE.CHAT, "ts": TIMELINE_SCOPE.SESSION, "tr": session, "files": [String]()], payload: ["content_type": "message", "text": text])
  }
  func texts(_ room: Room) -> [String] {
    let t = room.board.timelineOf("chat:session/\(session)")
    return t.items.keys.sorted().compactMap { t.items[$0]?.content?["text"].string }
  }

  func testFoundingMakesARoomOnDiskAndAtTheHub() async throws {
    let room = try await founded()
    XCTAssertEqual(FakeHub.shared.rooms, 1)
    XCTAssertEqual(Store.rooms(base: base), [room.roomIdHex])
    XCTAssertEqual(room.board.members[room.deviceIdHex]?.deviceRole, "human")
    // one device folder, under a name of its own
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: base.path).count, 1)
    room.close()
  }

  func testOneOwner() async throws {
    let room = try await founded()
    XCTAssertThrowsError(try Room.open(base: base, roomId: room.roomIdHex)) { XCTAssertEqual($0 as? StoreError, .failed("busy")) }
    room.close()
    let again = try Room.open(base: base, roomId: room.roomIdHex)
    XCTAssertEqual(again.deviceIdHex, room.deviceIdHex)
    again.close()
  }

  func testCatchUpInTheHubsOrderBuildsTheBoard() async throws {
    let room = try await founded()
    addSession(room)
    agentSays(room, seq: 1, "one"); agentSays(room, seq: 2, "two")
    FakeHub.shared.message(group: FakeDevice.sessionGroup(room.roomIdHex, session), ["from": agent, "number": 1, "text": "ls"])
    agentSays(room, seq: 4, "out of order")   // a gap in the agent's chain: refused, changes nothing
    agentSays(room, seq: 3, "three")
    let report = try await room.sync()
    XCTAssertEqual(room.cursor, 6)
    XCTAssertEqual(report.refused, 1)
    XCTAssertEqual(room.board.sessions[session]?.agentDeviceId, agent)
    XCTAssertEqual(texts(room), ["one", "two", "", "three"])   // the third item is the step of the work trail
    let step = room.board.timelineOf("chat:session/\(session)").items[4]?.content
    XCTAssertEqual(step?["terminal"].string, "work")
    XCTAssertTrue(Work.isWork(step))
    XCTAssertEqual(Work.fold([step!["work"]]).items.first?.tool, "Bash")
    // again: nothing new, nothing twice
    _ = try await room.sync()
    XCTAssertEqual(texts(room).count, 4)
    room.close()
  }

  func testAMessageIsEchoedPostedAndReplacedByTheHubsCopy() async throws {
    let room = try await founded()
    addSession(room)
    _ = try await room.sync()
    try await room.sendMessage(sessionId: session, text: "hello")
    let t = room.board.timelineOf("chat:session/\(session)")
    XCTAssertEqual(FakeHub.shared.envelopePosts.count, 1)
    XCTAssertEqual(t.echoes.count, 1, "shown at once")
    _ = try await room.sync()
    XCTAssertEqual(t.echoes.count, 0, "replaced by the hub's copy")
    XCTAssertEqual(texts(room), ["hello"])
    XCTAssertEqual(t.items.values.first?.senderDeviceId, room.deviceIdHex)
    room.close()
  }

  func testTheOutboxSurvivesARestartAndGoesOutUnchanged() async throws {
    var room = try await founded()
    addSession(room)
    _ = try await room.sync()
    FakeHub.shared.offline = true
    let sending = Task { try await room.sendMessage(sessionId: session, text: "kept") }
    try await Task.sleep(nanoseconds: 700_000_000)
    let waiting = try await room.onCore { $0.outbox() }
    XCTAssertEqual(waiting.count, 1)
    sending.cancel()
    room.close()
    // the app is gone; the hub comes back; the same bytes go out
    FakeHub.shared.offline = false
    room = try Room.open(base: base, roomId: room.roomIdHex)
    let after = try await room.onCore { $0.outbox() }
    XCTAssertEqual(after, waiting)
    _ = try await room.sync()
    try await room.flush()
    XCTAssertEqual(FakeHub.shared.envelopePosts, [b64u(waiting[0].parts[0])])
    _ = try await room.sync()
    XCTAssertEqual(texts(room), ["kept"])
    room.close()
  }

  func testARefusalReachesTheSenderAndLeavesNoEcho() async throws {
    let room = try await founded()
    addSession(room)
    _ = try await room.sync()
    // The hub refuses the envelope and keeps its number as a void record: the entry is done with.
    FakeHub.shared.refuse["/v2/envelopes"] = (403, "forbidden", true)
    do { try await room.sendMessage(sessionId: session, text: "no"); XCTFail("refused") }
    catch let e as HubError { XCTAssertEqual(e.code, "forbidden") }
    XCTAssertEqual(room.board.timelineOf("chat:session/\(session)").echoes.count, 0)
    let left = try await room.onCore { $0.outbox().count }
    XCTAssertEqual(left, 0, "a voided entry is reported to the core and never sent again")
    room.close()
  }

  /// A refusal that took no number for the envelope: this device signed that number and sends the same bytes again (9.0.8).
  func testARefusedEnvelopeThatWasNotVoidedWaitsAndIsSentAgain() async throws {
    let room = try await founded()
    addSession(room)
    _ = try await room.sync()
    FakeHub.shared.refuse["/v2/envelopes"] = (403, "forbidden", false)
    let sending = Task { try await room.sendMessage(sessionId: session, text: "waits") }
    try await Task.sleep(nanoseconds: 700_000_000)
    let waiting = try await room.onCore { $0.outbox() }
    XCTAssertEqual(waiting.count, 1)
    XCTAssertTrue(room.board.alerts.contains { $0.code == "forbidden" })
    FakeHub.shared.lock.withLock { FakeHub.shared.refuse = [:] }
    try await room.flush()
    _ = try await sending.value
    XCTAssertEqual(FakeHub.shared.envelopePosts, [b64u(waiting[0].parts[0])])
    room.close()
  }

  /// A Commit of this device is not merged by the hub's answer: the outbox reads the changes after it, and the
  /// Commit takes effect where the hub's log hands it back.
  func testAnOwnCommitTakesEffectWhenTheChangesBringItBack() async throws {
    let room = try await founded()
    _ = try await room.sync()
    XCTAssertEqual(room.state.epoch, 0)
    // The core alone: the answer leaves the group in its old epoch with the Commit pending.
    let probe = try FakeDevice(store: MemoryStore(), create: true)
    let other = try probe.foundRoom(recoveryCode: [], nowMs: 0)
    let id = try XCTUnwrap(try probe.update(group: other, forced: true, nowMs: 0))
    let commit = try XCTUnwrap(probe.outbox().first { $0.id == id })
    try probe.outboxAccepted(id, change: 1)
    XCTAssertEqual(try probe.groups().first?.epoch, 0)
    XCTAssertEqual(try probe.groups().first?.pending, true)
    XCTAssertEqual(try probe.processLogEntry(LogEntry(change: 1, group: other, kind: .commit(bytes: commit.parts[0], recoveryAuth: nil))), .ownCommit)
    XCTAssertEqual(try probe.groups().first?.epoch, 1)

    // The engine: posted, accepted, read back from the changes, merged; only then is the entry done.
    let group = room.roomId
    let entry = try await room.serial { let id = try await room.onCore { try $0.update(group: group, forced: true, nowMs: nowMs()) }; room.pumpOutbox(); return id }
    try await room.awaitOutcome(try XCTUnwrap(entry), orThrow: true)
    XCTAssertEqual(room.state.epoch, 1)
    XCTAssertEqual(room.groups[room.roomIdHex]?.pending, false)
    XCTAssertEqual(room.cursor, 1)
    XCTAssertEqual(room.coreCursor, 1)
    let paths = FakeHub.shared.lock.withLock { FakeHub.shared.posted.map(\.path) }
    let posted = try XCTUnwrap(paths.firstIndex { $0.hasSuffix("/commits") })
    XCTAssertTrue(paths[posted...].contains("/v2/changes"))
    XCTAssertFalse(room.board.alerts.contains { $0.code == "not-found" })
    room.close()
  }

  /// The log may bring an own Commit before the hub's answer to its post arrives: the core merges it there, the
  /// entry is gone when the answer comes, and that is no failure.
  func testAnOwnCommitTheLogBroughtBeforeTheAnswer() async throws {
    let room = try await founded()
    _ = try await room.sync()
    let hold = DispatchSemaphore(value: 0)
    FakeHub.shared.lock.withLock { FakeHub.shared.holdCommitAnswer = hold }
    let group = room.roomId
    let entry = try await room.serial { let id = try await room.onCore { try $0.update(group: group, forced: true, nowMs: nowMs()) }; room.pumpOutbox(); return id }
    // The hub took the Commit and has not answered: the catch-up brings it first.
    let until = nowMs() + 5_000
    while FakeHub.shared.lock.withLock({ FakeHub.shared.change }) == 0, nowMs() < until { try await Task.sleep(nanoseconds: 10_000_000) }
    _ = try await room.sync()
    XCTAssertEqual(room.state.epoch, 1)
    let waiting = try await room.onCore { $0.outbox().count }
    XCTAssertEqual(waiting, 0)
    hold.signal()
    try await room.awaitOutcome(try XCTUnwrap(entry), orThrow: true)
    XCTAssertEqual(room.state.epoch, 1)
    // The outbox goes on afterwards.
    FakeHub.shared.lock.withLock { FakeHub.shared.holdCommitAnswer = nil }
    try await room.setCrown(.str("x"))
    try await room.flush()
    XCTAssertEqual(FakeHub.shared.envelopePosts.count, 1)
    room.close()
  }

  /// A register write the core never sealed takes its echo back: the value before it shows again. A name sealed
  /// before the failure in the same write stays.
  func testARegisterThatIsNeverSealedShowsTheValueBefore() async throws {
    let room = try await founded()
    _ = try await room.sync()
    try await room.setCrown(.str("first"))
    let device = try XCTUnwrap(room.device as? FakeDevice)
    device.sealRefusal = "busy"
    do { try await room.setCrown(.str("second")); XCTFail("refused") } catch {}
    XCTAssertEqual(room.board.human.crown.string, "first")
    XCTAssertEqual(room.board.human.raw["crown"]?.value.string, "first")
    // (the names go out in their order: desk/a is sealed, the refusal comes for desk/b)
    device.sealsBeforeRefusal = 1
    do { try await room.setRegisters(["desk/a": .obj(["name": "A"]), "desk/b": .obj(["name": "B"])]); XCTFail("refused") } catch {}
    device.sealRefusal = nil
    // a value over the register's 4 KiB is refused before it is sealed, a string as much as an object
    do { try await room.setCrown(.str(String(repeating: "x", count: 5000))); XCTFail("too large") } catch { XCTAssertEqual(Room.codeOf(error), "too-large") }
    XCTAssertEqual(room.board.human.crown.string, "first")
    XCTAssertEqual(room.board.human.desks["a"]?["name"].string, "A", "sealed before the failure: it stays")
    XCTAssertNil(room.board.human.desks["b"])
    XCTAssertNil(room.board.human.raw["desk/b"])
    room.close()
  }

  /// Every account has a desk: a new one gets `main`, "Personal", created_at 0; written twice (or by two devices,
  /// the same value), still one desk; the last desk cannot be removed.
  func testEveryAccountHasItsFirstDesk() async throws {
    let room = try await founded()
    _ = try await room.sync()
    XCTAssertEqual(room.liveDesks, [])
    let wrote = try await room.ensureDesk()
    XCTAssertTrue(wrote)
    XCTAssertEqual(room.liveDesks, ["main"])
    XCTAssertEqual(room.board.human.desks["main"], Room.firstDesk)
    XCTAssertEqual(room.board.human.desks["main"]?["name"].string, "Personal")
    XCTAssertEqual(room.board.human.desks["main"]?["created_at"].double, 0)
    let again = try await room.ensureDesk()
    XCTAssertFalse(again, "a desk is there: nothing is written")
    // a second device writes the same register with the same value: still one desk
    try await room.setDesk("main", Room.firstDesk)
    XCTAssertEqual(room.liveDesks, ["main"])
    do { try await room.removeDesk("main"); XCTFail("the last desk") } catch { XCTAssertEqual(Room.codeOf(error), "last-desk") }
    XCTAssertEqual(room.liveDesks, ["main"])
    try await room.setDesk("d2", .obj(["name": "Work", "created_at": .n(1)]))
    try await room.removeDesk("main")
    XCTAssertEqual(room.liveDesks, ["d2"])
    room.close()
  }

  func testARegisterIsOneEnvelopePerNameAndShowsAtOnce() async throws {
    let room = try await founded()
    _ = try await room.sync()
    try await room.setDesk("d1", .obj(["name": "Home", "goals": "ship"]))
    XCTAssertEqual(room.board.human.desks["d1"]?["name"].string, "Home")
    _ = try await room.sync()
    XCTAssertEqual(room.board.human.desks["d1"]?["goals"].string, "ship")
    let posted = parse(try unb64u(FakeHub.shared.envelopePosts[0]))
    XCTAssertEqual(parse(try unhex(posted["p"] as! String))["name"] as? String, "desk/d1")
    room.close()
  }

  func testTheCacheShowsTheBoardBeforeTheHubAnswers() async throws {
    var room = try await founded()
    addSession(room)
    agentSays(room, seq: 1, "remembered")
    _ = try await room.sync()
    await room.saveCacheAndWait()
    room.close()
    FakeHub.shared.offline = true
    room = try Room.open(base: base, roomId: room.roomIdHex)
    let had = await room.restore()
    XCTAssertTrue(had)
    XCTAssertEqual(texts(room), ["remembered"])
    XCTAssertEqual(room.cursor, 2)
    room.close()
  }

  func testACacheBehindTheDeviceIsFilledWithoutTouchingTheCoreAgain() async throws {
    var room = try await founded()
    addSession(room)
    agentSays(room, seq: 1, "processed, not cached")
    _ = try await room.sync()
    room.close()   // ended before the cache was written: the core is at change 2, the cache at 0
    room = try Room.open(base: base, roomId: room.roomIdHex)
    XCTAssertEqual(room.coreCursor, 2)
    let report = try await room.sync()
    XCTAssertEqual(report.refused, 0)
    XCTAssertEqual(texts(room), ["processed, not cached"])
    XCTAssertEqual(room.board.sessions[session]?.agentDeviceId, agent)
    room.close()
  }

  func testAClosedRoomDoesNothingMore() async throws {
    let room = try await founded()
    _ = try await room.sync()
    room.close()
    do { try await room.setCrown(.str("x")); XCTFail("closed") } catch { XCTAssertEqual(Room.codeOf(error), "closed") }
    XCTAssertNil(room.hub.signer)
    XCTAssertEqual(FakeHub.shared.envelopePosts.count, 0)
  }

  func testTheHubsPagesAreNotBelievedAboutTheirShape() async throws {
    let room = try await founded()
    addSession(room)
    agentSays(room, seq: 1, "one")
    func item(_ change: Any) -> JSON { ["kind": "envelope", "change": change, "envelope": "AA"] }
    // out of order, twice the same, not above the cursor, not a whole number, beyond 2^53: refused before the core sees any
    for bad in [[item(5), item(4)], [item(5), item(5)], [item(0)], [item(1.5)], [item(9_223_372_036_854_775_808.0)], [item(-1)], [["kind": "envelope", "change": 3]]] as [[JSON]] {
      XCTAssertThrowsError(try Room.ordered(bad, after: 0))
    }
    XCTAssertEqual(try Room.ordered([item(3), ["kind": "of-a-newer-hub", "change": 4], item(9)], after: 2).map(\.change), [3, 9])
    XCTAssertNil(Wire.uint(true)); XCTAssertNil(Wire.uint("7")); XCTAssertEqual(Wire.uint(NSNumber(value: 7)), 7)
    // an item whose group is behind stops the run in front of it: the cursor does not pass it
    FakeHub.shared.lock.withLock { FakeHub.shared.items.reverse(); for i in FakeHub.shared.items.indices { FakeHub.shared.items[i]["change"] = UInt64(i + 1) } }
    do { _ = try await room.sync(); XCTFail("the envelope came before the Commit that founds its session") } catch { XCTAssertEqual(Room.codeOf(error), "group-behind") }
    XCTAssertEqual(room.cursor, 0)
    XCTAssertEqual(texts(room), [])
    room.close()
  }

  func testOnlyADocumentedAnswerCountsAsTaken() {
    XCTAssertNil(Room.accepted(.envelope, [:]))
    XCTAssertNil(Room.accepted(.envelope, ["change": "3"]))
    XCTAssertEqual(Room.accepted(.envelope, ["change": 3]), .some(3))
    XCTAssertEqual(Room.accepted(.relayMessage, ["n": NSNull()]), .some(nil))
    XCTAssertNil(Room.accepted(.message, ["n": NSNull()]))
    XCTAssertNil(Room.accepted(.keyPackages, [:]))
  }

  func testBodiesAreRenamedBetweenTheWireAndTheModel() throws {
    let file = Bytes(repeating: 5, count: 16)
    let wire: JV = .obj(["attachments": .arr([.obj(["file_id": .str(b64u(file)), "file_key": "k"])]), "previous_version_hash": .str(b64u(ZERO32)),
                         "note": .obj(["object_id": .str(b64u(file))]), "merged_from_object_ids": .arr([.str(b64u(file))])])
    let model = Records.renameFiles(wire, toWire: false, depth: 0)
    XCTAssertEqual(model["attachments"].array?.first?["attachment_id"].string, hex(file))
    XCTAssertEqual(model["previous_version_hash"].string, hex(ZERO32))
    XCTAssertEqual(model["note"]["object_id"].string, hex(file))
    XCTAssertEqual(model["merged_from_object_ids"].array?.first?.string, hex(file))
    XCTAssertEqual(Records.renameFiles(model, toWire: true, depth: 0), wire)
    XCTAssertEqual(Records.registerName("device/" + b64u(ZERO32), toWire: false), "device/" + hex(ZERO32))
    XCTAssertEqual(Records.registerName("device/" + hex(ZERO32), toWire: true), "device/" + b64u(ZERO32))
    XCTAssertEqual(Records.fileIds(wire), [file])
    // a body that names a file its signed header does not list is not shown
    let h = EnvelopeHeader(group: [], epoch: 0, sender: [], seq: 1, time: 0, kind: .item, fileIds: [])
    XCTAssertEqual(Records.decodePayload(wire.encoded(), header: h).state, "undecryptable")
    // a register becomes the one-name `values` the board reads; a board snapshot keeps its old name there
    let reg = Records.fromWire(.obj(["name": "board_snapshot/00ff", "value": .obj(["change": 3]), "lamport": 4]), header: EnvelopeHeader(group: [], epoch: 0, sender: [], seq: 1, time: 0, kind: .register), sessionId: nil)
    XCTAssertEqual(reg["values"]["scribble_snapshot/desk/00ff"]["change"].int, 3)
    XCTAssertEqual(reg["lamport"].int, 4)
  }
}
