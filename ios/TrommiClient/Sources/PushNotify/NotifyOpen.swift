// NotifyOpen: the Notification Service Extension's work without UIKit, so it is tested on Linux. A notification
// carries a fixed text and `e`, a sealed blob (spec/v2.md 15.2). From `e` to a card's title:
//   1. `e` is opened with the push key (NotifyCore.openPush): the room and a ticket;
//   2. with the ticket that one envelope is fetched from the room's hub (GET /v2/push-envelope, no access token);
//   3. the envelope is verified and opened (NotifyCore.openEnvelope) with the content key of its group and epoch;
//   4. the sender must be an agent device of that group, the kind a card's version or a permission request.
// Every step that does not hold gives nil, and the notification keeps the hub's fixed text. No error is shown and
// nothing of an envelope that failed a check is used.
import Foundation

/** What a notification shows of a card. */
public struct NotifyCard: Equatable {
  public var title: String
  public var cardId: String       // hex object id: /card/<id>
  public var sessionId: String    // hex
  public var senderId: String     // hex agent device
  public var permission: Bool
  public var urgent: Bool
}

public enum NotifyOpen {
  public static let maxTitle = 200
  /** The longest sealed blob (core `push::MAX_APNS_LEN`) and the longest answer of the hub read: one envelope is at most 64 KiB padded. */
  static let maxSealed = 512
  public static let maxAnswer = 200_000
  static let kindVersion: UInt8 = 2, kindRequest: UInt8 = 4, typeCard: UInt8 = 1

  /** Steps 1 to 4. `fetch` gets the hub's address for the envelope and returns the answer's body, nil on any failure. */
  public static func card(e: String, context: NotifyContext, core: NotifyCore, fetch: (URL) async -> Data?) async -> (card: NotifyCard, room: NotifyRoom)? {
    guard let (push, room) = push(e, context: context, core: core), let url = envelopeURL(room: room, ticket: push.ticket),
          let answer = await fetch(url), let bytes = envelope(fromAnswer: answer, change: push.change),
          let card = card(bytes, room: room, core: core) else { return nil }
    return (card, room)
  }

  /** `e` opened with the context's push key, and the room it names; nil when it does not open or the room is not in the context. */
  static func push(_ e: String, context: NotifyContext, core: NotifyCore) -> (ApnsPush, NotifyRoom)? {
    guard let sealed = NotifyText.unb64u(e), sealed.count <= maxSealed, let key = NotifyText.unb64u(context.pushKey), key.count == 32,
          let push = try? core.openPush(key: key, sealed: sealed), let room = context.room(push.roomId) else { return nil }
    return (push, room)
  }

  /** Where the envelope is fetched; nil without a ticket, and for a hub that is not reached over TLS. */
  static func envelopeURL(room: NotifyRoom, ticket: [UInt8]) -> URL? {
    guard !ticket.isEmpty, var c = URLComponents(string: room.hub), c.scheme == "https" || c.host == "127.0.0.1" || c.host == "localhost" else { return nil }
    c.path = (c.path.hasSuffix("/") ? String(c.path.dropLast()) : c.path) + "/v2/push-envelope"
    c.queryItems = [URLQueryItem(name: "ticket", value: NotifyText.b64u(ticket))]
    return c.url
  }

  /** The hub's answer `{ change, received_at, envelope }`: the envelope's bytes, if it is the one the push named and was not voided. */
  static func envelope(fromAnswer data: Data, change: UInt64) -> [UInt8]? {
    guard data.count <= maxAnswer, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          (o["change"] as? NSNumber)?.uint64Value == change, o["void_code"] == nil, let text = o["envelope"] as? String else { return nil }
    return NotifyText.unb64u(text)
  }

  /** Verify and open a card's envelope with the room's keys; nil when anything does not hold. */
  static func card(_ bytes: [UInt8], room: NotifyRoom, core: NotifyCore) -> NotifyCard? {
    let opened = try? core.openEnvelope(bytes) { group, epoch in room.key(group: group, epoch: epoch).flatMap { NotifyText.unb64u($0.key) } }
    // The key is looked up again from what the verified header says: the session and its agents belong to that key.
    guard let env = opened, let key = room.key(group: env.group, epoch: env.epoch), key.agents.contains(NotifyText.hex(env.sender)),
          let objectId = env.objectId, objectId.count == 16,
          let o = (try? JSONSerialization.jsonObject(with: Data(env.payload))) as? [String: Any] else { return nil }
    var title: String
    let permission = env.kind == kindRequest
    if permission {
      let description = (o["description"] as? String) ?? "", tool = clean((o["tool_name"] as? String) ?? "")
      title = !clean(description).isEmpty ? description : tool.isEmpty ? "" : "Darf ich \(tool) benutzen?"
    } else {
      guard env.kind == kindVersion, env.objectType == typeCard else { return nil }
      title = (o["title"] as? String) ?? ""
    }
    title = clean(title)
    if title.isEmpty { return nil }
    return NotifyCard(title: title, cardId: NotifyText.hex(objectId), sessionId: key.session, senderId: NotifyText.hex(env.sender),
                      permission: permission, urgent: (env.urgency ?? 0) >= 2)
  }

  /** One line, no control characters, at most maxTitle characters. */
  static func clean(_ s: String) -> String {
    let flat = String(String.UnicodeScalarView(s.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : $0 }))
    let t = flat.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    return t.count > maxTitle ? String(t.prefix(maxTitle - 1)) + "…" : t
  }
}
