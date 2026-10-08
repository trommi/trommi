// ShareImport: the app's half of the Share Extension (Sources/TrommiShare). It writes the small sealed snapshot the
// extension shows (desks, sessions, crowns: names and ids only) whenever they change, and imports what was shared from
// the App Group's inbox (ShareInbox): into the one note ("Add to Note"), or as a message to the picked session ("Send to
// Agent…") through the room's normal encrypted path. It runs when the app comes to the front and at once when the
// extension rings (a Darwin notification) while the app runs. Files are encrypted and uploaded as the note's own are.
import Foundation
import ShareInbox
import TrommiClient
import TrommiCore

/** The note's screen takes over what an import wrote into the note (it keeps its own text while it is open). */
extension Notification.Name {
  static let trommiNoteImported = Notification.Name("trommi-note-imported")
}

@MainActor
final class ShareImport {
  static let shared = ShareImport()
  private var inbox: ShareInbox?
  private var lastSnapshot: ShareSnapshot?
  private var running = false
  private var again = false
  private weak var model: BoardModel?

  /** Once a room is on the phone: the inbox (its key made now if missing), the bell from the extension. */
  func attach(_ model: BoardModel) {
    self.model = model
    #if os(iOS)
    if inbox == nil { inbox = ShareGroup.inbox(create: true) }
    #endif
    inbox?.sweep()
    #if canImport(Darwin)
    ShareSignal.observe { [weak self] in self?.run() }
    #endif
  }

  /** After a change of the board: the snapshot again when desks or sessions changed (names, crowns, order). */
  func boardChanged() {
    guard let m = model, !m.demo, let desk = m.desk, let room = m.room, let inbox = inbox else { return }
    let d = desk
    var crowns = [String: String]()
    for x in d.desks { if let c = d.crownOf(desk: x.id) { crowns[x.id] = c.id } }
    let desks = d.desks.map { ShareSnapshot.Desk(id: $0.id, name: $0.name, crown: crowns[$0.id]) }
    let sessions = d.agents.filter { !$0.archived && !$0.removed }.map {
      ShareSnapshot.Session(id: $0.id, name: $0.name, desk: d.deskOf($0) ?? $0.desk, parent: $0.parent, hue: $0.hue, online: $0.online)
    }
    var snap = ShareSnapshot(room: room.record.roomId, desks: desks, sessions: sessions)
    if let last = lastSnapshot { snap.written = last.written; if last == snap { return } }
    snap.written = ShareInbox.nowMs()
    lastSnapshot = snap
    try? inbox.writeSnapshot(snap)
  }

  /** Signed out: the extension shows nothing of the room any more. */
  func signedOut() {
    lastSnapshot = nil
    inbox?.clearSnapshot()
  }

  /** Import what waits (one run at a time; a ring during a run runs once more after it). */
  func run() {
    if running { again = true; return }
    guard let m = model, !m.demo, m.room != nil, let inbox = inbox else { return }
    running = true
    Task { @MainActor in
      repeat {
        again = false
        for r in inbox.pending() where inbox.claim(r.id) {
          await take(r, inbox: inbox, model: m)
        }
      } while again
      running = false
    }
  }

  private func take(_ r: ShareRequest, inbox: ShareInbox, model m: BoardModel) async {
    guard let room = m.room else { inbox.release(r.id); return }
    // the files first: encrypted and uploaded; an upload that fails leaves the share in the inbox for the next time
    var atts = [JV]()
    for i in r.items where i.kind == .image || i.kind == .file {
      let data: Data
      // a payload that does not open will never open: left out, the rest goes on
      do { data = try inbox.payload(i) } catch { m.fail("Shared item left out", error); continue }
      do { atts.append(try await m.upload(data, name: i.name, type: i.type, width: i.width, height: i.height)) }
      catch { inbox.release(r.id); m.fail("Not imported yet", error); return }
    }
    let words = r.words
    if r.action == .send, let to = r.to, r.room == nil || r.room == room.record.roomId, let key = m.desk?.sessionKey(of: to) {
      // taken out of the inbox before it is sealed: a send is never repeated (if it fails, it goes into the note)
      inbox.finish(r.id)
      do {
        var fields: [String: JV] = [:]
        if !atts.isEmpty { fields["attachments"] = .arr(atts) }
        try await room.sendMessage(sessionId: key, text: words, fields: fields)
        m.say("Sent to \(m.agent(to)?.name ?? r.toName ?? "the session")", "From the share sheet")
        return
      } catch {
        m.fail("Not sent: put into the note", error)
        await addToNote(words, atts, room: room, model: m)
        return
      }
    }
    if r.action == .send { m.say("The session is gone", "What you shared is in the note") }
    await addToNote(words, atts, room: room, model: m)
    inbox.finish(r.id)
    if r.action == .note { m.say("Added to the note", "From the share sheet") }
  }

  /** Onto the one note: its words below the note's, its files after the note's. */
  private func addToNote(_ words: String, _ atts: [JV], room: Room, model m: BoardModel) async {
    let note = m.desk?.notes.filter { $0.held.isNull }.sorted { $0.updated > $1.updated }.first
    var text = note?.text ?? ""
    if !words.isEmpty { text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? words : text + "\n" + words }
    let files = (note?.attachments ?? []) + atts
    var fields: [String: JV] = ["text": .str(text), "attachments": .arr(files), "updated_at": .n(nowMs())]
    if note == nil { fields["created_at"] = .n(nowMs()) }
    do {
      let id = try await room.saveNote(objectId: note?.id, fields: fields)
      NotificationCenter.default.post(name: .trommiNoteImported, object: nil, userInfo: ["id": id, "text": text, "files": files])
    } catch { m.fail("Not added to the note", error) }
  }
}
