// Gzip.swift: unpacking a canvas snapshot (gzip'd JSON, as the web packs it with CompressionStream). On Apple systems
// with the Compression framework (raw deflate after the gzip header); elsewhere nil (the canvas is read from its items).
import Foundation
#if canImport(Compression)
import Compression
#endif

public func gunzip(_ b: [UInt8]) -> [UInt8]? {
  #if canImport(Compression)
  guard b.count > 18, b[0] == 0x1f, b[1] == 0x8b, b[2] == 8 else { return nil }
  let flags = b[3]
  var o = 10
  if flags & 4 != 0 { guard o + 2 <= b.count else { return nil }; o += 2 + Int(b[o]) | Int(b[o + 1]) << 8 }
  if flags & 8 != 0 { while o < b.count && b[o] != 0 { o += 1 }; o += 1 }
  if flags & 16 != 0 { while o < b.count && b[o] != 0 { o += 1 }; o += 1 }
  if flags & 2 != 0 { o += 2 }
  guard o < b.count - 8 else { return nil }
  let size = Int(b[b.count - 4]) | Int(b[b.count - 3]) << 8 | Int(b[b.count - 2]) << 16 | Int(b[b.count - 1]) << 24
  let cap = max(size, 64) + 64
  var out = [UInt8](repeating: 0, count: cap)
  let src = Array(b[o..<(b.count - 8)])
  let n = out.withUnsafeMutableBufferPointer { dst in src.withUnsafeBufferPointer { s in compression_decode_buffer(dst.baseAddress!, cap, s.baseAddress!, s.count, nil, COMPRESSION_ZLIB) } }
  return n > 0 ? Array(out[0..<n]) : nil
  #else
  return nil
  #endif
}
