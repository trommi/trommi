// LiveActivities: "n agents working · m questions waiting" in the Dynamic Island and on the lock screen (README "Live
// Activity"; the widget is Sources/TrommiLive). The hub starts, updates and ends it by push; the app only hands it the
// tokens: the push-to-start token once per room (with a random tag of this phone for that room, which the activity's
// attributes carry back), and each running activity's own token to the hub whose tag it carries. iOS wakes the app in the
// background to deliver an activity's token when the hub started it. Off when Push is off (Settings · Devices: the
// tokens go from the hub, a running activity ends) and while Live Activities are off in the system's settings.
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation
import PushNotify
import TrommiClient
import os

private let log = Logger(subsystem: "com.trommi.ios", category: "live")

@MainActor
enum LiveActivities {
  private static var watching = false
  private static var observing = false
  private static var seen = Set<String>()
  /** The tokens this run got (kind, token, tag), to hand over again when Push is turned off or on. */
  private static var tokens: [(kind: String, token: String, tag: String?)] = []

  /** The tag of a room on this phone (8 random bytes, hex), made once. */
  static func tag(room: String) -> String {
    let k = "trommi-live-tag.\(room)"
    if let t = UserDefaults.standard.string(forKey: k) { return t }
    let t = (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    UserDefaults.standard.set(t, forKey: k)
    return t
  }

  /** Start listening for tokens (at launch, also a launch in the background). */
  static func watch() {
    // turned on later in the system's settings: the tokens then
    if !observing {
      observing = true
      Task { @MainActor in for await on in ActivityAuthorizationInfo().activityEnablementUpdates where on { watch() } }
    }
    guard !watching, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    watching = true
    Task { @MainActor in
      for await data in Activity<TrommiActivityAttributes>.pushToStartTokenUpdates {
        await register(token: hex(data), kind: "start", tag: nil)
      }
    }
    Task { @MainActor in
      for a in Activity<TrommiActivityAttributes>.activities { follow(a) }
      for await a in Activity<TrommiActivityAttributes>.activityUpdates { follow(a) }
    }
  }

  private static func follow(_ a: Activity<TrommiActivityAttributes>) {
    guard seen.insert(a.id).inserted else { return }
    Task { @MainActor in
      for await data in a.pushTokenUpdates {
        await register(token: hex(data), kind: "activity", tag: a.attributes.tag)
      }
    }
  }

  /** start: to the hub of every room (each with its tag); activity: to the room whose tag the activity carries. */
  private static func register(token: String, kind: String, tag: String?) async {
    if !tokens.contains(where: { $0.kind == kind && $0.token == token }) { tokens.append((kind, token, tag)) }
    let base = Store.defaultBase()
    let remove = Push.level == "off"
    let topic = Bundle.main.bundleIdentifier ?? "com.trommi.ios"
    for id in Store.rooms(base: base) {
      let mine = Self.tag(room: id)
      if kind == "activity" && tag != mine { continue }
      let mark = "live.\(id).\(kind).\(token).\(remove)"
      if UserDefaults.standard.bool(forKey: mark) { continue }
      do {
        let room = try Room.open(base: base, roomId: id)
        try await room.hub.registerLiveActivity(token: token, environment: Push.environment, topic: topic, kind: kind, tag: kind == "start" ? mine : nil, remove: remove)
        UserDefaults.standard.set(true, forKey: mark)
      } catch { log.error("trommi live: \(kind, privacy: .public) token for room \(String(id.prefix(8)), privacy: .public) not registered: \(String(describing: error), privacy: .public)") }
    }
  }

  /** Push turned off or on: the tokens again (off removes them at the hub). */
  static func levelChanged() {
    for k in UserDefaults.standard.dictionaryRepresentation().keys where k.hasPrefix("live.") { UserDefaults.standard.removeObject(forKey: k) }
    let again = tokens
    Task { @MainActor in for t in again { await register(token: t.token, kind: t.kind, tag: t.tag) } }
    // off: the hub forgets the tokens and can no longer end what runs, so it ends here
    if Push.level == "off" { endAll() }
    watch()
  }

  /** Signed out: every activity ends at once. */
  static func endAll() {
    Task { for a in Activity<TrommiActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) } }
  }

  private static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
}
#endif
