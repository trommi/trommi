// The Scribble Board through the core alone (RoomActions.swift `loadCanvas`, `applyCanvasItems`): `boardLoad`
// verifies what the hub served against the chains and Cuts, `boardReduce` merges it. The engine (`Room`) with the
// real core and `PocketHub` behind the hub's routes (PocketRoutes.swift): A draws, B loads the board.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class RoomBoardTests: XCTestCase {
  let tools = LiveCore()
  var hub = PocketHub()
  private var transport: [AnyClass] = []
  let board: BoardId = Bytes(repeating: 0x42, count: 16)
  var timeline: String { "desk/\(hex(board))" }
  /// The change number of the last item drawn.
  var lastChange: UInt64 = 0

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
  /// A founds a room; B comes in by invite and holds the room group from its founding.
  private func roomOfTwo() async throws -> (a: LiveDevice, b: Room, room: RoomId) {
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let b = try pocketRoom(self, room: room, tools: tools) { b in
      let exchanged = try exchangeInvite(from: a, to: b, tools: self.tools)
      _ = try a.inviteConfirm(invite: exchanged.invite, numbers: exchanged.inviterShows, requestHash: exchanged.requestHash, matches: true, nowMs: nowMs())
      try self.hub.post(a)
      _ = try b.joinInvited(try XCTUnwrap(self.hub.welcomes.last), nowMs: nowMs())
      _ = try a.inviteHandover(invite: exchanged.invite); try self.hub.post(a)
    }
    addTeardownBlock { await b.shutdown() }
    _ = try await b.sync()
    return (a, b, room)
  }
  /// One stroke from (x, x) on, as an item's body on the wire.
  private func stroke(_ x: Double) -> Bytes {
    let s = CanvasShape.stroke(Ink(pts: [x, x, x + 10, x + 10, x + 20, x + 5], t: [0, 1, 2], f: [0.5, 0.5, 0.5]), tool: "pen", color: "ink", width: 4)
    return body(["content_type": "strokes", "strokes": [CanvasState.entryOf(s)]])
  }
  private func body(_ model: JV) -> Bytes { Records.boardItem(model, toWire: true).with("schema_version", .n(2)).encoded() }
  /// A writes one item; the hub serves it on the board's route. Its head.
  @discardableResult private func draw(_ a: LiveDevice, _ payload: Bytes, served: Bool = true) throws -> WriterHead {
    let sealed = try a.seal(.boardItem(board: board, payload: payload), files: [], nowMs: nowMs())
    try hub.post(a)
    lastChange = hub.change
    if served { PocketRoutes.boards[hex(board), default: []].append(hub.change) }
    return WriterHead(writer: a.id, seq: sealed.seq, hash: sealed.hash)
  }

  /// Without a snapshot: every item the hub serves, merged by the core; a later erase removes the shape.
  func testABoardIsTheCoresMergeOfItsItems() async throws {
    let (a, b, _) = try await roomOfTwo()
    let first = try draw(a, stroke(0))
    try draw(a, stroke(100))
    _ = try await b.sync()
    let st = try await b.loadCanvas(timeline)
    XCTAssertEqual(st.shapes.count, 2)
    let id = "\(hex(a.id))/\(first.seq)/0"
    XCTAssertNotNil(st.shapes[id])
    XCTAssertEqual(st.reducedFrontier.first?.seq, first.seq + 1)

    try draw(a, body(["content_type": "erase", "stroke_ids": [.str(id)]]))
    _ = try await b.sync()
    let changed = b.applyCanvasItems(st, timelineKeyOf("scribble", timeline))
    XCTAssertEqual(changed, [id])
    XCTAssertNil(st.shapes[id])
    XCTAssertEqual(st.shapes.count, 1)
    XCTAssertTrue(b.applyCanvasItems(st, timelineKeyOf("scribble", timeline)).isEmpty, "nothing new: nothing changes")
  }

  /// With a snapshot: the shapes it holds and the items after its frontier. A hub that leaves out an item after
  /// the frontier is caught by the core (`withheld`), and nothing is drawn. Opened again, the board this device
  /// made is the start (the same snapshot again would be `replay`).
  func testASnapshotAndTheItemsAfterItAndAWithheldItem() async throws {
    let (a, b, room) = try await roomOfTwo()
    let one = try draw(a, stroke(0))
    // A's snapshot at its first item: the core's own merge, packed, encrypted, named by the register.
    let file = try tools.boardReduce(snapshot: nil, snapshotFrontier: [], items: [BoardItemBody(sender: a.id, seq: one.seq, payload: stroke(0))], frontier: [one])
    let sealed = try tools.encryptFile(Self.gzipStored(file))
    PocketRoutes.files[b64u(sealed.fileId)] = Data(sealed.stored)
    let attachment: JV = ["file_id": .str(b64u(sealed.fileId)), "file_key": .str(b64u(sealed.fileKey)), "sha256": .str(b64u(sealed.sha256)),
                          "total_size": .n(file.count), "file_name": "board.json.gz", "media_type": "application/gzip"]
    let value: JV = ["attachment": attachment, "frontier": .obj([b64u(a.id): .arr([.n(Int(one.seq)), .str(b64u(one.hash))])]), "change": .n(Int(hub.change))]
    _ = try a.seal(.register(group: room, name: "board_snapshot/\(b64u(board))", value: value.encoded()), files: [], nowMs: nowMs())
    try hub.post(a)
    let two = try draw(a, stroke(100))
    // an item after the frontier that the hub does not serve on the board's route (B reads it in its changes)
    let three = try draw(a, stroke(200), served: false)
    let threeAt = lastChange
    _ = try await b.sync()
    do { _ = try await b.loadCanvas(timeline); XCTFail("withheld") } catch { XCTAssertEqual(Room.codeOf(error), "withheld") }

    // served whole: the snapshot's shape and the two after it
    PocketRoutes.boards[hex(board), default: []].append(threeAt)
    let st = try await b.loadCanvas(timeline)
    let ids: Set<String> = Set([one, two, three].map { "\(hex(a.id))/\($0.seq)/0" })
    XCTAssertEqual(Set(st.shapes.keys), ids)

    // opened again (the core holds that frontier as applied): the board kept on this device, and what came since
    let four = try draw(a, stroke(300))
    _ = try await b.sync()
    let again = try await b.loadCanvas(timeline)
    XCTAssertEqual(Set(again.shapes.keys), ids.union(["\(hex(a.id))/\(four.seq)/0"]))
  }

  /// A register's value in force is the core's: B writes the crown while A's later-counted writes are already at
  /// the hub; the core does not make B's current, and the board shows A's value, B's echo gone.
  func testTheRegisterInForceIsTheCores() async throws {
    let (a, b, room) = try await roomOfTwo()
    for v in ["a1", "a2", "a3"] {
      _ = try a.seal(.register(group: room, name: "crown", value: JV.str(v).encoded()), files: [], nowMs: nowMs())
      try hub.post(a)
    }
    try await b.setCrown(.str("b"))
    try await b.flush(timeoutMs: 10_000)
    _ = try await b.sync()
    let core = try await b.onCore { try $0.register(group: room, name: "crown") }
    XCTAssertEqual(core.flatMap { JV.parse($0) }?.string, "a3")
    XCTAssertEqual(b.board.human.crown.string, "a3")
    XCTAssertEqual(b.board.human.raw["crown"]?.pending, false)
    XCTAssertEqual(b.board.human.raw["crown"]?.value.string, "a3")
  }

  /// The hub's lists of groups and of Welcomes are read page by page to their end.
  func testGroupsAndWelcomesAreReadPageByPage() async throws {
    let (_, b, _) = try await roomOfTwo()
    for k in 1...3 { hub.infos[Bytes(repeating: UInt8(k), count: 48)] = [0: [1]] }
    let groups = try await b.hub.groups()
    XCTAssertEqual(groups.count, hub.infos.count)
    XCTAssertGreaterThan(groups.count, 3)
    hub.welcomes = [[1], [2], [3]]
    let welcomes = try await b.hub.welcomes()
    XCTAssertEqual(welcomes.compactMap { $0["welcome"] as? String }, [[1], [2], [3]].map { b64u($0) })
  }

  /// gzip with one stored block (no compression): what `gunzip` reads.
  static func gzipStored(_ data: Bytes) -> Bytes {
    precondition(data.count < 65_535)
    let n = UInt16(data.count)
    var out: Bytes = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff, 1, UInt8(n & 0xff), UInt8(n >> 8), UInt8(~n & 0xff), UInt8(~n >> 8)]
    out += data
    let crc = crc32(data), size = UInt32(data.count)
    for v in [crc, size] { out += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8(v >> 24)] }
    return out
  }
}
