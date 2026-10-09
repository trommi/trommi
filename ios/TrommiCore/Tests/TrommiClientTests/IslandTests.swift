import XCTest
@testable import TrommiClient

final class IslandTests: XCTestCase {
  /** iPhone 15/16 (393 × 852, safe top 59), the Pro Max (430 × 932, 59) and the 16 Pro (402 × 874, 62): the grown shape
   *  is 11 pt from the edges and the top, holds the island, and its content row lies wholly below the sensors. */
  func testGeometry() throws {
    for (w, safeTop, top) in [(CGFloat(393), CGFloat(59), CGFloat(11)), (430, 59, 11), (402, 62, 14)] {
      let p = try XCTUnwrap(IslandPill.of(width: w, safeTop: safeTop))
      XCTAssertEqual(p.island.size, IslandPill.islandSize)
      XCTAssertEqual(p.island.minY, top)
      XCTAssertEqual(p.island.midX, w / 2, accuracy: 0.5)
      XCTAssertEqual(p.grown.minX, 11); XCTAssertEqual(p.grown.maxX, w - 11); XCTAssertEqual(p.grown.minY, 11)
      XCTAssertTrue(p.grown.contains(p.island))
      XCTAssertEqual(p.content.height, IslandPill.row)
      XCTAssertEqual(p.content.minY + p.grown.minY, p.island.maxY, "the content starts under the sensors at \(w)")
      XCTAssertGreaterThanOrEqual(p.grown.height, 2 * IslandPill.grownRadius, "room for the corners at \(w)")
    }
  }
  func testNoIsland() {
    XCTAssertNil(IslandPill.of(width: 390, safeTop: 47))   // a notch
    XCTAssertNil(IslandPill.of(width: 375, safeTop: 20))   // no notch
    XCTAssertNil(IslandPill.of(width: 1024, safeTop: 24))  // an iPad
  }
}
