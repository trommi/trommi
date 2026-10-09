// FastJSON.swift: UTF-8 JSON straight into JV in one pass over the bytes (a room snapshot is tens of MB of JSON:
// JSONSerialization and a conversion to JV took seconds of it). Strict: one value, then only whitespace; nil otherwise.
import Foundation

enum FastJSON {
  static func parse(_ bytes: [UInt8]) -> JV? {
    bytes.withUnsafeBufferPointer { buf -> JV? in
      var p = Parser(b: buf)
      guard let v = p.value(depth: 0) else { return Optional.none }
      p.ws()
      if p.at != buf.count { return Optional<JV>.none }
      return v
    }
  }
  struct Parser {
    let b: UnsafeBufferPointer<UInt8>
    var at = 0
    mutating func ws() { while at < b.count, b[at] == 0x20 || b[at] == 0x0a || b[at] == 0x0d || b[at] == 0x09 { at += 1 } }
    mutating func lit(_ s: StaticString) -> Bool {
      let n = s.utf8CodeUnitCount
      guard at + n <= b.count else { return false }
      for i in 0..<n where b[at + i] != s.utf8Start[i] { return false }
      at += n
      return true
    }
    mutating func value(depth: Int) -> JV? {
      guard depth < 256 else { return Optional.none }
      ws()
      guard at < b.count else { return Optional.none }
      switch b[at] {
      case 0x7b:   // {
        at += 1
        var o = [String: JV]()
        ws()
        if at < b.count, b[at] == 0x7d { at += 1; return .obj(o) }
        while true {
          ws()
          guard at < b.count, b[at] == 0x22, let k = string() else { return Optional.none }
          ws()
          guard at < b.count, b[at] == 0x3a else { return Optional.none }
          at += 1
          guard let v = value(depth: depth + 1) else { return Optional.none }
          o[k] = v
          ws()
          guard at < b.count else { return Optional.none }
          if b[at] == 0x2c { at += 1; continue }
          if b[at] == 0x7d { at += 1; return .obj(o) }
          return Optional.none
        }
      case 0x5b:   // [
        at += 1
        var a = [JV]()
        ws()
        if at < b.count, b[at] == 0x5d { at += 1; return .arr(a) }
        while true {
          guard let v = value(depth: depth + 1) else { return Optional.none }
          a.append(v)
          ws()
          guard at < b.count else { return Optional.none }
          if b[at] == 0x2c { at += 1; continue }
          if b[at] == 0x5d { at += 1; return .arr(a) }
          return Optional.none
        }
      case 0x22: return string().map { .str($0) }
      // (no ternary with nil: JV is nil-literal expressible, a nil there would be JSON null)
      case 0x74: if lit("true") { return .bool(true) }; return Optional<JV>.none
      case 0x66: if lit("false") { return .bool(false) }; return Optional<JV>.none
      case 0x6e: if lit("null") { return .null }; return Optional<JV>.none
      default: return number()
      }
    }
    mutating func number() -> JV? {
      let start = at
      if at < b.count, b[at] == 0x2d { at += 1 }
      var digits = 0, simple = true
      var v: Int64 = 0
      while at < b.count, b[at] >= 0x30, b[at] <= 0x39 {
        if digits < 18 { v = v * 10 + Int64(b[at] - 0x30) } else { simple = false }
        digits += 1; at += 1
      }
      guard digits > 0 else { return Optional.none }
      if at < b.count, b[at] == 0x2e || b[at] == 0x65 || b[at] == 0x45 {
        simple = false
        if b[at] == 0x2e { at += 1; var f = 0; while at < b.count, b[at] >= 0x30, b[at] <= 0x39 { at += 1; f += 1 }; guard f > 0 else { return Optional.none } }
        if at < b.count, b[at] == 0x65 || b[at] == 0x45 {
          at += 1
          if at < b.count, b[at] == 0x2b || b[at] == 0x2d { at += 1 }
          var e = 0; while at < b.count, b[at] >= 0x30, b[at] <= 0x39 { at += 1; e += 1 }
          guard e > 0 else { return Optional.none }
        }
      }
      if simple { return .num(Double(b[start] == 0x2d ? -v : v)) }
      guard let d = Double(String(decoding: UnsafeBufferPointer(rebasing: b[start..<at]), as: UTF8.self)) else { return Optional.none }
      return .num(d)
    }
    mutating func hex4() -> UInt32? {
      guard at + 4 <= b.count else { return Optional.none }
      var v: UInt32 = 0
      for _ in 0..<4 {
        let c = b[at]; at += 1
        let d: UInt32
        switch c { case 0x30...0x39: d = UInt32(c - 0x30); case 0x61...0x66: d = UInt32(c - 0x57); case 0x41...0x46: d = UInt32(c - 0x37); default: return Optional.none }
        v = v << 4 | d
      }
      return v
    }
    mutating func string() -> String? {
      at += 1   // the opening quote
      let start = at
      // fast path: no escapes
      while at < b.count, b[at] != 0x22, b[at] != 0x5c { if b[at] < 0x20 { return Optional.none }; at += 1 }
      guard at < b.count else { return Optional.none }
      if b[at] == 0x22 { let s = String(decoding: UnsafeBufferPointer(rebasing: b[start..<at]), as: UTF8.self); at += 1; return s }
      var out = Array(b[start..<at])
      while at < b.count {
        let c = b[at]
        if c == 0x22 { at += 1; return String(decoding: out, as: UTF8.self) }
        if c < 0x20 { return Optional.none }
        if c != 0x5c { out.append(c); at += 1; continue }
        at += 1
        guard at < b.count else { return Optional.none }
        let e = b[at]; at += 1
        switch e {
        case 0x22: out.append(0x22); case 0x5c: out.append(0x5c); case 0x2f: out.append(0x2f)
        case 0x62: out.append(0x08); case 0x66: out.append(0x0c); case 0x6e: out.append(0x0a); case 0x72: out.append(0x0d); case 0x74: out.append(0x09)
        case 0x75:
          guard var u = hex4() else { return Optional.none }
          if u >= 0xd800 && u < 0xdc00 {
            if at + 6 <= b.count, b[at] == 0x5c, b[at + 1] == 0x75 {
              at += 2
              guard let lo = hex4() else { return Optional.none }
              if lo >= 0xdc00 && lo < 0xe000 { u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00) } else { u = 0xfffd; at -= 6 }
            } else { u = 0xfffd }
          } else if u >= 0xdc00 && u < 0xe000 { u = 0xfffd }
          let sc = Unicode.Scalar(u) ?? "\u{fffd}"
          out += Array(String(Character(sc)).utf8)
        default: return Optional.none
        }
      }
      return Optional.none
    }
  }
}
