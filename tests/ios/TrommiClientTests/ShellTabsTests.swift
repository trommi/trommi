import XCTest
@testable import TrommiClient

final class ShellTabsTests: XCTestCase {
  func testStartsOnTheDesk() {
    let t = ShellTabs()
    XCTAssertEqual(t.lit, .desk); XCTAssertEqual(t.page, .desk); XCTAssertFalse(t.noteOpen)
  }

  func testNoteLightsNoteAndKeepsThePageUnderIt() {
    for from in [ShellTab.desk, .chat] {
      var t = ShellTabs(from)
      XCTAssertFalse(t.tap(.note))
      XCTAssertEqual(t.lit, .note, "the lens is on Note while the note is open (from \(from))")
      XCTAssertEqual(t.page, from, "the page under the note stays")
      XCTAssertTrue(t.noteOpen)
      XCTAssertFalse(t.tap(.note))
      XCTAssertEqual(t.lit, from, "a second tap on Note closes it: back on the page under it")
      XCTAssertFalse(t.noteOpen)
    }
  }

  func testOpenedFromElsewhere() {
    // a drop, a share: select(.note), whatever is in front
    var t = ShellTabs(.chat)
    t.select(.note)
    XCTAssertEqual(t.lit, .note); XCTAssertEqual(t.page, .chat)
    t.select(.note)
    XCTAssertEqual(t.page, .chat, "opening it again does not forget the page under it")
    t.closeNote()
    XCTAssertEqual(t.lit, .chat)
    t.closeNote()
    XCTAssertEqual(t.lit, .chat, "closing a closed note changes nothing")
  }

  func testAPageTabLeavesTheNote() {
    var t = ShellTabs(.desk)
    t.select(.note)
    XCTAssertFalse(t.tap(.chat), "from the note to another page: no pop")
    XCTAssertEqual(t.lit, .chat); XCTAssertEqual(t.page, .chat); XCTAssertFalse(t.noteOpen)
    t.select(.note)
    XCTAssertFalse(t.tap(.chat), "the page under the note: the note closes, the page is not popped")
    XCTAssertEqual(t.lit, .chat)
    t.select(.note); t.closeNote()
    XCTAssertEqual(t.lit, .chat, "the page under it is the one he was on last")
  }

  func testTapOnThePageInFrontPops() {
    var t = ShellTabs(.desk)
    XCTAssertTrue(t.tap(.desk), "the page he is on: back to its root")
    XCTAssertFalse(t.tap(.chat))
    XCTAssertTrue(t.tap(.chat))
  }

  func testInitWithNote() {
    let t = ShellTabs(.note)
    XCTAssertEqual(t.lit, .note); XCTAssertEqual(t.page, .desk)
  }

  func testIndex() {
    XCTAssertEqual(ShellTab.allCases.map { ShellTabs.index($0) }, [0, 1, 2])
  }
}
