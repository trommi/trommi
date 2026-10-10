import XCTest
@testable import TrommiClient

final class HubJSONTests: XCTestCase {
  /** A hub answer's booleans stay booleans through HubClient.json and JV(any:), numbers stay numbers, on every platform. */
  func testBooleansSurvive() throws {
    let j = try XCTUnwrap(HubClient.json(Data(#"{"devices":[{"is_online":true,"link":{"attached":false,"working":true,"since":1}}],"n":1,"z":0,"x":1.5}"#.utf8)))
    let v = JV(any: j)
    XCTAssertEqual(v["devices"][0]["is_online"], .bool(true))
    XCTAssertEqual(v["devices"][0]["link"]["attached"], .bool(false))
    XCTAssertEqual(v["n"], .num(1)); XCTAssertEqual(v["z"], .num(0)); XCTAssertEqual(v["x"], .num(1.5))
    XCTAssertEqual((j["n"] as? NSNumber)?.intValue, 1, "numbers still read as NSNumber")
    XCTAssertEqual(j["devices"].flatMap { ($0 as? [Any])?.first as? [String: Any] }?["is_online"] as? Bool, true)
    // what Foundation's own JSON gives goes through JV(any:) right too
    let f = try JSONSerialization.jsonObject(with: Data(#"{"t":true,"f":false,"one":1,"zero":0}"#.utf8))
    XCTAssertEqual(JV(any: f), .obj(["t": .bool(true), "f": .bool(false), "one": .num(1), "zero": .num(0)]))
    let link = cleanLink(v["devices"][0]["link"].with("hears", .str("live")))
    XCTAssertEqual(link?.attached, false, "a link not attached reads as not attached")
  }
}
