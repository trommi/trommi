// The core's self-test through the Swift binding, and what the binding says about itself.
import XCTest
import TrommiCoreRust

final class SelfTestTests: XCTestCase {
  func testTheSelfTestPasses() {
    let report = selfTest(nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
    for step in report.steps {
      XCTAssertTrue(step.ok, "\(step.name): \(step.detail)")
    }
    XCTAssertTrue(report.ok)
    XCTAssertEqual(report.steps.count, 11)
    XCTAssertEqual(report.versions, versions())
    XCTAssertEqual(report.versions.openmls, "0.9.1")
  }

  func testARefusalCarriesItsStableCode() {
    XCTAssertThrowsError(try base64urlDecode(text: "not base64url!")) { error in
      guard case let CoreError.Refused(code, _) = error else { return XCTFail("\(error)") }
      XCTAssertEqual(code, .badFormat)
      XCTAssertEqual(errorCodeText(code: code), "bad-format")
    }
    XCTAssertEqual(errorCodeFromText(text: "epoch-taken"), .epochTaken)
    XCTAssertNil(errorCodeFromText(text: "no-such-code"))
    XCTAssertEqual(logFinding(code: .roomBehind), .early)
  }

  func testRecordsWithKeysPrintNothingOfThem() throws {
    let encryptor = try FileEncryptor()
    _ = try encryptor.update(plaintext: Data(repeating: 1, count: 10))
    let end = try encryptor.finish()
    XCTAssertEqual("\(end.file)", "FileRef(<redacted>)")
    XCTAssertEqual(String(reflecting: end), "FileEnd(<redacted>)")
    XCTAssertTrue(Mirror(reflecting: end.file).children.isEmpty)
    var dumped = ""
    dump(end, to: &dumped)
    XCTAssertFalse(dumped.contains("fileKey"))
    // A file object that was used up refuses.
    XCTAssertThrowsError(try encryptor.finish())
  }
}
