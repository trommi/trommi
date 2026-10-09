// The device's store against the contract of core/src/store.rs: durable and whole, one owner, the revision.
import XCTest
@testable import TrommiClient

final class DeviceStoreTests: XCTestCase {
  var dir: URL!
  let key = Bytes(repeating: 7, count: 32)
  override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("trommi-store-\(UUID().uuidString)") }
  override func tearDown() { try? FileManager.default.removeItem(at: dir) }

  func entry(_ k: UInt8, _ v: String) -> StoreEntry { StoreEntry(key: [k], value: Array(v.utf8)) }
  func sorted(_ l: StoreLoaded) -> [String] { l.entries.sorted { $0.key.lexicographicallyPrecedes($1.key) }.map { "\($0.key[0])=\(String(decoding: $0.value, as: UTF8.self))" } }

  func testBatchesSurviveReopeningInOrder() throws {
    var s = try DeviceStore(directory: dir, key: key)
    XCTAssertEqual(try s.load(), StoreLoaded(revision: 0, entries: []))
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a"), entry(2, "b")]))
    // deletions first, then puts; of two puts of one key the later counts
    try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(1, "x"), entry(1, "c")], delete: [[2], [1], [9]]))
    s.close()
    s = try DeviceStore(directory: dir, key: key)
    let l = try s.load()
    XCTAssertEqual(l.revision, 2)
    XCTAssertEqual(sorted(l), ["1=c"])
  }

  func testAWrongRevisionWritesNothing() throws {
    let s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")]))
    XCTAssertThrowsError(try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "b")]))) { XCTAssertEqual($0 as? StoreError, .conflict) }
    XCTAssertThrowsError(try s.apply(expectedRevision: 5, batch: StoreBatch(put: [entry(1, "b")]))) { XCTAssertEqual($0 as? StoreError, .conflict) }
    s.close()
    let again = try DeviceStore(directory: dir, key: key)
    XCTAssertEqual(sorted(try again.load()), ["1=a"])
  }

  func testOneOwnerAtATime() throws {
    let s = try DeviceStore(directory: dir, key: key)
    XCTAssertThrowsError(try DeviceStore(directory: dir, key: key)) { XCTAssertEqual($0 as? StoreError, .failed("busy")) }
    s.close()
    XCTAssertNoThrow(try DeviceStore(directory: dir, key: key).close())
    // a closed store writes nothing
    XCTAssertThrowsError(try s.apply(expectedRevision: 0, batch: StoreBatch()))
  }

  func testARecordCutShortByACrashIsDropped() throws {
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")]))
    try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(2, "b")]))
    s.close()
    let log = dir.appendingPathComponent("state.log")
    let whole = try Data(contentsOf: log)
    for cut in [1, 3, 20] {
      try whole.dropLast(cut).write(to: log)
      s = try DeviceStore(directory: dir, key: key)
      let l = try s.load()
      XCTAssertEqual(l.revision, 1, "cut \(cut)")
      XCTAssertEqual(sorted(l), ["1=a"])
      // and the next batch stands behind a whole record
      try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(3, "c")]))
      s.close()
      s = try DeviceStore(directory: dir, key: key)
      XCTAssertEqual(sorted(try s.load()), ["1=a", "3=c"])
      s.close()
      try whole.write(to: log)
    }
  }

  func testADamagedRecordInTheMiddleIsNotSkipped() throws {
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    for i in 0..<3 { try s.apply(expectedRevision: UInt64(i), batch: StoreBatch(put: [entry(UInt8(i), "v")])) }
    s.close()
    let log = dir.appendingPathComponent("state.log")
    var bytes = Bytes(try Data(contentsOf: log))
    bytes[40] ^= 1   // inside the first record
    try Data(bytes).write(to: log)
    s = try DeviceStore(directory: dir, key: key)
    XCTAssertThrowsError(try s.load())
    s.close()
  }

  func testAnotherKeyOpensNothing() throws {
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")]))
    try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(2, "b")]))
    s.close()
    s = try DeviceStore(directory: dir, key: Bytes(repeating: 8, count: 32))
    XCTAssertThrowsError(try s.load())
    s.close()
  }

  func testTheLogIsFoldedIntoASnapshot() throws {
    let was = DeviceStore.compactAbove
    DeviceStore.compactAbove = 2000
    defer { DeviceStore.compactAbove = was }
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    for i in 0..<40 { try s.apply(expectedRevision: UInt64(i), batch: StoreBatch(put: [StoreEntry(key: [UInt8(i % 5)], value: Bytes(repeating: UInt8(i), count: 100))], delete: i == 39 ? [[0]] : [])) }
    s.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("state.snap").path))
    XCTAssertLessThan(try Data(contentsOf: dir.appendingPathComponent("state.log")).count, 2200)
    s = try DeviceStore(directory: dir, key: key)
    let l = try s.load()
    XCTAssertEqual(l.revision, 40)
    XCTAssertEqual(Set(l.entries.map { $0.key[0] }), [1, 2, 3, 4])
    XCTAssertEqual(l.entries.first { $0.key == [3] }?.value.first, 38)
    s.close()
  }

  func testRecordsTheSnapshotAlreadyHoldsAreSkipped() throws {
    // a crash between the snapshot's rename and the emptying of the log
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    for i in 0..<4 { try s.apply(expectedRevision: UInt64(i), batch: StoreBatch(put: [entry(UInt8(i), "v\(i)")])) }
    let log = try Data(contentsOf: dir.appendingPathComponent("state.log"))
    try s.compact()
    s.close()
    try log.write(to: dir.appendingPathComponent("state.log"))
    s = try DeviceStore(directory: dir, key: key)
    let l = try s.load()
    XCTAssertEqual(l.revision, 4)
    XCTAssertEqual(sorted(l), ["0=v0", "1=v1", "2=v2", "3=v3"])
    try s.apply(expectedRevision: 4, batch: StoreBatch(delete: [[0]]))
    s.close()
    s = try DeviceStore(directory: dir, key: key)
    XCTAssertEqual(try s.load().revision, 5)
    s.close()
  }

  func testRecordsCannotChangePlaces() throws {
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")]))
    try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(1, "b")]))
    try s.apply(expectedRevision: 2, batch: StoreBatch(put: [entry(1, "c")]))
    s.close()
    // the second and third record swapped: a gap in the revisions
    let log = dir.appendingPathComponent("state.log")
    let b = Bytes(try Data(contentsOf: log))
    var at = 0, parts = [Bytes]()
    while at < b.count { let n = Int(readBe32(b, at)); parts.append(Bytes(b[at..<(at + 8 + n)])); at += 8 + n }
    try Data(parts[0] + parts[2] + parts[1]).write(to: log)
    s = try DeviceStore(directory: dir, key: key)
    XCTAssertThrowsError(try s.load())
    s.close()
  }

  final class MemoryAnchor: StateAnchor {
    var value: UInt64?
    var fail = false
    func read() throws -> UInt64? { if fail { throw TrommiError("keychain") }; return value }
    func write(_ revision: UInt64) throws { if fail { throw TrommiError("keychain") }; value = revision }
  }
  func outbox(_ id: UInt8) -> StoreEntry { StoreEntry(key: [DeviceStore.outboxTable, id], value: [1]) }

  func testAnOlderStatePutBackDoesNotLoad() throws {
    let anchor = MemoryAnchor()
    var s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")]))
    XCTAssertNil(anchor.value, "a batch that signs nothing does not move the anchor")
    let old = try Data(contentsOf: dir.appendingPathComponent("state.log"))
    try s.apply(expectedRevision: 1, batch: StoreBatch(put: [outbox(1)]))
    XCTAssertEqual(anchor.value, 2, "a batch with something to send does, before it is answered")
    try s.apply(expectedRevision: 2, batch: StoreBatch(put: [entry(2, "b")]))
    s.close()
    // the log from before the outbox entry, put back: authentic, and refused
    let now = try Data(contentsOf: dir.appendingPathComponent("state.log"))
    try old.write(to: dir.appendingPathComponent("state.log"))
    s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    XCTAssertThrowsError(try s.load())
    s.close()
    // only the batch above the anchor dropped: loads (it signed nothing; the hub gives its items again)
    try now.dropLast(10).write(to: dir.appendingPathComponent("state.log"))
    s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    XCTAssertEqual(try s.load().revision, 2)
    s.close()
    // an anchor that cannot be read is not "no anchor"
    anchor.fail = true
    s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    XCTAssertThrowsError(try s.load())
    s.close()
  }

  func testAnAnsweredLastRecordThatDoesNotOpenIsDamageNotATornTail() throws {
    let anchor = MemoryAnchor()
    var s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    _ = try s.load()
    try s.apply(expectedRevision: 0, batch: StoreBatch(put: [outbox(1)]))
    s.close()
    let log = dir.appendingPathComponent("state.log")
    var b = Bytes(try Data(contentsOf: log)); b[b.count - 1] ^= 1
    try Data(b).write(to: log)
    s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    XCTAssertThrowsError(try s.load())
    s.close()
    XCTAssertEqual(Bytes(try Data(contentsOf: log)), b, "nothing is cut off a state that did not load")
  }

  func testDamageIsNotTakenForTheEndOfTheLog() throws {
    var s = try DeviceStore(directory: dir, key: key)
    _ = try s.load()
    for i in 0..<3 { try s.apply(expectedRevision: UInt64(i), batch: StoreBatch(put: [entry(UInt8(i), "v")])) }
    s.close()
    let log = dir.appendingPathComponent("state.log")
    let whole = Bytes(try Data(contentsOf: log))
    // a length in the middle made larger than the rest of the file
    var b = whole; b[1] ^= 0x40
    try Data(b).write(to: log)
    s = try DeviceStore(directory: dir, key: key); XCTAssertThrowsError(try s.load()); s.close()
    // a record's revision written down (it would be skipped as "already in the snapshot" if it were believed)
    b = whole; b[15] = 0
    try Data(b).write(to: log)
    s = try DeviceStore(directory: dir, key: key); XCTAssertThrowsError(try s.load()); s.close()
    // zeros behind the last whole record (a file grown by a power cut before its data came): the end of the log
    try Data(whole + Bytes(repeating: 0, count: 300)).write(to: log)
    s = try DeviceStore(directory: dir, key: key)
    XCTAssertEqual(try s.load().revision, 3)
    try s.apply(expectedRevision: 3, batch: StoreBatch(put: [entry(9, "z")]))
    s.close()
    s = try DeviceStore(directory: dir, key: key); XCTAssertEqual(try s.load().revision, 4); s.close()
  }

  func testAfterAFailedAnchorNothingMoreIsWritten() throws {
    let anchor = MemoryAnchor()
    let s = try DeviceStore(directory: dir, key: key, anchor: anchor)
    _ = try s.load()
    anchor.fail = true
    XCTAssertThrowsError(try s.apply(expectedRevision: 0, batch: StoreBatch(put: [outbox(1)])))
    anchor.fail = false
    XCTAssertThrowsError(try s.apply(expectedRevision: 1, batch: StoreBatch(put: [entry(1, "a")])))
    XCTAssertThrowsError(try s.apply(expectedRevision: 0, batch: StoreBatch(put: [entry(1, "a")])))
    s.close()
  }
}
