// RecordStore.swift: the device's encrypted store of what it verified (README "The huge room": per change, not per
// room). Three kinds of file in the room's folder, each sealed with the cache key (AES-256-GCM, Keychain on iOS):
//
//   records/<first>.seg  append-only segments of records: [u32 length][u64 envelope number][12 nonce][sealed record
//                        in RecCodec's bytes],
//                        AAD "trommi/v1/ios-rec/<number>" (a record cannot be moved to another number). A record seen
//                        again (its body loaded later) is appended again; the later one wins. A segment closes at 1 MiB (read in parallel).
//   head.bin             cursor, lamport, the chain heads, the session secrets: small, rewritten on each save.
//   grants.bin           the session grant chains: written only when they changed.
//
// One new message therefore writes its record (about a KiB) and the head, not the room. Reading verifies every seal;
// a damaged tail (a crash mid-write) is cut off and the rest kept.
import Foundation
import TrommiCore

public final class RecordStore: @unchecked Sendable {
  public static let segmentLimit = 1 << 20
  let dir: URL
  let key: Bytes
  private let queue = DispatchQueue(label: "trommi.records")
  public init(dir: URL, key: Bytes) { self.dir = dir; self.key = key }

  var recordsDir: URL { dir.appendingPathComponent("records", isDirectory: true) }
  var headURL: URL { dir.appendingPathComponent("head.bin") }
  var grantsURL: URL { dir.appendingPathComponent("grants.bin") }

  // ---- sealing ----
  private func seal(_ plain: Bytes, aad: String) throws -> Bytes {
    let nonce = systemRandom(12)
    return nonce + (try gcmSeal(key: key, nonce: nonce, aad: utf8(aad), plain))
  }
  private func open(_ b: Bytes, aad: String) -> Bytes? {
    guard b.count > 12 + 16 else { return nil }
    return try? gcmOpen(key: key, nonce: Array(b[0..<12]), aad: utf8(aad), Array(b[12...]))
  }
  private static var writeOptions: Data.WritingOptions {
    var o: Data.WritingOptions = [.atomic]
    #if os(iOS)
    o.insert(.completeFileProtectionUntilFirstUserAuthentication)
    #endif
    return o
  }

  // ---- small files ----
  public func writeSmall<T: Encodable>(_ v: T, to url: URL, aad: String) throws {
    let json = try JSONEncoder().encode(v)
    try Data(try seal(Array(json), aad: aad)).write(to: url, options: Self.writeOptions)
  }
  public func readSmall<T: Decodable>(_ t: T.Type, from url: URL, aad: String) -> T? {
    guard let d = try? Data(contentsOf: url), let plain = open(Array(d), aad: aad) else { return nil }
    return try? JSONDecoder().decode(t, from: Data(plain))
  }

  // ---- the records ----
  private func segments() -> [(first: Int, url: URL)] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: recordsDir.path)) ?? []
    return names.compactMap { n -> (Int, URL)? in
      guard n.hasSuffix(".seg"), let f = Int(n.dropLast(4)) else { return nil }
      return (f, recordsDir.appendingPathComponent(n))
    }.sorted { $0.0 < $1.0 }
  }
  /** Bytes appended by the last append (what one save wrote of records). */
  public private(set) var lastAppended = 0

  /** Append records (already in envelope order or not: each carries its number). */
  public func append(_ recs: [Rec]) throws {
    guard !recs.isEmpty else { return }
    // a big batch (a catch-up) goes in slices, so that segments stay near their limit
    if recs.count > 500 { var n = 0; for i in stride(from: 0, to: recs.count, by: 500) { try append(Array(recs[i..<min(i + 500, recs.count)])); n += lastAppended }; lastAppended = n; return }
    try FileManager.default.createDirectory(at: recordsDir, withIntermediateDirectories: true)
    var out = [UInt8]()
    out.reserveCapacity(recs.count * 600)
    for r in recs {
      let sealed = try seal(RecCodec.encode(r), aad: "trommi/v1/ios-rec/\(r.envelopeNumber)")
      let n = UInt64(r.envelopeNumber), len = UInt32(8 + sealed.count)
      out += [UInt8(len >> 24), UInt8(len >> 16 & 0xff), UInt8(len >> 8 & 0xff), UInt8(len & 0xff)]
      for i in (0..<8).reversed() { out.append(UInt8(n >> (UInt64(i) * 8) & 0xff)) }
      out += sealed
    }
    var seg = segments().last
    if let s = seg, let size = (try? FileManager.default.attributesOfItem(atPath: s.url.path)[.size] as? NSNumber)?.intValue, size + out.count > Self.segmentLimit { seg = nil }
    let url = seg?.url ?? recordsDir.appendingPathComponent("\(recs.map { $0.envelopeNumber }.min() ?? 0).seg")
    if !FileManager.default.fileExists(atPath: url.path) {
      var opts: Data.WritingOptions = []
      #if os(iOS)
      opts.insert(.completeFileProtectionUntilFirstUserAuthentication)
      #endif
      try Data().write(to: url, options: opts)
    }
    let h = try FileHandle(forWritingTo: url)
    defer { try? h.close() }
    try h.seekToEnd()
    try h.write(contentsOf: Data(out))
    lastAppended = out.count
  }

  /** Where each record lies: found from the clear frames alone (no opening), the last copy of a number winning. */
  public struct Index: @unchecked Sendable {
    public let files: [[UInt8]]
    /** (number, file, offset of the sealed bytes, their length), in envelope order. */
    public let entries: [(n: Int, file: Int, at: Int, len: Int)]
  }
  public func index() -> Index? {
    let segs = segments()
    var files = [[UInt8]](), last = [Int: (Int, Int, Int)]()
    for (i, seg) in segs.enumerated() {
      guard let d = try? Data(contentsOf: seg.url) else { return nil }
      let b = [UInt8](d)
      files.append(b)
      var at = 0
      while at + 4 <= b.count {
        let len = Int(b[at]) << 24 | Int(b[at + 1]) << 16 | Int(b[at + 2]) << 8 | Int(b[at + 3])
        guard len >= 8 + 28, at + 4 + len <= b.count else { break }
        var n = 0
        for k in 0..<8 { n = n << 8 | Int(b[at + 4 + k]) }
        last[n] = (i, at + 12, len - 8)
        at += 4 + len
      }
      // a torn tail (a crash mid-write) is cut off
      if at < b.count, let h = try? FileHandle(forWritingTo: seg.url) { try? h.truncate(atOffset: UInt64(at)); try? h.close() }
    }
    return Index(files: files, entries: last.keys.sorted().map { n in let x = last[n]!; return (n, x.0, x.1, x.2) })
  }
  /** Open and decode a run of the index's entries; nil when one seal does not open (the store is not to be trusted). */
  public func decode(_ ix: Index, _ range: Range<Int>) -> [Rec]? {
    var out = [Rec]()
    out.reserveCapacity(range.count)
    for e in ix.entries[range] {
      let sealed = Array(ix.files[e.file][e.at..<(e.at + e.len)])
      guard let plain = open(sealed, aad: "trommi/v1/ios-rec/\(e.n)"), let r = plain.withUnsafeBufferPointer({ try? RecCodec.decode($0) }), r.envelopeNumber == e.n else { return nil }
      out.append(r)
    }
    return out
  }

  /**
   * Every record, the last copy of each number winning, in envelope order. The segments are opened in parallel; a seal
   * that does not open ends that segment (its tail is cut off on the next append).
   */
  public func readAll() -> [Rec] {
    let segs = segments()
    var parts = [[(Int, Rec)]](repeating: [], count: segs.count)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: segs.count) { i in
      guard let d = try? Data(contentsOf: segs[i].url) else { return }
      let b = [UInt8](d)
      var at = 0, got = [(Int, Rec)]()
      while at + 4 <= b.count {
        let len = Int(b[at]) << 24 | Int(b[at + 1]) << 16 | Int(b[at + 2]) << 8 | Int(b[at + 3])
        guard len >= 8, at + 4 + len <= b.count else { break }
        var n = 0
        for k in 0..<8 { n = n << 8 | Int(b[at + 4 + k]) }
        let sealed = Array(b[(at + 12)..<(at + 4 + len)])
        guard let plain = open(sealed, aad: "trommi/v1/ios-rec/\(n)"), let r = plain.withUnsafeBufferPointer({ try? RecCodec.decode($0) }), r.envelopeNumber == n else { break }
        got.append((n, r))
        at += 4 + len
      }
      if at < b.count, let h = try? FileHandle(forWritingTo: segs[i].url) { try? h.truncate(atOffset: UInt64(at)); try? h.close() }
      lock.lock(); parts[i] = got; lock.unlock()
    }
    var byNumber = [Int: Rec]()
    byNumber.reserveCapacity(parts.reduce(0) { $0 + $1.count })
    for p in parts { for (n, r) in p { byNumber[n] = r } }
    return byNumber.keys.sorted().map { byNumber[$0]! }
  }

  /** Everything gone (a resync from envelope 0, leaving the room). */
  public func wipe() {
    try? FileManager.default.removeItem(at: recordsDir)
    try? FileManager.default.removeItem(at: headURL)
    try? FileManager.default.removeItem(at: grantsURL)
  }

  /** Total bytes of the segments (for the compaction rule and the measurements). */
  public var recordBytes: Int {
    segments().reduce(0) { $0 + ((try? FileManager.default.attributesOfItem(atPath: $1.url.path)[.size] as? NSNumber)?.intValue ?? 0) }
  }
}
