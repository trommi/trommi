// LiveActivities: "n agents working · m questions waiting" in the Dynamic Island and on the lock screen (spec/v2.md
// 15.3; the widget is Sources/TrommiLive). The hub starts, updates and ends it by push; the app only hands it the
// tokens (POST /v2/live-activity): the push-to-start token once per room (with a random tag of this phone for that
// room, which the activity's attributes carry back), and each running activity's own token to the hub whose tag it
// carries. iOS wakes the app in the background to deliver an activity's token when the hub started it. The tokens go
// through the room the app has open (Push.model), as in Push.swift.
//
// Off when Push is off (Settings · Devices) and while Live Activities are off in the system's settings. The v2 hub
// has no route that takes a token back, so with Push off no token is handed over any more, and an activity the hub
// still starts with a token it got earlier is ended here at once.
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
    // Push is off, but the hub still holds an earlier token and started this one: it ends at once
    if Push.level == "off" { Task { await a.end(nil, dismissalPolicy: .immediate) }; return }
    guard seen.insert(a.id).inserted else { return }
    Task { @MainActor in
      for await data in a.pushTokenUpdates {
        await register(token: hex(data), kind: "activity", tag: a.attributes.tag)
      }
    }
  }

  /** start: to the room's hub with this phone's tag for it; activity: only if the activity carries that tag. */
  private static func register(token: String, kind: String, tag: String?) async {
    if !tokens.contains(where: { $0.kind == kind && $0.token == token }) { tokens.append((kind, token, tag)) }
    guard Push.level != "off", let room = Push.model?.room, Push.model?.demo != true else { return }
    let id = room.roomIdHex
    let mine = Self.tag(room: id)
    if kind == "activity" && tag != mine { return }
    let mark = "live.\(id).\(kind).\(token)"
    if UserDefaults.standard.bool(forKey: mark) { return }
    do {
      let body: [String: Any] = ["kind": kind, "token": token, "tag": mine, "environment": Push.environment, "topic": Bundle.main.bundleIdentifier ?? "com.trommi.ios"]
      _ = try await room.hub.request("POST", "/live-activity", body: body)
      UserDefaults.standard.set(true, forKey: mark)
    } catch { log.error("trommi live: \(kind, privacy: .public) token for room \(String(id.prefix(8)), privacy: .public) not registered: \(String(describing: error), privacy: .public)") }
  }

  /** Push turned off or on: on hands the tokens over again; off ends what runs (the hub is not told, see above). */
  static func levelChanged() {
    for k in UserDefaults.standard.dictionaryRepresentation().keys where k.hasPrefix("live.") { UserDefaults.standard.removeObject(forKey: k) }
    if Push.level == "off" { endAll(); return }
    again()
    watch()
  }

  /**
   * The tokens of this run once more (each is sent once only): a token that arrived before the room was open, at
   * launch, is handed over when Push registers its own (Push.register).
   */
  static func again() {
    let list = tokens
    Task { @MainActor in for t in list { await register(token: t.token, kind: t.kind, tag: t.tag) } }
  }

  /** Signed out: every activity ends at once. */
  static func endAll() {
    Task { for a in Activity<TrommiActivityAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) } }
  }

  private static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
}
#endif
