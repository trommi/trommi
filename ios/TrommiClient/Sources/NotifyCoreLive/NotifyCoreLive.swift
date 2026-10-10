// NotifyCoreLive: PushNotify's `NotifyCore` on trommi-core, for the Notification Service Extension. It opens the
// sealed part of one push and one envelope, with keys the app handed over; it holds no device and no group state.
//
//   real      version, openPush (the binding's `openApnsPush`)
//   stubbed   openEnvelope: the binding (core/swift) has no call that opens an envelope without a device. A content
//             key never leaves the core (`holdsKey` says only whether the device has one), and an envelope is opened
//             by the device that checks its sender's chain (`receiveEnvelope`), which writes the device's store: the
//             extension cannot hold that store beside the app. So this throws, and the extension shows what the push
//             itself carries (room, change, urgency: `openPush`) with the hub's fixed text.
import Foundation
import PushNotify
import TrommiCoreRust

/// A refusal of the core, with the specification's code as text ("decrypt-failed", "bad-format", …). The message is
/// the core's and never holds key material or content.
public struct NotifyCoreError: Error, Equatable, CustomStringConvertible {
  public let code: String
  public let message: String
  public var description: String { message.isEmpty || message == code ? code : "\(code): \(message)" }
}

public final class NotifyCoreLive: NotifyCore {
  public init() {}
  /** The version of the core this extension links: proof that the library is in the binary. */
  public var version: String { versions().core }

  public func openPush(key: [UInt8], sealed: [UInt8]) throws -> ApnsPush {
    do {
      let note = try openApnsPush(key: Data(key), sealed: Data(sealed))
      return ApnsPush(roomId: [UInt8](note.roomId), change: note.change, urgency: note.urgency, ticket: [UInt8](note.ticket))
    } catch let CoreError.Refused(code, message) {
      throw NotifyCoreError(code: errorCodeText(code: code), message: message)
    }
  }

  // ---- stubbed: the binding has no stateless way to open an envelope ----------------------------------------

  public func openEnvelope(_ bytes: [UInt8], key: (_ group: [UInt8], _ epoch: UInt64) -> [UInt8]?) throws -> NotifyEnvelope {
    throw NotifyCoreError(code: "not-built", message: "openEnvelope(_:key:): not in this build of the core binding")
  }
}
