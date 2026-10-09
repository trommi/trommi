// Push.swift: notifications through APNs (spec/v2.md section 15). The app asks once, registers with Apple, and hands
// its device token to the room's hub (POST /v2/push) together with the push key: 32 random bytes the core made,
// under which the hub seals what a notification says ({ room_id, change, urgency, ticket }, the payload's `e`).
// Apple sees only a fixed text. The Notification Service Extension (Sources/TrommiNotify) puts the card's title and
// its session in place of that text, opened on the phone, and the card's path (`trommi-path`). A push that arrives
// while the app is open refreshes the board; a tap opens the card (Links.swift).
//
// The token goes to the hub through the room the app has open (the model's), never through a second `Room`: the
// device's state has one owner.
#if canImport(UIKit)
import Foundation
import Security
import TrommiClient
import UIKit
import UserNotifications
import os

private let log = Logger(subsystem: "com.trommi.ios", category: "push")

final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  /** The board to refresh (set by the App struct). */
  @MainActor weak var model: BoardModel? { didSet { Push.model = model } }

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
    Task { @MainActor in
      guard self.model?.room != nil else { return }
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        guard granted else { return }
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
      }
    }
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let t = deviceToken.map { String(format: "%02x", $0) }.joined()
    log.notice("trommi push: APNs token received")
    Task { await Push.register(token: t) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    log.error("trommi push: no APNs token: \(error.localizedDescription, privacy: .public)")
  }

  // In the foreground: show it as a banner too, and refresh at once.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    await model?.refresh()
    return [.banner, .list, .sound]
  }

  // A tap on it: the card (the path the extension found), and the board read again.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let info = response.notification.request.content.userInfo
    if let p = info["trommi-path"] as? String, p.hasPrefix("/") { await MainActor.run { model?.open(path: p) } }
    await model?.refresh()
  }
}

enum Push {
  /** The model whose open room the tokens are registered through (set with PushDelegate.model). */
  @MainActor static weak var model: BoardModel?

  // ---- the push key ----

  private static var keyItem: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.trommi.push-key", kSecAttrAccount as String: "apns"]
  }

  /**
   * The 32 bytes the hub seals a notification's `e` with: made once by the core, kept in the app's own Keychain
   * group (after first unlock, this device only). The extension gets its copy inside the context (NotifyBridge).
   * nil when the Keychain or the core refuses; nothing is registered then.
   */
  static func key() -> Bytes? {
    var q = keyItem
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 { return Array(d) }
    guard let k = try? Core.tools.generatePushKey(), k.count == 32 else { return nil }
    SecItemDelete(keyItem as CFDictionary)
    var add = keyItem
    add[kSecValueData as String] = Data(k)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
    return k
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
  /** A new level: told to the hub at once (off removes the registration). */
  @MainActor static func setLevel(_ l: String) async {
    level = l
    for k in UserDefaults.standard.dictionaryRepresentation().keys where k.hasPrefix("push.") { UserDefaults.standard.removeObject(forKey: k) }
    if let t = UserDefaults.standard.string(forKey: "trommi-push-token") { await register(token: t) }
    #if canImport(ActivityKit)
    LiveActivities.levelChanged()
    #endif
  }

  /**
   * Hand the token to the hub of the open room, once per room, token and level: POST /v2/push
   * `{ apns: { token, environment, topic, key }, level }`, or DELETE /v2/push `{ endpoint: token }` for level off.
   */
  @MainActor static func register(token: String) async {
    UserDefaults.standard.set(token, forKey: "trommi-push-token")
    guard let room = model?.room, model?.demo != true else { return }
    #if canImport(ActivityKit)
    LiveActivities.again()
    #endif
    let level = Push.level, env = environment, topic = Bundle.main.bundleIdentifier ?? "com.trommi.ios"
    let id = room.roomIdHex
    let mark = "push.\(id).\(env).\(token).\(level)"
    if UserDefaults.standard.bool(forKey: mark) { return }
    do {
      if level == "off" {
        _ = try await room.hub.request("DELETE", "/push", body: ["endpoint": token])
      } else {
        guard let key = key() else { log.error("trommi push: no push key"); return }
        let apns: [String: Any] = ["token": token, "environment": env, "topic": topic, "key": b64u(key)]
        _ = try await room.hub.request("POST", "/push", body: ["apns": apns, "level": level])
      }
      UserDefaults.standard.set(true, forKey: mark)
    // (only the hub's code: its message is the hub's text about a request that carried the push key)
    } catch { log.error("trommi push: registration for room \(String(id.prefix(8)), privacy: .public) failed: \((error as? HubError)?.code ?? "no answer", privacy: .public)") }
  }
}
#endif
