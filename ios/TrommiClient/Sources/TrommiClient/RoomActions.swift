// RoomActions.swift: what a human does in the app: write to an agent, answer a card, allow or deny a request, set a
// register (drafts, Later, desks, goals), write a Note, draw on a Scribble Board, send and fetch files, share a file
// by link. Each shows at once (an echo) and is replaced by the hub's copy when it comes back in the stream.
//
// Every write is one envelope the core seals and signs (`sendEnvelope`); it is in the core's outbox, durable,
// before the hub sees it.
import Foundation

extension Room {
  /** A local id for an own echo (shown at once, replaced when the hub has it). */
  func newLocalId() -> String { echoSeq += 1; return "local-\(nowMs())-\(echoSeq)" }

  /** A body in the names of spec/v2.md, with its schema version; refused when it is too large to seal. */
  private func wire(_ content: JV, maxBytes: Int = 60_000) throws -> (payload: Bytes, files: [FileId]) {
    var c = Records.renameFiles(content, toWire: true, depth: 0)
    if (c["schema_version"].int ?? 0) == 0 { c = c.with("schema_version", .num(Double(Compat.SCHEMA_VERSION))) }
    let payload = c.encoded()
    if payload.count > maxBytes { throw TrommiError("too-large", maxBytes == 60_000 ? "body over 60 KB: put it into an attachment" : "a register value is at most 4 KiB") }
    return (payload, Records.fileIds(c))
  }

  /**
   * One envelope: sealed by the core in the queue (after everything before it), remembered for its echo, posted.
   * Throws what the core refuses (no key, removed, too large) and, within a moment, what the hub refuses.
   */
  @discardableResult
  func send(localId: String? = nil, _ draft: @escaping () throws -> EnvelopeDraft) async throws -> (localId: String, sent: SentEnvelope) {
    if let u = upgrade { throw TrommiError("client-too-old", u.message) }
    let r: (String, SentEnvelope) = try await serial { [self] in
      if !self.synced { _ = try await self.catchUp() }
      let d = try draft()
      let sent = try await self.onCore { try $0.sendEnvelope(d, nowMs: nowMs()) }
      let lid = localId ?? self.newLocalId()
      self.ownEchoes[hex(sent.hash)] = lid
      self.pumpOutbox()
      return (lid, sent)
    }
    try await awaitOutcome(r.1.outboxId)
    return r
  }
  func dropEcho(_ localId: String, _ ch: inout Change) {
    for t in board.timelines.values where t.echoes[localId] != nil { t.echoes.removeValue(forKey: localId); ch.timelines.insert(t.key) }
  }

  // ---- chat ----------------------------------------------------------------------------------------------

  /** A message to a session's agent, or into a card's own Chat. */
  public func sendMessage(sessionId: String? = nil, cardId: String? = nil, text: String, fields: [String: JV] = [:]) async throws {
    let card = cardId.flatMap { board.cards[$0] }
    if let id = cardId, card == nil { throw TrommiError("not-found", "no card \(id)") }
    guard let sid = card?.sessionId ?? sessionId else { throw TrommiError("bad-argument", "a message names a session or a card") }
    guard let recipient = card.map({ board.holderOf($0) }) ?? board.sessions[sid]?.agentDeviceId else { throw TrommiError("bad-argument", "this session has no agent to write to") }
    var content: [String: JV] = ["content_type": "message", "text": .str(text)]
    for (k, v) in fields { content[k] = v }
    let timelineId = cardId.map { "card/\($0)" } ?? "session/\(sid)"
    // The echo: in the conversation at once, replaced by the real item when the hub has it.
    let lid = newLocalId()
    let key = timelineKeyOf("chat", timelineId)
    let t = board.timelineOf(key)
    t.echoes[lid] = TimelineItem(envelopeNumber: nil, localId: lid, pending: true, senderDeviceId: deviceIdHex, recipientDeviceId: recipient, sentAt: nowMs(),
                                 itemState: "loaded", contentType: "message", content: .obj(content))
    var ch = Change(); ch.timelines.insert(key); ch.sessions.insert(sid); emit(ch)
    do {
      let w = try wire(.obj(content))
      let session = try unhex(sid), cardBytes = try cardId.map { try unhex($0) }
      try await send(localId: lid) { cardBytes.map { .cardChat(card: $0, payload: w.payload, files: w.files) } ?? .sessionChat(session: session, payload: w.payload, files: w.files) }
    } catch { var c = Change(); dropEcho(lid, &c); emit(c); throw error }
  }

  // ---- cards ---------------------------------------------------------------------------------------------

  /** Answer an open card: choices, a note, notes per option, files; "read" (an info) and "shred" are answers too. */
  public func answer(cardId: String, choices: [String] = [], note: String? = nil, optionNotes: [String: String] = [:], attachments: [JV] = [],
                     marks: [JV] = [], trusted: Bool = false, action: String = "answer") async throws {
    guard let card = board.cards[cardId] else { throw TrommiError("not-found", "no such card") }
    if card.objectState != "open" { throw TrommiError("card-closed", "the card is not open") }
    if card.unsupported { throw TrommiError("needs-update", Compat.UPDATE_MESSAGE) }
    if card.contentState != "ok" { throw TrommiError("card-pruned", "this device holds only the header of this card (retention); answer it on a device that shows it") }
    if card.versionHash == nil { throw TrommiError("card-pruned", "no version") }
    if action == "answer" && !trusted {
      for ch in choices where !card.options.contains(where: { $0.key == ch }) { throw TrommiError("bad-choice", "the card has no option \(ch)") }
    }
    var content: [String: JV] = ["answer_action": .str(action), "choices": .arr(choices.map { .str($0) })]
    if let n = note { content["note"] = .str(n) }
    if !optionNotes.isEmpty { content["option_notes"] = .obj(optionNotes.mapValues { .str($0) }) }
    if !attachments.isEmpty { content["attachments"] = .arr(attachments) }
    if !marks.isEmpty { content["marks"] = .arr(marks) }
    if trusted { content["trusted"] = true }
    let plain = (note ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !optionNotes.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } && attachments.isEmpty && marks.isEmpty
    let settles = action == "answer" && !trusted && plain && choicesFinal(card, choices)
    let closes = action != "answer" || settles
    // The echo: the card is answered at once (the hub's copy replaces it).
    let lid = newLocalId()
    var a = Answer(answerAction: action, choices: choices, note: note, optionNotes: optionNotes, attachments: attachments, marks: marks, trusted: trusted,
                   boundObjectVersion: card.objectVersion, envelopeNumber: nil, envelopeHash: lid, byDeviceId: deviceIdHex, answeredAt: nowMs())
    a.pending = true
    let was = (card.objectState, card.closedHow, card.answer)
    board.answerEchoes[lid] = (was.0, was.1, was.2)
    card.answer = a; card.answers.append(a)
    card.objectState = closes ? "closed" : "answered"
    card.closedHow = action == "read" ? "read" : action == "shred" ? "shredded" : settles ? "settled" : "answered"
    board.project()
    var ch = Change(); ch.cards.insert(cardId); ch.stack = true; if let s = card.sessionId { ch.sessions.insert(s) }; emit(ch)
    do {
      let w = try wire(.obj(content))
      let object = try unhex(cardId)
      try await send(localId: lid) { .answer(object: object, choices: choices, closes: closes, payload: w.payload, files: w.files) }
    } catch {
      board.answerEchoes.removeValue(forKey: lid)
      card.objectState = was.0; card.closedHow = was.1; card.answer = was.2; card.answers.removeAll { $0.pending }
      board.project(); var c = Change(); c.cards.insert(cardId); c.stack = true; emit(c)
      throw error
    }
  }
  /** "I don't give a duck": the agent's own recommendation, its call. */
  public func trust(cardId: String, note: String? = nil) async throws {
    guard let c = board.cards[cardId] else { throw TrommiError("not-found", "no such card") }
    try await answer(cardId: cardId, choices: c.recommended, note: note, trusted: true)
  }
  public func markRead(cardId: String) async throws { try await answer(cardId: cardId, action: "read") }
  public func shred(cardId: String, note: String? = nil) async throws { try await answer(cardId: cardId, note: note, action: "shred") }

  /** Take an answer back: the card is open again. */
  public func decideAgain(cardId: String) async throws {
    guard let card = board.cards[cardId], let a = card.answer, a.envelopeHash != nil, !a.pending, card.versionHash != nil else { throw TrommiError("decision-mismatch", "no answer in force to take back") }
    let w = try wire(.obj([:]))
    let object = try unhex(cardId)
    try await send { .takeBack(object: object, payload: w.payload) }
  }

  /** Allow or deny a permission request. */
  public func verdict(requestId: String, allow: Bool) async throws {
    guard board.permissions[requestId] != nil else { throw TrommiError("not-found", "no such permission request") }
    let w = try wire(.obj([:]))
    let request = try unhex(requestId)
    try await send { .verdict(request: request, allow: allow, payload: w.payload) }
  }

  // ---- registers -----------------------------------------------------------------------------------------

  /**
   * Human registers (drafts, Later, ducks, the crown, desks, a session's settings): shown at once, then one envelope
   * per name in the room group. With `sessionId`: in that session's group, where its agent reads it (`goals`).
   */
  public func setRegisters(_ values: [String: JV], sessionId: String? = nil) async throws {
    for k in values.keys where k.hasPrefix("device/") && k != "device/\(deviceIdHex)" { throw TrommiError("forbidden", "a device writes only its own device register") }
    for k in values.keys where Board.isAgentKey(k) { throw TrommiError("forbidden", "\(k) is not a human key") }
    var ch = Change()
    for (k, v) in values where !k.hasPrefix("device/") && sessionId == nil {
      var echo = Rec(envelopeNumber: 0, envelopeHash: "", senderDeviceId: deviceIdHex, senderRole: "human", sentAt: nowMs(), kind: KIND.STATUS, isHead: true,
                     contentState: "ok", causal: Causal(senderDeviceId: deviceIdHex, senderSequence: 0, sentAt: nowMs(), lamport: lamport + 1), senderSequence: 0, epoch: 0)
      echo.pending = true
      board.setHumanRegister(k, v, echo, &ch)
    }
    board.project(); ch.stack = true; emit(ch)
    let group: GroupId
    if let sid = sessionId {
      guard let g = sessionGroup(sid) else { throw TrommiError("no-key", "this device is not in that session's group") }
      group = g.group
    } else {
      guard let g = roomGroup else { throw TrommiError("no-key", "this device is in no room") }
      group = g
    }
    for k in values.keys.sorted() {
      let v = values[k] ?? .null
      // (a value of null deletes the name; the 4 KiB limit is the register's, 9.3.5)
      let value: Bytes? = v.isNull ? nil : try wire(v, maxBytes: 4096).payload
      try await send { .register(group: group, name: k, value: value) }
    }
  }
  public func setDraft(cardId: String, _ draft: JV?) async throws { try await setRegisters(["draft/\(cardId)": draft ?? .null]) }
  public func snooze(cardId: String, until: UInt64?) async throws { try await setRegisters(["snooze/\(cardId)": until.map { .obj(["until": .n($0)]) } ?? .null]) }
  public func setCrown(_ v: JV?) async throws { try await setRegisters(["crown": v ?? .null]) }
  public func setDesk(_ id: String, _ v: JV?) async throws { try await setRegisters(["desk/\(id)": v ?? .null]) }
  /** A session's settings (register session/<id>): name, icon, desk, archived… merged into what is there. */
  public func editSession(_ sid: String, _ fields: [String: JV]) async throws {
    var cur = board.human.sessionSettings[sid]?.object ?? [:]
    for (k, v) in fields { cur[k] = v }
    try await setRegisters(["session/\(sid)": .obj(cur)])
  }
  /** The device's name for the other devices (register device/<id>), once after joining. */
  public func sendDeviceRegister(name: String, platform: String) async throws {
    if record.deviceRegisterSent { return }
    try await renameDevice(name: name, platform: platform)
  }
  /** This device's name again (Settings → Devices → Rename): its own register, which only it may write. */
  public func renameDevice(name: String, platform: String) async throws {
    try await setRegisters(["device/\(deviceIdHex)": .obj(["device_name": .str(String(name.prefix(40))), "platform": .str(platform)])])
    record.deviceRegisterSent = true
    try? store.save(record)
  }
  /** Whether the Emergency Kit was offered and put off (register `kit`). */
  public var kitPending: Bool { board.human.raw["kit"]?.value["pending"].bool == true }
  public var kitRegistered: Bool { board.human.raw["kit"].map { !$0.pending } ?? false }
  public func setKitPending(_ on: Bool) async throws { try await setRegisters(["kit": on ? .obj(["pending": true]) : .null]) }

  // ---- notes (objects of type note; any human device writes a version) -----------------------------------

  private func noteHead(_ id: String) -> (version: Int, hash: String, content: [String: JV])? {
    let m = board.notes[id]
    let base = m?.pending == true ? m?.base?.value : m
    if let l = noteHeads[id], base == nil || l.version >= base!.objectVersion { return l }
    guard let b = base else { return nil }
    var c = b.extra; c["text"] = .str(b.text)
    return (b.objectVersion, b.versionHash, c)
  }
  /** A new note (objectId nil) or a new version of one; close: delete it. Returns its object id. */
  @discardableResult public func saveNote(objectId: String? = nil, fields: [String: JV], close: Bool = false) async throws -> String {
    let head = objectId.flatMap { noteHead($0) }
    var content = head?.content ?? [:]
    for (k, v) in fields { content[k] = v }
    content["object_version"] = .n((head?.version ?? 0) + 1)
    content["previous_version_hash"] = .str(head?.hash ?? String(repeating: "0", count: 64))
    content["lamport"] = .n(lamport + 1)
    let w = try wire(.obj(content))
    let object = try objectId.map { try unhex($0) }
    let r = try await send { .note(object: object, payload: w.payload, closed: close, files: w.files) }
    // The object id of a new note is derived from its first envelope: known only now.
    guard let made = objectId ?? r.sent.objectId.map(hex) else { throw TrommiError("internal", "the core named no object for a new note") }
    // The echo: the note shows at once (the hub's copy replaces it).
    let prev = board.notes[made]
    var extra = content
    for k in ["object_type", "object_version", "previous_version_hash", "lamport", "schema_version"] { extra.removeValue(forKey: k) }
    var echo = Note(objectId: made, byDeviceId: deviceIdHex, text: content["text"]?.string ?? "", extra: extra, objectVersion: content["object_version"]?.int ?? 1, versionHash: hex(r.sent.hash),
                    versionHashes: prev?.versionHashes ?? [], causal: nil, envelopeNumber: prev?.envelopeNumber ?? 0, objectState: close ? "closed" : "open")
    echo.pending = true; echo.localId = r.localId
    echo.base = prev?.pending == true ? prev?.base : prev.map { Box($0) }
    board.notes[made] = echo
    noteHeads[made] = (content["object_version"]?.int ?? 1, hex(r.sent.hash), extra)
    var ch = Change(); ch.notes.insert(made); emit(ch)
    return made
  }
  public func deleteNote(_ id: String) async throws { try await saveNote(objectId: id, fields: [:], close: true) }

  // ---- files (spec/v2.md section 11) ---------------------------------------------------------------------

  /** A file's plain bytes from its reference in a body; checked against the reference's hash by the core. */
  public func fetchAttachment(_ ref: JV) async throws -> Bytes {
    guard let id = ref["attachment_id"].string, let fileId = try? unhex(id), let key = ref["file_key"].string, let sha = ref["sha256"].string else { throw TrommiError("bad-argument", "attachment reference") }
    if let hit = attachmentCache[id] { return hit }
    let stored = try await noted { try await hub.getFile(fileId) }
    let k = try unb64u(key), s = try unb64u(sha)
    let bytes = try await Task.detached(priority: .userInitiated) { try Core.tools.decryptFile(fileId: fileId, fileKey: k, sha256: s, stored: stored) }.value
    attachmentCache[id] = bytes
    attachmentOrder.append(id)
    if attachmentOrder.count > 48 { attachmentCache.removeValue(forKey: attachmentOrder.removeFirst()) }
    return bytes
  }
  /** Encrypt and upload a file; the attachment reference for a body. */
  public func uploadAttachment(_ bytes: Bytes, fileName: String, mediaType: String, width: Int? = nil, height: Int? = nil) async throws -> JV {
    let a = try await Task.detached(priority: .userInitiated) { try Core.tools.encryptFile(bytes) }.value
    try await noted { try await hub.putFile(a.fileId, a.stored) }
    var ref: [String: JV] = ["attachment_id": .str(hex(a.fileId)), "file_key": .str(b64u(a.fileKey)), "sha256": .str(b64u(a.sha256)), "total_size": .n(bytes.count),
                             "file_name": .str(fileName), "media_type": .str(mediaType)]
    if let w = width { ref["width"] = .n(w) }
    if let h = height { ref["height"] = .n(h) }
    attachmentCache[hex(a.fileId)] = bytes
    return .obj(ref)
  }

  // ---- the Scribble Board (spec/v2.md section 10) --------------------------------------------------------

  private func boardId(_ timelineId: String) throws -> BoardId {
    let p = parseTimelineKey("x:\(timelineId)")
    guard p.scope == "desk", let id = try? unhex(p.scopeId), id.count == 16 else { throw TrommiError("bad-argument", "a Scribble Board belongs to a desk") }
    return id
  }
  /** A board as it stands: the newest snapshot (register board_snapshot/<board>), then every item after it. */
  public func loadCanvas(_ timelineId: String) async throws -> CanvasState {
    let st = CanvasState()
    let key = timelineKeyOf("scribble", timelineId)
    var after: UInt64 = 0
    if let snap = board.human.scribbleSnapshots[timelineId], !snap["attachment"].isNull,
       let bytes = try? await fetchAttachment(Records.renameFiles(snap["attachment"], toWire: false, depth: 0)), let json = gunzip(bytes).flatMap({ JV.parse($0) }) {
      st.load(snapshot: json)
      // (10.3: the items from 1 000 changes before the snapshot's change on; the frontier skips what it holds)
      let at = UInt64(max(0, snap["change"].int ?? 0))
      after = at > 1000 ? at - 1000 : 0
    }
    try await loadBoardItems(key, try boardId(timelineId), after: after)
    applyCanvasItems(st, key)
    return st
  }
  /** Every item of a board after a change number, each through the core's checks, into the board's timeline. */
  func loadBoardItems(_ key: String, _ id: BoardId, after: UInt64) async throws {
    let t = board.timelineOf(key)
    t.windowOpen = true
    var from = after
    var ch = Change()
    while true {
      let r = try await noted { try await hub.boardItems(id, afterChange: from) }
      let list = r["items"] as? [JSON] ?? []
      try await applyPage(list, t, key, &ch)
      from = max(from, list.compactMap { ($0["change"] as? NSNumber)?.uint64Value }.max() ?? from)
      if list.isEmpty || r["more"] as? Bool != true { break }
    }
    ch.timelines.insert(key)
    emit(ch)
  }
  /** The loaded items of a board's timeline into a canvas state (in hub order; the frontier skips what it holds). */
  @discardableResult public func applyCanvasItems(_ st: CanvasState, _ key: String) -> Set<String> {
    var changed = Set<String>()
    guard let t = board.timelines[key] else { return changed }
    for n in t.items.keys.sorted() {
      guard let it = t.items[n], it.itemState == "loaded", let c = it.content, let seq = it.senderSequence else { continue }
      let role = board.members[it.senderDeviceId]?.deviceRole ?? "human"
      if let got = st.apply(sender: it.senderDeviceId, seq: seq, hash: it.envelopeHash, envelopeNumber: n, content: c, senderRole: role) { changed.formUnion(got) }
    }
    return changed
  }
  /** One board item (strokes, erase, move, send_away): the room group, human devices only. */
  public func sendCanvas(_ timelineId: String, _ content: JV) async throws {
    let id = try boardId(timelineId)
    let w = try wire(content)
    try await send { .boardItem(board: id, payload: w.payload, files: w.files) }
  }
  /** A selection of the board to a session: its picture and words; what was sent leaves the board. */
  public func sendSelection(sessionId: String, canvas timelineId: String, text: String, picture: JV, strokeIds: [String]) async throws {
    guard board.sessions[sessionId]?.agentDeviceId != nil else { throw TrommiError("bad-argument", "this session has no agent") }
    var c: [String: JV] = ["content_type": "selection_sent", "attachments": [picture], "stroke_ids": .arr(strokeIds.map { .str($0) }), "board": .str(timelineId)]
    if !text.isEmpty { c["text"] = .str(text) }
    let w = try wire(.obj(c))
    let session = try unhex(sessionId)
    try await send { .sessionChat(session: session, payload: w.payload, files: w.files) }
    if !strokeIds.isEmpty { try await sendCanvas(timelineId, .obj(["content_type": "send_away", "stroke_ids": .arr(strokeIds.map { .str($0) })])) }
  }

  // ---- a conversation's older pages ----------------------------------------------------------------------

  /**
   * A page the hub gave out of order (a Chat's older items, a board's items): each envelope through the core as a
   * `page` (checked against the group state of its epoch; accepted once its chain holds it), then into the timeline.
   */
  func applyPage(_ items: [JSON], _ t: Timeline, _ key: String, _ ch: inout Change) async throws {
    let parsed: [(change: UInt64, bytes: Bytes, void: String?)] = items.compactMap { j in
      guard let n = (j["change"] as? NSNumber)?.uint64Value, let b = (j["envelope"] as? String).flatMap({ try? unb64u($0) }) else { return nil }
      return (n, b, j["void_code"] as? String)
    }
    guard !parsed.isEmpty else { return }
    let got: [(UInt64, ReceivedEnvelope?)] = try await onCore { device in
      parsed.map { p in (p.change, try? device.receiveEnvelope(p.bytes, change: p.change, source: .page, voidCode: p.void, nowMs: nowMs())) }
    }
    for (n, e) in got {
      guard let e = e, let rec = Records.record(e, change: n, sessionId: sessionIdOfGroup[hex(e.header.group)]), rec.timelineId.map({ timelineKeyOf(rec.timelineKind ?? "", $0) }) == key else { continue }
      let had = t.items[Int(n)]
      if had == nil || had?.itemState == "header" || had?.itemState == "undecryptable" {
        var item = Board.itemOf(rec)
        item.pending = rec.pending
        t.items[Int(n)] = item
        if !t.numbers.contains(Int(n)) { t.numbers.append(Int(n)); t.numbers.sort() }
        if rec.contentState == "ok" { log[n] = rec; cacheSoon(n) }
      }
      ch.timelines.insert(key)
    }
  }
  /** The next older page of a conversation into the window ("Earlier"). */
  @discardableResult public func loadOlder(_ key: String, limit: Int = 50) async throws -> (loaded: Int, hasMore: Bool) {
    let t = board.timelineOf(key)
    t.windowOpen = true
    let p = parseTimelineKey(key)
    guard p.kind == "chat" else { return (0, false) }
    let loadedNumbers = t.items.values.filter { $0.itemState != "header" }.compactMap { $0.envelopeNumber }
    let before = min(t.loadedDownTo, loadedNumbers.min() ?? Int(cursor) + 1)
    let r = try await noted { try await hub.chatItems(timeline: p.timelineId, before: UInt64(max(0, before)), limit: limit) }
    let list = r["items"] as? [JSON] ?? []
    var ch = Change()
    let was = t.items.count
    try await applyPage(list, t, key, &ch)
    t.loadedDownTo = min(t.loadedDownTo, list.compactMap { ($0["change"] as? NSNumber)?.intValue }.min() ?? t.loadedDownTo)
    t.hasMore = r["more"] as? Bool ?? (list.count >= limit)
    ch.timelines.insert(key)
    emit(ch)
    return (t.items.count - was, t.hasMore)
  }
  /** The bodies of items above the window that are here as headers only. Since v2 the catch-up brings bodies: nothing to do. */
  @discardableResult public func loadNewer(_ key: String) async throws -> Int { 0 }

  // ---- links for people outside the room (spec/v2.md 11.5) -----------------------------------------------

  // "Copy link" on an Artifact IS the consent: the first one makes a link that holds 30 days, later ones give the
  // same link while it holds. The links this device made are kept in ShareStore.

  func shareStore() throws -> ShareStore {
    if let s = shareStoreMemo { return s }
    let s = ShareStore(dir: store.dir, key: try store.cacheKey())
    shareStoreMemo = s
    return s
  }
  /** This device's link for that file that still holds, if it made one. */
  public func liveShare(_ attachmentId: String) -> SharedLink? { (try? shareStore())?.live(attachmentId) }
  /** The link to one file for someone outside the room; the hub keeps only the hash of its secret. */
  public func shareLink(_ ref: JV, app: String = "https://app.trommi.com") async throws -> SharedLink {
    guard let id = ref["attachment_id"].string, let fileId = try? unhex(id), let key = ref["file_key"].string.flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-argument", "attachment reference") }
    let kept = try shareStore()
    if let live = kept.live(id) { return live }
    let made = try Core.tools.createShareLink(app: app, fileId: fileId, fileKey: key)
    let expires = nowMs() + UInt64(ShareStore.days) * 86_400_000 - 60_000
    let r = try await noted { try await hub.request("POST", "/shares", body: ["share_id": b64u(made.shareId), "secret_hash": b64u(made.secretHash), "file_id": b64u(fileId), "expires_at": expires]) }
    let link = SharedLink(shareId: hex(made.shareId), attachmentId: id, link: made.link, expiresAt: (r["expires_at"] as? NSNumber)?.uint64Value ?? expires)
    try kept.put(link)
    return link
  }
  /** Stop sharing that file: the hub forgets every link this device made for it. */
  public func stopSharing(_ attachmentId: String) async throws {
    let kept = try shareStore()
    for s in kept.all(attachmentId) {
      if let id = try? unhex(s.shareId) {
        do { _ = try await noted { try await hub.request("DELETE", "/shares/\(b64u(id))") } }
        catch let e as HubError where e.code == "not-found" {}   // (already gone at the hub)
      }
      try kept.remove(shareId: s.shareId)
    }
  }
}
