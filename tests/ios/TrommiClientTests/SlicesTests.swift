// The slices a walk hands the core (PastWalk.swift): at most 256 Commits and 16 MiB each, in order, and halved when
// the core still finds one too large.
import XCTest
@testable import TrommiClient

final class SlicesTests: XCTestCase {
  func testSlicesKeepOrderAndTheLimits() throws {
    var cap = Slices.maxCommits, slices = [[Int]]()
    try Slices.feed(Array(0..<600), size: { _ in 1 }, cap: &cap) { slices.append($0); return true }
    XCTAssertEqual(slices.map(\.count), [256, 256, 88])
    XCTAssertEqual(slices.flatMap { $0 }, Array(0..<600))
    // By bytes: two of 10 MiB never go together; one larger than a slice goes alone, and the core decides.
    slices = []
    try Slices.feed([10 << 20, 10 << 20, 20 << 20, 1], size: { $0 }, cap: &cap) { slices.append($0); return true }
    XCTAssertEqual(slices.map(\.count), [1, 1, 1, 1])
  }

  func testATooLargeSliceIsHalvedAndTheRestFollows() throws {
    var cap = Slices.maxCommits, taken = [Int](), tries = [Int]()
    try Slices.feed(Array(0..<10), size: { _ in 1 }, cap: &cap) { slice in
      tries.append(slice.count)
      guard slice.count <= 3 else { throw TrommiError("too-large") }
      taken += slice
      return true
    }
    XCTAssertEqual(taken, Array(0..<10))
    XCTAssertEqual(tries, [10, 5, 2, 2, 2, 2, 2])
    XCTAssertEqual(cap, 2)
    // One Commit the core refuses alone is the refusal.
    XCTAssertThrowsError(try Slices.feed([1], size: { $0 }, cap: &cap) { _ in throw TrommiError("too-large") })
  }

  func testAWalkStopsWhenTold() throws {
    var cap = Slices.maxCommits, slices = 0
    let finished = try Slices.feed(Array(0..<600), size: { _ in 1 }, cap: &cap) { _ in slices += 1; return false }
    XCTAssertFalse(finished)
    XCTAssertEqual(slices, 1)
  }
}
