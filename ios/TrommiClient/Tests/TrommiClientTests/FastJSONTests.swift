import XCTest
@testable import TrommiClient

final class FastJSONTests: XCTestCase {
  func testSameAsFoundation() throws {
    let samples = [#"{"a":[1,-2,3.5,1e3,-0.25E-2,12345678901234567890],"b":{"c":null,"d":true,"e":false},"s":"x\"\\\/\b\f\n\r\tä😀 é"}"#,
                   "[]", "{}", #"  [ "  " , { } , [ [ ] ] ]  "#, "0", #""text""#]
    for t in samples {
      let mine = try XCTUnwrap(FastJSON.parse(Array(t.utf8)), t)
      let theirs = try JSONDecoder().decode(JV.self, from: Data(t.utf8))
      XCTAssertEqual(mine, theirs, t)
    }
    for bad in ["", "{", "[1,]", #"{"a" 1}"#, "tru", "01x", #""\x""#, "[1] 2", "\"a\u{01}b\""] { XCTAssertTrue(FastJSON.parse(Array(bad.utf8)) == Optional<JV>.none, bad) }
  }
}
