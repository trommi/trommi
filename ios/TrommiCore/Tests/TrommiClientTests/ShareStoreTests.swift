import XCTest
import TrommiCore
@testable import TrommiClient

final class ShareStoreTests: XCTestCase {
  func testKeepsTheLinkUntilItRunsOutOrIsStopped() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shares-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let key = systemRandom(32), now: UInt64 = 1_791_000_000_000, day: UInt64 = 86_400_000
    let a = SharedLink(shareId: "s1", attachmentId: "att", link: "https://app.trommi.com/a/s1#x.y.z", expiresAt: now + 30 * day - 60_000)
    let store = ShareStore(dir: dir, key: key)
    XCTAssertNil(store.live("att", now: now))
    try store.put(a, now: now)
    // the same link while it holds: on this run and after a restart
    XCTAssertEqual(store.live("att", now: now), a)
    XCTAssertEqual(ShareStore(dir: dir, key: key).live("att", now: now + 29 * day), a)
    XCTAssertNil(store.live("other", now: now))
    // 30 days at first, counted down, never 0 while it holds
    XCTAssertEqual(a.daysLeft(now: now), 30)
    XCTAssertEqual(a.daysLeft(now: now + 29 * day), 1)
    XCTAssertEqual(a.daysLeft(now: now + 30 * day - 61_000), 1)
    // run out: no link any more (the next Copy link makes a new one)
    XCTAssertNil(store.live("att", now: now + 30 * day))
    XCTAssertEqual(a.daysLeft(now: now + 30 * day), 0)
    // the file on disk shows nothing of the link, and another key opens nothing
    let raw = try Data(contentsOf: dir.appendingPathComponent("shares.bin"))
    XCTAssertNil(raw.range(of: Data("app.trommi.com".utf8)))
    XCTAssertNil(ShareStore(dir: dir, key: systemRandom(32)).live("att", now: now))
    // stopped: gone, also after a restart
    try store.remove(shareId: "s1")
    XCTAssertNil(store.live("att", now: now))
    XCTAssertTrue(ShareStore(dir: dir, key: key).all("att").isEmpty)
  }
}
