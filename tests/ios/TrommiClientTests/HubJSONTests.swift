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
  /// A log gets known codes and the status only: never the hub's message, nor a code the hub made up.
  func testWhatOfAnErrorGoesIntoALog() {
    XCTAssertEqual(loggable(HubError(status: 403, code: "not-member", message: "secret text")), "not-member (403)")
    XCTAssertEqual(loggable(HubError(status: 400, code: "Bearer abc.def", message: "")), "other (400)")
    XCTAssertEqual(loggable(HubError(status: 0, code: "offline", message: "hub not reachable: 10.0.0.1")), "offline (0)")
    XCTAssertEqual(loggable(TrommiError("no-prf", "this passkey gives no key")), "no-prf")
    XCTAssertEqual(loggable(TrommiError("a code with spaces", "")), "other")
    XCTAssertEqual(loggable(CocoaError(.fileNoSuchFile)), "error")
  }
  /// The two lines of an agent's invite, as the web's page has them, the link in the second.
  func testTheAgentsTwoLines() {
    let link = "https://app.trommi.com/join#v1.a.b.c.d"
    XCTAssertEqual(agentConnectSteps(link: link).map(\.command), [
      "curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh",
      "/trommi:connect 'https://app.trommi.com/join#v1.a.b.c.d'"])
    XCTAssertEqual(agentConnectSteps(link: link).map(\.title), ["First time on this computer? Install:", "In your project folder, start claude (or codex) and paste:"])
    XCTAssertEqual(agentConnectSteps(link: link)[0].note, "Skip this if you have installed Trommi before (check: trommi-connector --version).")
    XCTAssertEqual(agentConnectSteps(link: link)[1].note, "Claude Code asks once whether to use the trommi MCP server: choose \"Use this MCP server\".")
  }
}
