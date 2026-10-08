// The Notification Service Extension's logic: the sealed context, `e` of a push, and one card's envelope opened with
// nothing but an agent's per-sender key; every check that must refuse.
import XCTest
@testable import TrommiCore
@testable import PushNotify

final class PushNotifyTests: XCTestCase {
  let roomId = systemRandom(32)
  let sid = systemRandom(16)
  let secret = EpochSecret(epoch: 3, key: systemRandom(32), hist: nil)
  lazy var agent = try! Device.generate()
  lazy var other = try! Device.generate()
  let objectId = systemRandom(16)

  func room(agents: [Device]? = nil) -> NotifyRoom {
    let a = agents ?? [agent]
    return NotifyRoom.build(roomId: roomId, hub: "https://hub.trommi.com", me: systemRandom(32), agents: a.map { ($0.id, $0.signPub) },
                            sessions: [NotifySessionInput(sessionId: sid, agentIds: a.map(\.id), secrets: [secret, EpochSecret(epoch: 1, key: systemRandom(32), hist: nil), EpochSecret(epoch: 2, key: systemRandom(32), hist: nil)],
                                                          show: NotifySession(agent: "abc", agentDevice: hex(agent.id), name: "Design", mark: nil))])
  }

  /** An envelope as an agent's connector seals it (Envelope.swift sealEnvelope, without a member list). */
  func envelope(from d: Device? = nil, kind: Int = KIND.OBJECT_VERSION, push: Bool = true, room rid: Bytes? = nil, time: UInt64 = nowMs(), epoch: Int? = nil,
                payload: String = #"{"schema_version":1,"object_type":"card","title":"Welche Farbe\n für den Knopf?"}"#, tamper: Bool = false) throws -> Bytes {
    let d = d ?? agent
    let h = Header(push: push, roomId: rid ?? roomId, epoch: epoch ?? secret.epoch, keyScope: KEY_SCOPE.SESSION, sessionId: sid, sender: d.id, seq: 5, prev: systemRandom(32),
                   logSeq: 2, logHash: systemRandom(32), recipient: ZERO32, time: time, kind: kind, card: ObjectBlock(id: objectId, state: 1, urgency: 2))
    let hb = try encodeHeader(h)
    let nonce = systemRandom(12)
    let key = try deriveSenderKey(roomId: rid ?? roomId, secret: secret, senderId: d.id, keyScope: KEY_SCOPE.SESSION, sessionId: sid)
    var ct = try gcmSeal(key: key, nonce: nonce, aad: hb, try encodeBody(bind: [], payload: utf8(payload)))
    let sig = try d.sign(LABEL.envelopeSig, hash(LABEL.envelope, hb, nonce, sha256(ct)))
    if tamper { ct[0] ^= 1 }
    return try joinEnvelope(headerBytes: hb, nonce: nonce, ciphertext: ct, ciphertextHash: nil, signature: sig)
  }

  func testContextKeepsOnlyPerSenderKeysOfTheNewestEpochs() throws {
    let r = room(agents: [agent, other])
    XCTAssertEqual(Set(r.keys.map(\.epoch)), [2, 3])
    XCTAssertEqual(r.keys.count, 4)
    XCTAssertFalse(r.keys.contains { $0.key == b64u(secret.key) })
    XCTAssertEqual(r.key(sender: hex(agent.id), session: hex(sid), epoch: 3), try deriveSenderKey(roomId: roomId, secret: secret, senderId: agent.id, keyScope: KEY_SCOPE.SESSION, sessionId: sid))
    // a human (or anyone not given as an agent) gets no key even if listed in the session
    let r2 = NotifyRoom.build(roomId: roomId, hub: "h", me: [], agents: [(agent.id, agent.signPub)], sessions: [NotifySessionInput(sessionId: sid, agentIds: [agent.id, other.id], secrets: [secret], show: nil)])
    XCTAssertEqual(r2.keys.map(\.sender), [hex(agent.id)])
  }

  func testContextSealing() throws {
    let c = NotifyContext(pushKey: b64u(systemRandom(32)), rooms: [room()])
    let k = systemRandom(32)
    let sealed = try NotifySeal.seal(c, key: k)
    XCTAssertEqual(NotifySeal.open(sealed, key: k), c)
    XCTAssertNil(NotifySeal.open(sealed, key: systemRandom(32)))
    var bad = sealed; bad[20] ^= 1
    XCTAssertNil(NotifySeal.open(bad, key: k))
    let look = LiveLook(mark: "iVBOR", name: "Design")
    XCTAssertEqual(LiveLook.open(try look.seal(key: k), key: k), look)
    XCTAssertNil(LiveLook.open(try look.seal(key: k), key: systemRandom(32)))
  }

  func testMessageOfAPush() throws {
    let pk = systemRandom(32)
    let rid = hex(roomId)
    let seal = { (json: String) -> String in let n = systemRandom(12); return b64u(n + (try! gcmSeal(key: pk, nonce: n, aad: utf8("trommi-apns-v1"), utf8(json)))) }
    let m = NotifyOpen.message(seal(#"{"room_id":"\#(rid)","envelope_number":42,"urgency":2,"t":"TICKET"}"#), pushKey: pk)
    XCTAssertEqual(m, PushMessage(roomId: rid, envelopeNumber: 42, urgency: 2, ticket: "TICKET", kind: nil, state: nil, deviceId: nil))
    XCTAssertNil(NotifyOpen.message(seal(#"{"room_id":"\#(rid)"}"#), pushKey: systemRandom(32)))
    XCTAssertNil(NotifyOpen.message("not base64!", pushKey: pk))
    let lost = NotifyOpen.message(seal(#"{"room_id":"\#(rid)","kind":"agent-lost","state":"gone","device_id":"\#(hex(agent.id))","since":1}"#), pushKey: pk)!
    XCTAssertEqual(NotifyOpen.lostText(lost, room: room()), "Design hat die Verbindung verloren.")
    XCTAssertNil(NotifyOpen.lostText(lost, room: nil))
  }

  func testCardOpensWithTheAgentsSenderKey() throws {
    let c = NotifyOpen.card(try envelope(), room: room())
    XCTAssertEqual(c, NotifyCard(title: "Welche Farbe für den Knopf?", cardId: hex(objectId), sessionId: hex(sid), senderId: hex(agent.id), permission: false))
    let p = NotifyOpen.card(try envelope(kind: KIND.PERMISSION_REQUEST, payload: #"{"schema_version":1,"tool_name":"Bash","description":"","input_preview":"ls"}"#), room: room())
    XCTAssertEqual(p?.title, "Darf ich Bash benutzen?")
    XCTAssertEqual(p?.permission, true)
    let long = NotifyOpen.card(try envelope(payload: #"{"object_type":"card","title":"\#(String(repeating: "x", count: 500))"}"#), room: room())
    XCTAssertEqual(long?.title.count, NotifyOpen.maxTitle)
  }

  func testCardRefusals() throws {
    let r = room()
    XCTAssertNil(NotifyOpen.card(try envelope(push: false), room: r), "no push flag: the hub may not swap in any envelope")
    XCTAssertNil(NotifyOpen.card(try envelope(room: systemRandom(32)), room: r), "another room")
    XCTAssertNil(NotifyOpen.card(try envelope(time: nowMs() - NotifyOpen.maxAgeMs - 60_000), room: r), "too old")
    XCTAssertNil(NotifyOpen.card(try envelope(time: nowMs() + 3_600_000), room: r), "from the future")
    XCTAssertNil(NotifyOpen.card(try envelope(from: other), room: r), "a sender not in the list")
    XCTAssertNil(NotifyOpen.card(try envelope(tamper: true), room: r), "a changed ciphertext breaks the signature")
    XCTAssertNil(NotifyOpen.card(try envelope(epoch: 9), room: r), "an epoch the context has no key for")
    XCTAssertNil(NotifyOpen.card(try envelope(payload: #"{"object_type":"note","title":"x"}"#), room: r), "not a card")
    XCTAssertNil(NotifyOpen.card(try envelope(payload: #"{"object_type":"card","title":"  \n "}"#), room: r), "no title")
    XCTAssertNil(NotifyOpen.card(try pruneEnvelope(try envelope()), room: r), "pruned")
    // signed by the agent, but the key in the context is another agent's: does not open
    var swapped = r
    swapped.senders[hex(other.id)] = b64u(other.signPub)
    swapped.keys = swapped.keys.map { var k = $0; k.key = b64u(systemRandom(32)); return k }
    XCTAssertNil(NotifyOpen.card(try envelope(), room: swapped))
  }

  func testFetchAddressAndAnswer() throws {
    let r = room()
    let u = NotifyOpen.envelopeURL(room: r, number: 7, ticket: "abc-_")!
    XCTAssertEqual(u.absoluteString, "https://hub.trommi.com/v1/rooms/\(hex(roomId))/push_envelope?envelope_number=7&device_id=\(r.me)&ticket=abc-_")
    var plain = r; plain.hub = "http://evil.example"
    XCTAssertNil(NotifyOpen.envelopeURL(room: plain, number: 7, ticket: "t"))
    let env = try envelope()
    XCTAssertEqual(NotifyOpen.envelope(fromAnswer: Data(#"{"envelope_number":7,"envelope":"\#(b64u(env))"}"#.utf8), number: 7), env)
    XCTAssertNil(NotifyOpen.envelope(fromAnswer: Data(#"{"envelope_number":8,"envelope":"\#(b64u(env))"}"#.utf8), number: 7))
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
