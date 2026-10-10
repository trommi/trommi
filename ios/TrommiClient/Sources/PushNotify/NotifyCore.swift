// NotifyCore: the one call of trommi-core that the Notification Service Extension makes, as a Swift protocol. This
// module holds no cryptography and does not link the Rust library: the real implementation is a thin adapter over
// the core (UniFFI), handed in by whoever links it; the tests hand in a fake.
//
// There is no call that opens an envelope: a content key never leaves the core, and the core opens an envelope only
// on the device that holds its group, whose store the app owns. So the extension shows no content.
import Foundation

/** What a sealed APNs notification says (spec/v2.md 15.2, core `push::ApnsPush`). No content. */
public struct ApnsPush: Equatable {
  /** The room something changed in (32 bytes). */
  public var roomId: [UInt8]
  /** The hub's change number of the envelope that rang. */
  public var change: UInt64
  /** 0 low, 1 normal, 2 high, 3 critical. */
  public var urgency: UInt8
  /** The hub's ticket for `GET /v2/push-envelope`; empty when there is no envelope to fetch. It fetches for a day: never log it. The extension does not use it: it could not open what it fetched. */
  public var ticket: [UInt8]
  public init(roomId: [UInt8], change: UInt64, urgency: UInt8, ticket: [UInt8]) {
    self.roomId = roomId; self.change = change; self.urgency = urgency; self.ticket = ticket
  }
}

public protocol NotifyCore {
  /**
   * Opens `nonce(12) ‖ AEAD` of a notification under the 32-byte push key this phone registered (core `push::open`).
   * Throws when it does not open or is not the one spelling of the four fields.
   */
  func openPush(key: [UInt8], sealed: [UInt8]) throws -> ApnsPush
}
