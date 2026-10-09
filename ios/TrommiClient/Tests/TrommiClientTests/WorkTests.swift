// WorkTests: a turn's trail (README "The trail"). The fold and the anchor are ports of shared/work.ts; the cases are
// those of shared/test.mjs "trail: the envelopes of a turn …", value for value. Then what the app makes of a chat
// that holds a trail: one message per turn where Work.anchor says, nothing to read, nothing for a preview.
import Foundation
import XCTest
@testable import TrommiClient

final class WorkTests: XCTestCase {
  let e1: JV = ["turn": "a1b2", "seq": 1, "state": "running", "started_at": 1000, "items": [
    ["id": "say:1", "kind": "text", "text": "I look first.", "at": 1100],
    ["id": "toolu_1", "kind": "step", "tool": "Read", "subject": "a.rs", "state": "running", "at": 1200],
  ]]
  let e2: JV = ["turn": "a1b2", "seq": 2, "state": "running", "started_at": 1000, "items": [
    ["id": "toolu_1", "kind": "step", "tool": "Read", "subject": "a.rs", "state": "ok", "at": 1200, "ms": 12],
    ["id": "agent:x", "kind": "helper", "tool": "Explore", "title": "Find it", "state": "running", "at": 1300, "steps": 2],
    ["id": "toolu_2", "kind": "step", "tool": "Bash", "title": "Run the tests", "state": "running", "at": 1400, "input": "cargo test"],
  ]]
  let e3: JV = ["turn": "a1b2", "seq": 3, "state": "done", "started_at": 1000, "ended_at": 9000, "more": 4, "items": [
    ["id": "toolu_2", "kind": "step", "tool": "Bash", "title": "Run the tests", "state": "failed", "at": 1400, "ms": 7000, "input": "cargo test", "output": "error[E0499]"],
    ["id": "agent:x", "kind": "helper", "tool": "Explore", "title": "Find it", "state": "ok", "at": 1300, "steps": 5, "ms": 6000],
  ]]

  func testWhatAnEnvelopeOfATrailIs() {
    XCTAssertTrue(Work.isWork(["content_type": "message", "terminal": "work", "work": e2]))
    XCTAssertFalse(Work.isWork(["terminal": "work"]))
    XCTAssertFalse(Work.isWork(["terminal": "answer", "work": e2]))
    XCTAssertFalse(Work.isWork(["terminal": "work", "work": ["turn": "", "items": []]]))
    XCTAssertFalse(Work.isWork(["terminal": "work", "work": ["turn": "t"]]))
    XCTAssertFalse(Work.isWork(nil))
    XCTAssertFalse(Work.isWork(.null))
  }

  func testTheFoldInTheOrderOfSeqWhateverCameFirst() {
    var want = WorkBlock()
    want.turn = "a1b2"; want.seq = 3; want.state = "done"; want.started = 1000; want.ended = 9000; want.more = 4
    var a = WorkLine(id: "say:1", kind: "text"); a.text = "I look first."; a.at = 1100
    var b = WorkLine(id: "toolu_1", kind: "step"); b.tool = "Read"; b.subject = "a.rs"; b.state = "ok"; b.at = 1200; b.ms = 12
    var c = WorkLine(id: "agent:x", kind: "helper"); c.tool = "Explore"; c.title = "Find it"; c.state = "ok"; c.at = 1300; c.ms = 6000; c.steps = 5
    var d = WorkLine(id: "toolu_2", kind: "step"); d.tool = "Bash"; d.title = "Run the tests"; d.input = "cargo test"; d.output = "error[E0499]"; d.state = "failed"; d.at = 1400; d.ms = 7000
    want.items = [a, b, c, d]
    XCTAssertEqual(Work.fold([e1, e2, e3]), want)
    XCTAssertEqual(Work.fold([e3, e1, e2]), want)
    // a turn still running: the first envelope alone
    let live = Work.fold([e1])
    XCTAssertEqual(live.state, "running"); XCTAssertNil(live.ended); XCTAssertEqual(live.items[1].state, "running")
  }

  func testNothingBeyondItsShapeIsTrusted() {
    let junk = Work.fold([.null, "x", ["turn": "t", "seq": 1, "state": "exploded", "started_at": -5, "items": [
      .null, ["kind": "step"], ["id": 7, "kind": "step"], ["id": "a", "kind": "video"],
      ["id": "b", "kind": "step", "tool": .str(String(repeating: "T", count: 500)), "state": "melting", "ms": "soon", "at": .num(Double.infinity), "output": .str(String(repeating: "o", count: 20000))],
      ["id": "b", "kind": "text", "text": "another kind under the same id"],
    ]]])
    XCTAssertEqual(junk.state, "running"); XCTAssertNil(junk.started); XCTAssertEqual(junk.items.count, 1)
    let x = junk.items[0]
    XCTAssertEqual(x.tool?.count, 80); XCTAssertNil(x.state); XCTAssertNil(x.ms); XCTAssertNil(x.at); XCTAssertEqual(x.output?.count, 8000); XCTAssertNil(x.text)
    let many = Work.fold([["turn": "t", "seq": 1, "items": .arr((0..<(Work.itemsMax + 50)).map { ["id": .str("s\($0)"), "kind": "step"] })]])
    XCTAssertEqual(many.items.count, Work.itemsMax)
  }

  func testAFailedCommandsExitCodeStandsOnItsStepAndOnlyThere() {
    let exits = Work.fold([
      ["turn": "t", "seq": 1, "items": [["id": "a", "kind": "step", "state": "running"], ["id": "b", "kind": "step", "state": "failed", "exit": 300], ["id": "c", "kind": "text", "text": "x", "exit": 1],
                                        ["id": "d", "kind": "step", "exit": 1.5], ["id": "e", "kind": "step", "exit": "1"]]],
      ["turn": "t", "seq": 2, "items": [["id": "a", "kind": "step", "state": "failed", "exit": 1]]],
    ])
    XCTAssertEqual(exits.items.map { $0.id }, ["a", "b", "c", "d", "e"])
    XCTAssertEqual(exits.items.map { $0.state }, ["failed", "failed", nil, nil, nil])
    XCTAssertEqual(exits.items.map { $0.exit }, [1, nil, nil, nil, nil])
    XCTAssertEqual(exits.items[0].exitSays, "exit code 1"); XCTAssertEqual(exits.items[0].says, "exit code 1")
    XCTAssertNil(exits.items[1].exitSays); XCTAssertEqual(exits.items[1].says, "ended with an error")
  }

  func testATurnBrokenOffHasNoEnd() {
    let broken = Work.fold([
      ["turn": "t", "seq": 1, "state": "running", "started_at": 1000, "items": [["id": "a", "kind": "step", "state": "running"]]],
      ["turn": "t", "seq": 2, "state": "interrupted", "started_at": 1000, "items": [["id": "a", "kind": "step", "state": "interrupted"]]],
    ])
    XCTAssertEqual(broken.state, "interrupted"); XCTAssertEqual(broken.started, 1000); XCTAssertNil(broken.ended); XCTAssertEqual(broken.items[0].state, "interrupted")
    XCTAssertEqual(broken.head, "Interrupted", "no made-up time")
    XCTAssertEqual(broken.line, "Interrupted · 1 step")
  }

  func testWhereTheBlockStands() {
    XCTAssertEqual(Work.anchor([12, 10, 15], typed: []), 10, "the first envelope, whatever order they are given in")
    XCTAssertEqual(Work.anchor([10, 12, 15], typed: [9, 16]), 10, "his prompt before the turn and the next one after it move nothing")
    XCTAssertEqual(Work.anchor([10, 12, 15], typed: [11]), 12, "typed while the turn ran: the block stands behind it")
    XCTAssertEqual(Work.anchor([10, 12, 15, 18], typed: [11, 13, 14]), 15, "behind the last of them")
    XCTAssertEqual(Work.anchor([10], typed: [11]), 10, "no envelope after it yet: the block stays")
    XCTAssertEqual(Work.anchor([10, 12], typed: [10, 12]), 10)
    XCTAssertNil(Work.anchor([], typed: [3]))
    XCTAssertEqual(Work.anchor([.nan, 7], typed: [.infinity]), 7)
  }

  /** The folded line as the web says it (session.mjs workBlock, span). */
  func testWhatTheBlockSays() {
    var w = Work.fold([e1, e2, e3])
    w.ended = 53000
    XCTAssertEqual(w.line, "Worked 52 s · 6 steps · 1 helper · 1 with an error", "2 listed steps and 4 more")
    XCTAssertEqual(w.rest, "and 4 more steps, not listed")
    let live = Work.fold([e1, e2])
    XCTAssertEqual(live.line, "Working · 2 steps · 1 helper · Bash · Run the tests")
    XCTAssertEqual(Work.fold([e1]).now, "Read · a.rs")
    XCTAssertNil(w.now)
    var two = w; two.items[1].state = "failed"
    XCTAssertEqual(two.summary, "6 steps · 1 helper · 2 with errors")
    var failed = WorkBlock(); failed.state = "failed"; failed.started = 0; failed.ended = 3000
    XCTAssertEqual(failed.head, "Stopped by an error after 3 s")
    XCTAssertEqual([0, 12, 300, 949, 950, 59400, 59600, 3_540_000, 3_900_000, 7_200_000].map(Work.span), ["0.1 s", "0.1 s", "0.3 s", "0.9 s", "1 s", "59 s", "1 min", "59 min", "1 h 5 min", "2 h"])
    XCTAssertEqual(w.items[2].name, "Helper Explore"); XCTAssertEqual(w.items[3].what, "Run the tests")
    XCTAssertTrue(w.items[3].opens, "the level full: a step with input or output opens"); XCTAssertFalse(w.items[1].opens)
  }

  // ---- in a chat (Desk.swift itemsOf, newestWord; ChatTeaser) -------------------------------------------

  private func rec(_ n: Int, from: String, role: String, sid: String, content: JV) -> Rec {
    Rec(envelopeNumber: n, envelopeHash: String(format: "%064x", n), senderDeviceId: from, senderRole: role, recipientDeviceId: nil, sentAt: UInt64(1_000_000 + n), kind: KIND.TIMELINE_ITEM, isHead: false,
        object: nil, timelineKind: "chat", timelineId: "session/\(sid)", sessionId: sid, content: content, contentState: "ok", bind: nil,
        causal: Causal(senderDeviceId: from, senderSequence: UInt64(n), sentAt: UInt64(n), lamport: n), senderSequence: UInt64(n), epoch: 1)
  }
  private func room() -> (Board, me: String, agent: String, sid: String) {
    let b = Board()
    let me = String(repeating: "a", count: 64), agent = String(repeating: "b", count: 64), sid = String(repeating: "c", count: 32)
    b.myDeviceId = me
    let s = b.sessionOf(sid)
    s.agentDeviceIds = [agent]; s.everAgentIds = [agent]; s.agentDeviceId = agent
    return (b, me, agent, sid)
  }
  private func work(_ turn: String, _ seq: Int, _ state: String, _ items: JV = []) -> JV {
    ["content_type": "message", "terminal": "work", "work": ["turn": .str(turn), "seq": .n(seq), "state": .str(state), "started_at": 1000, "items": items]]
  }

  func testATurnIsOneMessageNeverABubbleAndNothingToRead() throws {
    let (b, me, agent, sid) = room()
    var ch = Change()
    b.apply(rec(10, from: agent, role: "agent", sid: sid, content: ["content_type": "message", "text": "weiter", "terminal": "input"]), change: &ch)
    b.apply(rec(11, from: agent, role: "agent", sid: sid, content: work("t1", 1, "running", [["id": "s1", "kind": "step", "tool": "Read", "state": "running"]])), change: &ch)
    b.apply(rec(12, from: agent, role: "agent", sid: sid, content: work("t1", 2, "done", [["id": "s1", "kind": "step", "tool": "Read", "state": "ok"]])), change: &ch)
    b.apply(rec(13, from: agent, role: "agent", sid: sid, content: ["content_type": "message", "text": "Fertig.", "terminal": "answer"]), change: &ch)
    b.apply(rec(14, from: agent, role: "agent", sid: sid, content: work("t2", 1, "running", [["id": "s2", "kind": "step", "tool": "Bash", "title": "Run the tests", "state": "running"]])), change: &ch)
    // not a trail's: a human cannot write one, and an envelope without a turn is left out
    b.apply(rec(15, from: me, role: "human", sid: sid, content: work("t1", 9, "failed")), change: &ch)
    b.apply(rec(16, from: agent, role: "agent", sid: sid, content: ["content_type": "message", "terminal": "work", "text": "not shown"]), change: &ch)
    b.project()
    let d = DeskModel(board: b)
    let a = try XCTUnwrap(d.agents.first)
    let m = d.messagesOf(agent: a.id)
    XCTAssertEqual(m.map { $0.from }, ["user", "work", "agent", "work"])
    XCTAssertEqual(m.map { $0.seq }, [10, 11, 13, 14])
    XCTAssertEqual(m[1].work?.state, "done"); XCTAssertEqual(m[1].work?.seq, 2); XCTAssertEqual(m[1].work?.items.map { $0.state }, ["ok"])
    XCTAssertEqual(m[1].text, ""); XCTAssertTrue(m[1].attachments.isEmpty)
    XCTAssertEqual(m[3].work?.line, "Working · 1 step · Bash · Run the tests")
    XCTAssertNil(m[0].work); XCTAssertNil(m[2].work)
    // the same row while later envelopes come in
    let id = m[3].id
    b.apply(rec(17, from: agent, role: "agent", sid: sid, content: work("t2", 2, "done")), change: &ch)
    b.project()
    let again = DeskModel(board: b).messagesOf(agent: a.id)
    XCTAssertEqual(again.last?.id, id); XCTAssertEqual(again.last?.work?.state, "done")
    // the unread mark goes by what it said (13), not by the trail's envelopes behind it (14, 16, 17)
    XCTAssertEqual(b.timelines[timelineKeyOf("chat", "session/\(sid)")]?.newestAgentEnvelopeNumber, 17)
    XCTAssertEqual(DeskModel(board: b).newestWord(sessionId: sid), 13)
    // the preview is the last thing said
    XCTAssertEqual(ChatTeaser.of(again).text, "Fertig.")
  }

  func testTheBlockStandsBehindWhatHeTypedWhileTheTurnRan() throws {
    let (b, _, agent, sid) = room()
    var ch = Change()
    b.apply(rec(10, from: agent, role: "agent", sid: sid, content: work("t", 1, "running", [["id": "s1", "kind": "step", "tool": "Read", "state": "running"]])), change: &ch)
    b.apply(rec(11, from: agent, role: "agent", sid: sid, content: ["content_type": "message", "text": "und auch die Tests", "terminal": "input"]), change: &ch)
    b.project()
    var d = DeskModel(board: b)
    let a = try XCTUnwrap(d.agents.first)
    XCTAssertEqual(d.messagesOf(agent: a.id).map { $0.from }, ["work", "user"], "no envelope after it yet: the block stays")
    let id = d.messagesOf(agent: a.id)[0].id
    b.apply(rec(12, from: agent, role: "agent", sid: sid, content: work("t", 2, "running", [["id": "s1", "kind": "step", "tool": "Read", "state": "ok"], ["id": "s2", "kind": "step", "tool": "Bash", "state": "running"]])), change: &ch)
    b.apply(rec(15, from: agent, role: "agent", sid: sid, content: work("t", 3, "done", [["id": "s2", "kind": "step", "tool": "Bash", "state": "ok"]])), change: &ch)
    b.project()
    d = DeskModel(board: b)
    let m = d.messagesOf(agent: a.id)
    XCTAssertEqual(m.map { $0.from }, ["user", "work"], "his words never stand under the work they were typed into")
    XCTAssertEqual(m[1].seq, 12); XCTAssertEqual(m[1].ts, 1_000_012)
    XCTAssertEqual(m[1].id, id, "the block is the same row where it moved to")
    XCTAssertEqual(m[1].work?.items.count, 2, "one block, with all its steps")
    XCTAssertEqual(d.newestWord(sessionId: sid), 11)
  }
}
