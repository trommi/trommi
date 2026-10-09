// NotifyCoreLive: PushNotify's `NotifyCore` on trommi-core, for the Notification Service Extension. It opens the
// sealed part of one push and one envelope, with keys the app handed over; it holds no device and no group state.
//
// Stubbed today: the binding (core/swift) exports neither call yet (core `push::open`, `Envelope::decode`, `verify`,
// `open`). Until it does both throw, and the extension shows the hub's fixed text, as for every other failure.
import Foundation
import PushNotify
import TrommiCoreRust

public final class NotifyCoreLive: NotifyCore {
  public init() {}
  /** The version of the core this extension links: proof that the library is in the binary. */
  public var version: String { coreVersion() }
  struct NotBuilt: Error { let call: String }

  public func openPush(key: [UInt8], sealed: [UInt8]) throws -> ApnsPush { throw NotBuilt(call: #function) }
  public func openEnvelope(_ bytes: [UInt8], key: (_ group: [UInt8], _ epoch: UInt64) -> [UInt8]?) throws -> NotifyEnvelope { throw NotBuilt(call: #function) }
}
