import XCTest
@testable import TrommiClient

final class IslandTests: XCTestCase {
  /** iPhone 15/16 (393 × 852, safe top 59) and the Pro Max (430 × 932, safe top 59): the pill covers the island exactly
   *  in height, grows 32 pt each side, stays clear of the clock (ends ≈ 95 pt) and the battery (starts ≈ width − 95). */
  func testGeometry() throws {
    for (w, clockEnd, batteryStart) in [(CGFloat(393), CGFloat(95), CGFloat(298)), (430, 104, 326)] {
      let p = try XCTUnwrap(IslandPill.of(width: w, safeTop: 59))
      XCTAssertEqual(p.pill.midX, w / 2, accuracy: 0.5)
      XCTAssertEqual(p.pill.minY, p.island.minY)
      XCTAssertEqual(p.pill.height, p.island.height)
      XCTAssertEqual(p.radius, 18.5)
      XCTAssertEqual(p.pill.width, 190)
      XCTAssertTrue(p.pill.contains(p.island))
      XCTAssertGreaterThan(p.pill.minX, clockEnd, "clear of the clock at \(w)")
      XCTAssertLessThan(p.pill.maxX, batteryStart, "clear of the battery at \(w)")
      XCTAssertGreaterThanOrEqual(p.leftWing.width, 28); XCTAssertGreaterThanOrEqual(p.rightWing.width, 28)
    }
  }
  func testNoIsland() {
    XCTAssertNil(IslandPill.of(width: 390, safeTop: 47))   // a notch
    XCTAssertNil(IslandPill.of(width: 375, safeTop: 20))   // no notch
    XCTAssertNil(IslandPill.of(width: 1024, safeTop: 24))  // an iPad
  }
}
