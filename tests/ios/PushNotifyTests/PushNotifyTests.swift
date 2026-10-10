// The Notification Service Extension's logic with a fake core and a fake Keychain: the context's round trip, a push
// with and without a ticket, and every case that must leave the hub's fixed text (nil here) without leaking anything.
import XCTest
@testable import PushNotify

/** The Keychain item of the tests: bytes in memory. */
final class MemoryStorage: NotifyStorage {
  var bytes: [UInt8]?
  func read() -> [UInt8]? { bytes }
  func write(_ b: [UInt8]) throws { bytes = b }
  func clear() { bytes = nil }
}

/**
 * A core that seals nothing: a "sealed" push or envelope is its key followed by a JSON text. It refuses, like the
 * real one, a wrong key, a missing key and a broken signature (the JSON's `signed: false`).
 */
struct FakeCore: NotifyCore {
  struct Refused: Error {}
  var broken = false

  static func sealPush(key: [UInt8], _ p: ApnsPush) -> [UInt8] {
    key + Array(try! JSONSerialization.data(withJSONObject: ["room": p.roomId, "change": p.change, "urgency": p.urgency, "ticket": p.ticket]))
  }
  func openPush(key: [UInt8], sealed: [UInt8]) throws -> ApnsPush {
    guard !broken, sealed.count > 32, Array(sealed[0..<32]) == key,
          let o = try JSONSerialization.jsonObject(with: Data(sealed[32...])) as? [String: Any] else { throw Refused() }
    return ApnsPush(roomId: bytes(o["room"]), change: (o["change"] as! NSNumber).uint64Value, urgency: (o["urgency"] as! NSNumber).uint8Value, ticket: bytes(o["ticket"]))
  }

  static func sealEnvelope(key: [UInt8], _ e: NotifyEnvelope, signed: Bool = true) -> [UInt8] {
    var o: [String: Any] = ["group": e.group, "epoch": e.epoch, "sender": e.sender, "kind": e.kind, "payload": e.payload, "signed": signed]
    o["objectId"] = e.objectId; o["objectType"] = e.objectType; o["urgency"] = e.urgency
    return key + Array(try! JSONSerialization.data(withJSONObject: o))
  }
  func openEnvelope(_ b: [UInt8], key: (_ group: [UInt8], _ epoch: UInt64) -> [UInt8]?) throws -> NotifyEnvelope {
    guard !broken, b.count > 32, let o = try JSONSerialization.jsonObject(with: Data(b[32...])) as? [String: Any], o["signed"] as? Bool == true else { throw Refused() }
    let group = bytes(o["group"]), epoch = (o["epoch"] as! NSNumber).uint64Value
    guard let k = key(group, epoch), k == Array(b[0..<32]) else { throw Refused() }
    return NotifyEnvelope(group: group, epoch: epoch, sender: bytes(o["sender"]), kind: (o["kind"] as! NSNumber).uint8Value,
                          objectId: o["objectId"].map(bytes), objectType: (o["objectType"] as? NSNumber)?.uint8Value,
                          urgency: (o["urgency"] as? NSNumber)?.uint8Value, payload: bytes(o["payload"]))
  }
  private func bytes(_ v: Any?) -> [UInt8] { ((v as? [NSNumber]) ?? []).map(\.uint8Value) }
}

final class PushNotifyTests: XCTestCase {
  func random(_ n: Int) -> [UInt8] { (0..<n).map { _ in UInt8.random(in: 0...255) } }
  lazy var roomId = random(32)
  lazy var session = random(16)
  lazy var group = roomId + session
  lazy var agent = random(32)
  lazy var human = random(32)
  lazy var objectId = random(16)
  lazy var pushKey = random(32)
  lazy var keys: [UInt64: [UInt8]] = [1: random(32), 2: random(32), 3: random(32)]
  let ticket: [UInt8] = Array("room-device-change-expiry-mac".utf8)
  /** A text no fallback may ever show. */
  let secret = "Welche Farbe für den Knopf?"

  func context() -> NotifyContext {
    let k = keys.map { NotifyKey(group: group, session: session, epoch: $0.key, key: $0.value, agents: [agent]) }
    let room = NotifyRoom(roomId: NotifyText.hex(roomId), hub: "https://hub.trommi.com", me: NotifyText.hex(human), keys: k,
                          sessions: [NotifyText.hex(session): NotifySession(agent: "abc", agentDevice: NotifyText.hex(agent), name: "Design", mark: nil)])
    return NotifyContext(pushKey: pushKey, rooms: [room])
  }

  func e(ticket t: [UInt8]? = nil, key: [UInt8]? = nil, room: [UInt8]? = nil, change: UInt64 = 42) -> String {
    NotifyText.b64u(FakeCore.sealPush(key: key ?? pushKey, ApnsPush(roomId: room ?? roomId, change: change, urgency: 1, ticket: t ?? ticket)))
  }

  func envelope(epoch: UInt64 = 3, sender: [UInt8]? = nil, kind: UInt8 = 2, type: UInt8? = 1, urgency: UInt8? = 1, payload: String? = nil,
                key: [UInt8]? = nil, signed: Bool = true) -> [UInt8] {
    let p = payload ?? #"{"title":"Welche Farbe\n für den Knopf?"}"#
    let env = NotifyEnvelope(group: group, epoch: epoch, sender: sender ?? agent, kind: kind, objectId: objectId, objectType: type, urgency: urgency, payload: Array(p.utf8))
    return FakeCore.sealEnvelope(key: key ?? keys[epoch] ?? random(32), env, signed: signed)
  }

  func answer(_ envelope: [UInt8], change: UInt64 = 42, void: Bool = false) -> Data {
    var o: [String: Any] = ["change": change, "received_at": 1, "envelope": NotifyText.b64u(envelope)]
    if void { o["void_code"] = "forbidden" }
    return try! JSONSerialization.data(withJSONObject: o)
  }

  /** The whole way of one notification; the card, and what was fetched. */
  func shown(_ e: String, answer: Data?, core: FakeCore = FakeCore()) async -> (card: NotifyCard?, asked: [URL]) {
    final class Asked: @unchecked Sendable { var urls = [URL]() }
    let asked = Asked()
    let r = await NotifyOpen.card(e: e, context: context(), core: core) { url in asked.urls.append(url); return answer }
    return (r?.card, asked.urls)
  }

  // ---- the context ----

  func testContextRoundTripThroughTheStorage() throws {
    let storage = MemoryStorage()
    let store = NotifyStore(storage: storage)
    XCTAssertNil(store.read())
    let c = context()
    try store.write(c)
    XCTAssertEqual(store.read(), c)
    XCTAssertEqual(store.read()?.room(roomId)?.sessions[NotifyText.hex(session)]?.name, "Design")
    XCTAssertNil(store.read()?.room(random(32)))
    storage.bytes = Array(#"{"version":1,"pushKey":"","rooms":[]}"#.utf8)
    XCTAssertNil(store.read(), "a context of another version is not read")
    try store.write(c)
    store.clear()
    XCTAssertNil(storage.bytes)
    XCTAssertNil(store.read())
  }

  func testContextKeepsTheNewestTwoEpochsOfEachGroup() {
    let room = context().rooms[0]
    XCTAssertEqual(room.keys.map(\.epoch), [2, 3])
    XCTAssertNil(room.key(group: group, epoch: 1))
    XCTAssertEqual(room.key(group: group, epoch: 3)?.key, NotifyText.b64u(keys[3]!))
    XCTAssertNil(room.key(group: roomId, epoch: 3), "the room group has no key here")
  }

  func testText() {
    let b = random(41)
    XCTAssertEqual(NotifyText.unb64u(NotifyText.b64u(b)), b)
    XCTAssertEqual(NotifyText.hex([0, 0x0f, 0xa0, 0xff]), "000fa0ff")
    XCTAssertEqual(NotifyText.b64u([0xfb, 0xff]), "-_8")
    XCTAssertNil(NotifyText.unb64u("+/8="))
    XCTAssertNil(NotifyText.unb64u("not base64!"))
  }

  // ---- a push ----

  func testPushWithTicketShowsTheCardsTitle() async {
    let got = await shown(e(), answer: answer(envelope(urgency: 2)))
    XCTAssertEqual(got.card, NotifyCard(title: secret, cardId: NotifyText.hex(objectId), sessionId: NotifyText.hex(session),
                                        senderId: NotifyText.hex(agent), permission: false, urgent: true))
    XCTAssertEqual(got.asked.map(\.absoluteString), ["https://hub.trommi.com/v2/push-envelope?ticket=\(NotifyText.b64u(ticket))"])
    // the epoch before the newest still opens (a card sealed just before a key change)
    let older = await shown(e(), answer: answer(envelope(epoch: 2))).card
    XCTAssertEqual(older?.title, secret)
    XCTAssertEqual(older?.urgent, false)
  }

  func testPermissionRequest() async {
    let p = await shown(e(), answer: answer(envelope(kind: 4, type: 3, payload: #"{"tool_name":"Bash","description":"","input_preview":"ls"}"#))).card
    XCTAssertEqual(p?.title, "Darf ich Bash benutzen?")
    XCTAssertEqual(p?.permission, true)
    let d = await shown(e(), answer: answer(envelope(kind: 4, type: 3, payload: #"{"tool_name":"Bash","description":"List the files"}"#))).card
    XCTAssertEqual(d?.title, "List the files")
  }

  func testPushWithoutTicketFetchesNothing() async {
    let got = await shown(e(ticket: []), answer: answer(envelope()))
    XCTAssertNil(got.card)
    XCTAssertTrue(got.asked.isEmpty)
  }

  func testPushThatDoesNotOpenFetchesNothing() async {
    for bad in [e(key: random(32)), e(room: random(32)), "not base64!", NotifyText.b64u(random(600))] {
      let got = await shown(bad, answer: answer(envelope()))
      XCTAssertNil(got.card)
      XCTAssertTrue(got.asked.isEmpty)
    }
    let broken = await shown(e(), answer: answer(envelope()), core: FakeCore(broken: true))
    XCTAssertNil(broken.card)
    XCTAssertTrue(broken.asked.isEmpty)
  }

  // ---- the fallbacks ----

  func testFallbacks() async {
    let cases: [(String, Data?)] = [
      ("the fetch failed or timed out", nil),
      ("not the hub's answer", Data("<html>".utf8)),
      ("an answer larger than one envelope", answer(envelope(payload: #"{"title":"\#(String(repeating: "x", count: NotifyOpen.maxAnswer))"}"#))),
      ("another envelope than the push named", answer(envelope(), change: 41)),
      ("a void record", answer(envelope(), void: true)),
      ("no key for the epoch: the app has not processed the Commit yet", answer(envelope(epoch: 4))),
      ("an epoch older than the newest two", answer(envelope(epoch: 1, key: keys[1]))),
      ("sealed under another key", answer(envelope(key: random(32)))),
      ("the signature does not hold", answer(envelope(signed: false))),
      ("a sender that is not an agent of the group", answer(envelope(sender: human))),
      ("a chat message", answer(envelope(kind: 1, type: nil))),
      ("an answer", answer(envelope(kind: 3))),
      ("a kind of a newer protocol", answer(envelope(kind: 9))),
      ("a note, not a card", answer(envelope(type: 2))),
      ("no title", answer(envelope(payload: #"{"title":"  \n "}"#))),
      ("a payload that is not an object", answer(envelope(payload: #"["Welche Farbe"]"#))),
      ("a permission request without a tool", answer(envelope(kind: 4, type: 3, payload: #"{"description":" "}"#))),
    ]
    for (why, data) in cases {
      let got = await shown(e(), answer: data)
      XCTAssertNil(got.card, why)
      XCTAssertEqual(got.asked.count, 1, why)
    }
    XCTAssertNil(NotifyOpen.card(envelope(), room: context().rooms[0], core: FakeCore(broken: true)), "the core refuses")
    XCTAssertNotNil(NotifyOpen.card(envelope(), room: context().rooms[0], core: FakeCore()))
  }

  /** What the extension shows is the fixed text unless a card came back: a failure carries no text at all. */
  func testNothingOfThePayloadLeaksIntoTheFallback() async {
    let fixed = "A new question."
    let good = await shown(e(), answer: answer(envelope())).card?.title ?? fixed
    XCTAssertEqual(good, secret)
    for data in [answer(envelope(sender: human)), answer(envelope(signed: false)), answer(envelope(kind: 1, type: nil)), answer(envelope(epoch: 4))] {
      let text = await shown(e(), answer: data).card?.title ?? fixed
      XCTAssertEqual(text, fixed)
    }
  }

  // ---- details ----

  func testTitleIsOneShortLine() {
    let room = context().rooms[0]
    let long = NotifyOpen.card(envelope(payload: #"{"title":"\#(String(repeating: "x", count: 500))"}"#), room: room, core: FakeCore())
    XCTAssertEqual(long?.title.count, NotifyOpen.maxTitle)
    XCTAssertEqual(NotifyOpen.clean("a\u{07}b\n\n c\t"), "a b c")
  }

  func testFetchAddress() {
    var room = context().rooms[0]
    room.hub = "https://hub.example/base/"
    XCTAssertEqual(NotifyOpen.envelopeURL(room: room, ticket: [0xfb, 0xff])?.absoluteString, "https://hub.example/base/v2/push-envelope?ticket=-_8")
    room.hub = "http://localhost:8787"
    XCTAssertEqual(NotifyOpen.envelopeURL(room: room, ticket: [1])?.absoluteString, "http://localhost:8787/v2/push-envelope?ticket=AQ")
    room.hub = "http://evil.example"
    XCTAssertNil(NotifyOpen.envelopeURL(room: room, ticket: [1]))
  }

  func testGroupCandidates() {
    XCTAssertEqual(NotifyGroup.candidates(bundleID: "XTL-70CB783D.com.trommi.ios.notify", infoGroup: nil), ["group.XTL-70CB783D.com.trommi.ios", "group.com.trommi.ios"])
    XCTAssertEqual(NotifyGroup.candidates(bundleID: "com.trommi.ios.live", infoGroup: "group.x"), ["group.x", "group.com.trommi.ios"])
  }

  func testCountsLine() {
    XCTAssertEqual(LiveCounts(working: 1, waiting: 3).line, "1 agent working · 3 questions waiting")
    XCTAssertEqual(LiveCounts(working: 2, waiting: 1).line, "2 agents working · 1 question waiting")
  }
}
