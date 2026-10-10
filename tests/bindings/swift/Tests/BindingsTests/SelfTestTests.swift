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
    XCTAssertEqual(report.steps.count, 12)
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

  /// The known answers of spec/vectors/account.json: the Emergency Kit of an account without an e-mail.
  func testTheAccountVectors() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../spec/vectors/account.json")
    guard let vectors = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
      let idText = vectors["account_id_text"] as? String, let words = vectors["words"] as? String,
      let cases = vectors["cases"] as? [[String: Any]], let refusedTexts = vectors["refused_id_texts"] as? [[String: String]],
      let roomHex = vectors["room_id"] as? String, let sealedHex = vectors["sealed"] as? String
    else { return XCTFail("the vectors do not read") }
    func unhex(_ text: String) -> Data {
      var data = Data()
      var rest = Substring(text)
      while rest.count >= 2 { data.append(UInt8(rest.prefix(2), radix: 16)!); rest = rest.dropFirst(2) }
      return data
    }
    func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    func refused(_ work: () throws -> Void) -> ErrorCode? {
      do { try work() } catch let CoreError.Refused(code, _) { return code } catch { return .internal }
      return nil
    }
    XCTAssertEqual(try accountIdParse(text: idText), idText)
    XCTAssertEqual(try accountIdParse(text: " " + idText.uppercased().replacingOccurrences(of: "-", with: " ") + " "), idText)
    for text in ["", String(idText.dropFirst()), idText + "0", String(idText.dropLast()) + "g", "{\(idText)}", "urn:uuid:\(idText)"] {
      XCTAssertEqual(refused { _ = try accountIdParse(text: text) }, .badFormat, text)
    }
    for entry in refusedTexts {
      XCTAssertEqual(refused { _ = try kitKeysFor(name: AccountName(email: nil, id: entry["text"]), words: words) }, .badFormat, entry["why"] ?? "")
    }
    for entry in cases {
      guard let account = entry["account"] as? [String: String] else { return XCTFail("a case names no account") }
      let keys = try kitKeysFor(name: AccountName(email: account["email"], id: account["id"]), words: words)
      XCTAssertEqual(hex(keys.authKey), entry["auth_key"] as? String)
      XCTAssertEqual(hex(keys.wrapKey), entry["wrap_key"] as? String)
      var result: String
      do {
        result = "opens: " + hex(try openRecoveryCode(wrapKey: keys.wrapKey, roomId: unhex(roomHex), wayIn: .kit, credentialId: nil, sealed: unhex(sealedHex)))
      } catch let CoreError.Refused(code, _) {
        result = errorCodeText(code: code)
      }
      XCTAssertEqual(result, entry["result"] as? String, entry["why"] as? String ?? "")
    }
    XCTAssertEqual(refused { _ = try kitKeysFor(name: AccountName(email: "owner@example.com", id: idText), words: words) }, .badFormat)
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
