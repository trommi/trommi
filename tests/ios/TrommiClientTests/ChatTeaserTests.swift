// ChatTeaserTests: a Chat list row's teaser (the last thing said) and its date.
import Foundation
import XCTest
@testable import TrommiClient

final class ChatTeaserTests: XCTestCase {
  func msg(_ from: String, _ text: String, ts: UInt64 = 1000, kind: String? = nil, files: Int = 0) -> Message {
    Message(id: "\(from)-\(ts)", seq: Double(ts), agent: "a", from: from, kind: kind, text: text, attachments: Array(repeating: JV.obj([:]), count: files), ts: ts)
  }

  func testTheLastThingSaid() {
    let t = ChatTeaser.of([msg("agent", "First", ts: 1), msg("user", "Sieht gut aus", ts: 2), msg("agent", "Gepusht.\nDer Build läuft.", ts: 3)])
    XCTAssertEqual(t, ChatTeaser(text: "Gepusht. Der Build läuft.", ts: 3))
  }

  func testHisOwnWordsSayYou() {
    XCTAssertEqual(ChatTeaser.of([msg("agent", "Hi", ts: 1), msg("user", "Und das Scrollen?", ts: 2)]).text, "You: Und das Scrollen?")
  }

  func testWhatBecameOfAQuestionIsNotSaid() {
    let t = ChatTeaser.of([msg("agent", "Bin dran", ts: 1), msg("event", "Welche Farbe?", ts: 2, kind: "asked"), msg("event", "Welche Farbe?", ts: 3, kind: "decided"), msg("event", "x", ts: 4, kind: "done")])
    XCTAssertEqual(t, ChatTeaser(text: "Welche Farbe?", ts: 2), "a question put to him is said; its answer and its end are not")
  }

  func testAFileAloneAndNothingAtAll() {
    XCTAssertEqual(ChatTeaser.of([msg("user", "", ts: 5, files: 1)]).text, "You: Attachment")
    XCTAssertEqual(ChatTeaser.of([msg("agent", "  ", ts: 5, files: 3)]).text, "3 attachments")
    XCTAssertEqual(ChatTeaser.of([], task: "Belege sortieren"), ChatTeaser(text: "Belege sortieren", ts: nil))
  }

  func testPlainWords() {
    XCTAssertEqual(ChatTeaser.plain("## Stand\n\n☞ **Fertig**: `swift test` grün\n- eins\n```\ncode\n```"), "Stand Fertig: swift test grün eins code")
    XCTAssertEqual(ChatTeaser.plain(String(repeating: "wort ", count: 100)).count, 200)
  }

  func testStamp() {
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 9, minute: 38))!
    func at(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 7, _ min: Int = 52) -> UInt64 { UInt64(cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!.timeIntervalSince1970 * 1000) }
    XCTAssertEqual(ChatTeaser.stamp(at(2026, 10, 9), now: now, calendar: cal), "07:52")
    XCTAssertEqual(ChatTeaser.stamp(at(2026, 10, 8, 23, 59), now: now, calendar: cal), "Yesterday")
    XCTAssertEqual(ChatTeaser.stamp(at(2026, 10, 5), now: now, calendar: cal), "Monday")
    XCTAssertEqual(ChatTeaser.stamp(at(2026, 8, 28), now: now, calendar: cal), "28 Aug")
    XCTAssertEqual(ChatTeaser.stamp(at(2025, 12, 24), now: now, calendar: cal), "24.12.25")
  }

  func testTheHelpersAtTheEndOfTheTeaser() {
    func unit(_ id: String, blocked: Bool = false) -> DeskUnit {
      let a = Agent(id: id, deviceId: id, given: id, name: id, label: "", icon: "", mark: id, online: true, model: "", task: "", starred: false, parent: "m",
                    main: false, archived: false, position: 0, seen: 0, active: 0, deviceActive: 0, removed: false, own: false)
      return DeskUnit(id: id, agent: a, open: 0, online: true, running: false, stuck: false, blocked: blocked ? (why: "cut", text: "cut off") : nil, parent: "m")
    }
    var subs = (0..<10).map { unit("h\($0)") }
    subs[9] = unit("h9", blocked: true)
    let many = UnitStack(main: unit("m"), subs: subs).inline()
    XCTAssertEqual(many.shown.map { $0.id }, ["h9", "h0", "h1", "h2"], "four drawings, a stopped helper first")
    XCTAssertEqual(many.more, 6)
    let few = UnitStack(main: unit("m"), subs: Array(subs.prefix(3))).inline()
    XCTAssertEqual(few.shown.count, 3)
    XCTAssertEqual(few.more, 0)
  }
}
