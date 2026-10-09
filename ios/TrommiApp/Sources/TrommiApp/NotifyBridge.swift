// NotifyBridge: the app's half of the Notification Service Extension (Sources/TrommiNotify). After a change of the
// board (at most every 2 s) it writes the context into the Keychain item the extension reads (PushNotify:
// NotifyContext says what is in it and what that allows, NotifyGroup where it lies): the push key, the room's hub and
// this device's id, of every session group the content key of its newest two epochs with its agent devices
// (`Room.notifyKeys()`), and per session its name, board id and drawing. The app stays the one owner of the device's
// state; nothing else leaves it. It writes only when something changed. Signed out: the context goes.
import Foundation
import SwiftUI
import PushNotify
import TrommiClient

@MainActor
final class NotifyBridge {
  static let shared = NotifyBridge()
  private var due = false
  private var lastContext: NotifyContext?
  private var pngs: [String: String] = [:]

  /** After a change of the board: write within 2 s (a catch-up brings thousands of changes). */
  func boardChanged(_ m: BoardModel) {
    guard !due else { return }
    due = true
    Task { @MainActor [weak m] in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      self.due = false
      if let m = m { self.write(m) }
    }
  }

  /** Going to the background: written at once (keys that changed without a visible change too). */
  func writeNow(_ m: BoardModel) { write(m) }

  private func write(_ m: BoardModel) {
    #if os(iOS)
    guard !m.demo, let room = m.room, let d = m.desk, let pushKey = Push.key() else { return }
    let keys = room.notifyKeys().map { NotifyKey(group: $0.group, session: $0.session, epoch: $0.epoch, key: $0.key, agents: $0.agents) }
    // how each session with a key shows as the sender; a session the desk does not show gets the app's name
    var shows = [String: NotifySession]()
    let live = Set(keys.map(\.session))
    for a in d.agents where !a.removed && live.contains(a.deviceId) {
      shows[a.deviceId] = NotifySession(agent: a.id, agentDevice: a.agentDeviceId, name: a.name, mark: mark(a))
    }
    let r = NotifyRoom(roomId: room.roomIdHex, hub: room.hubURL, me: room.deviceIdHex, keys: keys, sessions: shows)
    let c = NotifyContext(pushKey: pushKey, rooms: [r])
    guard c != lastContext else { return }
    // the error names a Keychain status at most, never a key
    do { try NotifyGroup.writeContext(c); lastContext = c } catch { NSLog("trommi notify: context not written: %@", "\(error)") }
    #endif
  }

  /** A session's drawing as a PNG (base64), drawn once per drawing and hue: the extension has no pen. */
  private func mark(_ a: Agent) -> String? {
    let key = "\(a.mark)|\(a.hue)"
    if let p = pngs[key] { return p }
    #if canImport(UIKit)
    var shown = a
    shown.online = true
    let r = ImageRenderer(content: AgentMark(agent: shown, size: 40, crown: false).padding(4).environment(\.colorScheme, .light))
    r.scale = 3
    guard let d = r.uiImage?.pngData() else { return nil }
    let p = d.base64EncodedString()
    pngs[key] = p
    return p
    #else
    return nil
    #endif
  }

  /** Signed out: nothing of the room stays for the extension. */
  func signedOut() {
    lastContext = nil
    #if os(iOS)
    NotifyGroup.clear()
    #endif
  }
}
