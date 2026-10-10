import XCTest
@testable import TrommiClient

final class GzipTests: XCTestCase {
  func testInflate() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "gzip", withExtension: "json", subdirectory: "Fixtures") ?? Bundle.module.url(forResource: "gzip", withExtension: "json"))
    let f = try XCTUnwrap(JV.parse(Array(try Data(contentsOf: url))))
    let bytes = { (k: String) in (f[k].array ?? []).map { UInt8($0.int!) } }
    XCTAssertEqual(String(decoding: try XCTUnwrap(gunzip(bytes("small"))), as: UTF8.self), "hello hello hello hello")
    let big = try XCTUnwrap(gunzip(bytes("big")))
    XCTAssertEqual(big.count, f["big_len"].int)
    XCTAssertTrue(String(decoding: big, as: UTF8.self).hasPrefix(f["big_head"].string!))
    XCTAssertEqual(try XCTUnwrap(gunzip(bytes("stored"))), Array((0..<1024).map { UInt8($0 & 255) }))
    var broken = bytes("big"); broken[broken.count / 2] ^= 0x55
    XCTAssertNil(gunzip(broken), "a damaged stream (or its CRC) is refused")
    // the trailer's length is the sender's word: a length over the bound is refused before anything is allocated,
    // and a stream that unpacks past the bound stops there
    var lying = bytes("small")
    for i in 1...4 { lying[lying.count - i] = 0xff }
    XCTAssertNil(gunzip(lying))
    XCTAssertNil(gunzip(bytes("big"), maxBytes: big.count - 1))
    XCTAssertNotNil(gunzip(bytes("big"), maxBytes: big.count))
    XCTAssertNil(Inflate.inflate(Array(bytes("big")[10..<(bytes("big").count - 8)]), sizeHint: 1 << 40, maxBytes: 100))
  }

  /// A number a sender wrote as a time never traps, whatever it is.
  func testANumberOfTheContentIsClamped() {
    XCTAssertEqual(clampedU64(nil), 0)
    XCTAssertEqual(clampedU64(-5), 0)
    XCTAssertEqual(clampedU64(.nan), 0)
    XCTAssertEqual(clampedU64(.infinity), 0)
    XCTAssertEqual(clampedU64(1e30), 9_007_199_254_740_992)
    XCTAssertEqual(clampedU64(1_700_000_000_000.7), 1_700_000_000_000)
  }
}
