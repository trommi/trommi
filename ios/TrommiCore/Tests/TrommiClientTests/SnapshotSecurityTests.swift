// SnapshotSecurityTests.swift: the snapshot boot's refusals with hand-built envelopes (the JS core's vectors: a room of
// phone, laptop, agent, tablet; the room key of epoch 1): a pointer only from a human device's status under the room
// key, and in the overlap after a boot a different envelope at a sender's head is equivocation, the same one a replay.
import XCTest
@testable import TrommiCore
@testable import TrommiClient

final class SnapshotSecurityTests: XCTestCase {
  typealias J = [String: Any]
  static let v: J = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("TrommiCoreTests/Fixtures/vectors.json")
    return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! J
  }()
  func h(_ o: Any?) -> Bytes { try! unhex(o as! String) }
  func dev(_ name: String) throws -> Device { let d = (Self.v["devices"] as! J)[name] as! J; return try Device(signSeed: h(d["signSeed"]), kexPriv: h(d["kexSeed"])) }
  func state() throws -> RoomState {
    let entries = ((Self.v["log"] as! J)["entries"] as! [J]).prefix(4).map { h($0["bytes"]) }
    return try verifyLog(Array(entries), roomId: h((Self.v["room"] as! J)["roomId"]))
  }
  func roomKey() -> EpochSecret { let s = (Self.v["room"] as! J)["secret"] as! J; return EpochSecret(epoch: 1, key: h(s["key"]), hist: h(s["hist"])) }
  func pointer(at n: Int) -> Bytes {
    let v: JV = .obj(["values": .obj(["room_snapshot": .obj(["attachment": .obj(["attachment_id": .str(String(repeating: "ab", count: 16))]), "encoding": .str("gzip"),
                                                             "envelope_number": .num(Double(n)), "log_seq": .num(3), "log_hash": .str("00"), "written_at": .num(1)])]), "lamport": .num(1)])
    return v.encoded()
  }

  func testPointerOnlyFromAHumanUnderTheRoomKey() throws {
    let st = try state(), key = roomKey(), phone = try dev("phone"), agent = try dev("agent")
    let secrets: SecretLookup = { $0.keyScope == KEY_SCOPE.ROOM && $0.epoch == 1 ? key : nil }
    var c = Chains()
    // the phone's status with the pointer: accepted
    let good = try sealEnvelope(device: phone, state: st, secret: key, chains: &c, kind: KIND.STATUS, payload: pointer(at: 90), time: 1)
    XCTAssertEqual(Room.snapshotPointer(good.bytes, number: 100, state: st, secrets: secrets, me: phone.id)?.sender, hex(phone.id))
    // a pointer at a later number than the envelope that names it: refused
    XCTAssertNil(Room.snapshotPointer(good.bytes, number: 80, state: st, secrets: secrets, me: phone.id))
    // the agent forging the same under the room key (as if it held it): its signature is good, but agents hold no room key
    var forgedState = st
    let aid = hex(agent.id)
    let m = forgedState.members[aid]!
    forgedState.members[aid] = MemberState(id: m.id, role: ROLE.HUMAN, signPub: m.signPub, kexPub: m.kexPub, addedSeq: m.addedSeq, removedSeq: m.removedSeq, cut: m.cut)
    var ca = Chains()
    let forged = try sealEnvelope(device: agent, state: forgedState, secret: key, chains: &ca, kind: KIND.STATUS, payload: pointer(at: 90), time: 1)
    XCTAssertNil(Room.snapshotPointer(forged.bytes, number: 100, state: st, secrets: secrets, me: phone.id), "a pointer from an agent device is refused")
    var c2 = Chains()
    XCTAssertThrowsError(try verifyEnvelope(forged.bytes, state: st, chains: &c2, allowChainStart: true)) { XCTAssertEqual(($0 as? ZError)?.code, "forbidden") }
    // and the agent's status under a session key (where agents write): never a pointer
    var cs = Chains()
    let session = try sealEnvelope(device: agent, state: st, secret: EpochSecret(epoch: 1, key: Bytes(repeating: 7, count: 32), hist: nil), chains: &cs, kind: KIND.STATUS,
                                   keyScope: KEY_SCOPE.SESSION, sessionId: Bytes(repeating: 1, count: 16), payload: pointer(at: 90), time: 1)
    XCTAssertNil(Room.snapshotPointer(session.bytes, number: 100, state: st, secrets: { _ in EpochSecret(epoch: 1, key: Bytes(repeating: 7, count: 32), hist: nil) }, me: phone.id))
  }

  func testOverlapAfterABootEquivocationAndReplay() throws {
    let st = try state(), key = roomKey(), phone = try dev("phone"), laptop = try dev("laptop")
    let secrets: SecretLookup = { $0.keyScope == KEY_SCOPE.ROOM && $0.epoch == 1 ? key : nil }
    let msg = { (t: String) -> Bytes in JV.obj(["content_type": .str("message"), "text": .str(t)]).encoded() }
    // the phone's real envelopes 1, 2, 3
    var real = Chains()
    let e1 = try sealEnvelope(device: phone, state: st, secret: key, chains: &real, kind: KIND.TIMELINE_ITEM, payload: msg("one"), time: 1, timelineKind: TIMELINE.SCRIBBLE, timelineId: "desk/" + String(repeating: "1", count: 32))
    let e2 = try sealEnvelope(device: phone, state: st, secret: key, chains: &real, kind: KIND.TIMELINE_ITEM, payload: msg("two"), time: 2, timelineKind: TIMELINE.SCRIBBLE, timelineId: "desk/" + String(repeating: "1", count: 32))
    let after2 = real
    let e3 = try sealEnvelope(device: phone, state: st, secret: key, chains: &real, kind: KIND.TIMELINE_ITEM, payload: msg("three"), time: 3, timelineKind: TIMELINE.SCRIBBLE, timelineId: "desk/" + String(repeating: "1", count: 32))
    // a forged second envelope number 2: signed by the phone's key, other content (what a hostile hub cannot make, a
    // compromised sender could): built from the chain after envelope 1
    var fork = Chains(); fork[hex(phone.id)] = { var c = Chain(); c.seq = 1; c.hash = e1.hash; c.hashes = [1: e1.hash]; return c }()
    let forged2 = try sealEnvelope(device: phone, state: st, secret: key, chains: &fork, kind: KIND.TIMELINE_ITEM, payload: msg("not two"), time: 2, timelineKind: TIMELINE.SCRIBBLE, timelineId: "desk/" + String(repeating: "1", count: 32))
    XCTAssertNotEqual(forged2.hash, e2.hash)
    // the booted device: the snapshot's chain head for the phone is envelope 2 (only the head hash is known)
    var heads = Chains(); heads[hex(phone.id)] = { var c = Chain(); c.seq = 2; c.hash = e2.hash; c.hashes = [2: e2.hash]; return c }()
    let out = Room.check([(n: 10, bytes: e1.bytes, isVoid: false), (n: 11, bytes: forged2.bytes, isVoid: false), (n: 12, bytes: e2.bytes, isVoid: false), (n: 13, bytes: e3.bytes, isVoid: false)],
                         state: st, chains: heads, secrets: secrets, me: laptop.id, ownHashes: [])
    XCTAssertNil(out.stop)
    XCTAssertEqual(out.refused.map { $0.0 }, [11], "the different envelope at the head is refused")
    XCTAssertTrue(out.refused.first?.1.contains("equivocation") ?? false, out.refused.first?.1 ?? "")
    let replays = out.pres.filter { $0.contentState == "replay" }.map { $0.number }
    XCTAssertEqual(replays, [10, 12], "inside the head: skipped, never applied")
    XCTAssertEqual(out.pres.filter { $0.contentState == "ok" }.map { $0.number }, [13], "the tail after the head applies")
    XCTAssertEqual(out.chains[hex(phone.id)]?.seq, 3)
    _ = after2
  }
}
