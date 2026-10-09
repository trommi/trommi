// Records.swift: from what the core opened to what the board reads. The core has checked an envelope (signature,
// chain, who may write it, the object's state) and opened its body; here its header and body become one `Rec`, the
// record the board's reducer has always taken (Board.swift), so the views read the same model as before.
//
// The names the model keeps from before, and what they are in spec/v2.md:
//   envelopeNumber       the room's change number of the item
//   timelineId           "session/<hex>", "card/<hex>", "desk/<hex>" (a Scribble Board)
//   attachment_id        a body's `file_id` (base64url there, lower-case hex here), likewise poster_attachment_id
//   values               a register is one name per envelope: { name, value, lamport } becomes { values: { name: value } }
//   scribble_snapshot/…  the register board_snapshot/<board>
//   goals/<session>      the register `goals` of a session group
//   published            an Artifact; released_until is shared_until
import Foundation

enum Records {
  static let scopeNames = [TIMELINE_SCOPE.CARD: "card", TIMELINE_SCOPE.SESSION: "session", TIMELINE_SCOPE.DESK: "desk"]
  static let typeNames = [OBJECT_TYPE.CARD: "card", OBJECT_TYPE.NOTE: "note", OBJECT_TYPE.REQUEST: "request", OBJECT_TYPE.ARTIFACT: "published"]

  /** The record of a received envelope. `sessionId`: the session of its group (nil: the room group). */
  static func record(_ e: ReceivedEnvelope, change: UInt64, sessionId: String?) -> Rec? {
    let h = e.header
    let sender = hex(h.sender)
    var content: JV? = nil
    var state: String
    switch e.standing {
    case .accepted, .provisional: state = e.payload == nil ? "header" : "ok"
    case .notApplied(let code): state = code == "pruned" ? "pruned" : "undecryptable"
    }
    if let payload = e.payload, state == "ok" {
      let d = decodePayload(payload, header: h)
      content = d.content; state = d.state
    }
    if let c = content { content = fromWire(c, header: h, sessionId: sessionId) }
    var bind: DecodedBind? = nil
    switch e.bind {
    case .none: break
    case let .answer(o, vh, choices): bind = .answer(cardId: hex(o), versionHash: hex(vh), choices: choices)
    case let .takeBack(o, prev, vh): bind = .decideAgain(cardId: hex(o), previousHash: hex(prev), versionHash: hex(vh))
    case let .request(r, exp): bind = .permissionRequest(requestId: hex(r), expiresAt: exp)
    case let .verdict(r, rh, exp, allow): bind = .verdict(requestId: hex(r), requestHash: hex(rh), expiresAt: exp, allow: allow)
    }
    var timelineKind: String? = nil, timelineId: String? = nil
    if let k = h.timelineKind, let scope = h.timelineScope, let ref = h.timelineRef {
      timelineKind = TIMELINE_KIND_NAME[k] ?? String(k)
      timelineId = "\(scopeNames[scope] ?? String(scope))/\(hex(ref))"
    }
    let lam = lamportOf(content)
    var rec = Rec(envelopeNumber: Int(change), envelopeHash: hex(e.hash), senderDeviceId: sender, senderRole: e.senderRole == ROLE.HUMAN ? "human" : "agent",
                  recipientDeviceId: h.recipient.map(hex), sentAt: h.time, kind: h.kind, isHead: true,
                  object: h.objectId.map { ObjectHead(objectId: hex($0), objectState: h.objectState ?? CARD_STATE.OPEN, urgency: h.urgency ?? 1, answeredAt: h.answeredAt ?? 0) },
                  timelineKind: timelineKind, timelineId: timelineId, sessionId: sessionId, attachmentIds: h.fileIds.map(hex), content: content, contentState: state,
                  bind: bind, causal: Causal(senderDeviceId: sender, senderSequence: h.seq, sentAt: h.time, lamport: lam), senderSequence: h.seq, epoch: Int(h.epoch))
    // The core derived and checked the object id of a first version (9.2.1): the board need not doubt it.
    if rec.object != nil && (rec.kind == KIND.OBJECT_VERSION || rec.kind == KIND.PERMISSION_REQUEST) { rec.objectIdOk = true }
    rec.pending = e.standing == .provisional
    return rec
  }

  /**
   * A body as the model reads it: one UTF-8 JSON object, no BOM (the core checked that no object names a key
   * twice); a newer schema is kept as it is ("needs a newer Trommi"); every file a body names is in the signed
   * header's list, else the body is not shown.
   */
  static func decodePayload(_ bytes: Bytes, header h: EnvelopeHeader) -> (content: JV?, state: String) {
    if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { return (nil, "undecryptable") }
    guard String(bytes: bytes, encoding: .utf8) != nil, var c = JV.parse(bytes), c.object != nil else { return (nil, "undecryptable") }
    let files = Set(h.fileIds.map { b64u($0) })
    var ok = true
    func walk(_ v: JV, _ depth: Int) {
      if depth > 32 { ok = false; return }
      switch v {
      case .arr(let a): a.forEach { walk($0, depth + 1) }
      case .obj(let o):
        for (k, x) in o {
          if k == "file_id" || k == "poster_file_id", !x.isNull {
            guard let s = x.string, let b = try? unb64u(s), b.count == 16 else { ok = false; return }
          }
          walk(x, depth + 1)
        }
      default: break
      }
    }
    walk(c, 0)
    if !ok { return (nil, "undecryptable") }
    for a in (c["attachments"].array ?? []) {
      for k in ["file_id", "poster_file_id"] { if let id = a[k].string, !files.contains(id) { return (nil, "undecryptable") } }
    }
    if (c["schema_version"].int ?? Compat.SCHEMA_VERSION) > Compat.SCHEMA_VERSION { return (c, "newer_schema") }
    if c["content_type"].string == "message", c.has("note"), !noteRefValid(c["note"]) { c = c.with("note", nil) }
    if let t = c["teaser"].string, !teaserValid(t) { c = c.with("teaser", nil) }
    if let opts = c["options"].array {
      c = c.with("options", .arr(opts.map { o in o.has("final") && o["final"] != .bool(true) ? o.with("final", nil) : o }))
    }
    return (c, "ok")
  }
  static func noteRefValid(_ m: JV) -> Bool {
    guard let o = m.object, o.keys.allSatisfy({ $0 == "object_id" || $0 == "written_at" }), let id = o["object_id"]?.string, id.utf8.count == 32 else { return false }
    if let w = o["written_at"], !w.isNull { return (w.int ?? -1) >= 0 }
    return true
  }
  static func teaserValid(_ t: String) -> Bool {
    !t.isEmpty && t == t.trimmingCharacters(in: .whitespacesAndNewlines) && t.count <= 160 && !t.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
  }

  /** The names of spec/v2.md in a body to the names the model keeps (the table at the top of this file). */
  static func fromWire(_ c: JV, header h: EnvelopeHeader, sessionId: String?) -> JV {
    var c = renameFiles(c, toWire: false, depth: 0)
    switch h.kind {
    case KIND.STATUS:
      guard var name = c["name"].string.map({ registerName($0, toWire: false) }) else { return c }
      if name.hasPrefix("board_snapshot/") { name = "scribble_snapshot/desk/\(name.dropFirst("board_snapshot/".count))" }
      if name == "goals", let sid = sessionId { name = "goals/\(sid)" }
      var out: [String: JV] = ["values": .obj([name: c["value"]])]
      if let l = c.object?["lamport"] { out["lamport"] = l }
      return .obj(out)
    case KIND.OBJECT_VERSION:
      if let t = h.objectType, let name = typeNames[t] { c = c.with("object_type", .str(name)) }
      if h.objectType == OBJECT_TYPE.ARTIFACT, c.has("shared_until") { c = c.with("released_until", c["shared_until"]) }
      return c
    default: return c
    }
  }
  /**
   * Byte strings in a body are base64url on the wire (spec/v2.md section 2) and lower-case hex in the model, which
   * names things by hex everywhere (timelines, cards, devices): file_id ↔ attachment_id, and every `…object_id`,
   * `…object_ids` and `previous_version_hash`. A value that is not the id it should be is left as it is.
   */
  static func renameFiles(_ v: JV, toWire: Bool, depth: Int) -> JV {
    if depth > 32 { return v }
    func id(_ s: String, _ lengths: [Int]) -> JV? {
      guard let bytes = toWire ? (try? unhex(s)) : (try? unb64u(s)), lengths.contains(bytes.count) else { return nil }
      return .str(toWire ? b64u(bytes) : hex(bytes))
    }
    switch v {
    case .arr(let a): return .arr(a.map { renameFiles($0, toWire: toWire, depth: depth + 1) })
    case .obj(let o):
      var out = [String: JV]()
      for (k, x) in o {
        if let name = toWire ? Self.toWire[k] : Self.fromWire[k], let s = x.string { out[name] = id(s, [16]) ?? x }
        else if k.hasSuffix("object_id"), let s = x.string { out[k] = id(s, [16]) ?? x }
        else if k.hasSuffix("object_ids"), let list = x.array { out[k] = .arr(list.map { $0.string.flatMap { id($0, [16]) } ?? $0 }) }
        else if k == "previous_version_hash", let s = x.string { out[k] = id(s, [32]) ?? x }
        else { out[k] = renameFiles(x, toWire: toWire, depth: depth + 1) }
      }
      return .obj(out)
    default: return v
    }
  }
  private static let fromWire = ["file_id": "attachment_id", "poster_file_id": "poster_attachment_id"]
  private static let toWire = ["attachment_id": "file_id", "poster_attachment_id": "poster_file_id"]
  /** A register's name: a device id in it is base64url on the wire (9.3.3), hex in the model. */
  static func registerName(_ name: String, toWire: Bool) -> String {
    guard name.hasPrefix("device/") else { return name }
    let id = String(name.dropFirst("device/".count))
    guard let bytes = toWire ? (try? unhex(id)) : (try? unb64u(id)), bytes.count == 32 else { return name }
    return "device/" + (toWire ? b64u(bytes) : hex(bytes))
  }

  /** The file ids a body names, for the signed header. */
  static func fileIds(_ wire: JV) -> [FileId] {
    var out = [FileId]()
    for a in wire["attachments"].array ?? [] { for k in ["file_id", "poster_file_id"] { if let id = a[k].string, let b = try? unb64u(id), !out.contains(b) { out.append(b) } } }
    return out
  }

  /** One step of a work trail (an MLS message, 7.3) as the chat item the trail has always been folded from (Work.swift). */
  static func workStep(session: String, sender: String, turn: String, number: Int, time: UInt64, step: Bytes, change: UInt64) -> Rec? {
    guard let s = JV.parse(step), let text = s["text"].string else { return nil }
    var item: [String: JV] = ["id": .str(String(number)), "kind": .str(s["tool"].string == nil ? "text" : "step"), "at": .num(Double(time))]
    if let tool = s["tool"].string { item["tool"] = .str(tool); item["title"] = .str(text) } else { item["text"] = .str(text) }
    let work: JV = .obj(["turn": .str(turn), "seq": .num(Double(number)), "state": "running", "items": .arr([.obj(item)])])
    let content: JV = .obj(["content_type": "message", "terminal": "work", "text": "", "work": work])
    return Rec(envelopeNumber: Int(change), envelopeHash: "", senderDeviceId: sender, senderRole: "agent", recipientDeviceId: nil, sentAt: time, kind: KIND.TIMELINE_ITEM, isHead: true,
               object: nil, timelineKind: "chat", timelineId: "session/\(session)", sessionId: session, attachmentIds: [], content: content, contentState: "ok", bind: nil,
               causal: Causal(senderDeviceId: sender, senderSequence: 0, sentAt: time, lamport: 0), senderSequence: 0, epoch: 0)
  }

  /** The stream's `presence` event as the board's device entry. */
  static func presence(_ d: JV) -> JV {
    guard let id = d["device"].string.flatMap({ try? unb64u($0) }) else { return .null }
    let online = d["online"].truthy
    var link: [String: JV] = ["hears": .str(d["hears"].truthy ? "live" : "oncall"), "working": .bool(d["working"].truthy)]
    if let t = d["last_call_at"].int, t > 0 { link["last_call_at"] = .num(Double(t)) }
    var out: [String: JV] = ["device_id": .str(hex(id)), "is_online": .bool(online), "link": .obj(link)]
    if !online, let t = d["offline_since"].int { out["offline_since"] = .num(Double(t)) }
    return .obj(out)
  }
}
