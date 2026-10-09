// UnitStackTests: a main session's helpers as the folded stack of the web's sidebar (sidebar.mjs row: EDGES, the
// stopped ones first; app.mjs summary: the main's "whole").
import Foundation
import XCTest
@testable import TrommiClient

final class UnitStackTests: XCTestCase {
  func unit(_ id: String, open: Int = 0, online: Bool = true, running: Bool = false, stuck: Bool = false, blocked: Bool = false, parent: String? = nil) -> DeskUnit {
    let a = Agent(id: id, deviceId: id, given: id, name: id, label: "", icon: "", mark: id, online: online, model: "", task: "", starred: false, parent: parent,
                  main: parent == nil, archived: false, position: 0, seen: 0, active: 0, deviceActive: 0, removed: false, own: false)
    return DeskUnit(id: id, agent: a, open: open, online: online, running: running, stuck: stuck, blocked: blocked ? (why: "cut", text: "cut off") : nil, parent: parent)
  }

  func testAFewHelpersLieInTheirOrder() {
    let subs = [unit("a", parent: "m"), unit("b", blocked: true, parent: "m"), unit("c", running: true, parent: "m")]
    let s = UnitStack(main: unit("m"), subs: subs)
    XCTAssertEqual(s.lie.map { $0.id }, ["a", "b", "c"], "up to seven: every helper, in its order")
    XCTAssertEqual(s.count, 3)
    XCTAssertEqual(s.working, 1)
    XCTAssertEqual(s.waiting, 1)
  }

  func testMoreThanSevenTheStoppedFirst() {
    var subs = (0..<10).map { unit("h\($0)", parent: "m") }
    subs[8] = unit("h8", blocked: true, parent: "m")
    subs[9] = unit("h9", blocked: true, parent: "m")
    let s = UnitStack(main: unit("m"), subs: subs)
    XCTAssertEqual(s.lie.map { $0.id }, ["h8", "h9", "h0", "h1", "h2", "h3", "h4"], "the stopped ones first, the others in their order, seven in all")
    XCTAssertEqual(s.count, 10, "the count is of all helpers, not of the drawings")
  }

  func testTheWholeCountsTheHelpersIn() {
    let main = unit("m", open: 1, online: false)
    let subs = [unit("a", open: 2, running: true, parent: "m"), unit("b", online: false, running: true, stuck: true, parent: "m"), unit("c", blocked: true, parent: "m")]
    let s = UnitStack(main: main, subs: subs)
    XCTAssertEqual(s.whole.id, "m")
    XCTAssertEqual(s.whole.open, 3)
    XCTAssertTrue(s.whole.online, "one of them is connected")
    XCTAssertTrue(s.whole.running, "one of them works")
    XCTAssertTrue(s.whole.stuck)
    XCTAssertEqual(s.whole.blocked?.why, "cut", "a stopped helper does not hide in the fold")
    XCTAssertEqual(s.working, 1, "a helper that is not connected does not work")
    XCTAssertEqual(s.waiting, 2, "an open question or a stop waits on him")
  }

  func testUnreadWordsWait() {
    let s = UnitStack(main: unit("m"), subs: [unit("a", parent: "m"), unit("b", parent: "m")], unread: { $0.id == "b" })
    XCTAssertEqual(s.waiting, 1)
    XCTAssertNil(s.whole.blocked)
    XCTAssertFalse(s.whole.running)
  }

  func testAMainAloneIsItself() {
    let s = UnitStack(main: unit("m", open: 2, running: true), subs: [])
    XCTAssertTrue(s.lie.isEmpty)
    XCTAssertEqual(s.whole.open, 2)
    XCTAssertTrue(s.whole.running)
  }
}
