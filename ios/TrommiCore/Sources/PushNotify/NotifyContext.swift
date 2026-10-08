// NotifyContext: what the Notification Service Extension (TrommiNotify) may know to show a card's title in a push, and
// nothing more. The app writes it into the App Group, sealed (NotifyGroup.swift); the extension reads it.
//
// Least privilege: the extension never gets the device key (it cannot sign, cannot sign in to the hub, cannot send),
// never the room key, never a session's epoch secret and never the record store's key (it cannot read the board or
// any history). It gets, per room:
//   - the push key (it opens `e`, the hub's message sealed for this phone),
//   - each agent's signing key from the verified member list (it checks who signed the envelope),
//   - the per-sender keys of the agents in each session for the newest two key epochs: deriveSenderKey(room, session
//     secret, agent, session) (FORMAT.md). Such a key opens only what that one agent sends in that one session under
//     that epoch: never a human's message, never another agent's, nothing that a later epoch brings,
//   - per session the name, the board id and the drawing (a small PNG) for the notification's sender.
import Foundation
import TrommiCore

public struct NotifyContext: Codable, Equatable {
  public var version = 1
  /** The push key (base64url, 32 bytes): `e` of a push is sealed under it (hub/apns.mjs seal). */
  public var pushKey: String
  public var rooms: [NotifyRoom]
  public init(pushKey: String, rooms: [NotifyRoom]) { self.pushKey = pushKey; self.rooms = rooms }
  public func room(_ id: String) -> NotifyRoom? { rooms.first { $0.roomId == id } }
}

public struct NotifyRoom: Codable, Equatable {
  public var roomId: String                    // hex
  public var hub: String                       // the hub's URL
  public var me: String                        // this device's id (hex): the ticket is for it
  public var senders: [String: String]         // agent device id (hex) -> signing public key (base64url)
  public var keys: [NotifyKey]
  public var sessions: [String: NotifySession] // session id (hex) -> session
  public init(roomId: String, hub: String, me: String, senders: [String: String], keys: [NotifyKey], sessions: [String: NotifySession]) {
    self.roomId = roomId; self.hub = hub; self.me = me; self.senders = senders; self.keys = keys; self.sessions = sessions
  }
  public func key(sender: String, session: String, epoch: Int) -> Bytes? {
    keys.first { $0.sender == sender && $0.session == session && $0.epoch == epoch }.flatMap { try? unb64u($0.key) }
  }
}

/** One agent's sender key in one session and key epoch (deriveSenderKey). */
public struct NotifyKey: Codable, Equatable {
  public var sender: String   // hex device id
  public var session: String  // hex session id
  public var epoch: Int
  public var key: String      // base64url, 32 bytes
  public init(sender: String, session: String, epoch: Int, key: String) { self.sender = sender; self.session = session; self.epoch = epoch; self.key = key }
}

/** How a session shows as the sender of a notification. */
public struct NotifySession: Codable, Equatable {
  public var agent: String         // the board id (/s/<agent>)
  public var agentDevice: String?  // hex
  public var name: String
  public var mark: String?         // the drawing, a PNG (base64)
  public init(agent: String, agentDevice: String?, name: String, mark: String?) { self.agent = agent; self.agentDevice = agentDevice; self.name = name; self.mark = mark }
}

/** One session as the app knows it, for building a room of the context. */
public struct NotifySessionInput {
  public var sessionId: Bytes
  public var agentIds: [Bytes]
  public var secrets: [EpochSecret]
  public var show: NotifySession?
  public init(sessionId: Bytes, agentIds: [Bytes], secrets: [EpochSecret], show: NotifySession?) { self.sessionId = sessionId; self.agentIds = agentIds; self.secrets = secrets; self.show = show }
}

extension NotifyRoom {
  /** How many key epochs per session the context keeps (the newest ones: a rotation in flight still opens). */
  public static let epochsKept = 2

  /**
   * A room of the context from what the app verified: the agents (device id, signing key) of the member list and each
   * session with its agents and epoch secrets. Only per-sender keys leave: derived here, the secrets stay in the app.
   */
  public static func build(roomId: Bytes, hub: String, me: Bytes, agents: [(id: Bytes, signPub: Bytes)], sessions: [NotifySessionInput]) -> NotifyRoom {
    var senders = [String: String]()
    for a in agents { senders[hex(a.id)] = b64u(a.signPub) }
    var keys = [NotifyKey](), shows = [String: NotifySession]()
    for s in sessions {
      let sid = hex(s.sessionId)
      if let show = s.show { shows[sid] = show }
      for secret in s.secrets.sorted(by: { $0.epoch > $1.epoch }).prefix(epochsKept) {
        for a in s.agentIds where senders[hex(a)] != nil {
          guard let k = try? deriveSenderKey(roomId: roomId, secret: secret, senderId: a, keyScope: KEY_SCOPE.SESSION, sessionId: s.sessionId) else { continue }
          keys.append(NotifyKey(sender: hex(a), session: sid, epoch: secret.epoch, key: b64u(k)))
        }
      }
    }
    keys.sort { ($0.session, $0.sender, $0.epoch) < ($1.session, $1.sender, $1.epoch) }
    return NotifyRoom(roomId: hex(roomId), hub: hub, me: hex(me), senders: senders, keys: keys, sessions: shows)
  }
}

// ---- sealing ------------------------------------------------------------------------------------

public enum NotifySeal {
  static let aad = "trommi/v1/ios-notify-context"
  /** nonce (12) || AES-256-GCM(JSON) under the context key. */
  public static func seal(_ c: NotifyContext, key: Bytes) throws -> Bytes {
    let nonce = systemRandom(12)
    return nonce + (try gcmSeal(key: key, nonce: nonce, aad: utf8(aad), Array(try JSONEncoder().encode(c))))
  }
  public static func open(_ b: Bytes, key: Bytes) -> NotifyContext? {
    guard b.count > 28, let plain = try? gcmOpen(key: key, nonce: Array(b[0..<12]), aad: utf8(aad), Array(b[12...])) else { return nil }
    return try? JSONDecoder().decode(NotifyContext.self, from: Data(plain))
  }
}

/** What the Live Activity's widget shows besides the two counts: the crowned session's drawing (a PNG). */
public struct LiveLook: Codable, Equatable {
  public var mark: String?   // PNG, base64
  public var name: String?
  public init(mark: String?, name: String?) { self.mark = mark; self.name = name }
  static let aad = "trommi/v1/ios-live-look"
  public func seal(key: Bytes) throws -> Bytes {
    let nonce = systemRandom(12)
    return nonce + (try gcmSeal(key: key, nonce: nonce, aad: utf8(Self.aad), Array(try JSONEncoder().encode(self))))
  }
  public static func open(_ b: Bytes, key: Bytes) -> LiveLook? {
    guard b.count > 28, let plain = try? gcmOpen(key: key, nonce: Array(b[0..<12]), aad: utf8(aad), Array(b[12...])) else { return nil }
    return try? JSONDecoder().decode(LiveLook.self, from: Data(plain))
  }
}
