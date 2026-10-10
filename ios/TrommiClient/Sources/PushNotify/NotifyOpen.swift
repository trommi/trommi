// NotifyOpen: the Notification Service Extension's work without UIKit, so it is tested on Linux. A notification
// carries a fixed text and `e`, a sealed blob (spec/v1.md 15.2). `e` is opened with the push key
// (NotifyCore.openPush): the room, the change number and the urgency. That is all the extension learns, and it
// shows the hub's fixed text: the envelope the push names is not fetched, because nothing here could open it (a
// content key never leaves the core, NotifyCore.swift). A push that does not open, or names a room this phone is
// not in, gives nil, and the notification stays exactly as it came. No error is shown.
import Foundation

public enum NotifyOpen {
  /** The longest sealed blob (core `push::MAX_APNS_LEN`). */
  static let maxSealed = 512

  /** `e` opened with the context's push key; nil when it does not open or names a room that is not in the context. */
  public static func push(_ e: String, context: NotifyContext, core: NotifyCore) -> ApnsPush? {
    guard let sealed = NotifyText.unb64u(e), sealed.count <= maxSealed, let key = NotifyText.unb64u(context.pushKey), key.count == 32,
          let push = try? core.openPush(key: key, sealed: sealed), context.holds(room: push.roomId) else { return nil }
    return push
  }

  /** What the notifications of one room are threaded by: the start of its id, no content. */
  public static func thread(_ push: ApnsPush) -> String { String(NotifyText.hex(push.roomId).prefix(16)) }
}
