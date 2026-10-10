// TrommiNotify: the Notification Service Extension. Apple delivers a push with a fixed text ("A new question.") and
// `e`, a blob the hub sealed under this phone's push key (spec/v1.md 15.2). Here, on the phone and nowhere else:
//   1. the context is read from its Keychain item (PushNotify: NotifyGroup; the app writes it): the push key and
//      the room's id;
//   2. `e` is opened by trommi-core (NotifyCore.openPush): the room, the change number, the urgency;
//   3. the notification goes out with the fixed text, threaded by its room.
// No title of a card is shown: a content key never leaves the core, so the extension has none and opens no
// envelope (PushNotify's NotifyContext.swift and NotifyCore.swift). A push that does not open leaves the fixed text
// exactly as it came. No error is ever shown.
//
// The extension does no cryptography in Swift and never opens the device's store: it holds no device key, no
// content key and no MLS state, and cannot sign, send or sign in.
import Foundation
import PushNotify
import NotifyCoreLive
#if canImport(UserNotifications) && os(iOS)
import UserNotifications

/** The extension's principal class (Info.plist NSExtensionPrincipalClass, an Objective-C name without the module). */
@objc(TrommiNotificationService)
public final class TrommiNotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?
  private var task: Task<Void, Never>?
  /** didReceive's task and serviceExtensionTimeWillExpire come on different threads: one of them delivers. */
  private let lock = NSLock()

  public override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    let original = request.content
    // What goes out when nothing was verified is made HERE: one of the three fixed texts, no path to open. Whatever
    // else the push carried (the sender of a push is the hub, which is not believed) is not shown.
    let plain = NotifyWork.fixed(original)
    lock.lock(); handler = contentHandler; fallback = plain; lock.unlock()
    task = Task { [weak self] in
      let shown = await NotifyWork.content(for: original, fallback: plain)
      // cancelled: the time ran out and the fixed text went out already
      self?.deliver(Task.isCancelled ? plain : shown)
    }
  }

  public override func serviceExtensionTimeWillExpire() {
    task?.cancel()
    deliver(fallback ?? UNNotificationContent())
  }

  private func deliver(_ c: UNNotificationContent) {
    lock.lock()
    let h = handler
    handler = nil
    lock.unlock()
    h?(c)
  }
}

enum NotifyWork {
  /** The three texts a push may show without anything verified (spec/v1.md 15.2); any other becomes the first. */
  static let fixedTexts = ["A new question.", "Urgent: a new question.", "An agent lost its connection."]
  static func fixed(_ original: UNNotificationContent) -> UNNotificationContent {
    let c = UNMutableNotificationContent()
    c.title = "Trommi"
    c.body = fixedTexts.contains(original.body) ? original.body : fixedTexts[0]
    c.sound = original.sound
    return c
  }

  /** The notification to show: the fixed text, threaded by its room when the push opened under this phone's key. */
  static func content(for original: UNNotificationContent, fallback: UNNotificationContent) async -> UNNotificationContent {
    guard let e = original.userInfo["e"] as? String, let context = NotifyGroup.readContext(),
          let push = NotifyOpen.push(e, context: context, core: NotifyCoreLive()),
          let c = fallback.mutableCopy() as? UNMutableNotificationContent else { return fallback }
    c.threadIdentifier = NotifyOpen.thread(push)
    return c
  }
}
#endif
