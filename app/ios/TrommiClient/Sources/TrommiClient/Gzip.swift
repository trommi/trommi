// Gzip.swift: unpacking gzip'd JSON as the web packs it with CompressionStream (a canvas snapshot, the room snapshot).
// On Apple systems the Compression framework (raw deflate after the gzip header); elsewhere (Linux: trommi-swift, the
// interop suite) a small inflate of its own (RFC 1951). Either way the result is checked against the gzip trailer's
// length and CRC-32.
import Foundation
#if canImport(Compression)
import Compression
#endif

/** The most a gzip'd file is unpacked to (a snapshot of a board is far smaller): more is refused, not allocated. */
public let GUNZIP_MAX = 64 << 20

public func gunzip(_ b: [UInt8], maxBytes: Int = GUNZIP_MAX) -> [UInt8]? {
  guard b.count > 18, b[0] == 0x1f, b[1] == 0x8b, b[2] == 8 else { return nil }
  let flags = b[3]
  var o = 10
  if flags & 4 != 0 { guard o + 2 <= b.count else { return nil }; o += 2 + Int(b[o]) | Int(b[o + 1]) << 8 }
  if flags & 8 != 0 { while o < b.count && b[o] != 0 { o += 1 }; o += 1 }
  if flags & 16 != 0 { while o < b.count && b[o] != 0 { o += 1 }; o += 1 }
  if flags & 2 != 0 { o += 2 }
  guard o < b.count - 8 else { return nil }
  let crc = UInt32(b[b.count - 8]) | UInt32(b[b.count - 7]) << 8 | UInt32(b[b.count - 6]) << 16 | UInt32(b[b.count - 5]) << 24
  let size = Int(b[b.count - 4]) | Int(b[b.count - 3]) << 8 | Int(b[b.count - 2]) << 16 | Int(b[b.count - 1]) << 24
  // (the trailer's length is the sender's word: what is allocated is bounded by maxBytes, and the unpacked bytes
  // must come to exactly that length)
  guard size <= maxBytes else { return nil }
  let src = Array(b[o..<(b.count - 8)])
  var out: [UInt8]?
  #if canImport(Compression)
  let cap = max(size, 64) + 64
  var buf = [UInt8](repeating: 0, count: cap)
  let n = buf.withUnsafeMutableBufferPointer { dst in src.withUnsafeBufferPointer { s in compression_decode_buffer(dst.baseAddress!, cap, s.baseAddress!, s.count, nil, COMPRESSION_ZLIB) } }
  out = n > 0 ? Array(buf[0..<n]) : nil
  #else
  out = Inflate.inflate(src, sizeHint: size, maxBytes: maxBytes)
  #endif
  guard let r = out, r.count & 0xffff_ffff == size, crc32(r) == crc else { return nil }
  return r
}

/** CRC-32 (IEEE), the gzip trailer's check. */
func crc32(_ b: [UInt8]) -> UInt32 {
  var c: UInt32 = 0xffff_ffff
  for x in b { c = CRC_TABLE[Int((c ^ UInt32(x)) & 0xff)] ^ (c >> 8) }
  return c ^ 0xffff_ffff
}
private let CRC_TABLE: [UInt32] = (0..<256).map { n -> UInt32 in
  var c = UInt32(n)
  for _ in 0..<8 { c = c & 1 != 0 ? 0xedb8_8320 ^ (c >> 1) : c >> 1 }
  return c
}

/** Raw deflate (RFC 1951): stored, fixed and dynamic Huffman blocks. Nil on malformed input. */
enum Inflate {
  struct Bits {
    let b: [UInt8]
    var at = 0, bit = 0
    mutating func get(_ n: Int) -> Int? {
      var v = 0
      for i in 0..<n {
        guard at < b.count else { return nil }
        v |= Int((b[at] >> UInt8(bit)) & 1) << i
        bit += 1; if bit == 8 { bit = 0; at += 1 }
      }
      return v
    }
    mutating func align() { if bit != 0 { bit = 0; at += 1 } }
  }
  /** A canonical Huffman code: counts per length and symbols in code order. */
  struct Huff {
    var counts = [Int](repeating: 0, count: 16)
    var symbols = [Int]()
    init?(_ lengths: [Int]) {
      for l in lengths { counts[l] += 1 }
      counts[0] = 0
      var offs = [Int](repeating: 0, count: 16)
      for i in 1..<16 { offs[i] = offs[i - 1] + counts[i - 1] }
      symbols = [Int](repeating: 0, count: lengths.count)
      for (s, l) in lengths.enumerated() where l != 0 { symbols[offs[l]] = s; offs[l] += 1 }
    }
    func decode(_ r: inout Bits) -> Int? {
      var code = 0, first = 0, index = 0
      for len in 1..<16 {
        guard let x = r.get(1) else { return nil }
        code |= x
        let count = counts[len]
        if code - count < first { return symbols[index + (code - first)] }
        index += count; first += count; first <<= 1; code <<= 1
      }
      return nil
    }
  }
  static let LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
  static let LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
  static let DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
  static let DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
  static let ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

  static func inflate(_ src: [UInt8], sizeHint: Int = 0, maxBytes: Int = GUNZIP_MAX) -> [UInt8]? {
    var r = Bits(b: src)
    var out = [UInt8]()
    out.reserveCapacity(min(maxBytes, max(sizeHint, src.count * 3)))
    let fixedL = Huff((0..<288).map { $0 < 144 ? 8 : $0 < 256 ? 9 : $0 < 280 ? 7 : 8 })!
    let fixedD = Huff([Int](repeating: 5, count: 30))!
    while true {
      guard let final = r.get(1), let type = r.get(2) else { return nil }
      switch type {
      case 0:
        r.align()
        guard r.at + 4 <= src.count else { return nil }
        let len = Int(src[r.at]) | Int(src[r.at + 1]) << 8, nlen = Int(src[r.at + 2]) | Int(src[r.at + 3]) << 8
        guard len == ~nlen & 0xffff, r.at + 4 + len <= src.count else { return nil }
        out += src[(r.at + 4)..<(r.at + 4 + len)]
        if out.count > maxBytes { return nil }
        r.at += 4 + len
      case 1, 2:
        var lit = fixedL, dist = fixedD
        if type == 2 {
          guard let hlit = r.get(5), let hdist = r.get(5), let hclen = r.get(4) else { return nil }
          var cl = [Int](repeating: 0, count: 19)
          for i in 0..<(hclen + 4) { guard let v = r.get(3) else { return nil }; cl[ORDER[i]] = v }
          guard let clh = Huff(cl) else { return nil }
          var lengths = [Int]()
          let total = hlit + 257 + hdist + 1
          while lengths.count < total {
            guard let sym = clh.decode(&r) else { return nil }
            if sym < 16 { lengths.append(sym) }
            else if sym == 16 { guard let prev = lengths.last, let n = r.get(2) else { return nil }; lengths += [Int](repeating: prev, count: 3 + n) }
            else if sym == 17 { guard let n = r.get(3) else { return nil }; lengths += [Int](repeating: 0, count: 3 + n) }
            else { guard let n = r.get(7) else { return nil }; lengths += [Int](repeating: 0, count: 11 + n) }
          }
          guard lengths.count == total, let l = Huff(Array(lengths[0..<(hlit + 257)])), let d = Huff(Array(lengths[(hlit + 257)...])) else { return nil }
          lit = l; dist = d
        }
        while true {
          guard let sym = lit.decode(&r) else { return nil }
          if sym < 256 { out.append(UInt8(sym)); if out.count > maxBytes { return nil }; continue }
          if sym == 256 { break }
          let li = sym - 257
          guard li < 29, let le = r.get(LEXT[li]), let ds = dist.decode(&r), ds < 30, let de = r.get(DEXT[ds]) else { return nil }
          let len = LBASE[li] + le, back = DBASE[ds] + de
          guard back <= out.count else { return nil }
          let start = out.count - back
          for k in 0..<len { out.append(out[start + k]) }
          if out.count > maxBytes { return nil }
        }
      default: return nil
      }
      if final == 1 { return out }
    }
  }
}
