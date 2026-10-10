// GoalsTests: a desk's goals handed to the sessions on it (README "Desk goals for the agent"; Goals.swift, a port of
// shared/client.ts goalsWanted and syncGoals and shared/model.ts cleanGoals). The values are what the TS functions
// give (shared/test.mjs "desk goals for the agent …").
import Foundation
import XCTest
@testable import TrommiClient

final class GoalsTests: XCTestCase {
  let h = String(repeating: "1", count: 64), agent = String(repeating: "b", count: 64)
  let s1 = String(repeating: "c", count: 32), s2 = String(repeating: "d", count: 32)
  var n = 1

  private func set(_ b: Board, _ values: JV, session: String? = nil) {
    n += 1
    var ch = Change()
    b.apply(Rec(envelopeNumber: n, envelopeHash: String(format: "%064x", n), senderDeviceId: h, senderRole: "human", recipientDeviceId: nil, sentAt: UInt64(n), kind: KIND.STATUS, isHead: true,
                object: nil, timelineKind: nil, timelineId: nil, sessionId: session, content: ["values": values], contentState: "ok", bind: nil,
                causal: Causal(senderDeviceId: h, senderSequence: UInt64(n), sentAt: UInt64(n), lamport: n), senderSequence: UInt64(n), epoch: 1), change: &ch)
  }
  private func room() -> Board {
    let b = Board()
    b.myDeviceId = h
    for (sid, epoch) in [(s1, 3), (s2, 1)] {
      let s = b.sessionOf(sid)
      s.agentDeviceIds = [agent]; s.everAgentIds = [agent]; s.agentDeviceId = agent; s.sessionKeyEpoch = epoch
    }
    return b
  }
  private func wanted(_ b: Board, holds: Set<String>? = nil) -> [String: JV] {
    Dictionary(uniqueKeysWithValues: GoalsSync.wanted(b, holdsKey: { holds?.contains($0) ?? true }).map { ($0.sessionId, $0.value) })
  }

  func testTheGoalsAsTheyAreHandedOver() {
    let rest = (3...20).map(String.init).joined(separator: "\n")
    XCTAssertEqual(GoalsSync.clean(" 1. Ship the importer \n\n2. No regressions\n\(rest)\n21 is one too many"), "1. Ship the importer\n2. No regressions\n\(rest)", "20 lines, trimmed, blank lines out")
    XCTAssertEqual(GoalsSync.lines, GOALS_LINES)
    XCTAssertEqual(GoalsSync.clean("a\r\nb\r\n\r\n  c\t"), "a\nb\nc")
    XCTAssertEqual(GoalsSync.clean("a\rb"), "a\rb", "a lone carriage return ends no line (split is /\\r?\\n/)")
    XCTAssertEqual(GoalsSync.clean("\u{00a0}\u{feff} x \u{2028}"), "x", "what String.prototype.trim takes off")
    XCTAssertEqual(GoalsSync.clean(String(repeating: "x", count: 250)).count, 200)
    XCTAssertEqual(GoalsSync.clean(String(repeating: "😀", count: 101)).utf16.count, 200)
    XCTAssertEqual(GoalsSync.clean(" \n\t\n"), "")
  }

  func testNoDeskNoGoals() {
    let b = room()
    XCTAssertEqual(wanted(b), [s1: .null, s2: .null])
    XCTAssertTrue(GoalsSync.toWrite(b, holdsKey: { _ in true }).isEmpty, "nothing there, nothing wanted: nothing to write")
  }

  func testEverySessionGetsTheGoalsOfItsDeskUnderItsEpoch() {
    let b = room()
    set(b, ["desk/main": ["name": " Web App ", "created_at": 1, "goals": " 1. Ship the importer \n\n2. No regressions"], "desk/ab12cd34": ["name": "Site", "created_at": 2, "goals": "Launch"],
            .init("session/\(s2)"): ["desk": "ab12cd34"]])
    let w = wanted(b)
    XCTAssertEqual(w[s1], ["desk_id": "main", "desk_name": "Web App", "goals": "1. Ship the importer\n2. No regressions", "epoch": 3], "no desk of its own: the first of the menu")
    XCTAssertEqual(w[s2], ["desk_id": "ab12cd34", "desk_name": "Site", "goals": "Launch", "epoch": 1])
    XCTAssertEqual(GoalsSync.toWrite(b, holdsKey: { _ in true }).map { $0.sessionId }, [s1, s2])
    // written (each under its session's key): in step, nothing to write
    set(b, [.init("goals/\(s1)"): w[s1]!], session: s1)
    set(b, [.init("goals/\(s2)"): w[s2]!], session: s2)
    XCTAssertEqual(b.human.raw["goals/\(s1)"]?.value, w[s1], "goals/ is a human key, taken from a human under a session's key")
    XCTAssertTrue(GoalsSync.toWrite(b, holdsKey: { _ in true }).isEmpty)
    // the goals are edited
    set(b, ["desk/ab12cd34": ["name": "Site", "created_at": 2, "goals": "Launch on Friday"]])
    XCTAssertEqual(GoalsSync.toWrite(b, holdsKey: { _ in true }).map { $0.sessionId }, [s2])
    // the session moves to another desk
    set(b, [.init("session/\(s2)"): ["desk": "main"]])
    let moved = GoalsSync.toWrite(b, holdsKey: { _ in true })
    XCTAssertEqual(moved.map { $0.sessionId }, [s2]); XCTAssertEqual(moved.first?.value["desk_id"], "main"); XCTAssertEqual(moved.first?.value["epoch"].int, 1)
    // a desk that is gone: the first of the menu again
    set(b, [.init("session/\(s2)"): ["desk": "nowhere"]])
    XCTAssertEqual(wanted(b)[s2]?["desk_id"], "main")
    // a new epoch of the session (a new agent of the session cannot read what was sealed before it came)
    b.sessionOf(s1).sessionKeyEpoch = 4
    XCTAssertEqual(GoalsSync.toWrite(b, holdsKey: { _ in true }).first { $0.sessionId == s1 }?.value["epoch"].int, 4)
    // the goals are taken away: null
    set(b, ["desk/main": ["name": "Web App", "created_at": 1]])
    let gone = GoalsSync.toWrite(b, holdsKey: { _ in true })
    XCTAssertEqual(gone.map { $0.sessionId }, [s1, s2]); XCTAssertTrue(gone.allSatisfy { $0.value.isNull })
  }

  func testWhoGetsNone() {
    let b = room()
    set(b, ["desk/main": ["name": "Web App", "created_at": 1, "goals": "One"]])
    XCTAssertEqual(Set(wanted(b, holds: [s1]).keys), [s1], "a session whose key this device does not hold")
    b.sessionOf(s1).isActive = false
    b.sessionOf(s2).createdByAgent = true
    XCTAssertTrue(wanted(b).isEmpty, "an archived session, and a helper's (its connector reads its main's)")
    b.sessionOf(s1).isActive = true; b.sessionOf(s1).agentDeviceIds = []
    XCTAssertTrue(wanted(b).isEmpty, "a session without an agent")
  }

  func testTheOrderOfTheDeskMenu() {
    let b = room()
    set(b, ["desk/zz": ["name": "Old", "created_at": 1, "goals": "old"], "desk/main": ["name": "", "created_at": 9, "goals": "main"]])
    XCTAssertEqual(wanted(b)[s1]?["desk_id"], "main", "without an order: main first")
    XCTAssertEqual(wanted(b)[s1]?["desk_name"], "Desk", "a desk without a name")
    set(b, ["desk/zz": ["name": "Old", "created_at": 1, "goals": "old", "order": 0], "desk/main": ["name": "", "created_at": 9, "goals": "main", "order": 1]])
    XCTAssertEqual(wanted(b)[s1]?["desk_id"], "zz", "with an order: the order")
    set(b, ["desk/zz": .null])
    XCTAssertEqual(wanted(b)[s1]?["desk_id"], "main", "a removed desk is none")
  }

  func testTwoDevicesThatDisagreeNeverWriteInTurns() {
    let b = room()
    set(b, ["desk/main": ["name": "Web App", "created_at": 1, "goals": "One"]])
    let mine = wanted(b)[s1]!
    // another device put something else in its place after this one wrote
    set(b, [.init("goals/\(s1)"): ["desk_id": "main", "desk_name": "Web App", "goals": "Another", "epoch": 3]], session: s1)
    XCTAssertEqual(GoalsSync.toWrite(b, holdsKey: { _ in true }).map { $0.sessionId }, [s1, s2])
    XCTAssertEqual(GoalsSync.toWrite(b, holdsKey: { _ in true }, said: [s1: mine]).map { $0.sessionId }, [s2], "what this device already said is not said again")
  }
}
