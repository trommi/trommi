// SessionNameTests: the name a session shows in the chat list, in the web's order (app.mjs agents()): the human's
// rename, else the name the agent gave it (profile `agent_name`), else its device's name (the folder), and only then
// a short id. Also for a session whose agent device is no member here any more, and for a device the room does not
// enrol (every non-human leaf of a session group is its agent, as on the web).
import Foundation
import XCTest
@testable import TrommiClient

final class SessionNameTests: XCTestCase {
  let human = String(repeating: "a", count: 64)
  let agent = String(repeating: "b", count: 64)
  let sid = String(repeating: "c", count: 32)

  private func rec(_ n: Int, from: String, role: String, session: String?, values: [String: JV], epoch: Int = 1) -> Rec {
    Rec(envelopeNumber: n, envelopeHash: String(format: "%064x", n), senderDeviceId: from, senderRole: role, recipientDeviceId: nil, sentAt: UInt64(1_000_000 + n),
        kind: KIND.STATUS, isHead: true, object: nil, timelineKind: nil, timelineId: nil, sessionId: session, content: .obj(["values": .obj(values)]), contentState: "ok",
        bind: nil, causal: Causal(senderDeviceId: from, senderSequence: UInt64(n), sentAt: UInt64(n), lamport: n), senderSequence: UInt64(n), epoch: epoch)
  }
  /** A room with one human device (this one) and one agent device in one main session. */
  private func board() -> Board {
    let b = Board()
    b.myDeviceId = human
    var ch = Change()
    b.applyMembers([(id: human, role: "human", active: true, added: 0, removed: nil), (id: agent, role: "agent", active: true, added: 1, removed: nil)], change: &ch)
    b.applySession(sessionId: sid, agentIds: [agent], epoch: 1, parentSessionId: nil, archived: false, change: &ch)
    return b
  }
  private func name(_ b: Board) throws -> String {
    b.project()
    return try XCTUnwrap(DeskModel(board: b).agents.first { $0.sessionId == sid }).name
  }
  private func folder(_ name: String) -> JV { .obj(["device_name": .str(name), "platform": "claude-code", "folder": .str("~/git/\(name)"), "host": "desk"]) }

  func testIntroducedNameWithoutRename() throws {
    let b = board()
    var ch = Change()
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": folder("socom")]), change: &ch)
    b.apply(rec(2, from: agent, role: "agent", session: sid, values: ["profile": ["model": "claude-opus-5-5", "task": "Sockets", "agent_name": "Socom agent"]]), change: &ch)
    XCTAssertEqual(try name(b), "Socom agent", "the agent's introduced name")
  }

  func testRenameWinsOverIntroducedName() throws {
    let b = board()
    var ch = Change()
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["profile": ["model": "m", "agent_name": "Socom agent"]]), change: &ch)
    b.apply(rec(2, from: human, role: "human", session: nil, values: ["session/\(sid)": ["name": "trommi"]]), change: &ch)
    XCTAssertEqual(try name(b), "trommi", "the human's rename")
  }

  func testFolderNameWhenNothingIntroduced() throws {
    let b = board()
    var ch = Change()
    XCTAssertEqual(try name(b), String(sid.prefix(SESSION_ID_LEN)), "nothing known: the short id")
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": folder("socom")]), change: &ch)
    XCTAssertEqual(try name(b), "socom", "the device register's name (its folder)")
  }

  func testIntroduceAfterJoiningReachesTheName() throws {
    let b = board()
    var ch = Change()
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": folder("socom")]), change: &ch)
    XCTAssertEqual(try name(b), "socom")
    // a later epoch (another device joined), then the agent's introduce
    b.applySession(sessionId: sid, agentIds: [agent], epoch: 2, parentSessionId: nil, archived: false, change: &ch)
    b.apply(rec(2, from: agent, role: "agent", session: sid, values: ["profile": ["model": "m", "task": "t", "agent_name": "Sockets"]], epoch: 2), change: &ch)
    XCTAssertEqual(try name(b), "Sockets")
  }

  /** An agent that left: its device is no member, the session has no seat; its device register still names it. */
  func testGoneAgentKeepsItsFolderName() throws {
    let b = Board()
    b.myDeviceId = human
    var ch = Change()
    b.applyMembers([(id: human, role: "human", active: true, added: 0, removed: nil)], change: &ch)
    b.applySession(sessionId: sid, agentIds: [], epoch: 3, parentSessionId: nil, archived: false, change: &ch)
    b.sawAgent(sid, agent, epoch: 1)
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": folder("old-site")]), change: &ch)
    XCTAssertEqual(try name(b), "old-site")
  }

  /** A device register with no `device_name`: the last part of its folder. */
  func testFolderWhenNoDeviceName() throws {
    let b = board()
    var ch = Change()
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": ["folder": "~/git/socom", "platform": "claude-code"]]), change: &ch)
    XCTAssertEqual(try name(b), "socom")
  }

  /** Every non-human leaf of a session group sits in it, enrolled or not; a helper session's opener is the enrolled one. */
  func testSeatsAsTheWeb() {
    let h = Set([human]), helper = String(repeating: "d", count: 64)
    XCTAssertEqual(Board.seats(leaves: [human, agent], humans: h, enrolled: [], helper: false).agents, [agent], "a device the room does not enrol still sits")
    let s = Board.seats(leaves: [human, agent, helper], humans: h, enrolled: [agent], helper: true)
    XCTAssertEqual(s.opener, agent)
    XCTAssertEqual(s.agents.first, helper, "a helper session speaks with its helper device")
    XCTAssertEqual(Board.seats(leaves: [human, helper, agent], humans: h, enrolled: [agent], helper: false).agents.first, agent, "a main session speaks with its enrolled agent")
  }

  /** A helper session whose own device gave no name shows its opener's, as on the web. */
  func testHelperShowsOpenersFolder() throws {
    let b = board()
    var ch = Change()
    let child = String(repeating: "e", count: 32), helper = String(repeating: "d", count: 64)
    b.apply(rec(1, from: agent, role: "agent", session: sid, values: ["device/\(agent)": folder("socom")]), change: &ch)
    b.applyMembers([(id: human, role: "human", active: true, added: 0, removed: nil), (id: agent, role: "agent", active: true, added: 1, removed: nil), (id: helper, role: "agent", active: true, added: 1, removed: nil)], change: &ch)
    b.applySession(sessionId: child, agentIds: [helper, agent], epoch: 1, parentSessionId: sid, archived: false, opener: agent, change: &ch)
    b.project()
    XCTAssertEqual(DeskModel(board: b).agents.first { $0.sessionId == child }?.name, "socom")
  }
}
