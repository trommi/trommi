// DeskToolsTests: when the Desk shows Blitz and the duck for all, and what each acts on (Desk.swift DeskTools).
import Foundation
import XCTest
@testable import TrommiClient

final class DeskToolsTests: XCTestCase {
  func testOnlyInfos() {
    let t = DeskTools([(id: "a", kind: "info"), (id: "b", kind: "info")])
    XCTAssertTrue(t.showsBlitz); XCTAssertEqual(t.walk, 2, "Blitz walks the infos too")
    XCTAssertTrue(t.showsDuck); XCTAssertEqual(t.duck, []); XCTAssertEqual(t.read, ["a", "b"], "the duck marks them read")
  }
  func testMixed() {
    let t = DeskTools([(id: "d", kind: "decision"), (id: "i", kind: "info"), (id: "p", kind: "permission"), (id: "e", kind: "decision")])
    XCTAssertEqual(t.walk, 4, "the count is of every open card")
    XCTAssertEqual(t.duck, ["d", "e"]); XCTAssertEqual(t.read, ["i"])
    XCTAssertFalse(t.duck.contains("p") || t.read.contains("p"), "a permission request is never answered by the duck")
  }
  func testOnlyPermissions() {
    let t = DeskTools([(id: "p", kind: "permission")])
    XCTAssertTrue(t.showsBlitz); XCTAssertEqual(t.walk, 1)
    XCTAssertFalse(t.showsDuck, "nothing for the duck to act on")
  }
  /** The confirmation's words are the web's (desk.mjs duckAll): one short line, the counts only as the hint. */
  func testDuckWords() {
    let open = { (d: Int, i: Int) in DeskTools((0..<d).map { (id: "d\($0)", kind: "decision") } + (0..<i).map { (id: "i\($0)", kind: "info") }).duckWords }
    var w = open(28, 11)
    XCTAssertEqual(w.ask, "Duck all 39?"); XCTAssertEqual(w.yes, "Yes, duck them all")
    XCTAssertEqual(w.what, "28 decisions go to the agents, 11 cards to read are closed"); XCTAssertEqual(w.tip, "I don’t give a duck: for all 39 open cards")
    w = open(0, 11)
    XCTAssertEqual(w.ask, "Close all 11 as read?"); XCTAssertEqual(w.yes, "Yes, all read")
    XCTAssertEqual(w.what, "11 cards to read are closed"); XCTAssertEqual(w.tip, "I don’t give a duck: close all 11 cards to read")
    w = open(1, 0)
    XCTAssertEqual(w.ask, "Duck it?"); XCTAssertEqual(w.yes, "Yes, duck it")
    XCTAssertEqual(w.what, "1 decision goes to the agents"); XCTAssertEqual(w.tip, "I don’t give a duck: for the one open decision")
    w = open(0, 1)
    XCTAssertEqual(w.ask, "Close it as read?"); XCTAssertEqual(w.yes, "Yes, read")
    XCTAssertEqual(w.what, "1 card to read is closed"); XCTAssertEqual(w.tip, "I don’t give a duck: close the one card to read")
    w = open(1, 1)
    XCTAssertEqual(w.ask, "Duck all 2?"); XCTAssertEqual(w.what, "1 decision goes to the agents, 1 card to read is closed")
    XCTAssertEqual(open(3, 0).tip, "I don’t give a duck: for all 3 open decisions")
  }
  func testNothingOpen() {
    let t = DeskTools([])
    XCTAssertFalse(t.showsBlitz); XCTAssertFalse(t.showsDuck); XCTAssertEqual(t.walk, 0)
  }
}
