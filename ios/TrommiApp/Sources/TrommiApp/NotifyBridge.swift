// NotifyBridge: the app's half of the Notification Service Extension (Sources/TrommiNotify) and of the Live Activity's
// widget (Sources/TrommiLive). After a change of the board (at most every 2 s) it writes, sealed into the App Group
// (PushNotify's NotifyGroup):
//   - the context: the push key, each agent's signing key, the per-sender keys of the agents in each session (newest two
//     epochs, derived here: the session secrets stay in the app), and per session its name, board id and drawing;
//   - the look of the Live Activity: the drawing of the crowned session of the desk on screen.
// It writes only when something changed. Signed out: both go.
import Foundation
import SwiftUI
import PushNotify
import TrommiClient
import TrommiCore

@MainActor
final class NotifyBridge {
  static let shared = NotifyBridge()
  private var due = false
  private var lastContext: NotifyContext?
  private var lastLook: LiveLook?
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

  /** Going to the background: written at once (keys that rotated without a visible change too). */
  func writeNow(_ m: BoardModel) { write(m) }

  private func write(_ m: BoardModel) {
    #if os(iOS)
    guard !m.demo, let room = m.room, let d = m.desk else { return }
    let state = room.state
    let agents = state.members.values.filter { $0.role == ROLE.AGENT && $0.removedSeq == nil }.map { (id: $0.id, signPub: $0.signPub) }
    var bySession = [String: Agent]()
    for a in d.agents where !a.removed { bySession[a.deviceId] = a }
    var secrets = [String: [EpochSecret]]()
    for (k, s) in room.sessionSecrets { if let sid = k.split(separator: ":").first { secrets[String(sid), default: []].append(s) } }
    let sessions: [NotifySessionInput] = room.sessionStates.compactMap { sid, st in
      guard let sidBytes = try? unhex(sid) else { return nil }
      let a = bySession[sid]
      let show = a.map { NotifySession(agent: $0.id, agentDevice: $0.agentDeviceId, name: $0.name, mark: mark($0)) }
      return NotifySessionInput(sessionId: sidBytes, agentIds: st.agentIds.compactMap { try? unhex($0) }, secrets: secrets[sid] ?? [], show: show)
    }
    guard let roomId = try? unhex(room.record.roomId), let me = try? unhex(room.record.myDeviceId) else { return }
    let r = NotifyRoom.build(roomId: roomId, hub: room.record.hubURL, me: me, agents: agents, sessions: sessions)
    let c = NotifyContext(pushKey: Push.keyText(), rooms: [r])
    if c != lastContext {
      do { try NotifyGroup.writeContext(c); lastContext = c } catch { NSLog("trommi notify: context not written: %@", "\(error)") }
    }
    let crown = d.crownOf(desk: m.deskId)
    let look = LiveLook(mark: crown.map(mark), name: crown?.name)
    if look != lastLook {
      do { try NotifyGroup.writeLive(look); lastLook = look } catch { NSLog("trommi live: look not written: %@", "\(error)") }
    }
    #endif
  }

  /** A session's drawing as a PNG (base64), drawn once per drawing and hue: the extensions have no pen. */
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

  /** Signed out: nothing of the room stays for the extensions. */
  func signedOut() {
    lastContext = nil; lastLook = nil
    #if os(iOS)
    NotifyGroup.clear()
    #endif
  }
}
