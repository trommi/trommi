// Push.swift: notifications through APNs (README "Push", APNs). The app asks once, registers with Apple, and hands its
// device token to the hub of every room on this phone, with a key of its own: the hub seals the Web Push message
// ({ room_id, envelope_number, urgency, t } or the agent-lost word) under it as `e`, Apple sees only a fixed text. The
// Notification Service Extension (Sources/TrommiNotify) puts the card's title and its session in place of that text,
// decrypted on the phone, and the card's path (`trommi-path`). A push that arrives while the app is open refreshes the
// board; a tap opens the card (Links.swift).
#if canImport(UIKit)
import CryptoKit
import Foundation
import TrommiClient
import TrommiCore
import UIKit
import UserNotifications
import os

private let log = Logger(subsystem: "com.trommi.ios", category: "push")

final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  /** The board to refresh (set by the App struct). */
  @MainActor weak var model: BoardModel?
  private var token: String?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    #if canImport(ActivityKit)
    Task { @MainActor in LiveActivities.watch() }
    #endif
    // A room signed in later gets the token the next time the app comes to the front.
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.ask() }
    return true
  }

  /** Ask for permission (iOS asks the person once), then register with Apple; the token arrives below. */
  func ask() {
    guard !Store.rooms(base: Store.defaultBase()).isEmpty else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else { return }
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let t = deviceToken.map { String(format: "%02x", $0) }.joined()
    token = t
    log.notice("trommi push: APNs token received")
    Task.detached { await Push.register(token: t) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    log.error("trommi push: no APNs token: \(error.localizedDescription, privacy: .public)")
  }

  // In the foreground: show it as a banner too, and refresh at once.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    await refresh(notification.request.content.userInfo)
    return [.banner, .list, .sound]
  }

  // A tap on it: the card (the path the extension found), and the board read again.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let info = response.notification.request.content.userInfo
    if let p = info["trommi-path"] as? String, p.hasPrefix("/") { await MainActor.run { model?.open(path: p) } }
    await refresh(info)
  }

  @MainActor private func refresh(_ info: [AnyHashable: Any]) async {
    if let e = info["e"] as? String, let m = Push.open(e) { log.notice("trommi push: \(m["kind"] as? String ?? "card", privacy: .public) in room \(String((m["room_id"] as? String ?? "").prefix(8)), privacy: .public)") }
    await model?.refresh()
  }
}

enum Push {
  /** The 32-byte key the hub seals `e` with; made once, kept next to the rooms (mode 0600). */
  static func key() -> SymmetricKey {
    let file = Store.defaultBase().appendingPathComponent("push.key")
    if let d = try? Data(contentsOf: file), d.count == 32 { return SymmetricKey(data: d) }
    let k = SymmetricKey(size: .bits256)
    let d = k.withUnsafeBytes { Data($0) }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? d.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    return k
  }

  /** The push key as the hub and the extension take it (base64url). */
  static func keyText() -> String {
    key().withUnsafeBytes { Data($0) }.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /** `e` of a push: nonce || ciphertext || tag (base64url), AAD "trommi-apns-v1" (hub/apns.mjs seal). */
  static func open(_ e: String) -> [String: Any]? {
    var s = e.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s += "=" }
    guard let data = Data(base64Encoded: s), let box = try? AES.GCM.SealedBox(combined: data),
          let plain = try? AES.GCM.open(box, using: key(), authenticating: Data("trommi-apns-v1".utf8)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
  }

  /** A development build (xtool, the profile says aps-environment development) talks to Apple's sandbox. */
  static var environment: String {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .isoLatin1) else { return "production" }
    return text.range(of: #"<key>aps-environment</key>\s*<string>development</string>"#, options: .regularExpression) != nil ? "sandbox" : "production"
  }

  /** The push level of this phone (Settings · Devices): all, knocking, or off. */
  static var level: String {
    get { UserDefaults.standard.string(forKey: "trommi-push-level") ?? "knocking" }
    set { UserDefaults.standard.set(newValue, forKey: "trommi-push-level") }
  }
  /** A new level: told to the hub of every room at once (off removes the registration). */
  @MainActor static func setLevel(_ l: String) async {
    level = l
    for k in UserDefaults.standard.dictionaryRepresentation().keys where k.hasPrefix("push.") { UserDefaults.standard.removeObject(forKey: k) }
    if let t = UserDefaults.standard.string(forKey: "trommi-push-token") { await register(token: t) }
    #if canImport(ActivityKit)
    LiveActivities.levelChanged()
    #endif
  }
  /** Hand the token to the hub of every room on this phone, once per room, token and level. */
  @MainActor static func register(token: String) async {
    UserDefaults.standard.set(token, forKey: "trommi-push-token")
    let level = Push.level
    let keyText = Push.keyText()
    let env = environment, topic = Bundle.main.bundleIdentifier ?? "com.trommi.ios"
    let base = Store.defaultBase()
    for id in Store.rooms(base: base) {
      let mark = "push.\(id).\(env).\(token).\(level)"
      if UserDefaults.standard.bool(forKey: mark) { continue }
      do {
        let room = try Room.open(base: base, roomId: id)
        try await room.hub.registerApns(token: token, environment: env, topic: topic, key: keyText, level: level == "off" ? nil : level, remove: level == "off")
        UserDefaults.standard.set(true, forKey: mark)
      } catch { log.error("trommi push: registration for room \(String(id.prefix(8)), privacy: .public) failed: \(String(describing: error), privacy: .public)") }
    }
  }
}
#endif
