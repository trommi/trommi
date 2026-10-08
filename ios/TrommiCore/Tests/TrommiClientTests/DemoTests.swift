// DemoTests: the web demo's room (app/web/public/demo/fixture.json) as a board, read where the web keeps it: the same
// sessions, cards, conversations and desks the web demo shows, its times moved to now.
import Foundation
import XCTest
@testable import TrommiClient
import TrommiCore

final class DemoTests: XCTestCase {
  func fixtureData() throws -> Data {
    let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../..").standardizedFileURL
    return try Data(contentsOf: repo.appendingPathComponent("app/web/public/demo/fixture.json"))
  }

  func testTheDemoRoomIsABoard() throws {
    let data = try fixtureData()
    let raw = JV.parse(Array(data))!
    let now = nowMs()
    let b = try DemoFixture.board(data, now: now)
    XCTAssertEqual(b.members.count, raw["members"].array!.count)
    XCTAssertEqual(b.cards.count, raw["cards"].array!.count)
    XCTAssertEqual(b.published.count, raw["published"].array!.count)
    XCTAssertEqual(b.timelines.count, raw["timelines"].object!.count)
    let d = DeskModel(board: b)
    XCTAssertEqual(d.agents.count, raw["sessions"].array!.count)
    XCTAssertEqual(Set(d.desks.map { $0.id }), ["main", "test"])
    XCTAssertNotNil(d.byAgent["trommi"])
    XCTAssertEqual(d.byAgent["trommi-ui"]?.parent, "trommi", "a helper sits under its main session")
    XCTAssertFalse(d.view(desk: "main", now: now).fresh.isEmpty, "the Desk has open questions")
    XCTAssertGreaterThan(d.messagesOf(agent: "trommi").filter { $0.from != "event" }.count, 5)
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
