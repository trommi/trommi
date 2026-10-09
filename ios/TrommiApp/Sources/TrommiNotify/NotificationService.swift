// TrommiNotify: the Notification Service Extension. Apple delivers a push with a fixed text ("A new question.") and
// `e`, a blob the hub sealed under this phone's push key (spec/v2.md 15.2). Here, on the phone and nowhere else:
//   1. the context is read from its Keychain item (PushNotify: NotifyGroup; the app writes it): the push key, the
//      room's hub, the content keys of the session groups' newest two epochs, the sessions' names and drawings;
//   2. `e` is opened: the room and a ticket;
//   3. that one envelope is fetched from the hub with the ticket (GET /v2/push-envelope: no access token, an
//      ephemeral session without cookies or cache, 8 s);
//   4. it is verified and opened by trommi-core (NotifyCore), and must be a card's version or a permission request
//      sent by an agent device of its session (NotifyOpen);
//   5. its title is shown as a message from the session (a communication notification: INSendMessageIntent with the
//      session as sender, its name and drawing; the interaction donated), with the card's path for the tap.
// Anything that does not hold leaves the hub's fixed text exactly as it came: no key for the epoch yet (the app has
// not processed the Commit), a signature that does not hold, no network, no time left. No error is ever shown.
//
// The extension does no cryptography in Swift and never opens the device's store: it holds no device key and no MLS
// state, and cannot sign, send or sign in. What its keys do allow is said in PushNotify's NotifyContext.swift.
// Memory (the limit is 24 MB): the core's library, the context (the keys and one small PNG per session) and one
// envelope (at most 64 KiB padded; the answer is refused above 200 kB).
import Foundation
import PushNotify
import NotifyCoreLive
#if canImport(UserNotifications) && os(iOS)
import UserNotifications
import Intents

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
    lock.lock(); handler = contentHandler; fallback = original; lock.unlock()
    task = Task { [weak self] in
      let shown = await NotifyWork.content(for: original)
      // cancelled: the time ran out and the fixed text went out already
      self?.deliver(Task.isCancelled ? original : shown)
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
  /** The notification to show: the card's title from its session, or `original` untouched. */
  static func content(for original: UNNotificationContent) async -> UNNotificationContent {
    guard let e = original.userInfo["e"] as? String, let context = NotifyGroup.readContext(),
          let found = await NotifyOpen.card(e: e, context: context, core: NotifyCoreLive(), fetch: fetch) else { return original }
    return await show(found.card, room: found.room, original: original)
  }

  /** The hub's answer for the ticket, nil on any failure. The ticket is in the URL: the URL is never logged. */
  static func fetch(_ url: URL) async -> Data? {
    let conf = URLSessionConfiguration.ephemeral
    conf.timeoutIntervalForRequest = 8
    conf.timeoutIntervalForResource = 10
    conf.httpCookieStorage = nil
    conf.urlCache = nil
    var req = URLRequest(url: url)
    let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    req.setValue("ios/\(version)", forHTTPHeaderField: "Trommi-Client")
    let s = URLSession(configuration: conf)
    defer { s.finishTasksAndInvalidate() }
    guard let (data, res) = try? await s.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200, data.count <= NotifyOpen.maxAnswer else { return nil }
    return data
  }

  /** The card as a message from its session: the session's name and drawing as the sender, the title as the text. */
  static func show(_ card: NotifyCard, room: NotifyRoom, original: UNNotificationContent) async -> UNNotificationContent {
    guard let c = original.mutableCopy() as? UNMutableNotificationContent else { return original }
    let session = room.sessions[card.sessionId]
    let name = session?.name ?? "Trommi"
    c.title = name
    c.body = card.urgent ? "Urgent: \(card.title)" : card.title
    c.threadIdentifier = "\(room.roomId.prefix(16))-\(card.sessionId)"
    var info = c.userInfo
    info["trommi-path"] = "/card/\(card.cardId)"
    c.userInfo = info
    let image = session?.mark.flatMap { Data(base64Encoded: $0) }.map { INImage(imageData: $0) }
    let sender = INPerson(personHandle: INPersonHandle(value: "\(room.roomId.prefix(16))-\(card.sessionId)", type: .unknown), nameComponents: nil,
                          displayName: name, image: image, contactIdentifier: nil, customIdentifier: card.sessionId, isMe: false, suggestionType: .none)
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: c.body, speakableGroupName: nil,
                                     conversationIdentifier: c.threadIdentifier, serviceName: nil, sender: sender, attachments: nil)
    if let image = image { intent.setImage(image, forParameterNamed: \.sender) }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    try? await interaction.donate()
    return (try? c.updating(from: intent)) ?? c
  }
}
#endif
