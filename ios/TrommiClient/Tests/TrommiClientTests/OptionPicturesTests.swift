import XCTest
@testable import TrommiClient

final class OptionPicturesTests: XCTestCase {
  private func jv(_ s: String) -> JV { try! JSONDecoder().decode(JV.self, from: Data(s.utf8)) }
  private func pic(_ name: String) -> JV { jv(#"{"file_name":"\#(name)","media_type":"image/png"}"#) }
  private let file = #"{"file_name":"log.txt","media_type":"text/plain"}"#
  private func opts(_ keys: String...) -> [Option] { keys.map { Option(jv(#"{"key":"\#($0)","label":"\#($0.capitalized)"}"#)) } }

  func testSectionNamesItsPicture() {
    // the section's picture is a position among all the attachments; the index returned counts pictures only
    let atts = [jv(file), pic("a.png"), pic("b.png")]
    let secs = [jv(#"{"text":"intro"}"#), jv(#"{"key":"x","label":"X","text":"..","picture":2}"#), jv(#"{"key":"y","label":"Y","text":"..","picture":2}"#)]
    XCTAssertEqual(OptionPictures.of(attachments: atts, options: opts("x", "y"), sections: secs), ["x": 1, "y": 1], "one picture for two options")
  }

  func testFileNames() {
    let atts = [pic("side-dark.png"), pic("side-light.png")]
    XCTAssertEqual(OptionPictures.of(attachments: atts, options: opts("light", "dark"), sections: nil), ["dark": 0, "light": 1])
    // only one picture names an option: not plain enough
    XCTAssertEqual(OptionPictures.of(attachments: [pic("x-dark.png"), pic("other.png")], options: opts("light", "dark"), sections: nil), [:])
  }

  func testCountOnlyFromThree() {
    let three = [pic("1.png"), pic("2.png"), pic("3.png")]
    XCTAssertEqual(OptionPictures.of(attachments: three, options: opts("a", "b", "c"), sections: nil), ["a": 0, "b": 1, "c": 2])
    XCTAssertEqual(OptionPictures.of(attachments: Array(three.prefix(2)), options: opts("a", "b"), sections: nil), [:], "two and two: no guess")
  }
}
