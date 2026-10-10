// A device that the hub calls removed (spec/hub-api.md point 42), with the engine (`Room`), the real core and
// `PocketHub` behind the hub's routes (PocketRoutes.swift): the room believes it only when the room group's own
// Commits say so; a bare `not-member` keeps everything.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class RoomRemovalTests: XCTestCase {
  let tools = LiveCore()
  var hub = PocketHub()
  private var transport: [AnyClass] = []

  override func setUp() async throws {
    Core.tools = tools
    transport = HubClient.transportForTests
    hub = PocketHub()
    PocketRoutes.install(hub)
  }
  override func tearDown() async throws { HubClient.transportForTests = transport }

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }
  private func writeNote(_ device: LiveDevice, _ text: String) throws {
    _ = try device.seal(.noteFirst(payload: utf8(#"{"schema_version":1,"text":"\#(text)","previous_version_hash":"\#(b64u(ZERO32))"}"#)), files: [], nowMs: nowMs())
    try hub.post(device)
  }
  private func notes(_ room: Room) -> [String] { room.board.notes.values.map(\.text).filter { !$0.isEmpty }.sorted() }

  /// A founds a room and writes a Note; B comes in by invite and reads it.
  private func roomOfTwo() async throws -> (a: LiveDevice, b: Room, room: RoomId) {
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let b = try pocketRoom(self, room: room, past: PastWork(toLearn: [hex(room)]), tools: tools) { b in
      let exchanged = try exchangeInvite(from: a, to: b, tools: self.tools)
      _ = try a.inviteConfirm(invite: exchanged.invite, numbers: exchanged.inviterShows, requestHash: exchanged.requestHash, matches: true, nowMs: nowMs())
      try self.hub.post(a)
      _ = try b.joinInvited(try XCTUnwrap(self.hub.welcomes.last), nowMs: nowMs())
      _ = try a.inviteHandover(invite: exchanged.invite); try self.hub.post(a)
    }
    addTeardownBlock { await b.shutdown() }
    try writeNote(a, "one")
    _ = try await b.sync()
    XCTAssertEqual(notes(b), ["one"])
    return (a, b, room)
  }
  private func remove(_ b: Room, by a: LiveDevice, in room: RoomId) throws {
    _ = try a.removeHumanDevices([try a.cutOf(group: room, device: b.device.id)], nowMs: nowMs())
    try hub.post(a)
  }
  private func code(_ op: () async throws -> Void) async -> String? {
    do { try await op(); return nil } catch { return (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? "\(error)" }
  }

  /// A removes B; the hub cuts B off and names it removed. B reads the room group's Commits from the removal
  /// route, its core says one removed it: the room is marked removed and sends nothing more.
  func testARemovalIsBelievedWithTheCommitThatSaysSo() async throws {
    let (a, b, room) = try await roomOfTwo()
    try writeNote(a, "two")
    try remove(b, by: a, in: room)
    PocketRoutes.removed[hex(b.device.id)] = hub.change
    PocketRoutes.asked = []

    let thrown = await code { _ = try await b.sync() }
    XCTAssertEqual(thrown, "removed")
    XCTAssertNotNil(b.removedAt)
    XCTAssertTrue(PocketRoutes.asked.contains("GET /groups/\(b64u(room))/removal"))
    XCTAssertFalse(PocketRoutes.asked.contains("GET /changes"), "nothing but the proof is read")
    XCTAssertTrue(b.board.alerts.contains { $0.code == "removed" })

    // From here on nothing is asked of the hub.
    PocketRoutes.asked = []
    let again = await code { _ = try await b.sync() }
    XCTAssertEqual(again, "removed")
    XCTAssertEqual(PocketRoutes.asked, [])
  }

  /// A hub that names B removed while no Commit says so: everything is kept, `not-member` is said, and once the
  /// hub lets B in again it reads on where it was.
  func testAHubThatSaysRemovedWithoutProofChangesNothing() async throws {
    let (a, b, room) = try await roomOfTwo()
    _ = try a.update(group: room, forced: true, nowMs: nowMs())
    try hub.post(a)
    PocketRoutes.removed[hex(b.device.id)] = hub.change

    let thrown = await code { _ = try await b.sync() }
    XCTAssertEqual(thrown, "not-member")
    XCTAssertNil(b.removedAt)
    XCTAssertEqual(notes(b), ["one"])
    XCTAssertTrue(b.store.hasRecord)

    PocketRoutes.removed = [:]
    try writeNote(a, "two")
    _ = try await b.sync()
    XCTAssertEqual(notes(b), ["one", "two"])
    XCTAssertNil(b.removedAt)
  }

  /// B read its removal in the changes before the hub cut it off: the log alone marks it removed. The mark is kept
  /// in room.json: the app started again knows it without asking the hub.
  func testARemovalReadInTheChangesIsTheProof() async throws {
    let (a, b, room) = try await roomOfTwo()
    try remove(b, by: a, in: room)

    let thrown = await code { _ = try await b.sync() }
    XCTAssertEqual(thrown, "removed")
    XCTAssertNotNil(b.removedAt)

    XCTAssertNotNil(try b.store.load().removedAt)
    let other = try await pocketRoomAgain(b)
    XCTAssertNotNil(other.removedAt)
    PocketRoutes.asked = []
    let again = await code { _ = try await other.sync() }
    XCTAssertEqual(again, "removed")
    XCTAssertEqual(PocketRoutes.asked, [])
  }

  /// An envelope the hub refuses with `not-member` while B's core holds it as a leaf stays in the outbox and goes
  /// out again; nothing that B wrote is given up on the hub's word.
  func testAnEnvelopeRefusedAsNotMemberWaits() async throws {
    let (_, b, _) = try await roomOfTwo()
    PocketRoutes.refuseOnce["POST /envelopes"] = "not-member"
    try await b.saveNote(fields: ["text": .str("mine")])
    try await b.flush(timeoutMs: 10_000)
    // the refused bytes went out again and were taken: the envelope was not given up
    let refused = try XCTUnwrap(PocketRoutes.refused.first?["envelope"] as? String)
    XCTAssertTrue(hub.chains.contains { $0.sender == b.device.id && b64u($0.bytes) == refused })
    XCTAssertEqual(try b.device.outbox().count, 0)
  }

  /// The same device in a fresh `Room` (an app start): its state as stored.
  private func pocketRoomAgain(_ old: Room) async throws -> Room {
    let store = old.store
    let record = try store.load()
    await old.shutdown()
    let state = try store.openState()
    let device = try XCTUnwrap(try tools.openDevice(store: state) as? LiveDevice)
    let room = try Room(store: store, record: record, deviceStore: state, device: device)
    addTeardownBlock { await room.shutdown() }
    return room
  }
}
