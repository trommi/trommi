import XCTest
@testable import TrommiClient

final class RecordStoreTests: XCTestCase {
  func rec(_ n: Int, text: String = "hello") -> Rec {
    var r = Rec(envelopeNumber: n, envelopeHash: String(repeating: "ab", count: 32), senderDeviceId: String(repeating: "0f", count: 32), senderRole: "agent",
                recipientDeviceId: nil, sentAt: 1_791_000_000_000 + UInt64(n), kind: 1, isHead: false,
                object: ObjectHead(objectId: String(repeating: "c", count: 32), objectState: 1, urgency: 2, answeredAt: 0),
                timelineKind: "chat", timelineId: "session/\(String(repeating: "1", count: 32))", sessionId: String(repeating: "1", count: 32),
                attachmentIds: ["dd"], content: .obj(["content_type": .str("message"), "text": .str(text), "n": .num(1.5), "k": .num(-3), "ok": .bool(true), "l": .arr([.null, .str("Ä")])]),
                contentState: "ok", bind: .answer(cardId: "aa", versionHash: "bb", choices: ["x", "Y"]),
                causal: Causal(senderDeviceId: String(repeating: "0f", count: 32), senderSequence: UInt64(n), sentAt: 5, lamport: 7), senderSequence: UInt64(n), epoch: 2)
    r.objectIdOk = true
    return r
  }
  func testCodecRoundTrip() throws {
    let r = rec(42)
    let b = RecCodec.encode(r)
    let back = try b.withUnsafeBufferPointer { try RecCodec.decode($0) }
    let enc = JSONEncoder(); enc.outputFormatting = .sortedKeys
    XCTAssertEqual(try enc.encode(back), try enc.encode(r))
    XCTAssertEqual(back.content, r.content)
    XCTAssertEqual(back.bind, r.bind)
  }
  func testAppendReadLastWinsAndTornTail() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rs-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let rs = RecordStore(dir: dir, key: systemRandom(32))
    try rs.append((1...1200).map { rec($0) })
    try rs.append([rec(7, text: "again")])
    XCTAssertLessThan(rs.lastAppended, 1024)
    let ix = try XCTUnwrap(rs.index())
    XCTAssertEqual(ix.entries.count, 1200)
    let all = try XCTUnwrap(rs.decode(ix, 0..<ix.entries.count))
    XCTAssertEqual(all.map { $0.envelopeNumber }, Array(1...1200))
    XCTAssertEqual(all[6].content?["text"].string, "again")
    // a torn write at the end: cut off, the rest kept
    let seg = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: rs.recordsDir, includingPropertiesForKeys: nil).sorted { $0.path < $1.path }.last)
    let h = try FileHandle(forWritingTo: seg); try h.seekToEnd(); try h.write(contentsOf: Data([0, 0, 1, 0, 1, 2])); try h.close()
    XCTAssertEqual(try XCTUnwrap(rs.index()).entries.count, 1200)
    // a record opened with another key: refused
    let other = RecordStore(dir: dir, key: systemRandom(32))
    XCTAssertNil(other.decode(try XCTUnwrap(other.index()), 0..<1))
  }
}
