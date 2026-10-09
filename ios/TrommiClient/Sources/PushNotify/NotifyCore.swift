// NotifyCore: the two calls of trommi-core that the Notification Service Extension needs, as a Swift protocol. This
// module holds no cryptography and does not link the Rust library: the real implementation is a thin adapter over
// the core (UniFFI), handed in by whoever links it; the tests hand in a fake.
import Foundation

/** What a sealed APNs notification says (spec/v2.md 15.2, core `push::ApnsPush`). No content. */
public struct ApnsPush: Equatable {
  /** The room something changed in (32 bytes). */
  public var roomId: [UInt8]
  /** The hub's change number of the envelope that rang. */
  public var change: UInt64
  /** 0 low, 1 normal, 2 high, 3 critical. */
  public var urgency: UInt8
  /** The hub's ticket for `GET /v2/push-envelope`; empty when there is no envelope to fetch. It fetches for a day: never log it. */
  public var ticket: [UInt8]
  public init(roomId: [UInt8], change: UInt64, urgency: UInt8, ticket: [UInt8]) {
    self.roomId = roomId; self.change = change; self.urgency = urgency; self.ticket = ticket
  }
}

/** One stored envelope, decoded, its signature verified, its body opened (spec/v2.md section 9). */
public struct NotifyEnvelope: Equatable {
  /** The group the envelope belongs to (the header's `group_id`). */
  public var group: [UInt8]
  /** The epoch whose content key sealed it. */
  public var epoch: UInt64
  /** The device that signed it (32 bytes). */
  public var sender: [UInt8]
  /** The header's kind: 2 is a version of an object, 4 a permission request. */
  public var kind: UInt8
  /** For the kinds that name an object: its id (16 bytes), its type (1 is a card) and its urgency (0 to 3). */
  public var objectId: [UInt8]?
  public var objectType: UInt8?
  public var urgency: UInt8?
  /** The body's payload: one UTF-8 JSON object. */
  public var payload: [UInt8]
  public init(group: [UInt8], epoch: UInt64, sender: [UInt8], kind: UInt8, objectId: [UInt8]?, objectType: UInt8?, urgency: UInt8?, payload: [UInt8]) {
    self.group = group; self.epoch = epoch; self.sender = sender; self.kind = kind
    self.objectId = objectId; self.objectType = objectType; self.urgency = urgency; self.payload = payload
  }
}

public protocol NotifyCore {
  /**
   * Opens `nonce(12) ‖ AEAD` of a notification under the 32-byte push key this phone registered (core `push::open`).
   * Throws when it does not open or is not the one spelling of the four fields.
   */
  func openPush(key: [UInt8], sealed: [UInt8]) throws -> ApnsPush

  /**
   * Decodes one envelope, VERIFIES ITS SIGNATURE against the sender named in its header, and opens its body with the
   * content key that `key` returns for the envelope's group and epoch (core `Envelope::decode`, `verify`, `open`).
   * Throws when any step fails, when `key` returns nil, and for a pruned envelope. Nothing of an envelope whose
   * signature does not hold is ever returned.
   */
  func openEnvelope(_ bytes: [UInt8], key: (_ group: [UInt8], _ epoch: UInt64) -> [UInt8]?) throws -> NotifyEnvelope
}
