// NotifyContext: what the Notification Service Extension (TrommiNotify) may know, and nothing more. The app is the
// one owner of the device's state (its MLS groups, its device key, its store): the extension never opens that store.
// The app writes this context into the Keychain (NotifyGroup.swift); the extension reads it.
//
// The extension gets:
//   - the push key: 32 bytes this phone registered with the hub, which open the sealed part of a notification
//     (the room, the change number, the urgency; no content);
//   - the ids of the rooms this phone is in.
// It gets no content key of any group and no name of a session: a content key never leaves the core, so there is
// none to hand over, and the extension opens no envelope. It never gets the device key either (it cannot sign,
// cannot sign in to the hub, cannot send) and no MLS state. What a notification shows is the hub's fixed text.
import Foundation

public struct NotifyContext: Codable, Equatable {
  /** 3: without content keys and sessions. A stored context of another version is not read. */
  public static let currentVersion = 3
  public var version = NotifyContext.currentVersion
  /** The push key (base64url, 32 bytes). */
  public var pushKey: String
  /** The rooms this phone is in (hex ids). */
  public var rooms: [String]
  public init(pushKey: [UInt8], rooms: [String]) { self.pushKey = NotifyText.b64u(pushKey); self.rooms = rooms }
  /** Whether this phone is in that room. */
  public func holds(room id: [UInt8]) -> Bool { rooms.contains(NotifyText.hex(id)) }
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
