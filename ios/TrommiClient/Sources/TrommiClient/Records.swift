// Records.swift: from what the core opened to what the board reads. The core has checked an envelope (signature,
// chain, who may write it, the object's state) and opened its body; here its header and body become one `Rec`, the
// record the board's reducer has always taken (Board.swift), so the views read the same model as before.
//
// The names the model keeps from before, and what they are in spec/v1.md:
//   envelopeNumber       the room's change number of the item
//   timelineId           "session/<hex>", "card/<hex>", "desk/<hex>" (a Scribble Board)
//   attachment_id        a body's `file_id` (base64url there, lower-case hex here), likewise poster_attachment_id
//   values               a register is one name per envelope: { name, value, lamport } becomes { values: { name: value } }
//   scribble_snapshot/…  the register board_snapshot/<board>
//   stroke_ids, board units  a board item's `shape_ids` and whole 1/16 units (`boardItem`, at the end of this file)
//   goals/<session>      the register `goals` of a session group
//   published            an Artifact; released_until is shared_until
import Foundation

enum Records {
  static let typeNames: [ObjectType: String] = [.card: "card", .note: "note", .request: "request", .artifact: "published"]

  /** The header's kind as the number of spec/v1.md section 9, which the model keeps (Wire.swift `KIND`). */
  static func kindNumber(_ kind: EnvelopeKind) -> Int {
    switch kind {
    case .item: return KIND.TIMELINE_ITEM
    case .version: return KIND.OBJECT_VERSION
    case .answer: return KIND.ANSWER
    case .request: return KIND.PERMISSION_REQUEST
    case .verdict: return KIND.VERDICT
    case .register: return KIND.STATUS
    case .takeBack: return KIND.DECIDE_AGAIN
    case .reserved(let n): return Int(n)
    }
  }
  /** The model's name of a timeline: its kind and "<scope>/<hex id>". */
  static func timeline(_ t: TimelineRef) -> (kind: String, id: String) {
    switch t {
    case .sessionChat(let s): return ("chat", "session/\(hex(s))")
    case .cardChat(let c): return ("chat", "card/\(hex(c))")
    case .board(let b): return ("scribble", "desk/\(hex(b))")
    }
  }
  static func stateNumber(_ s: ObjectState) -> Int { s == .open ? CARD_STATE.OPEN : s == .answered ? CARD_STATE.ANSWERED : CARD_STATE.CLOSED }

  /**
   * The record of a received envelope that took its place: applied, provisional, or chained with a body that did
   * not open (which still counts for its object's state, 9.2.1). `senderRole`: "human" or "agent", as the room
   * names that device. nil for an outcome that shows nothing (refused, void, chained by check 7 or 8).
   */
  static func record(_ e: ReceivedEnvelope, senderRole: String) -> Rec? {
    let h = e.header
    let sender = hex(h.sender)
    let sessionId = h.sessionId.map(hex)
    var content: JV? = nil
    var state: String
    switch e.outcome {
    case .applied, .provisional: state = e.payload == nil ? "header" : "ok"
    case .chained:
      switch e.code {
      case "pruned": state = "pruned"
      case "newer-version": state = "newer_schema"
      case "no-key", "decrypt-failed", "too-large", "bad-format": state = "undecryptable"
      default: return nil
      }
    case .void, .refused: return nil
    }
    if let payload = e.payload, state == "ok" {
      let d = decodePayload(payload, header: h)
      content = d.content; state = d.state
    }
    if let c = content { content = fromWire(c, header: h, sessionId: sessionId) }
    var bind: DecodedBind? = nil
    switch e.bind {
    case nil: break
    case let .answer(o, vh, choices): bind = .answer(cardId: hex(o), versionHash: hex(vh), choices: choices)
    case let .takeBack(o, prev, vh): bind = .decideAgain(cardId: hex(o), previousHash: hex(prev), versionHash: hex(vh))
    case let .request(r, exp): bind = .permissionRequest(requestId: hex(r), expiresAt: exp)
    case let .verdict(r, rh, exp, allow): bind = .verdict(requestId: hex(r), requestHash: hex(rh), expiresAt: exp, allow: allow)
    }
    let t = h.timeline.map(timeline)
    let lam = lamportOf(content)
    var rec = Rec(envelopeNumber: Int(e.change), envelopeHash: hex(e.hash), senderDeviceId: sender, senderRole: senderRole,
                  recipientDeviceId: h.recipient.map(hex), sentAt: h.time, kind: kindNumber(h.kind), isHead: true,
                  object: h.object.map { ObjectHead(objectId: hex($0.objectId), objectState: stateNumber($0.state), urgency: $0.urgency.rawValue, answeredAt: $0.answeredAt) },
                  timelineKind: t?.kind, timelineId: t?.id, sessionId: sessionId, attachmentIds: h.fileIds.map(hex), content: content, contentState: state,
                  bind: bind, causal: Causal(senderDeviceId: sender, senderSequence: h.seq, sentAt: h.time, lamport: lam), senderSequence: h.seq, epoch: Int(h.epoch))
    // The core derived and checked the object id of a first version (9.2.1): the board need not doubt it.
    if rec.object != nil && (h.kind == .version || h.kind == .request) { rec.objectIdOk = true }
    rec.pending = e.outcome == .provisional
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

  /** The names of spec/v1.md in a body to the names the model keeps (the table at the top of this file). */
  static func fromWire(_ c: JV, header h: EnvelopeHeader, sessionId: String?) -> JV {
    var c = renameFiles(c, toWire: false, depth: 0)
    switch h.kind {
    case .register:
      guard var name = c["name"].string.map({ registerName($0, toWire: false) }) else { return c }
      if name.hasPrefix("board_snapshot/") {
        // (the board is base64url in the register's name, hex in the model's timeline id)
        let id = String(name.dropFirst("board_snapshot/".count))
        name = "scribble_snapshot/desk/\((try? unb64u(id)).flatMap { $0.count == 16 ? hex($0) : nil } ?? id)"
      }
      if name == "goals", let sid = sessionId { name = "goals/\(sid)" }
      var out: [String: JV] = ["values": .obj([name: c["value"]])]
      if let l = c.object?["lamport"] { out["lamport"] = l }
      return .obj(out)
    case .version:
      if let t = h.object?.type, let name = typeNames[t] { c = c.with("object_type", .str(name)) }
      if h.object?.type == .artifact, c.has("shared_until") { c = c.with("released_until", c["shared_until"]) }
      return c
    case .item where h.timeline.map({ if case .board = $0 { return true }; return false }) == true: return boardItem(c, toWire: false)
    default: return c
    }
  }
  /**
   * Byte strings in a body are base64url on the wire (spec/v1.md section 2) and lower-case hex in the model, which
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

  /** The file ids a body names, for the signed header: a body's attachments, and the pictures of a board item. */
  static func fileIds(_ wire: JV) -> [FileId] {
    var out = [FileId]()
    let refs = (wire["attachments"].array ?? []) + (wire["strokes"].array ?? []).map { $0["attachment"] }
    for a in refs { for k in ["file_id", "poster_file_id"] { if let id = a[k].string, let b = try? unb64u(id), !out.contains(b) { out.append(b) } } }
    return out
  }

  // ---- the Scribble Board's bodies (spec/v1.md 10.5) ---------------------------------------------------------
  //
  // The views and `CanvasState` (Canvas.swift) keep the model they had: positions and lengths in board units with
  // fractions, shape ids "<sender in hex>/<number>/<index>", `stroke_ids`, a picture's size and type beside its
  // attachment. On the wire (10.5) every position and length is a whole number of 1/16 unit, an id names its
  // sender in base64url, the list is `shape_ids`, a stroke carries no transform, and a picture is `rect` and
  // `attachment` alone. These two functions are the one place where the two meet.

  private static let lengths: Set<String> = ["width", "size", "wrap"]
  /** A length or position in the other form: board units ↔ whole 1/16 units (kept within 32 bits). */
  private static func q(_ v: JV, toWire: Bool) -> JV {
    guard let d = v.double, d.isFinite else { return v }
    return .num(toWire ? max(-2_147_483_648, min(2_147_483_647, InkWire.jsRound(d * InkWire.Q))) : d / InkWire.Q)
  }
  /** A shape id in the other form: its sender is hex in the model, base64url on the wire. */
  static func shapeId(_ id: String, toWire: Bool) -> String {
    let parts = id.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 3, let sender = toWire ? (try? unhex(String(parts[0]))) : (try? unb64u(String(parts[0]))), sender.count == 32 else { return id }
    return "\(toWire ? b64u(sender) : hex(sender))/\(parts[1])/\(parts[2])"
  }
  /** One shape of a `strokes` item or of a snapshot. To the wire: a transform is applied to the points and left out. */
  static func boardShape(_ entry: JV, toWire: Bool) -> JV {
    guard var e = entry.object, let tool = e["tool"]?.string else { return entry }
    if toWire, InkWire.STROKE_TOOLS.contains(tool), let m = e["transform"]?.array?.compactMap({ $0.double }), let ink = InkWire.unpack(e["points"]?.string) {
      let baked = InkWire.bake(ink, m)
      e["points"] = .str(InkWire.pack(baked.ink))
      if let w = e["width"]?.double { e["width"] = .num(w * baked.scale) }
    }
    for k in lengths { if let v = e[k] { e[k] = q(v, toWire: toWire) } }
    for k in ["at", "rect"] { if let a = e[k]?.array { e[k] = .arr(a.map { q($0, toWire: toWire) }) } }
    if toWire {
      if let w = e["width"]?.double { e["width"] = .num(max(1, min(16_000, w))) }
      if let z = e["z"]?.double { e["z"] = .num(InkWire.jsRound(z)) }
      // What the model keeps beside a picture's attachment is the attachment's own on the wire.
      for k in ["transform", "continues", "nw", "nh", "mime", "name", "by"] { e.removeValue(forKey: k) }
      if tool == "image", var a = e["attachment"]?.object {
        if a["file_name"] == nil { a["file_name"] = entry["name"].string.map { .str($0) } ?? "picture" }
        if a["media_type"] == nil { a["media_type"] = entry["mime"].string.map { .str($0) } ?? "image/png" }
        if a["width"] == nil, let w = entry["nw"].int, w > 0 { a["width"] = .n(w) }
        if a["height"] == nil, let h = entry["nh"].int, h > 0 { a["height"] = .n(h) }
        e["attachment"] = .obj(a)
      }
    } else if tool == "image" {
      let a = e["attachment"] ?? .null
      if let w = a["width"].double { e["nw"] = .num(w) }
      if let h = a["height"].double { e["nh"] = .num(h) }
      if let m = a["media_type"].string { e["mime"] = .str(m) }
      if let n = a["file_name"].string { e["name"] = .str(n) }
    }
    return .obj(e)
  }
  /** A board item's body between the model and the wire. A body that is no board item is returned as it is. */
  static func boardItem(_ content: JV, toWire: Bool) -> JV {
    guard var c = content.object else { return content }
    switch c["content_type"]?.string {
    case "strokes":
      // (a piece that continues a stroke is not a shape of 10.5: it is not written)
      let list = (c["strokes"]?.array ?? []).filter { !toWire || $0["continues"].isNull }
      c["strokes"] = .arr(list.map { boardShape($0, toWire: toWire) })
    case "erase", "send_away", "move":
      let (from, to) = toWire ? ("stroke_ids", "shape_ids") : ("shape_ids", "stroke_ids")
      if let ids = c.removeValue(forKey: from)?.array { c[to] = .arr(ids.map { $0.string.map { .str(shapeId($0, toWire: toWire)) } ?? $0 }) }
      if let off = c["offset"]?.array { c["offset"] = .arr(off.map { q($0, toWire: toWire) }) }
    default: break
    }
    return .obj(c)
  }
  /**
   * A snapshot file of 10.8 (`{ v: 3, shapes, frontier, gone, moved }`, decompressed) as `CanvasState.load` takes
   * it: the shapes in the model's form with `id` and `by`, the frontier and the ids by hex. nil for a `v` this
   * version does not read (above 3: needs a newer Trommi) or a file that is no such object.
   */
  static func boardSnapshot(_ file: JV) -> JV? {
    guard file.object != nil, let v = file["v"].int, v == 3 else { return nil }
    let shapes: [JV] = (file["shapes"].array ?? []).compactMap { e in
      guard let id = e["id"].string.map({ shapeId($0, toWire: false) }) else { return nil }
      return boardShape(renameFiles(e, toWire: false, depth: 0), toWire: false).with("id", .str(id)).with("by", .str(String(id.prefix { $0 != "/" })))
    }
    var frontier = [String: JV]()
    for (writer, head) in file["frontier"].object ?? [:] {
      guard let w = try? unb64u(writer), w.count == 32, let seq = head[0].int else { continue }
      frontier[hex(w)] = .arr([.n(seq), (head[1].string.flatMap { try? unb64u($0) }).map { .str(hex($0)) } ?? .null])
    }
    let gone = (file["gone"].array ?? []).compactMap { $0.string.map { JV.str(shapeId($0, toWire: false)) } }
    let moved: [JV] = (file["moved"].array ?? []).compactMap { m in
      guard let id = m[0].string else { return nil }
      return .arr([.str(shapeId(id, toWire: false)), q(m[1], toWire: false), q(m[2], toWire: false)])
    }
    return .obj(["v": 3, "shapes": .arr(shapes), "frontier": .obj(frontier), "gone": .arr(gone), "moved": .arr(moved)])
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
