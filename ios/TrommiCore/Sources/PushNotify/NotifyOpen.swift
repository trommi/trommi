// NotifyOpen: the Notification Service Extension's work without UIKit (tested on Linux): open `e` of a push with the push
// key, and open the one envelope the push names (fetched with its ticket) with the context's keys: the room, a sender
// of the verified member list, its signature, the push flag, a recent time, then decrypt with that agent's sender key
// and read the title. Anything that does not hold is nil, and the push keeps its fixed text ("Eine neue Frage.").
import Foundation
import TrommiCore

/** The hub's message in `e` (README "Push"): a card, or the word that a session lost its link. */
public struct PushMessage: Equatable {
  public var roomId: String
  public var envelopeNumber: Int?
  public var urgency: Int?
  public var ticket: String?
  public var kind: String?      // "agent-lost"
  public var state: String?     // cut | gone
  public var deviceId: String?
}

/** What a notification shows of a card. */
public struct NotifyCard: Equatable {
  public var title: String
  public var cardId: String       // hex object id: /card/<id>
  public var sessionId: String    // hex
  public var senderId: String     // hex agent device
  public var permission: Bool
}

public enum NotifyOpen {
  /** How old a card may be to show its title (the hub could hand over an older envelope with a fresh ticket). */
  public static let maxAgeMs: UInt64 = 48 * 3600 * 1000
  public static let maxTitle = 200

  /** `e`: nonce || ciphertext || tag, base64url, AAD "trommi-apns-v1" (hub/apns.mjs seal). */
  public static func message(_ e: String, pushKey: Bytes) -> PushMessage? {
    guard let b = try? unb64u(e), b.count > 28,
          let plain = try? gcmOpen(key: pushKey, nonce: Array(b[0..<12]), aad: utf8("trommi-apns-v1"), Array(b[12...])),
          let o = (try? JSONSerialization.jsonObject(with: Data(plain))) as? [String: Any],
          let room = o["room_id"] as? String, room.utf8.count == 64 else { return nil }
    return PushMessage(roomId: room, envelopeNumber: (o["envelope_number"] as? NSNumber)?.intValue, urgency: (o["urgency"] as? NSNumber)?.intValue,
                       ticket: o["t"] as? String, kind: o["kind"] as? String, state: o["state"] as? String, deviceId: o["device_id"] as? String)
  }

  /** Where the extension fetches the envelope: GET push_envelope with the ticket (no access token). */
  public static func envelopeURL(room: NotifyRoom, number: Int, ticket: String) -> URL? {
    guard var c = URLComponents(string: room.hub), c.scheme == "https" || c.host == "127.0.0.1" || c.host == "localhost" else { return nil }
    c.path = "/v1/rooms/\(room.roomId)/push_envelope"
    c.queryItems = [URLQueryItem(name: "envelope_number", value: String(number)), URLQueryItem(name: "device_id", value: room.me), URLQueryItem(name: "ticket", value: ticket)]
    return c.url
  }

  /** The hub's answer `{ envelope_number, envelope }`: the envelope's bytes, if it is the one asked for. */
  public static func envelope(fromAnswer data: Data, number: Int) -> Bytes? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (o["envelope_number"] as? NSNumber)?.intValue == number,
          o["void"] == nil, let e = o["envelope"] as? String else { return nil }
    return try? unb64u(e)
  }

  /** Verify and open a card's envelope with the context's keys; nil when anything does not hold. */
  public static func card(_ bytes: Bytes, room: NotifyRoom, now: UInt64 = nowMs()) -> NotifyCard? {
    guard let split = try? splitEnvelope(bytes), let ct = split.ciphertext, let h = try? decodeHeader(split.headerBytes) else { return nil }
    guard hex(h.roomId) == room.roomId, h.push, let card = h.card,
          h.kind == KIND.OBJECT_VERSION || h.kind == KIND.PERMISSION_REQUEST,
          h.keyScope == KEY_SCOPE.SESSION, let sid = h.sessionId,
          h.time + maxAgeMs >= now, h.time <= now + 10 * 60_000 else { return nil }
    let sender = hex(h.sender)
    guard let pubText = room.senders[sender], let pub = try? unb64u(pubText) else { return nil }
    let envHash = hash(LABEL.envelope, split.headerBytes, split.nonce, sha256(ct))
    guard verify(pub, LABEL.envelopeSig, envHash, split.signature) else { return nil }
    guard let key = room.key(sender: sender, session: hex(sid), epoch: h.epoch),
          let plain = try? gcmOpen(key: key, nonce: split.nonce, aad: split.headerBytes, ct),
          let body = try? decodeBody(plain),
          let o = (try? JSONSerialization.jsonObject(with: Data(body.payload))) as? [String: Any] else { return nil }
    let permission = h.kind == KIND.PERMISSION_REQUEST
    var title: String
    if permission {
      let d = (o["description"] as? String) ?? ""
      let tool = (o["tool_name"] as? String) ?? ""
      title = !clean(d).isEmpty ? d : tool.isEmpty ? "" : "Darf ich \(tool) benutzen?"
    } else {
      if let t = o["object_type"] as? String, t != "card" { return nil }
      title = (o["title"] as? String) ?? ""
    }
    title = clean(title)
    if title.isEmpty { return nil }
    return NotifyCard(title: title, cardId: hex(card.id), sessionId: hex(sid), senderId: sender, permission: permission)
  }

  /** One line, no control characters, at most maxTitle characters. */
  static func clean(_ s: String) -> String {
    let flat = String(String.UnicodeScalarView(s.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : $0 }))
    let t = flat.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    return t.count > maxTitle ? String(t.prefix(maxTitle - 1)) + "…" : t
  }

  /** The text of a push that names a session that lost its link, with the session's name when the context knows it. */
  public static func lostText(_ m: PushMessage, room: NotifyRoom?) -> String? {
    guard m.kind == "agent-lost", let dev = m.deviceId, let name = room?.sessions.values.filter({ $0.agentDevice == dev }).map(\.name).sorted().first else { return nil }
    return m.state == "cut" ? "\(name) ist abgeschnitten: hört dich nicht mehr." : "\(name) hat die Verbindung verloren."
  }
}
