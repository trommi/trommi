// Bytes.swift: byte helpers and the canonical encoding (FORMAT.md section 2), as in zcrypto.mjs (W, R, b64u, hex).
import Foundation

public typealias Bytes = [UInt8]

/** Every refusal carries a stable machine-readable code, the same codes as zcrypto.mjs (ZError.code). */
public struct ZError: Error, CustomStringConvertible, Equatable {
  public let code: String
  public let message: String
  public init(_ code: String, _ message: String = "") { self.code = code; self.message = message }
  public var description: String { message.isEmpty ? code : "\(code): \(message)" }
}
@inline(__always) func fail(_ code: String, _ message: String = "") -> ZError { ZError(code, message) }

public let VERSION: UInt8 = 1
public let ZERO32 = Bytes(repeating: 0, count: 32)
public let ZERO16 = Bytes(repeating: 0, count: 16)

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
/** Lower-case hex only, like zcrypto.mjs unhex. */
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

let MAX_SAFE: UInt64 = (1 << 53) - 1

func need(_ b: Bytes, _ n: Int, _ what: String) throws -> Bytes {
  if b.count != n { throw fail("bad-argument", "\(what) must be \(n) bytes") }
  return b
}

// ---- canonical writer and reader ----------------------------------------------------

/** Fixed field order, big-endian integers, length-prefixed byte strings: exactly one encoding of a value. */
public final class W {
  public private(set) var out = Bytes()
  public init() {}
  @discardableResult public func u8(_ v: Int) throws -> W { guard (0...0xff).contains(v) else { throw fail("bad-argument", "u8 out of range") }; out.append(UInt8(v)); return self }
  @discardableResult public func u16(_ v: Int) throws -> W { guard (0...0xffff).contains(v) else { throw fail("bad-argument", "u16 out of range") }; out += [UInt8(v >> 8), UInt8(v & 0xff)]; return self }
  @discardableResult public func u32(_ v: Int) throws -> W { guard v >= 0 && v <= 0xffff_ffff else { throw fail("bad-argument", "u32 out of range") }; out += be32(UInt32(v)); return self }
  @discardableResult public func u64(_ v: UInt64) throws -> W { guard v <= MAX_SAFE else { throw fail("bad-argument", "u64 out of range") }; out += be64(v); return self }
  @discardableResult public func raw(_ b: Bytes, _ n: Int? = nil, _ what: String = "field") throws -> W { if let n = n { _ = try need(b, n, what) }; out += b; return self }
  @discardableResult public func var16(_ b: Bytes) throws -> W { try u16(b.count); out += b; return self }
  @discardableResult public func var32(_ b: Bytes) throws -> W { try u32(b.count); out += b; return self }
  /** str16(max): UTF-8, at most max bytes, no leading byte order mark. Swift strings are always well-formed. */
  @discardableResult public func str16(_ s: String, max: Int) throws -> W {
    let raw = Array(s.utf8)
    if raw.count > max { throw fail("bad-argument", "string too long") }
    if s.unicodeScalars.first == "\u{FEFF}" { throw fail("bad-argument", "a string starts with a byte order mark") }
    return try var16(raw)
  }
}
public func be32(_ v: UInt32) -> Bytes { [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }
public func be64(_ v: UInt64) -> Bytes { (0..<8).map { UInt8((v >> UInt64(56 - 8 * $0)) & 0xff) } }
public func u32Bytes(_ v: Int) -> Bytes { be32(UInt32(truncatingIfNeeded: v)) }

public struct R {
  let b: Bytes
  public private(set) var o = 0
  public init(_ bytes: Bytes) { b = bytes }
  public var left: Int { b.count - o }
  func want(_ n: Int) throws { if left < n { throw fail("bad-format", "truncated") } }
  public mutating func u8() throws -> Int { try want(1); defer { o += 1 }; return Int(b[o]) }
  public mutating func u16() throws -> Int { try want(2); defer { o += 2 }; return Int(b[o]) << 8 | Int(b[o + 1]) }
  public mutating func u32() throws -> Int { try want(4); defer { o += 4 }; return Int(b[o]) << 24 | Int(b[o + 1]) << 16 | Int(b[o + 2]) << 8 | Int(b[o + 3]) }
  public mutating func u64() throws -> UInt64 {
    try want(8)
    var v: UInt64 = 0
    for i in 0..<8 { v = v << 8 | UInt64(b[o + i]) }
    o += 8
    if v > MAX_SAFE { throw fail("bad-format", "integer above 2^53-1") }
    return v
  }
  public mutating func take(_ n: Int) throws -> Bytes { try want(n); defer { o += n }; return Array(b[o..<(o + n)]) }
  public mutating func var16() throws -> Bytes { try take(try u16()) }
  public mutating func var32() throws -> Bytes { try take(try u32()) }
  public mutating func str16(_ max: Int) throws -> String {
    let raw = try var16()
    if raw.count > max { throw fail("bad-format", "string too long") }
    guard let s = String(validating: raw, as: UTF8.self) else { throw fail("bad-format", "string is not UTF-8") }
    if s.unicodeScalars.first == "\u{FEFF}" { throw fail("bad-format", "a string starts with a byte order mark") }
    return s
  }
  public func end() throws { if left != 0 { throw fail("bad-format", "trailing bytes") } }
}

/** Version byte and object type byte of every top-level object. */
func header(_ r: inout R, _ type: UInt8) throws {
  let v = try r.u8()
  if v != Int(VERSION) { throw fail("bad-version", "version \(v) is not supported") }
  let t = try r.u8()
  if t != Int(type) { throw fail("bad-format", "object type \(t), expected \(type)") }
}

public enum OBJ {
  public static let LOG_ENTRY: UInt8 = 0x01, ENVELOPE: UInt8 = 0x02, ENVELOPE_PRUNED: UInt8 = 0x03, SEALED: UInt8 = 0x04
  public static let INVITE_OFFER: UInt8 = 0x05, INVITE_REQUEST: UInt8 = 0x06, INVITE_REVEAL: UInt8 = 0x07, BACK_LINK: UInt8 = 0x08
  public static let ASSET: UInt8 = 0x09, ASSET_WRAP: UInt8 = 0x0a, DEVICE_PUBLIC: UInt8 = 0x0b, DEVICE_SECRET: UInt8 = 0x0c, HUB_AUTH: UInt8 = 0x0d
  public static let GRANT: UInt8 = 0x0e, SESSION_BACK_LINK: UInt8 = 0x0f
}

/** Randomness: the system's, or (tests only) a deterministic generator that makes outputs reproducible. */
public typealias RNG = (Int) -> Bytes
public func systemRandom(_ n: Int) -> Bytes {
  var g = SystemRandomNumberGenerator()
  return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
}
/** The vectors' generator: call c (from 0) with seed s returns n bytes, byte j = (s + 17c + j) mod 256. */
public func seededRNG(_ seed: Int) -> RNG {
  var call = 0
  return { n in
    defer { call += 1 }
    return (0..<n).map { UInt8((seed + 17 * call + $0) & 0xff) }
  }
}
