// The Swift binding reaches the Rust core: one call through UniFFI and the static library.
import XCTest
@testable import TrommiCoreRust

final class RoundTripTests: XCTestCase {
  func testCoreVersion() {
    XCTAssertEqual(coreVersion(), "0.0.0")
  }
}
