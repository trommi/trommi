// RecCodec.swift: a record (Rec) as compact bytes for the device's store (RecordStore): varints, hex ids as raw bytes,
// the body (JV) as a small tag-length-value tree. Several times faster to read back than JSON with Codable, which
// decides how fast a warm start replays the room. Only this device reads it; the version byte lets it change.
import Foundation

enum RecCodec {
  static let version: UInt8 = 2

  // ---- writing ----
  struct W {
    var b = [UInt8]()
    mutating func u(_ v: UInt64) { var v = v; while v >= 0x80 { b.append(UInt8(v & 0x7f) | 0x80); v >>= 7 }; b.append(UInt8(v)) }
    mutating func i(_ v: Int) { u(UInt64(bitPattern: Int64((v << 1) ^ (v >> 63)))) }
    mutating func bool(_ v: Bool) { b.append(v ? 1 : 0) }
    mutating func s(_ v: String) {
      // lowercase hex of even length (ids, hashes): stored as its bytes
      let u8 = Array(v.utf8)
      if u8.count >= 2, u8.count % 2 == 0, u8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }) {
        b.append(1); u(UInt64(u8.count / 2))
        var k = 0
        while k < u8.count { b.append(nib(u8[k]) << 4 | nib(u8[k + 1])); k += 2 }
      } else { b.append(0); u(UInt64(u8.count)); b += u8 }
    }
    private func nib(_ c: UInt8) -> UInt8 { c <= 57 ? c - 48 : c - 87 }
    mutating func os(_ v: String?) { if let v = v { b.append(1); s(v) } else { b.append(0) } }
    mutating func jv(_ v: JV) {
      switch v {
      case .null: b.append(0)
      case .bool(let x): b.append(x ? 2 : 1)
      case .num(let d):
        if d == d.rounded(), abs(d) < 4.5e15 { b.append(3); i(Int(d)) }
        else { b.append(4); let bits = d.bitPattern; for k in 0..<8 { b.append(UInt8(bits >> (UInt64(k) * 8) & 0xff)) } }
      case .str(let x): b.append(5); let u8 = Array(x.utf8); u(UInt64(u8.count)); b += u8
      case .arr(let a): b.append(6); u(UInt64(a.count)); for x in a { jv(x) }
      case .obj(let o): b.append(7); u(UInt64(o.count)); for k in o.keys.sorted() { let u8 = Array(k.utf8); u(UInt64(u8.count)); b += u8; jv(o[k]!) }   // sorted: the same bytes for the same value
      }
    }
  }

  static func encode(_ r: Rec) -> [UInt8] {
    var w = W()
    w.b.reserveCapacity(256)
    w.b.append(version)
    w.i(r.envelopeNumber); w.s(r.envelopeHash); w.s(r.senderDeviceId); w.s(r.senderRole); w.os(r.recipientDeviceId)
    w.u(r.sentAt); w.i(r.kind); w.bool(r.isHead)
    if let o = r.object { w.b.append(1); w.s(o.objectId); w.i(o.objectState); w.i(o.urgency); w.u(o.answeredAt) } else { w.b.append(0) }
    w.os(r.timelineKind); w.os(r.timelineId); w.os(r.sessionId)
    w.u(UInt64(r.attachmentIds.count)); for a in r.attachmentIds { w.s(a) }
    if let c = r.content { w.b.append(1); w.jv(c) } else { w.b.append(0) }
    w.s(r.contentState)
    switch r.bind {
    case nil: w.b.append(0)
    case .answer(let c, let v, let ch)?: w.b.append(1); w.s(c); w.s(v); w.u(UInt64(ch.count)); for x in ch { w.s(x) }
    case .decideAgain(let c, let p, let v)?: w.b.append(2); w.s(c); w.s(p); w.s(v)
    case .permissionRequest(let q, let e)?: w.b.append(3); w.s(q); w.u(e)
    case .verdict(let q, let h, let e, let a)?: w.b.append(4); w.s(q); w.s(h); w.u(e); w.bool(a)
    }
    w.s(r.causal.senderDeviceId); w.u(r.causal.senderSequence); w.u(r.causal.sentAt); w.i(r.causal.lamport); w.bool(r.causal.noBody)
    w.u(r.senderSequence); w.i(r.epoch)
    // (one byte: objectIdOk in the low bits, `winner` as 8)
    w.b.append((r.objectIdOk.map { $0 ? 2 : 1 } ?? 0) | (r.winner ? 8 : 0))
    w.os(r.localId); w.bool(r.pending)
    return w.b
  }

  // ---- reading ----
  struct Bad: Error {}
  struct R {
    let b: UnsafeBufferPointer<UInt8>
    var at = 0
    mutating func byte() throws -> UInt8 { guard at < b.count else { throw Bad() }; defer { at += 1 }; return b[at] }
    mutating func u() throws -> UInt64 {
      var v: UInt64 = 0, shift: UInt64 = 0
      while true { let x = try byte(); v |= UInt64(x & 0x7f) << shift; if x < 0x80 { return v }; shift += 7; if shift > 63 { throw Bad() } }
    }
    mutating func i() throws -> Int { let z = try u(); return Int(Int64(bitPattern: (z >> 1) ^ (0 &- (z & 1)))) }
    mutating func bool() throws -> Bool { try byte() != 0 }
    mutating func bytes(_ n: Int) throws -> UnsafeBufferPointer<UInt8> {
      guard n >= 0, at + n <= b.count else { throw Bad() }
      defer { at += n }
      return UnsafeBufferPointer(rebasing: b[at..<(at + n)])
    }
    mutating func utf8(_ n: Int) throws -> String { String(decoding: try bytes(n), as: UTF8.self) }
    static let hexDigits = Array("0123456789abcdef".utf8)
    mutating func s() throws -> String {
      let t = try byte(), n = Int(try u())
      if t == 0 { return try utf8(n) }
      let raw = try bytes(n)
      return String(unsafeUninitializedCapacity: n * 2) { out in
        var k = 0
        for x in raw { out[k] = R.hexDigits[Int(x >> 4)]; out[k + 1] = R.hexDigits[Int(x & 15)]; k += 2 }
        return n * 2
      }
    }
    mutating func os() throws -> String? { try byte() == 0 ? nil : try s() }
    mutating func jv() throws -> JV {
      switch try byte() {
      case 0: return .null
      case 1: return .bool(false)
      case 2: return .bool(true)
      case 3: return .num(Double(try i()))
      case 4: var bits: UInt64 = 0; for k in 0..<8 { bits |= UInt64(try byte()) << (UInt64(k) * 8) }; return .num(Double(bitPattern: bits))
      case 5: return .str(try utf8(Int(try u())))
      case 6: let n = Int(try u()); var a = [JV](); a.reserveCapacity(min(n, 4096)); for _ in 0..<n { a.append(try jv()) }; return .arr(a)
      case 7:
        let n = Int(try u()); var o = [String: JV](minimumCapacity: min(n, 4096))
        for _ in 0..<n { let k = try utf8(Int(try u())); o[k] = try jv() }
        return .obj(o)
      default: throw Bad()
      }
    }
  }

  static func decode(_ bytes: UnsafeBufferPointer<UInt8>) throws -> Rec {
    var r = R(b: bytes)
    guard try r.byte() == version else { throw Bad() }
    let n = try r.i(), h = try r.s(), sender = try r.s(), role = try r.s(), recipient = try r.os()
    let sentAt = try r.u(), kind = try r.i(), isHead = try r.bool()
    var object: ObjectHead? = nil
    if try r.byte() == 1 { object = ObjectHead(objectId: try r.s(), objectState: try r.i(), urgency: try r.i(), answeredAt: try r.u()) }
    let tk = try r.os(), tid = try r.os(), sid = try r.os()
    var atts = [String]()
    for _ in 0..<Int(try r.u()) { atts.append(try r.s()) }
    var content: JV? = Optional<JV>.none
    if try r.byte() == 1 { content = try r.jv() }
    let cs = try r.s()
    var bind: DecodedBind? = nil
    switch try r.byte() {
    case 0: break
    case 1:
      let c = try r.s(), v = try r.s(); var ch = [String](); for _ in 0..<Int(try r.u()) { ch.append(try r.s()) }
      bind = .answer(cardId: c, versionHash: v, choices: ch)
    case 2: bind = .decideAgain(cardId: try r.s(), previousHash: try r.s(), versionHash: try r.s())
    case 3: bind = .permissionRequest(requestId: try r.s(), expiresAt: try r.u())
    case 4: bind = .verdict(requestId: try r.s(), requestHash: try r.s(), expiresAt: try r.u(), allow: try r.bool())
    default: throw Bad()
    }
    let causal = Causal(senderDeviceId: try r.s(), senderSequence: try r.u(), sentAt: try r.u(), lamport: try r.i(), noBody: try r.bool())
    let seq = try r.u(), epoch = try r.i()
    let okb = try r.byte()
    let localId = try r.os(), pending = try r.bool()
    var rec = Rec(envelopeNumber: n, envelopeHash: h, senderDeviceId: sender, senderRole: role, recipientDeviceId: recipient, sentAt: sentAt, kind: kind,
                  isHead: isHead, object: object, timelineKind: tk, timelineId: tid, sessionId: sid, attachmentIds: atts, content: content, contentState: cs,
                  bind: bind, causal: causal, senderSequence: seq, epoch: epoch)
    rec.objectIdOk = okb & 3 == 0 ? nil : okb & 3 == 2
    rec.winner = okb & 8 != 0
    rec.localId = localId; rec.pending = pending
    return rec
  }
}
