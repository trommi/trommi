// Island.swift: where the app's passing word stands on an iPhone with the Dynamic Island. An app cannot draw into the
// island, so the word is a pure black shape laid exactly over it: it starts as the island's own capsule and grows, as
// the system's expanded island does, to a shape 11 pt from the screen's edges with corners concentric to the display,
// one row of content under the sensor row. Phones without an island (a safe area top below 51 pt) get nil: the app
// shows its glass capsule under the status bar instead.
import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

public struct IslandPill {
  /** The island as iOS draws it: 126 × 37 pt, centred. */
  public static let islandSize = CGSize(width: 126, height: 37)
  /** The grown shape: this far from the screen's edges and its top, corners of this radius (continuous). */
  public static let inset: CGFloat = 11
  public static let grownRadius: CGFloat = 44
  /** The row of content under the sensor row. */
  public static let row: CGFloat = 51

  /** The island itself (the collapsed shape) and the grown shape, in screen coordinates. */
  public let island: CGRect
  public let grown: CGRect
  /** The content's row inside the grown shape, in the grown shape's own coordinates: below the sensors. */
  public var content: CGRect { CGRect(x: 0, y: island.maxY - grown.minY, width: grown.width, height: grown.maxY - island.maxY) }

  /** The island's top for a safe area top: 11 pt on the phones with a 59 pt safe area (14 Pro to 16), lower on those
   *  with thinner bezels (62 pt: 14 pt). The grown shape starts at 11 pt on all of them, so it covers the island
   *  whichever it is. */
  public static func islandTop(safeTop: CGFloat) -> CGFloat { min(max(safeTop - 48, 11), 20) }

  /** The shapes for a screen `width` wide whose safe area starts `safeTop` from the top; nil without an island. */
  public static func of(width: CGFloat, safeTop: CGFloat) -> IslandPill? {
    guard safeTop >= 51, width < 600 else { return nil }
    let s = islandSize
    let island = CGRect(x: ((width - s.width) / 2).rounded(), y: islandTop(safeTop: safeTop), width: s.width, height: s.height)
    let grown = CGRect(x: inset, y: inset, width: width - 2 * inset, height: island.maxY - inset + row)
    return IslandPill(island: island, grown: grown)
  }
}
