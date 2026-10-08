// VectorTests.swift: every section of shared/crypto/vectors.json (copied to Fixtures/), byte for byte where the bytes are
// deterministic, and by verifying where they are Ed25519 signatures (CryptoKit signs with randomness on Apple platforms).
import Foundation
import XCTest
@testable import TrommiCore

typealias J = [String: Any]
func fixture(_ name: String) -> J {
  let url = Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: "json")!
  return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! J
}
extension Dictionary where Key == String, Value == Any {
  subscript(j key: String) -> J { self[key] as! J }
  func s(_ key: String) -> String { self[key] as! String }
  func h(_ key: String) -> Bytes { try! unhex(self[key] as! String) }
  func i(_ key: String) -> Int { (self[key] as! NSNumber).intValue }
  func u(_ key: String) -> UInt64 { (self[key] as! NSNumber).uint64Value }
  func a(_ key: String) -> [J] { self[key] as! [J] }
}
func XCTAssertThrowsCode(_ code: String, _ expr: @autoclosure () throws -> Any, file: StaticString = #filePath, line: UInt = #line) {
  do { _ = try expr(); XCTFail("expected \(code), nothing thrown", file: file, line: line) }
  catch let e as ZError { XCTAssertEqual(e.code, code, "\(e)", file: file, line: line) }
  catch { XCTFail("expected ZError \(code), got \(error)", file: file, line: line) }
}

final class VectorTests: XCTestCase {
  static let v = fixture("vectors")
  var v: J { Self.v }
  func dev(_ name: String) throws -> Device { let d = v[j: "devices"][j: name]; return try Device(signSeed: d.h("signSeed"), kexPriv: d.h("kexSeed")) }
  func logBytes() -> [Bytes] { v[j: "log"].a("entries").map { $0.h("bytes") } }
  func state(upTo n: Int) throws -> RoomState { try verifyLog(Array(logBytes().prefix(n + 1)), roomId: v[j: "room"].h("roomId")) }
  func recovery() throws -> Device { try recoveryDevice(v[j: "recovery"].s("code")) }

  func testEncoding() throws {
    let e = v[j: "encoding"]
    XCTAssertEqual(b64u(e.h("bytes")), e.s("base64url"))
    XCTAssertEqual(try unb64u(e.s("base64url")), e.h("bytes"))
    XCTAssertThrowsCode("bad-format", try unb64u("APv_EA=="))
    XCTAssertThrowsCode("bad-format", try unb64u("APv_EB"))           // non-zero trailing bits
    XCTAssertThrowsCode("bad-format", try unb64u("A"))
    let hh = e[j: "hash"]
    XCTAssertEqual(hash(hh.s("label"), hh.h("data")), hh.h("out"))
    let k = e[j: "hkdf"]
    XCTAssertEqual(hkdf(k.h("ikm"), salt: k.h("salt"), label: k.s("label"), context: k.h("context"), length: k.i("length")), k.h("out"))
  }

  func testDevices() throws {
    for name in ["phone", "laptop", "agent", "tablet", "helper"] {
      let d = v[j: "devices"][j: name], x = try dev(name)
      XCTAssertEqual(x.signPub, d.h("signPub")); XCTAssertEqual(x.kexPub, d.h("kexPub")); XCTAssertEqual(x.id, d.h("id"))
      if d["secretFile"] != nil { XCTAssertEqual(x.exportSecret(), d.h("secretFile")); XCTAssertEqual(try Device.importSecret(d.h("secretFile")).id, x.id) }
    }
  }

  func testSignature() throws {
    let s = v[j: "signature"], phone = try dev("phone")
    XCTAssertTrue(verify(phone.signPub, s.s("label"), s.h("message"), s.h("signature")), "the JS signature verifies")
    let mine = try phone.sign(s.s("label"), s.h("message"))
    XCTAssertTrue(verify(phone.signPub, s.s("label"), s.h("message"), mine), "our signature verifies")
    XCTAssertFalse(verify(phone.signPub, "trommi/v1/hub-auth", s.h("message"), mine), "labels separate domains")
  }

  func testRecovery() throws {
    let r = v[j: "recovery"]
    XCTAssertEqual(try formatRecoveryCode(seededRNG(r.i("rngSeed"))(32)), r.s("code"))
    XCTAssertEqual(try parseRecoveryCode(r.s("code")), r.h("raw"))
    XCTAssertEqual(try parseRecoveryCode(r.s("code").lowercased().replacingOccurrences(of: "-", with: " ")), r.h("raw"))
    let d = try recovery()
    XCTAssertEqual(d.signPub, r.h("signPub")); XCTAssertEqual(d.kexPub, r.h("kexPub")); XCTAssertEqual(d.id, r.h("id"))
    XCTAssertThrowsCode("bad-recovery-code", try parseRecoveryCode("1234"))
  }

  func testSealedBox() throws {
    let s = v[j: "sealedBox"], laptop = try dev("laptop")
    let sealed = try seal(laptop.kexPub, s.h("plaintext"), aad: s.h("aad"), rng: seededRNG(s.i("rngSeed")))
    XCTAssertEqual(sealed, s.h("sealed"), "byte for byte, with the fixed ephemeral key")
    XCTAssertEqual(try openSealed(laptop, s.h("sealed"), aad: s.h("aad")), s.h("plaintext"))
    XCTAssertThrowsCode("decrypt-failed", try openSealed(laptop, s.h("sealed"), aad: []))
    XCTAssertThrowsCode("decrypt-failed", try openSealed(try dev("phone"), s.h("sealed"), aad: s.h("aad")))
  }

  func testRoom() throws {
    let r = v[j: "room"], phone = try dev("phone"), rec = try recovery()
    let st = try applyEntry(nil, r.h("genesis"))
    XCTAssertEqual(st.roomId, r.h("roomId"))
    let e = try decodeEntry(r.h("genesis"))
    XCTAssertEqual(try encodeEntryBody(e), e.body, "decode and encode give the same body")
    // The founding entry rebuilt from the same randomness: same body; the signature verifies (and ours does too).
    let rng = seededRNG(r.i("rngSeed"))
    let nonce = rng(16), secret = EpochSecret(epoch: 1, key: rng(32), hist: rng(32))
    XCTAssertEqual(secret.key, r[j: "secret"].h("key")); XCTAssertEqual(secret.hist, r[j: "secret"].h("hist"))
    let c = epochCommits(secret)
    XCTAssertEqual(c.keyCommit, r.h("keyCommit")); XCTAssertEqual(c.histCommit, r.h("histCommit"))
    var g = Entry(type: ENTRY.GENESIS, seq: 0, prev: ZERO32, time: r.u("time"), signerKind: SIGNER.DEVICE, signer: phone.id)
    g.roomNonce = nonce; g.member = Member(role: ROLE.HUMAN, signPub: phone.signPub, kexPub: phone.kexPub); g.recovery = (rec.signPub, rec.kexPub)
    g.epoch = 1; g.keyCommit = c.keyCommit; g.histCommit = c.histCommit
    XCTAssertEqual(try encodeEntryBody(g), e.body)
    let mine = try signEntry(g, phone)
    XCTAssertEqual(try applyEntry(nil, mine).roomId, st.roomId, "our signed genesis gives the same room id")
    // Wraps: byte for byte with the same ephemeral keys, and they open to the epoch secret.
    let wraps = r.a("wraps")
    XCTAssertEqual(try wrapEpochKey(st, secret, phone.id, rng: rng), wraps[0].h("sealed"))
    XCTAssertEqual(try wrapEpochKey(st, secret, rec.id, rng: rng), wraps[1].h("sealed"))
    XCTAssertEqual(try unwrapEpochKey(st, phone, wraps[0].h("sealed"), epoch: 1), secret)
    XCTAssertEqual(try unwrapEpochKey(st, rec, wraps[1].h("sealed"), epoch: 1), secret)
  }

  func testInvites() throws {
    let entries = logBytes()
    let names = ["phone": try dev("phone"), "laptop": try dev("laptop"), "agent": try dev("agent"), "helper": try dev("helper")]
    let joining = ["Laptop": "laptop", "Agent": "agent", "Helper": "helper"]
    for inv in v.a("invites") {
      let before = inv.i("logSeqBefore")
      let state = try verifyLog(Array(entries.prefix(before + 1)), roomId: v[j: "room"].h("roomId"))
      let inviter = names[inv.s("inviter")]!, device = names[joining[inv.s("name")]!]!
      let made = try createInvite(state: state, inviter: inviter, hub: inv.s("hub"), role: inv.i("role"), app: inv.s("app"), now: inv.u("now") , rng: seededRNG(inv.i("rngSeed")))
      XCTAssertEqual(made.link, inv.s("link"))
      XCTAssertEqual(made.invite.inviteId, inv.h("inviteId"))
      XCTAssertEqual(made.invite.expiresAt, inv.u("expiresAt"))
      let offer = inv.h("offer")
      XCTAssertEqual(Array(made.offer.dropLast(64)), Array(offer.dropLast(64)), "offer body")
      XCTAssertNoThrow(try verifyInviteOffer(state, made.offer, now: inv.u("now")))
      XCTAssertNoThrow(try verifyInviteOffer(state, offer, now: inv.u("now")))
      XCTAssertEqual(try inviteOfferHash(offer), inv.h("offerHash"))
      let link = try parseInviteLink(inv.s("link"))
      XCTAssertEqual(link.hub, inv.s("hub")); XCTAssertEqual(link.secret, inv.h("secret"))
      // The joining device's request: body and MAC byte for byte (the MAC is deterministic), signature verified.
      let (request, join) = try createJoinRequest(link: inv.s("link"), offer: offer, log: Array(entries.prefix(before + 1)), device: device, now: inv.u("now"))
      let vreq = inv.h("request")
      XCTAssertEqual(Array(request.dropLast(64)), Array(vreq.dropLast(64)), "request body and MAC")
      XCTAssertNoThrow(try verifyInviteRequest(vreq)); XCTAssertNoThrow(try verifyInviteRequest(request))
      XCTAssertEqual(inviteRequestHash(vreq), inv.h("requestHash"))
      XCTAssertEqual(inviteRequestHash(request), inv.h("requestHash"), "hashes never cover a signature (R9)")
      // The inviter's reveal and the check code.
      let acc = try acceptJoinRequest(invite: made.invite, request: vreq, inviter: inviter, now: inv.u("now"))
      XCTAssertEqual(Array(acc.reveal.dropLast(64)), Array(inv.h("reveal").dropLast(64)))
      XCTAssertEqual(acc.code, inv.s("checkCode"))
      XCTAssertEqual(try checkReveal(join: join, reveal: inv.h("reveal"), log: Array(entries.prefix(before + 1))), inv.s("checkCode"))
      XCTAssertEqual(checkEmoji(inv.s("checkCode")).count, 6)
      // The add entry, and the joining device's end of it.
      let entry = try decodeEntry(inv.h("entry"))
      XCTAssertEqual(entry.inviteId, inv.h("inviteId"))
      XCTAssertEqual(try encodeEntryBody(entry), entry.body)
      XCTAssertEqual(inv.h("entry"), entries[before + 1])
      let done = try completeJoin(join: join, device: device, log: Array(entries.prefix(before + 2)), wrap: inv["wrap"] is NSNull ? nil : inv.h("wrap"))
      if let opened = inv["roomKeyOpened"] as? J {
        XCTAssertEqual(done.secret?.key, opened.h("key")); XCTAssertEqual(done.secret?.hist, opened.h("hist"))
        // The wrap byte for byte from the wrap generator.
        let room = v[j: "room"][j: "secret"]
        XCTAssertEqual(try wrapEpochKey(done.state, EpochSecret(epoch: 1, key: room.h("key"), hist: room.h("hist")), device.id, rng: seededRNG(inv.i("wrapRngSeed"))), inv.h("wrap"))
      } else { XCTAssertNil(done.secret) }
    }
  }

  func testEnvelopes() throws {
    let e = v[j: "envelopes"], phone = try dev("phone"), agent = try dev("agent"), tablet = try dev("tablet")
    let st3 = try state(upTo: 3), st5 = try state(upTo: 5)
    let sessionId = e[j: "session"].h("sessionId")
    let sk = e[j: "session"][j: "sessionKey"]
    let session = EpochSecret(epoch: sk.i("epoch"), key: sk.h("key"), hist: sk.h("hist"))
    let roomS = v[j: "room"][j: "secret"]
    let room = EpochSecret(epoch: 1, key: roomS.h("key"), hist: roomS.h("hist"))
    let roomId = st3.roomId
    XCTAssertEqual(try deriveSenderKey(roomId: roomId, secret: room, senderId: phone.id, keyScope: 0, sessionId: nil), e[j: "senderKeys"].h("phoneRoom"))
    XCTAssertEqual(try deriveSenderKey(roomId: roomId, secret: session, senderId: phone.id, keyScope: 1, sessionId: sessionId), e[j: "senderKeys"].h("phoneSession"))
    XCTAssertEqual(try deriveSenderKey(roomId: roomId, secret: session, senderId: agent.id, keyScope: 1, sessionId: sessionId), e[j: "senderKeys"].h("agentSession"))
    XCTAssertEqual(try objectIdOf(agent.id, 1), e[j: "card"].h("cardId"))
    let names = ["phone": phone, "agent": agent, "tablet": tablet]
    let secrets: SecretLookup = { h in h.keyScope == 1 ? (bytesEqual(h.sessionId, sessionId) ? session : nil) : (h.epoch == 1 ? room : nil) }

    // Seal each again from the same inputs: header, nonce, ciphertext and hash byte for byte; the signature verifies.
    for (name, state) in [("chat", st3), ("card", st3), ("answer", st3), ("desk", st3), ("afterRecovery", st5)] {
      let x = e[j: name]
      let device = names[x.s("sender")]!
      let hs = x[j: "hubSees"]
      let decoded = try decodeHeader(x.h("header"))
      XCTAssertEqual(try encodeHeader(decoded), x.h("header"), "\(name): header round trip")
      XCTAssertEqual(decoded.isHead, hs["isHead"] as! Bool); XCTAssertEqual(decoded.push, hs["push"] as! Bool); XCTAssertEqual(decoded.kind, hs.i("kind"))
      XCTAssertEqual(decoded.timelineId, hs["timelineId"] as? String)
      var chains = Chains()
      if let prev = decoded.prev as Bytes?, !isZero(prev) { var c = Chain(); c.seq = decoded.seq - 1; c.hash = prev; c.hashes[c.seq] = prev; chains[hex(device.id)] = c }
      let card = decoded.card
      let sealed = try sealEnvelope(device: device, state: state, secret: decoded.keyScope == 1 ? session : room, chains: &chains, kind: x.i("kind"), keyScope: decoded.keyScope,
                                    sessionId: decoded.sessionId, bind: x["bind"] != nil ? x.h("bind") : [], payload: x.h("payload"),
                                    recipient: x["recipient"] != nil ? names[x.s("recipient")]!.id : nil, time: x.u("time"), card: card, timelineKind: decoded.timelineKind,
                                    timelineId: decoded.timelineId, blobs: decoded.blobs, push: decoded.push, seen: decoded.seen, rng: seededRNG(x.i("rngSeed")))
      XCTAssertEqual(sealed.header, decoded)
      let split = try splitEnvelope(sealed.bytes)
      XCTAssertEqual(split.headerBytes, x.h("header"), "\(name): header")
      XCTAssertEqual(split.nonce, x.h("nonce"), "\(name): nonce")
      XCTAssertEqual(split.ciphertext, x.h("ciphertext"), "\(name): ciphertext")
      XCTAssertEqual(sha256(split.ciphertext!), x.h("ciphertextHash"))
      XCTAssertEqual(sealed.hash, x.h("hash"), "\(name): envelope hash")
      XCTAssertTrue(verify(device.signPub, LABEL.envelopeSig, sealed.hash, split.signature), "\(name): our signature")
      XCTAssertTrue(verify(device.signPub, LABEL.envelopeSig, x.h("hash"), x.h("signature")), "\(name): the JS signature")
      XCTAssertEqual(Array(sealed.bytes.dropLast(64)), Array(x.h("bytes").dropLast(64)))
      XCTAssertEqual(chains[hex(device.id)]?.seq, decoded.seq)
    }

    // Open them in order as a receiving device does (chains from nothing), with full verification.
    var chains = Chains()
    for name in ["chat", "card", "answer", "desk"] {
      let o = try openEnvelope(e[j: name].h("bytes"), state: st3, chains: &chains, secrets: secrets, selfId: agent.id)
      XCTAssertNil(o.quarantined)
      XCTAssertEqual(o.payload, e[j: name].h("payload"))
      XCTAssertEqual(o.hash, e[j: name].h("hash"))
      if name == "answer" { XCTAssertEqual(o.bind, e[j: name].h("bind")); XCTAssertTrue(o.forMe) }
    }
    XCTAssertThrowsCode("replay", try openEnvelope(e[j: "chat"].h("bytes"), state: st3, chains: &chains, secrets: secrets))
    var fresh = Chains()
    XCTAssertThrowsCode("gap", try verifyEnvelope(e[j: "answer"].h("bytes"), state: st3, chains: &fresh))
    XCTAssertNoThrow(try verifyEnvelope(e[j: "answer"].h("bytes"), state: st3, chains: &fresh, allowChainStart: true))
    // After the recovery the phone is removed: refused; reading history on purpose is bounded by the signed cut,
    // which is empty in the vectors (the recovery saw none of its envelopes), so even then it is refused.
    var c5 = Chains()
    XCTAssertThrowsCode("removed-sender", try verifyEnvelope(e[j: "chat"].h("bytes"), state: st5, chains: &c5))
    XCTAssertThrowsCode("removed-sender", try verifyEnvelope(e[j: "chat"].h("bytes"), state: st5, chains: &c5, allowRemovedSender: true))
    // The helper's removal (entry 4) also names an empty cut; the phone at epoch 2 (before the recovery) is fine.
    var c4 = Chains()
    XCTAssertNoThrow(try verifyEnvelope(e[j: "chat"].h("bytes"), state: try state(upTo: 4), chains: &c4))
    var c6 = Chains()
    let after = try openEnvelope(e[j: "afterRecovery"].h("bytes"), state: st5, chains: &c6, secrets: secrets, selfId: agent.id)
    XCTAssertEqual(after.payload, e[j: "afterRecovery"].h("payload"))
    XCTAssertEqual(try deriveSenderKey(roomId: roomId, secret: session, senderId: tablet.id, keyScope: 1, sessionId: sessionId), e[j: "afterRecovery"].h("senderKey"))
    // Pruned forms: still verify, cannot be opened; the full form opens against the hash the chain accepted.
    XCTAssertEqual(try pruneEnvelope(e[j: "chat"].h("bytes")), e.h("pruned"))
    XCTAssertEqual(try pruneEnvelope(e[j: "answer"].h("bytes")), e.h("prunedAnswer"))
    var cp = Chains()
    let pv = try verifyEnvelope(e.h("pruned"), state: st3, chains: &cp)
    XCTAssertTrue(pv.pruned)
    XCTAssertThrowsCode("pruned", try openEnvelope(e.h("prunedAnswer"), state: st3, chains: &cp, secrets: secrets, allowChainStart: true))
    XCTAssertEqual(try openVerifiedEnvelope(e[j: "chat"].h("bytes"), state: st3, secrets: secrets, envelopeHash: pv.hash).payload, e[j: "chat"].h("payload"))
    XCTAssertThrowsCode("hash-mismatch", try openVerifiedEnvelope(e[j: "chat"].h("bytes"), state: st3, secrets: secrets, envelopeHash: e[j: "card"].h("hash")))
    // A flipped ciphertext byte under a valid signature cannot pass: the signature covers the ciphertext hash.
    var bad = e[j: "card"].h("bytes"); bad[bad.count - 70] ^= 1
    var cb = Chains()
    XCTAssertThrowsCode("bad-signature", try openEnvelope(bad, state: st3, chains: &cb, secrets: secrets, allowChainStart: true))
  }

  func testBinds() throws {
    let b = v[j: "binds"], e = v[j: "envelopes"]
    let cardId = e[j: "card"].h("cardId"), cardHash = e[j: "card"].h("hash"), answerHash = e[j: "answer"].h("hash")
    XCTAssertEqual(try encodeAnswerBind(objectId: cardId, versionHash: cardHash, choices: ["yes"]), b.h("answer"))
    let T0: UInt64 = 1790000000000
    XCTAssertEqual(try encodeVerdictBind(requestId: Bytes(repeating: 0x71, count: 16), requestHash: Bytes(repeating: 0x72, count: 32), expiresAt: T0 + 300000, allow: true), b.h("verdict"))
    XCTAssertEqual(try encodeDecideAgainBind(objectId: cardId, previousHash: answerHash, versionHash: cardHash), b.h("decideAgain"))
    XCTAssertEqual(try encodeRequestBind(requestId: Bytes(repeating: 0x71, count: 16), expiresAt: T0 + 300000), b.h("request"))
    XCTAssertEqual(try decodeBind(kind: KIND.ANSWER, b.h("answer")), .answer(objectId: cardId, versionHash: cardHash, choices: ["yes"]))
    XCTAssertEqual(try decodeBind(kind: KIND.VERDICT, b.h("verdict")), .verdict(requestId: Bytes(repeating: 0x71, count: 16), requestHash: Bytes(repeating: 0x72, count: 32), expiresAt: T0 + 300000, allow: true))
  }

  func testHubAuth() throws {
    let a = v[j: "hubAuth"], agent = try dev("agent")
    let mine = try signHubAuth(device: agent, roomId: v[j: "room"].h("roomId"), hub: a.s("hub"), challenge: a.h("challenge"))
    XCTAssertEqual(Array(mine.dropLast(64)), Array(a.h("signed").dropLast(64)))
    let d = try decodeHubAuth(a.h("signed"))
    XCTAssertTrue(verify(agent.signPub, LABEL.hubAuth, d.body, d.signature))
    let m = try decodeHubAuth(mine)
    XCTAssertTrue(verify(agent.signPub, LABEL.hubAuth, m.body, m.signature))
    XCTAssertThrowsCode("bad-argument", try signHubAuth(device: agent, roomId: d.roomId, hub: "https://Hub.example", challenge: d.challenge))
    XCTAssertThrowsCode("bad-argument", try signHubAuth(device: agent, roomId: d.roomId, hub: "http://hub.example", challenge: d.challenge))
    XCTAssertNoThrow(try signHubAuth(device: agent, roomId: d.roomId, hub: "http://127.0.0.1:8890", challenge: d.challenge))
  }

  func testEpochChanges() throws {
    let c = v[j: "epochChanges"], st3 = try state(upTo: 3), rec = try recovery()
    let phone = try dev("phone"), laptop = try dev("laptop"), tablet = try dev("tablet")
    // Remove: the laptop removes the helper, epoch 2.
    let rm = c[j: "remove"]
    let st4 = try applyEntry(st3, rm.h("entry"))
    XCTAssertEqual(st4.head.hash, rm.h("entryHash")); XCTAssertEqual(st4.epoch, 2)
    XCTAssertEqual(try encodeEntryBody(try decodeEntry(rm.h("entry"))), try decodeEntry(rm.h("entry")).body)
    var rng = seededRNG(rm.i("rngSeed"))
    let s2 = EpochSecret(epoch: 2, key: rng(32), hist: rng(32))
    XCTAssertEqual(s2.key, rm[j: "secret"].h("key"))
    XCTAssertEqual(epochCommits(s2).keyCommit, rm.h("keyCommit")); XCTAssertEqual(epochCommits(s2).histCommit, rm.h("histCommit"))
    let recipients = [phone.id, laptop.id, rec.id]
    for (i, w) in rm.a("wraps").enumerated() {
      XCTAssertEqual(try wrapEpochKey(st4, s2, recipients[i], rng: rng), w.h("sealed"), "remove wrap \(i) byte for byte")
    }
    XCTAssertEqual(try unwrapEpochKey(st4, laptop, rm.a("wraps")[1].h("sealed"), epoch: 2), s2)
    let rs = v[j: "room"][j: "secret"]
    let s1 = EpochSecret(epoch: 1, key: rs.h("key"), hist: rs.h("hist"))
    XCTAssertEqual(try makeBackLink(st4.roomId, s2, previous: s1), rm.h("backLink"))
    XCTAssertEqual(try openBackLink(st4, s2, rm.h("backLink")), s1)
    // Recover: phone and laptop out, tablet in, the agent stays, epoch 3, a new recovery key.
    let rc = c[j: "recover"]
    XCTAssertEqual(try unwrapEpochKey(st4, rec, rc.h("recoveryWrapUsed"), epoch: 2), s2)
    XCTAssertEqual(try formatRecoveryCode(seededRNG(rc.i("newCodeRngSeed"))(32)), rc.s("newCode"))
    let newRec = try recoveryDevice(rc.s("newCode"))
    XCTAssertEqual(newRec.id, rc[j: "newRecovery"].h("id"))
    let st5 = try applyEntry(st4, rc.h("entry"))
    XCTAssertEqual(st5.head.hash, rc.h("entryHash")); XCTAssertEqual(st5.epoch, 3); XCTAssertEqual(st5.recovery.id, newRec.id)
    rng = seededRNG(rc.i("rngSeed"))
    let s3 = EpochSecret(epoch: 3, key: rng(32), hist: rng(32))
    XCTAssertEqual(s3.key, rc[j: "secret"].h("key"))
    XCTAssertEqual(try wrapEpochKey(st5, s3, tablet.id, rng: rng), rc.a("wraps")[0].h("sealed"))
    XCTAssertEqual(try wrapEpochKey(st5, s3, newRec.id, rng: rng), rc.a("wraps")[1].h("sealed"))
    XCTAssertEqual(try unwrapEpochKey(st5, tablet, rc.a("wraps")[0].h("sealed"), epoch: 3), s3)
    XCTAssertEqual(try openBackLink(st5, s3, rc.h("backLink")), s2)
    XCTAssertThrowsCode("wrong-epoch", try openBackLink(st5, s2, rc.h("backLink")))
  }

  func testLog() throws {
    let l = v[j: "log"]
    let st = try verifyLog(logBytes(), roomId: v[j: "room"].h("roomId"))
    XCTAssertEqual(st.epoch, l.i("finalEpoch"))
    let names = try ["agent": dev("agent").id, "tablet": dev("tablet").id]
    XCTAssertEqual(st.activeMembers.map { hex($0.id) }, (l["activeMembers"] as! [String]).map { hex(names[$0]!) })
    for (i, e) in l.a("entries").enumerated() {
      XCTAssertEqual(st.hashes[i], e.h("hash"))
      let d = try decodeEntry(e.h("bytes"))
      XCTAssertEqual(d.body, e.h("body")); XCTAssertEqual(d.type, e.i("type")); XCTAssertEqual(st.epochAt(i), e.i("epochAfter"))
      XCTAssertEqual(try encodeEntryBody(d), d.body)
    }
    let st3 = try state(upTo: 3)
    let refused = l[j: "refused"]
    XCTAssertThrowsCode("bad-format", try applyEntry(st3, refused.h("retiredType4")))
    XCTAssertThrowsCode("bad-entry", try applyEntry(st3, refused.h("signedByAgent")))
    XCTAssertThrowsCode("bad-entry", try applyEntry(st3, refused.h("replayOfEntry3")))
    XCTAssertThrowsCode("wrong-room", try verifyLog(logBytes(), roomId: ZERO32))
    // Rollback and fork against a pin.
    let pin = pinOf(st)
    XCTAssertEqual(try checkLogAgainstPin(st, pin), .same)
    XCTAssertEqual(try checkLogAgainstPin(st, pinOf(st3)), .extended)
    XCTAssertThrowsCode("log-rollback", try checkLogAgainstPin(st3, pin))
    // A tampered signature.
    var bad = logBytes()[1]; bad[bad.count - 1] ^= 1
    XCTAssertThrowsCode("bad-signature", try applyEntry(try state(upTo: 0), bad))
  }

  func testAssets() throws {
    let a = v[j: "assets"]
    let small = a[j: "small"]
    let enc = try encryptAsset(small.h("plaintext"), rng: seededRNG(small.i("rngSeed")))
    XCTAssertEqual(enc.blob, small.h("blob")); XCTAssertEqual(enc.key, small.h("key")); XCTAssertEqual(enc.sha256, small.h("sha256"))
    XCTAssertEqual(try decryptAsset(small.h("blob"), key: small.h("key"), expectedSha256: small.h("sha256")), small.h("plaintext"))
    let two = a[j: "twoChunks"]
    let data = (0..<70000).map { UInt8(($0 * 7) & 0xff) }
    let big = try encryptAsset(data, rng: seededRNG(two.i("rngSeed")))
    XCTAssertEqual(big.blob.count, two.i("blobLength")); XCTAssertEqual(big.sha256, two.h("sha256"))
    XCTAssertEqual(try decryptAsset(big.blob, key: big.key), data)
    XCTAssertThrowsCode("bad-format", try decryptAsset(Array(big.blob.prefix(22 + 65536 + 16 + 5)), key: big.key))      // cut inside the last chunk
    XCTAssertThrowsCode("decrypt-failed", try decryptAsset(Array(big.blob.prefix(22 + 65536 + 16)), key: big.key))     // cut at a chunk boundary
  }

  func testPadding() throws {
    XCTAssertEqual(paddedLength(1), 256); XCTAssertEqual(paddedLength(257), 512); XCTAssertEqual(paddedLength(65536), 65536); XCTAssertEqual(paddedLength(65537), 131072)
    let b = try encodeBody(bind: [], payload: utf8("hi"))
    XCTAssertEqual(b.count, 256)
    XCTAssertEqual(try decodeBody(b).payload, utf8("hi"))
    var tail = b; tail[255] = 1
    XCTAssertThrowsCode("bad-format", try decodeBody(tail))
    XCTAssertThrowsCode("bad-format", try decodeBody(Array(b.prefix(200))))
  }
}
