// TrommiNotify: the Notification Service Extension. Apple delivers a push with a fixed text ("Eine neue Frage.") and `e`,
// the hub's message sealed under this phone's push key (README "Push"). Here, on the phone and nowhere else:
//   1. the sealed context from the App Group (PushNotify: NotifyGroup; the app writes it): the push key, the agents'
//      signing keys, their per-sender keys, the sessions' names and drawings;
//   2. `e` opened: room, envelope number, ticket;
//   3. that one envelope fetched from the hub with the ticket (GET push_envelope: no access token, no device key, an
//      ephemeral session without cookies or cache, 8 s);
//   4. verified and opened (NotifyOpen.card: the room, a sender of the member list, its signature, the push flag, at most
//      48 hours old; decrypted with that agent's key for that session and epoch), its title read;
//   5. shown as a message from the session (a communication notification: INSendMessageIntent with the session as
//      sender, its name and drawing; the interaction donated), with the card's path for the tap.
// Anything that does not hold leaves the fixed text. The extension holds no device key, no room key, no epoch secret, no
// board: it cannot sign, send, sign in, or read anything but what one agent sent in one session. Memory: one envelope
// (a card is at most 64 KiB padded) and the context (tens of KiB), far under the extension's 24 MB.
import Foundation
import PushNotify
import TrommiCore
#if canImport(UserNotifications) && os(iOS)
import UserNotifications
import Intents

/** The extension's principal class (Info.plist NSExtensionPrincipalClass, an Objective-C name without the module). */
@objc(TrommiNotificationService)
public final class TrommiNotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?
  private var task: Task<Void, Never>?

  public override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    fallback = request.content
    task = Task { [weak self] in
      let shown = await NotifyWork.content(for: request.content)
      self?.deliver(shown)
    }
  }

  public override func serviceExtensionTimeWillExpire() {
    task?.cancel()
    deliver(fallback ?? UNNotificationContent())
  }

  private func deliver(_ c: UNNotificationContent) {
    guard let h = handler else { return }
    handler = nil
    h(c)
  }
}

enum NotifyWork {
  static func content(for original: UNNotificationContent) async -> UNNotificationContent {
    guard let e = original.userInfo["e"] as? String, let ctx = NotifyGroup.readContext(), let pushKey = try? unb64u(ctx.pushKey),
          let m = NotifyOpen.message(e, pushKey: pushKey) else { return original }
    let room = ctx.room(m.roomId)
    if m.kind == "agent-lost" {
      guard let text = NotifyOpen.lostText(m, room: room), let c = original.mutableCopy() as? UNMutableNotificationContent else { return original }
      c.body = text
      return c
    }
    guard let room = room, let n = m.envelopeNumber, let t = m.ticket, let url = NotifyOpen.envelopeURL(room: room, number: n, ticket: t),
          let bytes = await fetch(url, number: n), let card = NotifyOpen.card(bytes, room: room) else { return original }
    return await show(card, urgent: (m.urgency ?? 0) >= 2, room: room, original: original)
  }

  static func fetch(_ url: URL, number: Int) async -> Bytes? {
    let conf = URLSessionConfiguration.ephemeral
    conf.timeoutIntervalForRequest = 8
    conf.timeoutIntervalForResource = 10
    conf.httpCookieStorage = nil
    conf.urlCache = nil
    let req = URLRequest(url: url)
    let s = URLSession(configuration: conf)
    defer { s.finishTasksAndInvalidate() }
    guard let (data, res) = try? await s.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200, data.count < 200_000 else { return nil }
    return NotifyOpen.envelope(fromAnswer: data, number: number)
  }

  /** The card as a message from its session: the session's name and drawing as the sender, the title as the text. */
  static func show(_ card: NotifyCard, urgent: Bool, room: NotifyRoom, original: UNNotificationContent) async -> UNNotificationContent {
    guard let c = original.mutableCopy() as? UNMutableNotificationContent else { return original }
    let session = room.sessions[card.sessionId]
    let name = session?.name ?? "Trommi"
    c.title = name
    c.body = urgent ? "Dringend: \(card.title)" : card.title
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
