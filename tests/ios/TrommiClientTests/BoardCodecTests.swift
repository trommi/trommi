import XCTest
@testable import TrommiClient

final class BoardCodecTests: XCTestCase {
  /** Every stored field of the board's parts is in BoardCodec: a new field makes this count differ (then add it there). */
  func testFieldsCovered() {
    let rec = Rec(envelopeNumber: 1, envelopeHash: "aa", senderDeviceId: "bb", senderRole: "agent", recipientDeviceId: nil, sentAt: 1, kind: 2, isHead: true, object: nil,
                  timelineKind: nil, timelineId: nil, sessionId: nil, content: nil, contentState: "ok", bind: nil, causal: Causal(senderDeviceId: "bb", senderSequence: 1, sentAt: 1, lamport: 1),
                  senderSequence: 1, epoch: 1)
    let counts: [(Any, Int)] = [
      (RoomMember(deviceId: "aa", role: "human"), 15), (Session("s"), 27), (Card("c", agent: "a", rec: rec), 21),
      (Permission(objectId: "p", agentDeviceId: "a", sessionId: nil, toolName: "t", description: "d", inputPreview: "i", expiresAt: 1, versionHash: "v", envelopeNumber: 1, sentAt: 1), 13),
      (Timeline("chat:session/x"), 14), (Board(), 25), (HumanRegisters(), 8),
    ]
    for (x, n) in counts { XCTAssertEqual(Mirror(reflecting: x).children.count, n, "fields of \(type(of: x)): update BoardCodec and this count") }
  }

  /** A board read back writes the same bytes; chat bodies older than the kept ones become headers. */
  func testRoundTrip() throws {
    let b = Board()
    b.roomId = "r"; b.myDeviceId = "me"; b.lastEnvelopeNumber = 99
    var ch = Change()
    b.applyMembers([(id: "aa", role: "human", active: true, added: 0, removed: nil), (id: "bb", role: "agent", active: true, added: 1, removed: nil)], change: &ch)
    let s = b.sessionOf(String(repeating: "1", count: 32)); s.agentDeviceIds = ["bb"]; s.everAgentIds = ["bb"]; s.profile = .obj(["task": .str("t")])
    s.statusLines = [StatusLine(id: "x", label: "X", state: "working", detail: nil, objectId: nil, envelopeNumber: 3, updatedAt: 4)]
    s.agentAlerts = [(key: "k", value: .num(1), envelopeNumber: 5)]
    let t = b.timelineOf(s.timelineKey)
    for n in 1...100 {
      t.items[n] = TimelineItem(envelopeNumber: n, localId: nil, pending: false, envelopeHash: String(format: "%064x", n), senderDeviceId: n % 2 == 0 ? "aa" : "bb", senderSequence: UInt64(n),
                                recipientDeviceId: n % 2 == 0 ? "bb" : nil, sentAt: UInt64(n), itemState: "loaded", contentType: "message", content: .obj(["content_type": .str("message"), "text": .str("m\(n)")]))
      t.numbers.append(n)
    }
    let rec = Rec(envelopeNumber: 7, envelopeHash: "cc", senderDeviceId: "bb", senderRole: "agent", recipientDeviceId: nil, sentAt: 7, kind: 2, isHead: true, object: nil,
                  timelineKind: nil, timelineId: nil, sessionId: s.sessionId, content: nil, contentState: "ok", bind: nil, causal: Causal(senderDeviceId: "bb", senderSequence: 7, sentAt: 7, lamport: 1),
                  senderSequence: 7, epoch: 1)
    let c = Card("c1", agent: "bb", rec: rec)
    let content: JV = .obj(["object_type": .str("card"), "object_version": .num(1), "card_type": .str("decision"), "title": .str("T"), "options": .arr([.str("a"), .str("b")])])
    c.versions = [CardVersion(objectVersion: 1, versionHash: "cc", previousVersionHash: nil, envelopeNumber: 7, sentAt: 7, objectState: "open", urgency: "normal", content: content)]
    c.fields = (content.object ?? [:]).filter { !["object_type", "object_version"].contains($0.key) }
    let a = Answer(answerAction: "answer", choices: ["a"], note: "n", optionNotes: ["a": "x"], attachments: [], marks: [], trusted: false, boundObjectVersion: 1, envelopeNumber: 8,
                   envelopeHash: "dd", byDeviceId: "aa", answeredAt: 8, takenBackAt: nil, takenBackSentAt: nil)
    c.answers = [a]; c.answer = a
    b.cards["c1"] = c
    b.human.desks = ["main": .obj(["name": .str("Desk")])]
    b.human.raw["desk/main"] = RegisterValue(value: .str("x"), envelopeNumber: 9, senderSequence: 2, byDeviceId: "aa", causal: Causal(senderDeviceId: "aa", senderSequence: 2, sentAt: 9, lamport: 3))
    b.notes["n1"] = Note(objectId: "n1", byDeviceId: "aa", text: "hi", extra: ["k": .bool(true)], objectVersion: 1, versionHash: "ee", versionHashes: ["ee"], causal: nil, envelopeNumber: 10, objectState: "open")

    let bytes = BoardCodec.encode(b, bodiesKept: 60)
    let back = Board()
    try bytes.withUnsafeBufferPointer { try BoardCodec.decode($0, into: back) }
    XCTAssertTrue(BoardCodec.encode(back, bodiesKept: 60) == bytes, "a board read back writes the same bytes")
    let bt = try XCTUnwrap(back.timelines[s.timelineKey])
    XCTAssertEqual(bt.items.count, 100)
    XCTAssertEqual(bt.items[40]?.itemState, "header"); XCTAssertNil(bt.items[40]?.content)
    XCTAssertEqual(bt.items[41]?.content?["text"].string, "m41")
    XCTAssertEqual(bt.items[2]?.recipientDeviceId, "bb"); XCTAssertNil(bt.items[3]?.recipientDeviceId)
    XCTAssertTrue(bt.hasMore)
    XCTAssertEqual(back.cards["c1"]?.title, "T"); XCTAssertEqual(back.cards["c1"]?.answer?.choices, ["a"]); XCTAssertEqual(back.cards["c1"]?.answer?.optionNotes["a"], "x")
    XCTAssertEqual(back.sessions[s.sessionId]?.agentAlerts.first?.key, "k")
    XCTAssertEqual(back.notes["n1"]?.extra["k"], .bool(true))
    XCTAssertEqual(back.members["bb"]?.deviceRole, "agent")
  }
}
