// JSON.swift: a JSON value that keeps everything it was given (unknown fields included), so a body from a newer client
// is never refused for fields this version does not know: it reads what it knows and keeps the rest.
import Foundation
import TrommiCore

public enum JV: Equatable, Hashable, Codable, CustomStringConvertible {
  case null
  case bool(Bool)
  case num(Double)
  case str(String)
  case arr([JV])
  case obj([String: JV])

  // ---- from and to Foundation's JSON ----------------------------------------------------------

  public init(any v: Any?) {
    // A Swift Bool first, by its dynamic type (`as? Bool` would also take an NSNumber 1 on Apple systems); an NSNumber
    // that holds a boolean is a boolean too: CFBoolean on Apple systems, objCType "c" in swift-corelibs-foundation (Linux),
    // where JSONSerialization's true/false came out as numbers before.
    if let b = v as? Bool, let x = v, type(of: x) == Bool.self { self = .bool(b); return }
    switch v {
    case nil, is NSNull: self = .null
    case let n as NSNumber:
      #if canImport(Darwin)
      if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue); return }
      #else
      if String(cString: n.objCType) == "c" { self = .bool(n.boolValue); return }
      #endif
      self = .num(n.doubleValue)
    case let b as Bool: self = .bool(b)
    case let i as Int: self = .num(Double(i))
    case let d as Double: self = .num(d)
    case let s as String: self = .str(s)
    case let a as [Any]: self = .arr(a.map { JV(any: $0) })
    case let o as [String: Any]: self = .obj(o.mapValues { JV(any: $0) })
    default: self = .null
    }
  }
  /** Parse UTF-8 JSON bytes; nil when it is not JSON. */
  public static func parse(_ bytes: Bytes) -> JV? {
    guard let v = try? JSONDecoder().decode(JV.self, from: Data(bytes)) else { return nil }
    return v
  }
  public var any: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let b): return b
    case .num(let d): return d == d.rounded() && abs(d) < 9.007199254740992e15 ? Int(d) as Any : d as Any
    case .str(let s): return s
    case .arr(let a): return a.map { $0.any }
    case .obj(let o): return o.mapValues { $0.any }
    }
  }
  /** Compact JSON with sorted keys (the same bytes for the same value). */
  public func encoded() -> Bytes {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return Array((try? enc.encode(self)) ?? Data("null".utf8))
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let d = try? c.decode(Double.self) { self = .num(d) }
    else if let s = try? c.decode(String.self) { self = .str(s) }
    else if let a = try? c.decode([JV].self) { self = .arr(a) }
    else if let o = try? c.decode([String: JV].self) { self = .obj(o) }
    else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not JSON") }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .num(let d): if d == d.rounded() && abs(d) < 9.007199254740992e15 { try c.encode(Int64(d)) } else { try c.encode(d) }
    case .str(let s): try c.encode(s)
    case .arr(let a): try c.encode(a)
    case .obj(let o): try c.encode(o)
    }
  }

  // ---- reading ---------------------------------------------------------------------------------

  public subscript(_ key: String) -> JV { if case .obj(let o) = self { return o[key] ?? .null }; return .null }
  public subscript(_ i: Int) -> JV { if case .arr(let a) = self, i >= 0, i < a.count { return a[i] }; return .null }
  public var isNull: Bool { self == .null }
  public var string: String? { if case .str(let s) = self { return s }; return nil }
  public var double: Double? { if case .num(let d) = self { return d }; return nil }
  /** A whole number (JSON numbers are doubles): nil for fractions and non-numbers. */
  public var int: Int? { if case .num(let d) = self, d == d.rounded(), abs(d) < 9.007199254740992e15 { return Int(d) }; return nil }
  public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
  /** JavaScript's truthiness, for the fields the web reads with `!!x` or `x ? … : …`. */
  public var truthy: Bool {
    switch self {
    case .null: return false
    case .bool(let b): return b
    case .num(let d): return d != 0 && !d.isNaN
    case .str(let s): return !s.isEmpty
    default: return true
    }
  }
  public var array: [JV]? { if case .arr(let a) = self { return a }; return nil }
  public var object: [String: JV]? { if case .obj(let o) = self { return o }; return nil }
  public func has(_ key: String) -> Bool { object?[key] != nil }
  public var description: String { String(decoding: encoded(), as: UTF8.self) }

  /** A copy with one field set (nil removes it). */
  public func with(_ key: String, _ v: JV?) -> JV {
    var o = object ?? [:]
    o[key] = v
    return .obj(o)
  }
}

extension JV: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral, ExpressibleByFloatLiteral {
  public init(stringLiteral v: String) { self = .str(v) }
  public init(integerLiteral v: Int) { self = .num(Double(v)) }
  public init(floatLiteral v: Double) { self = .num(v) }
  public init(booleanLiteral v: Bool) { self = .bool(v) }
  public init(arrayLiteral v: JV...) { self = .arr(v) }
  public init(dictionaryLiteral v: (String, JV)...) { self = .obj(Dictionary(v, uniquingKeysWith: { $1 })) }
  public init(nilLiteral: ()) { self = .null }
}

public extension JV {
  static func s(_ v: String?) -> JV { v.map { .str($0) } ?? .null }
  static func n(_ v: Int?) -> JV { v.map { .num(Double($0)) } ?? .null }
  static func n(_ v: UInt64?) -> JV { v.map { .num(Double($0)) } ?? .null }
}
