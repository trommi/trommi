// ExtraTests.swift: what vectors.json does not cover, against Fixtures/extra-vectors.json (written by the JS core,
// dev/ios-extra-vectors.mjs): session grants, the account KDF, the check emoji table; and Argon2id against RFC 9106.
import Foundation
import XCTest
@testable import TrommiCore

final class ExtraTests: XCTestCase {
  static let x = fixture("extra-vectors")
  static let v = fixture("vectors")
  func dev(_ name: String) throws -> Device { let d = Self.v[j: "devices"][j: name]; return try Device(signSeed: d.h("signSeed"), kexPriv: d.h("kexSeed")) }

  func testSessionGrants() throws {
    let s = Self.x[j: "sessions"]
    let room = try verifyLog((s["log"] as! [String]).map { try unhex($0) }, roomId: Self.v[j: "room"].h("roomId"))
    let phone = try dev("phone"), agent = try dev("agent"), laptop = try dev("laptop")
    let grants = s.a("grants")
    var ss: SessionState? = nil
    var secrets = [Int: EpochSecret]()
    for g in grants {
      ss = try applyGrant(ss, g.h("grant"), room)
      XCTAssertEqual(ss!.grantHash, g.h("grantHash"))
      XCTAssertEqual(ss!.epoch, g.i("epoch"))
      XCTAssertEqual(ss!.agentIds, [hex(agent.id)])
      XCTAssertFalse(ss!.stale)
      let wraps = try g.a("wraps").map { (id: try unhex($0.s("id")), sealed: try unhex($0.s("sealed"))) }
      XCTAssertEqual(try grantManifestHash(wraps), g.h("manifestHash"), "the manifest over the JS wraps")
      XCTAssertEqual(ss!.manifestHash, g.h("manifestHash"))
      // Every holder opens its wrap: humans and the recovery key with history, the agent without.
      let mine = wraps.first { bytesEqual($0.id, phone.id) }!
      let opened = try unwrapSessionKey(roomId: room.roomId, sessionState: ss!, device: phone, sealed: mine.sealed, epoch: ss!.epoch)
      XCTAssertEqual(opened.key, g[j: "secret"].h("key")); XCTAssertEqual(opened.hist, g[j: "secret"].h("hist"))
      let a = try unwrapSessionKey(roomId: room.roomId, sessionState: ss!, device: agent, sealed: wraps.first { bytesEqual($0.id, agent.id) }!.sealed, epoch: ss!.epoch)
      XCTAssertNil(a.hist)
      XCTAssertNotNil(wraps.first { bytesEqual($0.id, laptop.id) })
      XCTAssertThrowsCode("decrypt-failed", try unwrapSessionKey(roomId: room.roomId, sessionState: ss!, device: laptop, sealed: mine.sealed, epoch: ss!.epoch))
      secrets[ss!.epoch] = opened
    }
    XCTAssertEqual(try sessionCommits(sessionId: s.h("sessionId"), secrets[2]!).keyCommit, s.h("keyCommit"))
    // The back link of the rotation opens epoch 1, checked against the commitments in the grant chain.
    XCTAssertEqual(try openSessionBackLink(roomId: room.roomId, sessionState: ss!, secret: secrets[2]!, link: grants[1].h("backLink")), secrets[1]!)
    // A grant out of order, or applied twice, is refused.
    XCTAssertThrowsCode("bad-grant", try applyGrant(nil, grants[1].h("grant"), room))
    XCTAssertThrowsCode("bad-grant", try applyGrant(ss, grants[1].h("grant"), room))
    var tampered = grants[0].h("grant"); tampered[tampered.count - 1] ^= 1
    XCTAssertThrowsCode("bad-signature", try applyGrant(nil, tampered, room))
    // The agent's card under the session key, opened by the phone.
    var chains = Chains()
    let sid = s.h("sessionId")
    let o = try openEnvelope(s[j: "card"].h("bytes"), state: room, chains: &chains, secrets: { h in bytesEqual(h.sessionId, sid) ? secrets[h.epoch] : nil })
    let card = try JSONSerialization.jsonObject(with: Data(o.payload!)) as! J
    XCTAssertEqual(card.s("title"), s[j: "card"].s("title"))
    XCTAssertEqual(o.header.card?.urgency, 2)
    // Our own grant (a re-seal by the laptop) verifies in the chain, and a rotation with a back link.
    let reseal = try createSessionGrant(state: room, signer: laptop, sessionState: ss, current: secrets[2]!, agentIds: [agent.id])
    XCTAssertEqual(reseal.sessionState.epoch, 2)
    let rot = try createSessionGrant(state: room, signer: laptop, sessionState: reseal.sessionState, current: secrets[2]!, agentIds: [agent.id], rotate: true)
    XCTAssertEqual(try openSessionBackLink(roomId: room.roomId, sessionState: rot.sessionState, secret: rot.secret, link: rot.backLink!), secrets[2]!)
    XCTAssertEqual(try grantManifestHash(rot.wraps), rot.sessionState.manifestHash)
  }

  func testCheckEmojiTable() throws {
    let table = Self.x["checkEmoji"] as! [[String]]
    XCTAssertEqual(table.count, 64)
    XCTAssertEqual(CHECK_EMOJI.count, 64)
    for (i, e) in table.enumerated() { XCTAssertEqual(CHECK_EMOJI[i].emoji, e[0]); XCTAssertEqual(CHECK_EMOJI[i].word, e[1]) }
    XCTAssertEqual(checkEmoji("08-27-06-25-44-09").map { $0.word }, ["panda", "pizza", "elephant", "strawberry", "paperclip", "rooster"])
    XCTAssertEqual(checkEmoji("08-27-64").count, 0)
    XCTAssertEqual(checkEmoji("nonsense").count, 0)
  }

  /** RFC 9106 section 5.3: the Argon2id test vector (with secret and associated data, 4 lanes, 32 KiB, 3 passes). */
  func testArgon2idRFC9106() throws {
    let tag = try argon2id(password: Bytes(repeating: 1, count: 32), salt: Bytes(repeating: 2, count: 16), iterations: 3, memoryKiB: 32, parallelism: 4, length: 32,
                           secret: Bytes(repeating: 3, count: 8), ad: Bytes(repeating: 4, count: 12))
    XCTAssertEqual(hex(tag), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659")
  }

  /** The account KDF with the app's parameters (Argon2id, 64 MiB, t = 3), against hash-wasm in the JS core. */
  func testAccount() throws {
    let a = Self.x[j: "account"]
    XCTAssertEqual(try normaliseEmail(a.s("email")), a.s("normalisedEmail"))
    XCTAssertEqual(accountSalt(a.s("normalisedEmail")), a.h("salt"))
    let started = Date()
    let master = try accountMasterKey(email: a.s("normalisedEmail"), password: a.s("password"))
    print("Argon2id 64 MiB, t=3: \(Int(Date().timeIntervalSince(started) * 1000)) ms")
    XCTAssertEqual(master, a.h("master"))
    let keys = try accountPasswordKeys(email: a.s("email"), password: a.s("password"))
    XCTAssertEqual(keys.authKey, a.s("authKey"))
    XCTAssertEqual(try accountUnwrapCode(wrapKey: keys.wrapKey, roomId: a.s("roomId"), blob: a.s("keyWrapped")), a.s("code"))
    XCTAssertThrowsCode("wrong-login", try accountUnwrapCode(wrapKey: Bytes(repeating: 0, count: 32), roomId: a.s("roomId"), blob: a.s("keyWrapped")))
  }
}
