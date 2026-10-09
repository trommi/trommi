// The Live Activity "n agents working · m questions waiting" (README "Live Activity"). The hub starts it with a
// push-to-start push (`attributes-type: TrommiActivityAttributes`, `attributes: { tag }`), updates and ends it; the type's
// name and its JSON keys are the wire format, so they are fixed here for the app and its widget alike.
import Foundation

/** The counts of a Live Activity: what the hub pushes as `content-state`, and nothing else. */
public struct LiveCounts: Codable, Hashable {
  public var working: Int
  public var waiting: Int
  public init(working: Int, waiting: Int) { self.working = working; self.waiting = waiting }
  /** "2 agents working · 3 questions waiting", the words of the lock screen. */
  public var line: String {
    let a = working == 1 ? "1 agent working" : "\(working) agents working"
    let q = waiting == 1 ? "1 question waiting" : "\(waiting) questions waiting"
    return "\(a) · \(q)"
  }
}

#if canImport(ActivityKit)
import ActivityKit

public struct TrommiActivityAttributes: ActivityAttributes {
  public typealias ContentState = LiveCounts
  /** A random word of this phone per room (LiveActivities in the app): which room's hub started it. */
  public var tag: String
  public init(tag: String) { self.tag = tag }
}
#endif
