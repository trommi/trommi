// DemoTests: the web demo's room (demo/data/fixture.json) as a board, read where the web keeps it: the same
// sessions, cards, conversations and desks the web demo shows, its times moved to now.
import Foundation
import XCTest
@testable import TrommiClient

final class DemoTests: XCTestCase {
  /** The repository's root: the first folder above this file that holds demo/data. */
  func repoRoot() throws -> URL {
    var repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while repo.path != "/", !FileManager.default.fileExists(atPath: repo.appendingPathComponent("demo/data/fixture.json").path) { repo = repo.deletingLastPathComponent() }
    return repo
  }
  func fixtureData() throws -> Data { try Data(contentsOf: try repoRoot().appendingPathComponent("demo/data/fixture.json")) }

  func testTheDemoRoomIsABoard() throws {
    let data = try fixtureData()
    let raw = JV.parse(Array(data))!
    // The demo room is shared with the web app (demo/data). The app's demo has no hub and no core state: what it
    // shows is this file alone, so an empty room would be an empty demo.
    XCTAssertFalse(raw["sessions"].array?.isEmpty ?? true, "demo/data/fixture.json has agent sessions")
    XCTAssertFalse(raw["cards"].array?.isEmpty ?? true, "demo/data/fixture.json has cards")
    let now = nowMs()
    let b = try DemoFixture.board(data, now: now)
    XCTAssertEqual(b.members.count, raw["members"].array!.count)
    XCTAssertEqual(b.cards.count, raw["cards"].array!.count)
    XCTAssertEqual(b.published.count, raw["published"].array!.count)
    XCTAssertEqual(b.timelines.count, raw["timelines"].object!.count)
    let d = DeskModel(board: b)
    XCTAssertEqual(d.agents.count, raw["sessions"].array!.count)
    XCTAssertEqual(Set(d.desks.map { $0.id }), ["main", "platform"])
    XCTAssertNotNil(d.byAgent["fernly-web"])
    XCTAssertEqual(d.byAgent["landing-page"]?.parent, "fernly-web", "a helper sits under its main session")
    let desk = d.view(desk: "main", now: now)
    XCTAssertFalse(desk.fresh.isEmpty, "the Desk has open questions")
    XCTAssertFalse(desk.units.isEmpty, "the Desk shows the agents")
    // every file a card or a page names is in demo/data/files (the app reads them from there, DemoMode.swift)
    let files = try FileManager.default.contentsOfDirectory(atPath: try repoRoot().appendingPathComponent("demo/data/files").path)
    let named = Set(String(decoding: data, as: UTF8.self).components(separatedBy: "/demo/files/").dropFirst().compactMap { $0.split(separator: "\"").first.map(String.init) })
    XCTAssertFalse(named.isEmpty)
    XCTAssertTrue(named.isSubset(of: Set(files)), "missing: \(named.subtracting(files))")
    XCTAssertGreaterThan(d.messagesOf(agent: "fernly-web").filter { $0.from != "event" }.count, 5)
    // the times are now's: the newest card is minutes old, not days
    let newest = b.cards.values.map { $0.updatedAt }.max()!
    XCTAssertLessThan(now - min(now, newest), 24 * 3_600_000)
  }

  func testTimesShiftOnlyStamps() {
    let v = JV.obj(["sent_at": .num(1_700_000_000_000), "envelope_number": .num(1_700_000_000_000), "until": .num(1_700_000_000_000), "x": .arr([.obj(["created_at": .num(1_700_000_000_000)])])])
    let s = DemoFixture.shift(v, by: 1000)
    XCTAssertEqual(s["sent_at"].double, 1_700_000_001_000)
    XCTAssertEqual(s["until"].double, 1_700_000_001_000)
    XCTAssertEqual(s["envelope_number"].double, 1_700_000_000_000)
    XCTAssertEqual(s["x"][0]["created_at"].double, 1_700_000_001_000)
  }
}
