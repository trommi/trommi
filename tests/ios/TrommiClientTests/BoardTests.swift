// BoardTests: the board model (Board.swift, a port of shared/model.mjs) and the pen (Pen.swift) on their own: the
// scribbles are the web's byte for byte, the reducer keeps what a newer client writes and shows it as needing an update,
// never as something it is not.
import Foundation
import XCTest
@testable import TrommiClient

final class BoardTests: XCTestCase {
  func fixture(_ name: String) throws -> Data {
    let url = Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil) ?? Bundle.module.resourceURL!.appendingPathComponent("Fixtures/\(name)")
    return try Data(contentsOf: url)
  }

  /** The seeded scribbles of the Swift pen are the web's (dev/ios-pen.mjs wrote the vectors from ui.mjs). */
  func testPenScribblesAreTheWebs() throws {
    let vec = try JSONSerialization.jsonObject(with: try fixture("pen-vectors.json")) as! [[String: Any]]
    XCTAssertGreaterThan(vec.count, 5)
    for v in vec {
      let seed = v["seed"] as! String, svg = v["svg"] as! String
      if Pen.drawingName(seed) != nil && !Pen.kinds.contains(Pen.drawingName(seed)!) { continue }
      let s = Pen.scribble(seed: seed)
      let paths = svg.components(separatedBy: " d=\"").dropFirst().map { String($0.prefix { $0 != "\"" }) }
      XCTAssertEqual(s.paths, paths, "the strokes of \(seed)")
      let rot = Double(svg.components(separatedBy: "rotate:")[1].prefix { $0 != "d" })!
      XCTAssertEqual(s.rotate, rot, "the tilt of \(seed)")
      XCTAssertEqual(Pen.hueFor(id: seed, mark: seed), v["hue"] as! Int, "the hue of \(seed)")
    }
  }

  private func rec(_ n: Int, kind: Int, from: String, role: String, session: String? = nil, object: ObjectHead? = nil, timeline: (String, String)? = nil,
                   content: JV?, state: String = "ok", bind: DecodedBind? = nil, epoch: Int = 1) -> Rec {
    Rec(envelopeNumber: n, envelopeHash: String(format: "%064x", n), senderDeviceId: from, senderRole: role, recipientDeviceId: nil, sentAt: UInt64(1_000_000 + n), kind: kind, isHead: kind != KIND.TIMELINE_ITEM,
        object: object, timelineKind: timeline?.0, timelineId: timeline?.1, sessionId: session, content: content, contentState: state, bind: bind,
        causal: Causal(senderDeviceId: from, senderSequence: UInt64(n), sentAt: UInt64(n), lamport: n), senderSequence: UInt64(n), epoch: epoch)
  }

  /** A card of a newer type, a newer schema, an unknown message type: kept, shown as "needs a newer Trommi", never answered as something else. */
  func testNewerThingsAreKeptAndMarked() throws {
    let b = Board()
    b.myDeviceId = String(repeating: "a", count: 64)
    let agent = String(repeating: "b", count: 64), sid = String(repeating: "c", count: 32)
    let s = b.sessionOf(sid)
    s.agentDeviceIds = [agent]; s.everAgentIds = [agent]; s.agentDeviceId = agent
    var ch = Change()
    let id1 = String(repeating: "1", count: 32), id2 = String(repeating: "2", count: 32)
    // a card_type this version does not know (with a field it does not know either)
    b.apply(rec(1, kind: KIND.OBJECT_VERSION, from: agent, role: "agent", session: sid, object: ObjectHead(objectId: id1, objectState: 1, urgency: 1, answeredAt: 0),
                content: ["object_type": "card", "object_version": 1, "card_type": "vote", "title": "Pick a colour", "options": [["key": "red", "label": "Red"]], "ballot": ["x": 1]]), change: &ch)
    // a body of a newer schema
    b.apply(rec(2, kind: KIND.OBJECT_VERSION, from: agent, role: "agent", session: sid, object: ObjectHead(objectId: id2, objectState: 1, urgency: 2, answeredAt: 0),
                content: ["schema_version": 2, "object_type": "card", "object_version": 1, "title": "From the future"], state: "newer_schema"), change: &ch)
    // a message of a content type this version does not know
    b.apply(rec(3, kind: KIND.TIMELINE_ITEM, from: agent, role: "agent", session: sid, timeline: ("chat", "session/\(sid)"), content: ["content_type": "poll", "question": "?"]), change: &ch)
    b.project()
    let d = DeskModel(board: b)
    let c1 = try XCTUnwrap(d.byCard[id1])
    XCTAssertTrue(c1.unsupported, "an unknown card type is a placeholder, not a decision")
    XCTAssertEqual(b.cards[id1]?.fields["ballot"], ["x": 1], "the unknown field is kept")
    if let c2 = d.byCard[id2] { XCTAssertTrue(c2.unsupported || c2.contentState != "ok", "a newer schema is not read as this version's card") }
    // the conversation keeps the unknown item, shown as needing an update (not dropped, not shown as a message)
    let items = b.timelines[timelineKeyOf("chat", "session/\(sid)")]?.ordered ?? []
    XCTAssertEqual(items.count, 1)
    XCTAssertEqual(items.first?.contentType, "poll")
  }

  /** R2: registers settle by (lamport, sender, sequence) whatever the delivery order. */
  func testRegistersSettleByCausalOrder() {
    let b = Board()
    let h1 = String(repeating: "1", count: 64), h2 = String(repeating: "2", count: 64)
    var ch = Change()
    var late = rec(2, kind: KIND.STATUS, from: h2, role: "human", content: ["values": ["desk/x": ["name": "Second"]]])
    late.causal.lamport = 9
    var early = rec(3, kind: KIND.STATUS, from: h1, role: "human", content: ["values": ["desk/x": ["name": "First"]]])
    early.causal.lamport = 4
    b.apply(late, change: &ch)
    b.apply(early, change: &ch)
    XCTAssertEqual(b.human.desks["x"]?["name"], "Second", "the causally later write wins, even when it came first")
  }

  /** A desk's goals as the web keeps them (app.mjs cleanGoals; the expected values are what that function returns). */
  func testGoalsAreCleanedAsOnTheWeb() {
    XCTAssertEqual(cleanGoals("\n\n 1. Ship iOS  \r\n2. Sleep\t\n\n"), " 1. Ship iOS\n2. Sleep")
    XCTAssertEqual(cleanGoals("a\n\nb\n"), "a\n\nb", "a blank line inside stays")
    XCTAssertEqual(GOALS_LINES, 20)
    // folded on the Desk: the first five lines, the rest behind "+N more"
    let twelve = (1...12).map { "goal \($0)" }.joined(separator: "\n")
    XCTAssertEqual(goalsFold(twelve).shown, (1...5).map { "goal \($0)" }.joined(separator: "\n"))
    XCTAssertEqual(goalsFold(twelve).more, 7)
    XCTAssertEqual(goalsFold("a\nb\nc\nd\ne").more, 0, "five lines: nothing to fold")
    XCTAssertEqual(goalsFold("a\nb\nc\nd\ne").shown, "a\nb\nc\nd\ne")
    XCTAssertEqual(goalsFold("").more, 0)
    XCTAssertEqual(cleanGoals((1...21).map(String.init).joined(separator: "\n")), (1...20).map(String.init).joined(separator: "\n"), "a checklist of 20 lines, the 21st cut")
    XCTAssertEqual(cleanGoals(String(repeating: "x", count: 250)).count, 200)
    XCTAssertEqual(cleanGoals(String(repeating: "😀", count: 101)).utf16.count, 200, "200 UTF-16 units, as the web counts")
    XCTAssertEqual(cleanGoals("   "), "")
    XCTAssertEqual(cleanGoals("a\rb"), "a\nb")
  }

  /** The goals come with the desk's register (a human status envelope) and show on that desk only. */
  func testDeskGoalsFromTheRegister() {
    let b = Board()
    let h = String(repeating: "1", count: 64)
    var ch = Change()
    b.apply(rec(2, kind: KIND.STATUS, from: h, role: "human", content: ["values": ["desk/main": ["name": "Trommi", "created_at": 5, "goals": "1. Launch\n2. iOS parity\n\n"], "desk/web": ["name": "Website", "created_at": 9]]]), change: &ch)
    let d = DeskModel(board: b)
    XCTAssertEqual(d.desks.map { $0.goals }, ["1. Launch\n2. iOS parity", ""])
    XCTAssertEqual(d.view(desk: "main").goals, "1. Launch\n2. iOS parity")
    XCTAssertEqual(d.view(desk: "web").goals, "")
    XCTAssertEqual(d.view(desk: ALL_DESKS).goals, "", "none on All desks")
    // the write keeps every other field; an empty text takes the field away
    let kept = deskRegister(b.human.desks["main"], goals: "Ship\n")
    XCTAssertEqual(kept["goals"], "Ship"); XCTAssertEqual(kept["name"], "Trommi"); XCTAssertEqual(kept["created_at"].double, 5)
    let cleared = deskRegister(kept, goals: " \n")
    XCTAssertFalse(cleared.has("goals")); XCTAssertEqual(cleared["name"], "Trommi")
    // no desk yet: the first one is made for them
    let first = deskRegister(nil, goals: "One", now: 100)
    XCTAssertEqual(first["name"], "Personal"); XCTAssertEqual(first["created_at"].double, 0); XCTAssertEqual(first["goals"], "One")
  }
}

/** The Scribble Board's stroke format against the shared fixture (dev/interop/fixtures/strokes.json). */
final class InkTests: XCTestCase {
  func fixture() throws -> JV {
    let url = Bundle.module.url(forResource: "Fixtures/strokes.json", withExtension: nil) ?? Bundle.module.resourceURL!.appendingPathComponent("Fixtures/strokes.json")
    return try XCTUnwrap(JV.parse(Array(try Data(contentsOf: url))))
  }
  func testStrokesDecodeAndPackByteForByte() throws {
    let f = try fixture()
    for s in f["strokes"].array ?? [] {
      let name = s["name"].string ?? "?"
      let packed = try XCTUnwrap(s["entry"]["points"].string)
      let ink = try XCTUnwrap(InkWire.unpack(packed), name)
      let dec = s["decoded"].array ?? []
      XCTAssertEqual(ink.count, dec.count, name)
      for (i, p) in dec.enumerated() {
        XCTAssertEqual(ink.pts[2 * i], p["x"].double!, accuracy: 1e-9, "\(name) x")
        XCTAssertEqual(ink.pts[2 * i + 1], p["y"].double!, accuracy: 1e-9, "\(name) y")
        XCTAssertEqual(ink.t[i], p["t"].double!, accuracy: 1e-9, "\(name) t")
        XCTAssertEqual(ink.f[i], p["force"].double!, accuracy: 1e-3, "\(name) force")
        if let az = p["azimuth"].double { XCTAssertEqual(ink.az![i], az, accuracy: 1e-5, "\(name) azimuth") }
        if let al = p["altitude"].double { XCTAssertEqual(ink.al![i], al, accuracy: 1e-5, "\(name) altitude") }
      }
      XCTAssertEqual(ink.sim, s["simulated"].bool ?? false, name)
      XCTAssertEqual(InkWire.pack(ink), packed, "\(name): packed again byte for byte")
    }
  }
  func testPalette() {
    XCTAssertEqual(Palette.color("ink"), 0x1b1f23)
    XCTAssertEqual(Palette.color("ink", dark: true), 0xe9eeea)
    XCTAssertEqual(Palette.color("nope", tool: "marker"), 0xffd43b)
    XCTAssertEqual(Palette.nearest(r: 0.1, g: 0.44, b: 0.76, tool: "pen"), "blue")
  }
}
