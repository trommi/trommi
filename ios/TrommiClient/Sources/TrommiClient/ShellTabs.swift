// ShellTabs: which item of the iPhone's bar is lit, and which page lies in front. Chat and Desk are pages; Note is no
// page: it lies over the page he came from. While it is open the bar is lit on Note, closed it is back on that page.
// Pure, so `swift test` covers every way the note opens and closes (a tap, a drop, a share, from either page).
import Foundation

public enum ShellTab: String, Sendable, CaseIterable { case chat, desk, note }

public struct ShellTabs: Equatable, Sendable {
  /** The lit item of the bar. */
  public private(set) var lit: ShellTab
  /** The page under the note (never .note): shown while the note is open, selected again when it closes. */
  public private(set) var under: ShellTab
  public init(_ tab: ShellTab = .desk) { lit = tab == .note ? .desk : tab; under = lit; if tab == .note { lit = .note } }

  /** The note lies over the page. */
  public var noteOpen: Bool { lit == .note }
  /** The page in front (under the note while it is open). */
  public var page: ShellTab { lit == .note ? under : lit }
  /** The item's place in the bar, from the left. */
  public static func index(_ t: ShellTab) -> Int { t == .chat ? 0 : t == .desk ? 1 : 2 }

  /** Go to a page, or open the note over the page in front (from anywhere: a drop, a share, a menu). */
  public mutating func select(_ t: ShellTab) {
    if t == .note { if lit != .note { under = lit; lit = .note } }
    else { lit = t; under = t }
  }
  /** Close the note: back on the page under it. Nothing when it is not open. */
  public mutating func closeNote() { if lit == .note { lit = under } }
  /**
   * A tap on an item of the bar. Note toggles the note; a page closes the note and goes there. True when he tapped
   * the page he is already on with no note over it: the caller then goes back to that page's root.
   */
  public mutating func tap(_ t: ShellTab) -> Bool {
    if t == .note { if lit == .note { closeNote() } else { select(.note) }; return false }
    if lit == t { return true }
    select(t)
    return false
  }
}
