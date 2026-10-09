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
  func testNothingOpen() {
    let t = DeskTools([])
    XCTAssertFalse(t.showsBlitz); XCTAssertFalse(t.showsDuck); XCTAssertEqual(t.walk, 0)
  }
}
