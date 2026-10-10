// The Notification Service Extension's logic with a fake core and a fake Keychain: the context's round trip, a push
// that opens, and every push that must leave the hub's fixed text (nil here). The extension shows no content: the
// context holds no content key, and nothing is fetched.
import XCTest
@testable import PushNotify

/** The Keychain item of the tests: bytes in memory. */
final class MemoryStorage: NotifyStorage {
  var bytes: [UInt8]?
  func read() -> [UInt8]? { bytes }
  func write(_ b: [UInt8]) throws { bytes = b }
  func clear() { bytes = nil }
}

/** A core that seals nothing: a "sealed" push is its key followed by a JSON text. It refuses, like the real one, a wrong key. */
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
  private func bytes(_ v: Any?) -> [UInt8] { ((v as? [NSNumber]) ?? []).map(\.uint8Value) }
}

final class PushNotifyTests: XCTestCase {
  func random(_ n: Int) -> [UInt8] { (0..<n).map { _ in UInt8.random(in: 0...255) } }
  lazy var roomId = random(32)
  lazy var pushKey = random(32)
  let ticket: [UInt8] = Array("room-device-change-expiry-mac".utf8)

  func context() -> NotifyContext { NotifyContext(pushKey: pushKey, rooms: [NotifyText.hex(roomId)]) }

  func e(ticket t: [UInt8]? = nil, key: [UInt8]? = nil, room: [UInt8]? = nil, change: UInt64 = 42, urgency: UInt8 = 1) -> String {
    NotifyText.b64u(FakeCore.sealPush(key: key ?? pushKey, ApnsPush(roomId: room ?? roomId, change: change, urgency: urgency, ticket: t ?? ticket)))
  }

  // ---- the context ----

  func testContextRoundTripThroughTheStorage() throws {
    let storage = MemoryStorage()
    let store = NotifyStore(storage: storage)
    XCTAssertNil(store.read())
    let c = context()
    try store.write(c)
    XCTAssertEqual(store.read(), c)
    XCTAssertEqual(store.read()?.holds(room: roomId), true)
    XCTAssertEqual(store.read()?.holds(room: random(32)), false)
    try store.write(c)
    store.clear()
    XCTAssertNil(storage.bytes)
    XCTAssertNil(store.read())
  }

  /// The context is the push key and the rooms' ids, and nothing else: no content key, no session, no name.
  func testTheContextHoldsNoContentKey() throws {
    let storage = MemoryStorage()
    try NotifyStore(storage: storage).write(context())
    let stored = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(storage.bytes))) as? [String: Any])
    XCTAssertEqual(Set(stored.keys), ["version", "pushKey", "rooms"])
    XCTAssertEqual(stored["version"] as? Int, 3)
    XCTAssertEqual(stored["rooms"] as? [String], [NotifyText.hex(roomId)])
  }

  /// What an older build stored (version 2, with the sessions' content keys) is not read: the extension then has no
  /// context and shows the fixed text, until the app wrote today's.
  func testAContextOfAnotherVersionIsNotRead() {
    let storage = MemoryStorage()
    let store = NotifyStore(storage: storage)
    storage.bytes = Array(#"{"version":2,"pushKey":"","rooms":[{"roomId":"00","hub":"https://hub.example","me":"00","keys":[],"sessions":{}}]}"#.utf8)
    XCTAssertNil(store.read())
    storage.bytes = Array(#"{"version":1,"pushKey":"","rooms":[]}"#.utf8)
    XCTAssertNil(store.read())
    storage.bytes = Array(#"{"version":2,"pushKey":"","rooms":[]}"#.utf8)
    XCTAssertNil(store.read())
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

  /// A push sealed under this phone's key for a room it is in opens: the room, the change, the urgency. No content.
  func testAPushOpensToRoomChangeAndUrgency() {
    let push = NotifyOpen.push(e(urgency: 2), context: context(), core: FakeCore())
    XCTAssertEqual(push, ApnsPush(roomId: roomId, change: 42, urgency: 2, ticket: ticket))
    XCTAssertEqual(push.map(NotifyOpen.thread), String(NotifyText.hex(roomId).prefix(16)))
    // A push without a ticket opens the same: the ticket is not used.
    XCTAssertEqual(NotifyOpen.push(e(ticket: []), context: context(), core: FakeCore())?.change, 42)
  }

  /// Everything else leaves the notification as it came (nil): another key, a room this phone is not in, bytes that
  /// are no sealed push, one that is too long, a core that refuses, a context without a usable key.
  func testAPushThatDoesNotOpenGivesNothing() {
    for bad in [e(key: random(32)), e(room: random(32)), "not base64!", "", NotifyText.b64u(random(600))] {
      XCTAssertNil(NotifyOpen.push(bad, context: context(), core: FakeCore()), bad)
    }
    XCTAssertNil(NotifyOpen.push(e(), context: context(), core: FakeCore(broken: true)))
    XCTAssertNil(NotifyOpen.push(e(), context: NotifyContext(pushKey: pushKey, rooms: []), core: FakeCore()))
    XCTAssertNil(NotifyOpen.push(e(key: [1, 2, 3]), context: NotifyContext(pushKey: [1, 2, 3], rooms: [NotifyText.hex(roomId)]), core: FakeCore()))
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
