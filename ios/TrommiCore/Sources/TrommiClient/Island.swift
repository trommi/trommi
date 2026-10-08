// Island.swift: where the undo pill stands on an iPhone with the Dynamic Island. An app cannot draw into the island, so
// the pill is a pure black capsule laid exactly over it and a little wider: it reads as the island growing. Its content
// (the undo arrow in its ring, the count) sits only in the two wings beside the island. Phones without an island (a
// safe area top below 51 pt) get nil: the app shows its glass pill at the top right instead.
import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

public struct IslandPill {
  /** The island as iOS draws it (iPhone 14 Pro and later: 126 × 37 pt, 11 pt from the top, centred). */
  public static let islandSize = CGSize(width: 126, height: 37)
  public static let islandTop: CGFloat = 11
  /** How much wider the pill is than the island: one wing of `wing` points on each side. */
  public static let wing: CGFloat = 32

  public let island: CGRect
  public let pill: CGRect
  public var radius: CGFloat { pill.height / 2 }
  /** The free part left and right of the island inside the pill (the count left, the arrow right). */
  public var leftWing: CGRect { CGRect(x: pill.minX, y: pill.minY, width: island.minX - pill.minX, height: pill.height) }
  public var rightWing: CGRect { CGRect(x: island.maxX, y: pill.minY, width: pill.maxX - island.maxX, height: pill.height) }

  /** The pill for a screen `width` wide whose safe area starts `safeTop` from the top; nil without an island. */
  public static func of(width: CGFloat, safeTop: CGFloat) -> IslandPill? {
    guard safeTop >= 51, width < 600 else { return nil }
    let s = islandSize
    let island = CGRect(x: ((width - s.width) / 2).rounded(), y: islandTop, width: s.width, height: s.height)
    let pill = CGRect(x: island.minX - wing, y: islandTop, width: s.width + 2 * wing, height: s.height)
    return IslandPill(island: island, pill: pill)
  }
}
