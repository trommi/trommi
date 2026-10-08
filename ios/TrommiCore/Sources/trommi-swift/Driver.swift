// Driver.swift: `trommi-swift driver`, the interop driver (dev/interop/README in the repo README, "Interop"). One
// device per process; JSON lines on stdin and stdout:
//
//   in   {"id": 1, "cmd": "list_cards", "args": {...}}
//   out  {"id": 1, "ok": true, "result": ...}  or  {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
//
// The first line out is {"ready": true, "impl": "swift", "driver_protocol": 1}. A command this side does not have
// answers code "unsupported". The command set and the shapes of the results are dev/interop/protocol.mjs; the JS side
// (dev/interop/driver-js.mjs) speaks the same, so dev/interop/run.mjs drives either against the other.
// Nothing here prints a link, a password or a key.
import Foundation
import TrommiClient
import TrommiCore

let DRIVER_PROTOCOL = 1

struct DriverError: Error { let code: String; let message: String }

/** The commands this driver has (version_info lists them; dev/interop/parity.mjs reads them). */
let DRIVER_COMMANDS = [
  "version_info", "join", "join_wait", "login", "forgot", "whoami", "sync", "members", "sessions", "list_cards", "card",
  "answer", "shred", "mark_read", "decide_again", "chat_send", "chat_list", "set_register", "registers", "note_save", "notes",
  "invite", "invite_status", "invite_confirm", "remove_member", "leave", "register_push", "check_envelope", "alerts",
  "account_status", "make_kit", "change_password", "scribble_draw", "scribble_shapes", "set_live",
]

@MainActor final class Driver {
  let base: URL
  var room: Room?
  var joining: Task<Room, Error>?
  var joinCode: String?
  var joinEnded = false
  var joinName: String?
  var liveTask: Task<Void, Never>?
  var pairings: [String: Room.Pairing] = [:]
  var agentInvites: [String: Room.AgentInvite] = [:]
  var confirmed: [String: String] = [:]          // invite id -> "added" | session id
  init(base: URL) { self.base = base }

  func need() throws -> Room {
    guard let r = room else { throw DriverError(code: "no-room", message: "join or log in first") }
    return r
  }
  func adopt(_ r: Room, name: String?) async throws {
    room = r
    try await r.sendDeviceRegister(name: name ?? "trommi-swift driver", platform: "trommi-swift")
    try await r.sync()
    startLive()
  }
  func startLive() {
    guard liveTask == nil, let r = room else { return }
    liveTask = Task { @MainActor in await r.runLive() }
  }
  func stopLive() { liveTask?.cancel(); liveTask = nil }

  static func str(_ a: JV, _ k: String) throws -> String {
    guard let s = a[k].string else { throw DriverError(code: "bad-argument", message: "\(k) is missing") }
    return s
  }

  // ---- the board as plain JSON (the shapes of protocol.mjs) ----------------------------------------------

  func cardJSON(_ c: Card, _ r: Room) -> JV {
    let hasPicture = c.attachments.contains { ($0["media_type"].string ?? "").hasPrefix("image/") }
    return .obj([
      "id": .str(c.objectId), "title": .str(c.title), "card_type": .str(c.cardType), "state": .str(c.objectState),
      "closed_how": .s(c.closedHow), "urgency": .str(c.urgency), "session_id": .s(c.sessionId), "agent_device_id": .str(c.agentDeviceId),
      "options": .arr(c.options.map { .obj(["key": .str($0.key), "label": .str($0.label), "final": .bool($0.final)]) }),
      "choices": .arr((c.answer?.choices ?? []).map { .str($0) }), "multiple": .bool(c.allowsMultiple),
      "unsupported": .bool(c.unsupported), "version": .n(c.objectVersion), "teaser": .s(c.teaser),
      "sections": .n(c.sections?.count ?? 0), "has_html": .bool(c.html != nil), "attachments": .n(c.attachments.count),
      "has_picture": .bool(hasPicture), "recommended": .arr(c.recommended.map { .str($0) }),
      "urgency_reason": .s(c.urgencyReason), "close_summary": .s(c.closeSummary), "in_stack": .bool(r.board.stack.contains(c.objectId)),
    ])
  }
  func cardOf(_ r: Room, _ a: JV) throws -> Card {
    let id = try Driver.str(a, "card")
    guard let c = r.board.cards[id] ?? r.board.cards.values.first(where: { $0.objectId.hasPrefix(id) }) else { throw DriverError(code: "not-found", message: "no card \(id)") }
    return c
  }

  // ---- one command ---------------------------------------------------------------------------------

  func handle(_ cmd: String, _ a: JV) async throws -> JV {
    switch cmd {
    case "version_info":
      var hub: JV = .null
      if let r = room, let v = try? await r.hub.versionInfo() {
        hub = .obj(["protocol_versions_supported": .arr(v.protocolVersionsSupported.map { .n($0) }), "minimum_client_versions": .obj(v.minimumClientVersions.mapValues { .str($0) })])
      }
      return .obj(["impl": "swift", "driver_protocol": .n(DRIVER_PROTOCOL), "client": .str(HubClient.clientName), "protocol_version": .n(Compat.PROTOCOL_VERSION),
                   "schema_version": .n(Compat.SCHEMA_VERSION), "commands": .arr(DRIVER_COMMANDS.map { .str($0) }), "roles": ["human"],
                   "known": .obj(["content_types": .arr(Compat.CONTENT_TYPES.sorted().map { .str($0) }), "object_types": .arr(Compat.OBJECT_TYPES.sorted().map { .str($0) }),
                                  "card_types": .arr(Compat.CARD_TYPES.sorted().map { .str($0) }), "answer_actions": .arr(Compat.ANSWER_ACTIONS.sorted().map { .str($0) }),
                                  "envelope_kinds": .arr((1...7).filter { KIND.isKnown($0) }.map { .n($0) }), "timeline_kinds": .arr(Compat.TIMELINE_KINDS.sorted().map { .n($0) })]),
                   "hub": hub])

    case "join":
      // Returns once the check code is there; the join goes on (join_wait), nothing is added before the other side confirms.
      let link = try Driver.str(a, "link"), name = a["name"].string
      joinCode = nil
      let base = self.base
      joinEnded = false
      joinName = name
      joining = Task { @MainActor in
        defer { self.joinEnded = true }
        return try await Room.join(link: link, base: base, pollMs: 100) { ev in if case .checkCode(let c) = ev { self.joinCode = c } }
      }
      let until = nowMs() + 20_000
      while joinCode == nil && !joinEnded && nowMs() < until { try await Task.sleep(nanoseconds: 20_000_000) }
      if joinCode == nil {
        if let j = joining { joining = nil; _ = try await j.value }
        throw DriverError(code: "timeout", message: "no check code")
      }
      return .obj(["check_code": .str(joinCode!)])
    case "join_wait":
      guard let j = joining else { throw DriverError(code: "bad-argument", message: "no join running") }
      let r = try await j.value
      joining = nil
      try await adopt(r, name: a["name"].string ?? joinName)
      return .obj(["device_id": .str(r.record.myDeviceId), "room_id": .str(r.record.roomId)])
    case "login":
      let r = try await Room.loginWithPassword(hubURL: try Driver.str(a, "hub_url"), email: try Driver.str(a, "email"), password: try Driver.str(a, "password"), base: base)
      try await adopt(r, name: a["name"].string)
      return .obj(["device_id": .str(r.record.myDeviceId), "room_id": .str(r.record.roomId)])
    case "forgot":
      let r = try await Room.resetPassword(hubURL: try Driver.str(a, "hub_url"), email: try Driver.str(a, "email"), words: try Driver.str(a, "words"), newPassword: try Driver.str(a, "new_password"), base: base)
      try await adopt(r, name: a["name"].string)
      return .obj(["device_id": .str(r.record.myDeviceId)])
    case "whoami":
      let r = try need()
      return .obj(["device_id": .str(r.record.myDeviceId), "room_id": .str(r.record.roomId), "role": .str(r.record.role), "live": .bool(r.live), "key_epoch": .n(r.state.epoch)])
    case "sync":
      let r = try need()
      let rep = try await r.sync()
      return .obj(["envelopes": .n(rep.envelopes), "refused": .n(rep.refused)])
    case "set_live":
      if a["on"].bool == false { stopLive() } else { startLive() }
      return .obj([:])
    case "members":
      let r = try need()
      return .arr(r.board.members.values.sorted { $0.deviceId < $1.deviceId }.map { m in
        .obj(["device_id": .str(m.deviceId), "role": .str(m.deviceRole), "active": .bool(m.isActive), "name": .str(m.deviceName)])
      })
    case "sessions":
      let r = try need()
      return .arr(r.board.sessions.values.sorted { $0.sessionId < $1.sessionId }.map { s in
        .obj(["session_id": .str(s.sessionId), "agent_device_ids": .arr(s.agentDeviceIds.map { .str($0) }), "active": .bool(s.isActive), "name": .s(s.settings["name"].string)])
      })
    case "list_cards":
      let r = try need()
      let all = a["all"].bool == true
      return .arr(r.board.cards.values.filter { all || $0.objectState == "open" }.sorted { $0.objectId < $1.objectId }.map { cardJSON($0, r) })
    case "card":
      let r = try need()
      return cardJSON(try cardOf(r, a), r)

    case "answer", "shred", "mark_read", "decide_again":
      let r = try need()
      let c = try cardOf(r, a)
      switch cmd {
      case "answer":
        var notes = [String: String]()
        for (k, v) in a["option_notes"].object ?? [:] { if let s = v.string { notes[k] = s } }
        if a["trusted"].bool == true { try await r.trust(cardId: c.objectId, note: a["note"].string) }
        else { try await r.answer(cardId: c.objectId, choices: (a["choices"].array ?? []).compactMap { $0.string }, note: a["note"].string, optionNotes: notes) }
      case "shred": try await r.shred(cardId: c.objectId, note: a["note"].string)
      case "mark_read": try await r.markRead(cardId: c.objectId)
      default: try await r.decideAgain(cardId: c.objectId)
      }
      let f = try await r.flush()
      return .obj(["envelope_number": .n(f.number), "envelope_hash": .str(f.hash)])

    case "chat_send":
      let r = try need()
      let sid = a["session"].string
      try await r.sendMessage(sessionId: sid, cardId: a["card"].string, text: try Driver.str(a, "text"))
      let f = try await r.flush()
      return .obj(["envelope_number": .n(f.number)])
    case "chat_list":
      let r = try need()
      let key: String
      if let c = a["card"].string { key = timelineKeyOf("chat", "card/\(c)") } else { key = timelineKeyOf("chat", "session/\(try Driver.str(a, "session"))") }
      var pages = 0
      while pages < 50 {
        let res = try await r.loadOlder(key, limit: 100)
        pages += 1
        if !res.hasMore { break }
      }
      let t = r.board.timelineOf(key)
      let items = t.items.values.sorted { ($0.envelopeNumber ?? Int.max) < ($1.envelopeNumber ?? Int.max) }
      return .arr(items.map { i in
        let role = r.board.members[i.senderDeviceId]?.deviceRole ?? "unknown"
        return .obj(["from": .str(role), "text": .s(i.content?["text"].string), "content_type": .s(i.contentType), "state": .str(i.itemState), "envelope_number": .n(i.envelopeNumber)])
      })

    case "set_register":
      let r = try need()
      try await r.setRegisters([try Driver.str(a, "key"): a["value"]])
      try await r.flush()
      return .obj([:])
    case "registers":
      let r = try need()
      return .obj(["keys": .arr(r.board.human.raw.keys.sorted().map { .str($0) }), "desks": .obj(r.board.human.desks)])
    case "note_save":
      let r = try need()
      let id = try await r.saveNote(fields: ["text": .str(try Driver.str(a, "text")), "created_at": .n(nowMs())])
      try await r.flush()
      return .obj(["id": .str(id)])
    case "notes":
      let r = try need()
      return .arr(r.board.notes.values.filter { $0.objectState == "open" }.sorted { $0.objectId < $1.objectId }.map { .obj(["id": .str($0.objectId), "text": .str($0.text)]) })

    case "invite":
      let r = try need()
      let app = a["app_url"].string ?? "http://127.0.0.1/join"
      if a["role"].string == "agent" {
        let inv = try await r.createAgentInvite(app: app, label: a["label"].string)
        agentInvites[inv.pairing.inviteId] = inv
        return .obj(["invite_id": .str(inv.pairing.inviteId), "link": .str(inv.pairing.link)])
      }
      let p = try await r.createPairing(app: app)
      pairings[p.inviteId] = p
      return .obj(["invite_id": .str(p.inviteId), "link": .str(p.link)])
    case "invite_status":
      let r = try need()
      let id = try Driver.str(a, "invite_id")
      if let done = confirmed[id] { return .obj(["state": "done", "check_code": .null, "session_id": .str(done)]) }
      if var inv = agentInvites[id] {
        _ = try await r.checkPairing(&inv.pairing); agentInvites[id] = inv
        return .obj(["state": .str(inv.pairing.code == nil ? "open" : "confirm_code"), "check_code": .s(inv.pairing.code)])
      }
      guard var p = pairings[id] else { throw DriverError(code: "not-found", message: "no such invite") }
      _ = try await r.checkPairing(&p); pairings[id] = p
      return .obj(["state": .str(p.code == nil ? "open" : "confirm_code"), "check_code": .s(p.code)])
    case "invite_confirm":
      let r = try need()
      let id = try Driver.str(a, "invite_id"), matches = a["matches"].bool ?? false
      if let inv = agentInvites[id] {
        agentInvites[id] = nil
        let sid = try await r.confirmAgent(inv, matches: matches)
        confirmed[id] = sid
        return .obj(["session_id": .str(sid)])
      }
      guard let p = pairings[id] else { throw DriverError(code: "not-found", message: "no such invite") }
      pairings[id] = nil
      try await r.confirmPairing(p, matches: matches)
      confirmed[id] = "added"
      return .obj([:])
    case "remove_member":
      let r = try need()
      try await r.removeDevices((a["device_ids"].array ?? [a["device_id"]]).compactMap { $0.string })
      return .obj(["key_epoch": .n(r.state.epoch)])
    case "leave":
      let r = try need()
      stopLive()
      try await r.leaveRoom()
      room = nil
      return .obj([:])
    case "register_push":
      let r = try need()
      guard let ap = a["apns"].object else { throw DriverError(code: "unsupported", message: "this device registers APNs only") }
      try await r.hub.registerApns(token: ap["token"]?.string ?? "", environment: ap["environment"]?.string ?? "sandbox", topic: ap["topic"]?.string ?? "", key: ap["key"]?.string ?? "", remove: a["remove"].bool == true)
      return .obj([:])
    case "check_envelope":
      // Verify (and open) one envelope against this device's member list, keys and chains, applying nothing.
      let r = try need()
      let bytes = try unb64u(try Driver.str(a, "envelope"))
      var chains = r.chains
      let secrets: SecretLookup = { [room = r] h in
        h.keyScope == KEY_SCOPE.SESSION ? room.sessionSecrets["\(hex(h.sessionId ?? [])):\(h.epoch)"] : room.roomSecrets[h.epoch]
      }
      do {
        let o = try openEnvelope(bytes, state: r.state, chains: &chains, secrets: secrets, selfId: r.device.id, allowChainStart: true, allowRemovedSender: true, commit: false)
        return .obj(["ok": true, "code": .null, "content_state": .str(o.quarantined == nil ? "ok" : "undecryptable")])
      } catch let e as ZError where e.code == "no-key" {
        do {
          _ = try verifyEnvelope(bytes, state: r.state, chains: &chains, allowChainStart: true, allowRemovedSender: true, commit: false)
          return .obj(["ok": true, "code": .null, "content_state": "undecryptable"])
        } catch let e as ZError { return .obj(["ok": false, "code": .str(e.code)]) }
      } catch let e as ZError { return .obj(["ok": false, "code": .str(e.code)]) }
    case "alerts":
      let r = try need()
      return .arr(r.board.alerts.map { .obj(["code": .str($0.code), "envelope_number": .n($0.envelopeNumber)]) })

    case "account_status":
      let r = try need()
      guard let st = try await r.accountStatus() else { return .null }
      return .obj(["email": .str(st.email), "verified": .bool(st.emailVerifiedAt != nil), "has_recovery": .bool(st.hasRecovery)])
    case "make_kit":
      let r = try need()
      let k = try await r.makeEmergencyKit(password: try Driver.str(a, "password"))
      return .obj(["words": .str(k.words), "email": .str(k.email)])
    case "change_password":
      let r = try need()
      try await r.changePassword(current: try Driver.str(a, "current"), next: try Driver.str(a, "next"))
      return .obj([:])

    case "scribble_draw":
      let r = try need()
      let tl = deskCanvas(a["desk"].string ?? "main")
      let pts = (a["points"].array ?? [10, 10, 40, 30, 80, 20]).compactMap { $0.double }
      // an entry as given (fixtures/strokes.json), else one this core makes
      let e = a["entry"].object != nil ? a["entry"] : CanvasState.entryOf(CanvasShape(id: "", by: "", tool: "pen", pts: pts, pr: nil, color: "ink", size: 4, z: 0))
      try await r.sendCanvas(tl, .obj(["content_type": "strokes", "strokes": [e]]))
      try await r.flush()
      return .obj([:])
    case "scribble_shapes":
      let r = try need()
      try await r.sync()
      let st = try await r.loadCanvas(deskCanvas(a["desk"].string ?? "main"))
      return .arr(st.shapes.values.sorted { $0.id < $1.id }.map { .obj(["id": .str($0.id), "tool": .str($0.tool), "points": .n($0.pts.count / 2)]) })

    default:
      throw DriverError(code: "unsupported", message: "the Swift driver has no command \(cmd)")
    }
  }
}

/** Lines from stdin, read on a thread of their own. */
func stdinLines() -> AsyncStream<String> {
  AsyncStream { cont in
    let t = Thread {
      while let line = readLine(strippingNewline: true) { cont.yield(line) }
      cont.finish()
    }
    t.start()
  }
}

func writeLine(_ v: JV) {
  var b = v.encoded()
  b.append(0x0A)
  FileHandle.standardOutput.write(Data(b))
}

@MainActor func runDriver(base: URL) async {
  let d = Driver(base: base)
  writeLine(.obj(["ready": true, "impl": "swift", "driver_protocol": .n(DRIVER_PROTOCOL)]))
  for await line in stdinLines() {
    guard let req = JV.parse(Array(line.utf8)), let cmd = req["cmd"].string else {
      writeLine(.obj(["id": .null, "ok": false, "error": .obj(["code": "bad-request", "message": "not a command line"])]))
      continue
    }
    let id = req["id"]
    do {
      let result = try await d.handle(cmd, req["args"])
      writeLine(.obj(["id": id, "ok": true, "result": result]))
    } catch let e as DriverError {
      writeLine(.obj(["id": id, "ok": false, "error": .obj(["code": .str(e.code), "message": .str(e.message)])]))
    } catch let e as ZError {
      writeLine(.obj(["id": id, "ok": false, "error": .obj(["code": .str(e.code), "message": .str(e.message)])]))
    } catch let e as HubError {
      writeLine(.obj(["id": id, "ok": false, "error": .obj(["code": .str(e.code), "message": .str(e.message), "status": .n(e.status)])]))
    } catch {
      writeLine(.obj(["id": id, "ok": false, "error": .obj(["code": "internal", "message": .str("\(error)")])]))
    }
  }
  d.stopLive()
  if let r = d.room { _ = try? await r.flush(timeoutMs: 3000) }
}
