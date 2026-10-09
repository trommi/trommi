// Wire.swift: byte strings and their text forms, the error every refusal is, and the numbers of spec/v2.md that the
// model reads from a signed header. No cryptography: that is trommi-core (Core.swift).
import Foundation

public typealias Bytes = [UInt8]

/** Every refusal carries a stable machine-readable code: the codes of spec/v2.md section 16, and a few local ones. */
public struct TrommiError: Error, CustomStringConvertible, Equatable {
  public let code: String
  public let message: String
  public init(_ code: String, _ message: String = "") { self.code = code; self.message = message }
  public var description: String { message.isEmpty ? code : "\(code): \(message)" }
}
@inline(__always) func fail(_ code: String, _ message: String = "") -> TrommiError { TrommiError(code, message) }

public let ZERO32 = Bytes(repeating: 0, count: 32)
public let ZERO16 = Bytes(repeating: 0, count: 16)

/** The kinds of a stored item (spec/v2.md section 9). 8 to 255 are reserved: read, chained, never applied. */
public enum KIND {
  public static let TIMELINE_ITEM = 1, OBJECT_VERSION = 2, ANSWER = 3, PERMISSION_REQUEST = 4, VERDICT = 5, STATUS = 6, DECIDE_AGAIN = 7
  static let MAX = 7
  public static func isKnown(_ kind: Int) -> Bool { kind >= 1 && kind <= MAX }
}
public enum TIMELINE { public static let CHAT = 1, CANVAS = 2 }
public enum TIMELINE_SCOPE { public static let CARD = 1, SESSION = 2, DESK = 3 }
public enum OBJECT_TYPE { public static let CARD = 1, NOTE = 2, REQUEST = 3, ARTIFACT = 4 }
public enum CARD_STATE { public static let OPEN = 1, ANSWERED = 2, CLOSED = 3 }
public enum ROLE { public static let HUMAN = 1, AGENT = 2 }

// ---- text forms ------------------------------------------------------------------

private let B64: [UInt8] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
private let B64_REV: [Int16] = {
  var t = [Int16](repeating: -1, count: 128)
  for (i, c) in B64.enumerated() { t[Int(c)] = Int16(i) }
  return t
}()

/** base64url without padding (RFC 4648 section 5). */
public func b64u(_ bytes: Bytes) -> String {
  var out = [UInt8]()
  out.reserveCapacity((bytes.count * 4 + 2) / 3)
  var i = 0
  while i + 2 < bytes.count {
    let n = (UInt32(bytes[i]) << 16) | (UInt32(bytes[i + 1]) << 8) | UInt32(bytes[i + 2])
    out += [B64[Int(n >> 18)], B64[Int((n >> 12) & 63)], B64[Int((n >> 6) & 63)], B64[Int(n & 63)]]
    i += 3
  }
  if i + 1 == bytes.count {
    let n = UInt32(bytes[i]) << 16
    out += [B64[Int(n >> 18)], B64[Int((n >> 12) & 63)]]
  } else if i + 2 == bytes.count {
    let n = (UInt32(bytes[i]) << 16) | (UInt32(bytes[i + 1]) << 8)
    out += [B64[Int(n >> 18)], B64[Int((n >> 12) & 63)], B64[Int((n >> 6) & 63)]]
  }
  return String(decoding: out, as: UTF8.self)
}

/** Strict decoder: no padding, no foreign characters, no non-zero trailing bits. */
public func unb64u(_ str: String) throws -> Bytes {
  let s = Array(str.utf8)
  if s.count % 4 == 1 { throw fail("bad-format", "base64url: impossible length") }
  var out = Bytes()
  out.reserveCapacity(s.count * 3 / 4)
  var acc: UInt32 = 0, bits = 0
  for c in s {
    let v = c < 128 ? B64_REV[Int(c)] : -1
    if v < 0 { throw fail("bad-format", "base64url: foreign character") }
    acc = (acc << 6) | UInt32(v)
    bits += 6
    if bits >= 8 { bits -= 8; out.append(UInt8((acc >> UInt32(bits)) & 0xff)) }
    acc &= (1 << 24) - 1
  }
  if bits > 0 && (acc & ((1 << UInt32(bits)) - 1)) != 0 { throw fail("bad-format", "base64url: non-canonical tail") }
  return out
}

private let HEXDIGITS: [UInt8] = Array("0123456789abcdef".utf8)
public func hex(_ bytes: Bytes) -> String {
  var out = [UInt8]()
  out.reserveCapacity(bytes.count * 2)
  for b in bytes { out.append(HEXDIGITS[Int(b >> 4)]); out.append(HEXDIGITS[Int(b & 15)]) }
  return String(decoding: out, as: UTF8.self)
}
/** Lower-case hex only. */
public func unhex(_ str: String) throws -> Bytes {
  let s = Array(str.utf8)
  if s.count % 2 != 0 { throw fail("bad-format", "hex") }
  var out = Bytes(repeating: 0, count: s.count / 2)
  func v(_ c: UInt8) throws -> UInt8 {
    switch c {
    case 48...57: return c - 48
    case 97...102: return c - 87
    default: throw fail("bad-format", "hex")
    }
  }
  for i in 0..<out.count { out[i] = try (v(s[2 * i]) << 4) | v(s[2 * i + 1]) }
  return out
}

public func utf8(_ s: String) -> Bytes { Array(s.utf8) }

public func concat(_ parts: Bytes...) -> Bytes { parts.flatMap { $0 } }
public func concat(_ parts: [Bytes]) -> Bytes { parts.flatMap { $0 } }

/** Equality without an early exit. */
public func bytesEqual(_ a: Bytes?, _ b: Bytes?) -> Bool {
  guard let a = a, let b = b, a.count == b.count else { return false }
  var d: UInt8 = 0
  for i in 0..<a.count { d |= a[i] ^ b[i] }
  return d == 0
}
/** Lexicographic, unsigned; the order of every sorted id list. */
public func compareBytes(_ a: Bytes, _ b: Bytes) -> Int {
  let n = min(a.count, b.count)
  for i in 0..<n where a[i] != b[i] { return Int(a[i]) - Int(b[i]) }
  return a.count - b.count
}
public func isZero(_ b: Bytes) -> Bool { b.reduce(0, |) == 0 }

public func systemRandom(_ n: Int) -> Bytes {
  var g = SystemRandomNumberGenerator()
  return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
}

/** The clock, in milliseconds since 1970. */
public func nowMs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

/** Numbers of an untrusted JSON answer (the hub's), read exactly. */
public enum Wire {
  /** The most a counter of the protocol may be (spec/v2.md 15.2: 2^53 − 1), so that no JSON reader rounds it. */
  public static let maxCount: UInt64 = (1 << 53) - 1
  /** A whole number from 0 to 2^53 − 1; nil for anything else (negative, a fraction, a boolean, text, too large). */
  public static func uint(_ v: Any?) -> UInt64? {
    if v is Bool { return nil }
    guard let n = v as? NSNumber else { return nil }
    let d = n.doubleValue
    guard d >= 0, d <= Double(maxCount), d == d.rounded() else { return nil }
    return UInt64(d)
  }
  public static func int(_ v: Any?) -> Int? { uint(v).map { Int($0) } }
}
