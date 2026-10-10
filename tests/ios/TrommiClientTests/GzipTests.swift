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
  }
}
