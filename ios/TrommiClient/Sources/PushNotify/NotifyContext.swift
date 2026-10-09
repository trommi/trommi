// NotifyContext: what the Notification Service Extension (TrommiNotify) may know to show a card's title in a push,
// and nothing more. The app is the one owner of the device's state (its MLS groups, its device key, its store): the
// extension never opens that store. The app writes this context into the Keychain (NotifyGroup.swift); the
// extension reads it.
//
// The extension gets:
//   - the push key: 32 bytes this phone registered with the hub, which open the sealed part of a notification;
//   - per room the hub's URL and this device's id;
//   - per session group the content key of its newest two epochs, and the agent devices that may be the sender;
//   - per session the name, the board id and the drawing (a small PNG) shown as the notification's sender.
// It never gets the device key (it cannot sign, cannot sign in to the hub, cannot send), no MLS state, and never
// the room group's content key.
//
// What this does not limit: in protocol v2 a group has one content key per epoch, not one key per sender. A
// session's content key opens everything written in that session during that epoch: every agent's and every
// human's messages, not only the cards this extension shows. That is weaker least privilege than v1, where the
// extension held keys that opened one agent's envelopes only. It is the reason why only the newest two epochs of
// session groups are handed over (a card sealed just before a key change still opens; older history does not) and
// why the room group's key is never handed over.
import Foundation

public struct NotifyContext: Codable, Equatable {
  public var version = 2
  /** The push key (base64url, 32 bytes). */
  public var pushKey: String
  public var rooms: [NotifyRoom]
  public init(pushKey: [UInt8], rooms: [NotifyRoom]) { self.pushKey = NotifyText.b64u(pushKey); self.rooms = rooms }
  public func room(_ id: [UInt8]) -> NotifyRoom? { let h = NotifyText.hex(id); return rooms.first { $0.roomId == h } }
}

public struct NotifyRoom: Codable, Equatable {
  /** How many epochs per session group the context keeps: the newest ones. */
  public static let epochsKept = 2

  public var roomId: String                    // hex
  public var hub: String                       // the hub's URL
  public var me: String                        // this device's id (hex)
  public var keys: [NotifyKey]
  public var sessions: [String: NotifySession] // session id (hex) -> how it shows

  /** A room of the context. Of each group only the newest `epochsKept` epochs are kept, whatever is handed in. */
  public init(roomId: String, hub: String, me: String, keys: [NotifyKey], sessions: [String: NotifySession]) {
    self.roomId = roomId; self.hub = hub; self.me = me; self.sessions = sessions
    var kept = [NotifyKey]()
    for (_, ofGroup) in Dictionary(grouping: keys, by: \.group) {
      kept += ofGroup.sorted { $0.epoch > $1.epoch }.prefix(Self.epochsKept)
    }
    self.keys = kept.sorted { ($0.group, $0.epoch) < ($1.group, $1.epoch) }
  }

  func key(group: [UInt8], epoch: UInt64) -> NotifyKey? {
    let g = NotifyText.hex(group)
    return keys.first { $0.group == g && $0.epoch == epoch }
  }
}

/** The content key of one session group in one epoch, and who may be the sender of what the extension shows. */
public struct NotifyKey: Codable, Equatable {
  public var group: String     // hex group id
  public var session: String   // hex session id
  public var epoch: UInt64
  public var key: String       // base64url, 32 bytes
  public var agents: [String]  // hex device ids of the session's agent devices
  public init(group: [UInt8], session: [UInt8], epoch: UInt64, key: [UInt8], agents: [[UInt8]]) {
    self.group = NotifyText.hex(group); self.session = NotifyText.hex(session); self.epoch = epoch
    self.key = NotifyText.b64u(key); self.agents = agents.map(NotifyText.hex).sorted()
  }
}

/** How a session shows as the sender of a notification. */
public struct NotifySession: Codable, Equatable {
  public var agent: String         // the board id (/s/<agent>)
  public var agentDevice: String?  // hex
  public var name: String
  public var mark: String?         // the drawing, a PNG (base64)
  public init(agent: String, agentDevice: String?, name: String, mark: String?) { self.agent = agent; self.agentDevice = agentDevice; self.name = name; self.mark = mark }
}

/** Byte strings as text, for this module alone (it links nothing else). */
enum NotifyText {
  private static let hexDigits = Array("0123456789abcdef".utf8)
  static func hex(_ b: [UInt8]) -> String {
    var out = [UInt8]()
    out.reserveCapacity(b.count * 2)
    for x in b { out.append(hexDigits[Int(x >> 4)]); out.append(hexDigits[Int(x & 15)]) }
    return String(decoding: out, as: UTF8.self)
  }

  /** base64url without padding (RFC 4648 section 5). */
  static func b64u(_ b: [UInt8]) -> String {
    Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  /** nil for anything that is not base64url without padding. */
  static func unb64u(_ s: String) -> [UInt8]? {
    guard s.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x2d || $0 == 0x5f }),
          s.utf8.count % 4 != 1 else { return nil }
    let padded = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - s.utf8.count % 4) % 4)
    return Data(base64Encoded: padded).map { Array($0) }
  }
}
