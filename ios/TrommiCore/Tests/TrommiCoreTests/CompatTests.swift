// CompatTests.swift: forward compatibility (README "Versioning and compatibility"), as shared/crypto/crypto-test.mjs
// "a kind from a newer format" and shared/test.mjs "forward compatibility": an envelope kind of a newer format is
// verified and keeps the chain, a newer version byte is newer-version, records are classified, /v1/version decoded.
import Foundation
import XCTest
@testable import TrommiCore

final class CompatTests: XCTestCase {
  var v: J { VectorTests.v }
  func dev(_ name: String) throws -> Device { let d = v[j: "devices"][j: name]; return try Device(signSeed: d.h("signSeed"), kexPriv: d.h("kexSeed")) }

  /** The vectors' card (agent, session key, kind 2) re-made as kind 9 by its own agent: signed, in chain, unknown to this version. */
  func testUnknownKindIsVerifiedAndKeepsTheChain() throws {
    let e = v[j: "envelopes"], agent = try dev("agent")
    let st3 = try verifyLog(Array(v[j: "log"].a("entries").map { $0.h("bytes") }.prefix(4)), roomId: v[j: "room"].h("roomId"))
    let sessionId = e[j: "session"].h("sessionId"), sk = e[j: "session"][j: "sessionKey"]
    let session = EpochSecret(epoch: sk.i("epoch"), key: sk.h("key"), hist: sk.h("hist"))
    let secrets: SecretLookup = { h in h.keyScope == 1 ? session : nil }
    var header = e[j: "card"].h("header")
    let kindAt = 1 + 1 + 32 + 4 + 1 + 16 + 32 + 8 + 32 + 4 + 32 + 32 + 8
    XCTAssertEqual(Int(header[kindAt]), KIND.OBJECT_VERSION)
    header[kindAt] = 9
    let nonce = Bytes(repeating: 7, count: 12), payload = Array(#"{"schema_version":1,"object_type":"poll"}"#.utf8)
    let key = try deriveSenderKey(roomId: st3.roomId, secret: session, senderId: agent.id, keyScope: 1, sessionId: sessionId)
    let ct = try gcmSeal(key: key, nonce: nonce, aad: header, try encodeBody(bind: [], payload: payload))
    let envHash = hash(LABEL.envelope, header, nonce, sha256(ct))
    let bytes = try joinEnvelope(headerBytes: header, nonce: nonce, ciphertext: ct, ciphertextHash: nil, signature: try agent.sign(LABEL.envelopeSig, envHash))

    XCTAssertThrowsCode("bad-format", try peekEnvelope(bytes, strictKinds: true))
    let peek = try peekEnvelope(bytes)
    XCTAssertEqual(peek.header.kind, 9); XCTAssertFalse(peek.header.knownKind); XCTAssertNotNil(peek.header.card)
    var chains = Chains()
    let o = try openEnvelope(bytes, state: st3, chains: &chains, secrets: secrets, allowChainStart: true)
    XCTAssertEqual(o.kind, 9); XCTAssertEqual(o.payload, payload); XCTAssertNil(o.quarantined)
    XCTAssertEqual(chains[hex(agent.id)]?.hash, envHash, "the unknown kind advanced the sender's chain")
    XCTAssertEqual(Item.of(envelopeKind: o.kind), .unsupported(kind: "envelope kind 9"))
    // Tampered, it is still refused by its signature.
    var bad = bytes; bad[bad.count - 3] ^= 1
    var fresh = Chains()
    XCTAssertThrowsCode("bad-signature", try verifyEnvelope(bad, state: st3, chains: &fresh, allowChainStart: true))
    // A writer never makes one.
    var h = try decodeHeader(e[j: "card"].h("header")); h.kind = 9
    XCTAssertThrowsCode("bad-argument", try encodeHeader(h))
  }

  func testNewerVersionBytes() throws {
    var env = v[j: "envelopes"][j: "chat"].h("bytes"); env[0] = 2
    XCTAssertThrowsCode("newer-version", try splitEnvelope(env))
    env[0] = 0
    XCTAssertThrowsCode("bad-version", try splitEnvelope(env))
    var header = v[j: "envelopes"][j: "chat"].h("header"); header[0] = 2
    XCTAssertThrowsCode("newer-version", try decodeHeader(header))
    var body = try encodeBody(bind: [], payload: Array("{}".utf8)); body[0] = 2
    XCTAssertThrowsCode("newer-version", try decodeBody(body))
    XCTAssertThrowsCode("newer-version", try decodeBind(kind: KIND.ANSWER, [2]))
  }

  func testItemClassification() {
    XCTAssertEqual(Item.of(envelopeKind: KIND.TIMELINE_ITEM, timelineKind: 1, schemaVersion: 1, contentType: "message"), .supported)
    XCTAssertEqual(Item.of(envelopeKind: KIND.TIMELINE_ITEM, timelineKind: 1, contentType: "voice"), .unsupported(kind: "content_type voice"))
    XCTAssertEqual(Item.of(envelopeKind: KIND.TIMELINE_ITEM, timelineKind: 3, contentType: "message"), .unsupported(kind: "timeline kind 3"))
    XCTAssertEqual(Item.of(envelopeKind: KIND.OBJECT_VERSION, schemaVersion: 2, objectType: "card"), .unsupported(kind: "schema_version 2"))
    XCTAssertEqual(Item.of(envelopeKind: KIND.OBJECT_VERSION, objectType: "card", cardType: "poll"), .unsupported(kind: "card_type poll"))
    XCTAssertEqual(Item.of(envelopeKind: KIND.OBJECT_VERSION, objectType: "card", cardType: "info"), .supported)
    XCTAssertEqual(Item.of(envelopeKind: KIND.OBJECT_VERSION, objectType: "checklist"), .unsupported(kind: "object_type checklist"))
    XCTAssertEqual(Item.of(envelopeKind: KIND.OBJECT_VERSION, objectType: "note", cardType: "whatever"), .supported, "card_type matters on cards only")
    XCTAssertEqual(Item.of(envelopeKind: KIND.ANSWER, answerAction: "snooze"), .unsupported(kind: "answer_action snooze"))
    XCTAssertTrue(Item.of(envelopeKind: KIND.ANSWER, answerAction: "shred").isSupported)
    XCTAssertTrue(Item.of(envelopeKind: KIND.STATUS).isSupported)
  }

  func testHubVersionInfo() throws {
    let body = #"{"protocol_versions_supported":[1],"minimum_client_versions":{"ios":"1.2.0","app":"0.2.0"},"recommended_client_versions":{"ios":"1.4.0"},"message":"Bitte aktualisieren.","later_field":{"x":1}}"#
    let info = try XCTUnwrap(HubVersionInfo.parse(Data(body.utf8)))
    XCTAssertEqual(info.minimumClientVersions["ios"], "1.2.0")
    XCTAssertEqual(info.writeSchemaVersion, 1, "nothing said: 1")
    XCTAssertEqual(HubVersionInfo.parse(Data(#"{"write_format_versions":{"envelope":1,"schema":3}}"#.utf8))?.writeSchemaVersion, Compat.SCHEMA_VERSION, "never above its own")
    XCTAssertEqual(info.verdict(version: "1.1.9"), .updateRequired(minimum: "1.2.0", message: "Bitte aktualisieren."))
    XCTAssertEqual(info.verdict(version: "1.2.0"), .updateAvailable(recommended: "1.4.0"))
    XCTAssertEqual(info.verdict(version: "1.4.0-beta.1"), .current)
    XCTAssertEqual(info.verdict(version: "2.0"), .current)
    let bare = try XCTUnwrap(HubVersionInfo.parse(Data("{}".utf8)))
    XCTAssertEqual(bare.verdict(version: "0.0.1"), .current, "an older hub that says nothing")
    let newer = try XCTUnwrap(HubVersionInfo.parse(Data(#"{"protocol_versions_supported":[2,3]}"#.utf8)))
    XCTAssertEqual(newer.verdict(version: "9.9.9"), .updateRequired(minimum: nil, message: "Please update Trommi."))
    XCTAssertNil(HubVersionInfo.parse(Data("[1]".utf8)))
    XCTAssertEqual([compareVersions("1.10.0", "1.9.9"), compareVersions("1.2", "1.2.0"), compareVersions("0.9.0", "1.0.0")], [1, 0, -1])
  }
}
