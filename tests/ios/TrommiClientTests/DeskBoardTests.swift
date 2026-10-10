// DeskBoardTests: which Scribble Board a desk has (README "Scribble Board"), and whose message a terminal-mirrored
// chat item is (README "The terminal mirror"). The board ids are the ones shared/scribble.ts deskBoard gives (computed
// with node from the shared code, 9 October 2026; shared/scribble-test.mjs holds the first five).
import Foundation
import XCTest
@testable import TrommiClient

final class DeskBoardTests: XCTestCase {
  func testADesksBoardIsTheSharedFold() {
    XCTAssertEqual(deskBoard("main"), "desk/6d61696e000000000000000000000004")
    XCTAssertEqual(deskBoard("main"), MAIN_BOARD)
    XCTAssertEqual(deskBoard(nil), MAIN_BOARD, "a room without desks draws on the board of 'main'")
    XCTAssertEqual(deskBoard(""), MAIN_BOARD)
    XCTAssertEqual(deskBoard("a1b2c3d4"), "desk/61316232633364340000000000000008", "a menu desk's 8 hex is folded")
    XCTAssertEqual(deskBoard("0123456789abcdef0123456789abcdef"), "desk/0123456789abcdef0123456789abcdef", "32 hex is taken as it is")
    XCTAssertEqual(deskBoard("0123456789ABCDEF0123456789abcdef"), "desk/00000000000000000000202020202000", "upper case is not hex here: folded")
    XCTAssertEqual(deskBoard("x"), "desk/78000000000000000000000000000001")
    XCTAssertEqual(deskBoard("ä desk with a long name, longer than sixteen bytes"), "desk/f8db5c256532752c233d7d6220262754")
    XCTAssertEqual(deskBoard("Büro 🛠"), "desk/42c3bc726f20f09f9ba000000000000a")
  }

  func testAllDesksHasABoardOfItsOwn() {
    XCTAssertEqual(ALL_BOARD, "desk/616c6c2d6465736b7300000000000009")
    XCTAssertEqual(deskBoard("all-desks"), ALL_BOARD)
    XCTAssertEqual(deskBoard(ALL_DESKS), "desk/616c6c00000000000000000000000003")
    XCTAssertNotEqual(deskBoard(ALL_DESKS), ALL_BOARD, "the board 'All' had before 8 October is not read again")
  }

  func testTheViewPicksTheBoard() throws {
    let d = DeskModel(board: Board())
    XCTAssertEqual(d.view(desk: nil).board, MAIN_BOARD, "no desks yet")
    XCTAssertEqual(d.view(desk: ALL_DESKS).board, MAIN_BOARD, "All desks is a view only with two desks or more")
    let b = Board()
    b.human.desks = ["main": ["name": "Main", "created_at": 1], "a1b2c3d4": ["name": "Büro", "created_at": 2]]
    let two = DeskModel(board: b)
    XCTAssertEqual(two.view(desk: ALL_DESKS).board, ALL_BOARD)
    XCTAssertEqual(two.view(desk: "main").board, MAIN_BOARD)
    XCTAssertEqual(two.view(desk: "a1b2c3d4").board, "desk/61316232633364340000000000000008")
    XCTAssertEqual(two.view(desk: nil).board, MAIN_BOARD, "no desk chosen: the first")
  }

  // ---- the terminal mirror ----

  func testAnAgentsTerminalInputIsHisMessage() {
    let s = DeskModel.speaker(human: false, content: .obj(["content_type": "message", "text": "weiter", "terminal": "input"]))
    XCTAssertEqual(s.from, "user"); XCTAssertEqual(s.terminal, "input")
  }

  func testTerminalFromAHumanDeviceCountsForNothing() {
    for t in ["input", "answer"] {
      let s = DeskModel.speaker(human: true, content: .obj(["text": "x", "terminal": .str(t)]))
      XCTAssertEqual(s.from, "user"); XCTAssertNil(s.terminal)
    }
  }

  func testAnAgentsTerminalAnswerIsTheAgents() {
    let s = DeskModel.speaker(human: false, content: .obj(["text": "Fertig.", "terminal": "answer"]))
    XCTAssertEqual(s.from, "agent"); XCTAssertEqual(s.terminal, "answer")
    let plain = DeskModel.speaker(human: false, content: .obj(["text": "Hi"]))
    XCTAssertEqual(plain.from, "agent"); XCTAssertNil(plain.terminal)
    let odd = DeskModel.speaker(human: false, content: .obj(["text": "Hi", "terminal": "else"]))
    XCTAssertEqual(odd.from, "agent"); XCTAssertNil(odd.terminal, "a value this app does not know is no mark")
  }

  func testTheChatListSaysYouBeforeATerminalLine() {
    var m = Message(id: "e7", seq: 7, agent: "a", from: "agent", text: "mach weiter mit dem Build", ts: 7)
    let s = DeskModel.speaker(human: false, content: .obj(["terminal": "input"]))
    m.from = s.from; m.terminal = s.terminal
    XCTAssertEqual(ChatTeaser.of([Message(id: "e6", seq: 6, agent: "a", from: "agent", text: "Hi", ts: 6), m]).text, "You: mach weiter mit dem Build")
  }
}
