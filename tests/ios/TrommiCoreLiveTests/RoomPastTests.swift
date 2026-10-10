// What was written before a device came by link (RoomPast.swift), with the engine (`Room`), the real core and
// `PocketHub` behind the hub's routes (PocketRoutes.swift): A writes Notes, B joins by invite, and B's `Room` shows
// them only once it learned the room group's past.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class RoomPastTests: XCTestCase {
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
  /// The texts of the Notes on a room's board whose bodies opened.
  private func notes(_ room: Room) -> [String] { room.board.notes.values.map(\.text).filter { !$0.isEmpty }.sorted() }

  /// A founds a room and writes `early`; B comes in by invite. `handover`: A hands B the old keys at once.
  /// `past`: what B's room record notes about the past (RoomAccount.swift notes the room group after an invite).
  private func roomOfTwo(early: [String], handover: Bool = true, past: (RoomId) -> PastWork?) throws -> (a: LiveDevice, b: Room, room: RoomId, invite: Bytes) {
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    for text in early { try writeNote(a, text) }
    var invite = Bytes()
    let b = try pocketRoom(self, room: room, past: past(room), tools: tools) { b in
      let exchanged = try exchangeInvite(from: a, to: b, tools: self.tools)
      invite = exchanged.invite
      _ = try a.inviteConfirm(invite: exchanged.invite, numbers: exchanged.inviterShows, requestHash: exchanged.requestHash, matches: true, nowMs: nowMs())
      try self.hub.post(a)
      _ = try b.joinInvited(try XCTUnwrap(self.hub.welcomes.last), nowMs: nowMs())
      if handover { _ = try a.inviteHandover(invite: exchanged.invite); try self.hub.post(a) }
    }
    addTeardownBlock { await b.shutdown() }
    return (a, b, room, invite)
  }

  /// Without the group's past, what A wrote before B came is passed over; once the past is noted as to be learned,
  /// the next sync learns it and reads the old Notes, and what A wrote after B came, in the hub's order.
  func testWhatWasWrittenBeforeADeviceCameIsReadOnceThePastIsLearned() async throws {
    let (a, b, room, _) = try roomOfTwo(early: ["one", "two"]) { _ in nil }
    try writeNote(a, "three")

    let without = try await b.sync()
    XCTAssertEqual(without.beforeJoining, 2)
    XCTAssertEqual(notes(b), [], "the chain of A began before B came: nothing of it is taken")
    XCTAssertEqual(b.record.past?.passedOver, true)
    XCTAssertEqual(try b.store.load().past?.passedOver, true, "noted in room.json")

    b.notePast { $0.toLearn = [hex(room)] }
    let with = try await b.sync()
    XCTAssertEqual(notes(b), ["one", "three", "two"])
    XCTAssertEqual(with.opened, 3)
    XCTAssertEqual(with.beforeJoining, 0)
    XCTAssertEqual(b.record.past, PastWork(), "nothing is left to do")
    XCTAssertEqual(try b.store.load().past, PastWork())
    XCTAssertEqual(b.cursor, hub.change)
    // B holds A's chain from its first number, as A does.
    let device = try XCTUnwrap(b.device as? LiveDevice)
    XCTAssertEqual(try device.cutOf(group: room, device: a.id).seq, 3)

    // Nothing is asked again: the next sync fetches no history.
    PocketRoutes.asked = []
    _ = try await b.sync()
    XCTAssertFalse(PocketRoutes.asked.contains { $0.hasSuffix("/log") })
    XCTAssertEqual(notes(b), ["one", "three", "two"])
  }

  /// A device that joined by invite has the room group noted from the start: its first sync shows the past. A hub
  /// that fails while the history is fetched leaves the note, and the next sync goes on.
  func testAnInterruptedLearningGoesOnAtTheNextSync() async throws {
    let (_, b, room, _) = try roomOfTwo(early: ["one"]) { PastWork(toLearn: [hex($0)]) }
    PocketRoutes.refuseOnce["GET /groups/\(b64u(room))/log"] = "internal"
    _ = try await b.sync()
    XCTAssertEqual(notes(b), [])
    XCTAssertEqual(b.record.past?.toLearn, [hex(room)])

    _ = try await b.sync()
    XCTAssertEqual(notes(b), ["one"])
    XCTAssertEqual(b.record.past, PastWork())
  }

  /// The old keys come by A's handover. Before it, the old Notes take their places in A's chain without their
  /// bodies; when the handover brought the keys, the changes are read back and the Notes open.
  func testTheOldItemsOpenWhenTheHandoverComesLater() async throws {
    let (a, b, _, invite) = try roomOfTwo(early: ["one", "two"], handover: false) { PastWork(toLearn: [hex($0)]) }
    _ = try await b.sync()
    XCTAssertEqual(notes(b), [])
    XCTAssertEqual(b.record.past?.toLearn, [])
    XCTAssertEqual(b.record.past?.closed, true)

    _ = try a.inviteHandover(invite: invite)
    try hub.post(a)
    _ = try await b.sync()
    XCTAssertEqual(notes(b), ["one", "two"])
    XCTAssertEqual(b.record.past, PastWork())
  }
}
