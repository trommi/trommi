// SnapshotModel.swift: the JS model inside a room snapshot (shared/snapshot.ts snapshotOf: cards at rest as compactCard
// makes them, sessions as serialiseSession, timeline metadata without items, the human registers' raw values, the
// device registers) into this device's board, as bootFromSnapshot does in JS. Grant-derived session fields stay as this
// device verified them itself (the snapshot is stated trust, the grants are checked); registers go through the same
// setter as live ones, so their causal order holds for what comes after.
import Foundation
import TrommiCore

enum SnapshotModel {
  static let bookkeeping: Set<String> = ["schema_version", "object_type", "object_version", "previous_version_hash"]
  static let noteCore: Set<String> = ["object_id", "by_device_id", "object_version", "version_hash", "version_hashes", "causal", "envelope_number", "object_state",
                                      "pending", "unsupported", "local_id", "_base"]
  static func u64(_ v: JV) -> UInt64 { UInt64(max(0, v.double ?? 0)) }
  static func strings(_ v: JV) -> [String] { (v.array ?? []).compactMap { $0.string } }
  static func causal(_ v: JV) -> Causal? {
    guard v.object != nil, let s = v["sender_device_id"].string else { return nil }
    return Causal(senderDeviceId: s, senderSequence: u64(v["sender_sequence"]), sentAt: u64(v["sent_at"]), lamport: v["lamport"].int ?? 0, noBody: v["no_body"].truthy)
  }
  /** A sane lamport (R2, review 3): an inflated one in a snapshot is not adopted. */
  static func lamport(_ c: Causal?) -> Int { guard let l = c?.lamport, l > 0, l <= LAMPORT_MAX else { return 0 }; return l }

  /** expandCard: the newest version's content and the answer in force, written once at rest, back in place. */
  static func expandCard(_ c: JV) -> JV {
    guard var o = c.object else { return c }
    if var versions = o["versions"]?.array, let lv = versions.last, let at = lv["content"]["$card"].array {
      let own = Set(at.compactMap { $0.string }), rest = lv["content"]["rest"].object ?? [:]
      var content = [String: JV]()
      for k in strings(lv["content"]["keys"]) { content[k] = own.contains(k) ? (o[k] ?? .null) : (rest[k] ?? .null) }
      var v = lv.object ?? [:]; v["content"] = .obj(content)
      versions[versions.count - 1] = .obj(v)
      o["versions"] = .arr(versions)
    }
    if o["answer"]?.string == "$card" { o["answer"] = o["answers"]?.array?.last ?? .null }
    return .obj(o)
  }

  static func answer(_ a: JV) -> Answer? {
    guard a.object != nil, let by = a["by_device_id"].string else { return nil }
    return Answer(answerAction: a["answer_action"].string ?? "answer", choices: strings(a["choices"]), note: a["note"].string,
                  optionNotes: (a["option_notes"].object ?? [:]).compactMapValues { $0.string }, attachments: a["attachments"].array ?? [], marks: a["marks"].array ?? [],
                  trusted: a["trusted"].truthy, boundObjectVersion: a["bound_object_version"].int ?? 1, envelopeNumber: a["envelope_number"].int, envelopeHash: a["envelope_hash"].string,
                  byDeviceId: by, answeredAt: u64(a["answered_at"]), takenBackAt: a["taken_back_at"].int, takenBackSentAt: a["taken_back_sent_at"].isNull ? nil : u64(a["taken_back_sent_at"]),
                  pending: false)
  }

  static func card(_ raw: JV) -> Card? {
    let c = expandCard(raw)
    guard let id = c["object_id"].string, let agent = c["agent_device_id"].string else { return nil }
    let x = Card(snapshot: id, agent: agent)
    x.sessionId = c["session_id"].string
    x.objectState = c["object_state"].string ?? "open"; x.urgency = c["urgency"].string ?? "normal"
    x.versions = (c["versions"].array ?? []).map {
      CardVersion(objectVersion: $0["object_version"].int ?? 1, versionHash: $0["version_hash"].string ?? "", previousVersionHash: $0["previous_version_hash"].string,
                  envelopeNumber: $0["envelope_number"].int ?? 0, sentAt: u64($0["sent_at"]), objectState: $0["object_state"].string ?? "open",
                  urgency: $0["urgency"].string ?? "normal", content: $0["content"].isNull ? nil : $0["content"])
    }
    // the fields: the newest readable version's content without its bookkeeping (Board.applyObjectVersion)
    if let o = x.versions.last?.content?.object { x.fields = o.filter { !bookkeeping.contains($0.key) } }
    else { for k in CARD_CONTENT_FIELDS where c.has(k) && !c[k].isNull { x.fields[k] = c[k] } }
    x.objectVersion = c["object_version"].int ?? x.versions.last?.objectVersion ?? 1
    x.versionHash = c["version_hash"].string
    x.envelopeNumber = c["envelope_number"].int ?? 0; x.firstEnvelopeNumber = c["first_envelope_number"].int ?? x.envelopeNumber
    x.createdAt = u64(c["created_at"]); x.updatedAt = u64(c["updated_at"])
    x.answers = (c["answers"].array ?? []).compactMap(answer)
    x.answer = answer(c["answer"])
    x.closedHow = c["closed_how"].string
    if c["in_revision"].object != nil { x.inRevision = InRevision(by: c["in_revision"]["by"].string ?? "hand_back", envelopeNumber: c["in_revision"]["envelope_number"].int ?? 0) }
    if let tk = c["timeline_key"].string { x.timelineKey = tk }
    x.contentState = c["content_state"].string ?? "ok"
    x.refusedHead = c["refused_head"].int
    x.unsupported = c["unsupported"].string != nil
    return x
  }

  /**
   * Fill the board from the snapshot's model. `grantSessions`: the sessions whose grants this device verified (their
   * agents, epochs and creator stay as verified). Returns the highest sane lamport the snapshot's writes carry.
   */
  @discardableResult static func apply(_ model: JV, to b: Board, grantSessions: Set<String>) -> Int {
    var change = Change()
    var maxLamport = 0
    for raw in model["cards"].array ?? [] { if let c = card(raw) { b.cards[c.objectId] = c } }
    for p in model["permissions"].array ?? [] {
      guard let id = p["object_id"].string, let agent = p["agent_device_id"].string else { continue }
      let x = Permission(objectId: id, agentDeviceId: agent, sessionId: p["session_id"].string, toolName: p["tool_name"].string ?? "", description: p["description"].string ?? "",
                         inputPreview: p["input_preview"].string ?? "", expiresAt: u64(p["expires_at"]), versionHash: p["version_hash"].string ?? "",
                         envelopeNumber: p["envelope_number"].int ?? 0, sentAt: u64(p["sent_at"]))
      x.permissionState = p["permission_state"].string ?? "pending"
      x.withdrawReason = p["withdraw_reason"].string
      if let v = p["verdict"].object { x.verdict = (v["allow"]?.truthy ?? false, v["by_device_id"]?.string ?? "", v["envelope_number"]?.int ?? 0) }
      b.permissions[id] = x
    }
    for n in model["notes"].array ?? [] {
      guard let id = n["object_id"].string else { continue }
      let c = causal(n["causal"])
      maxLamport = max(maxLamport, lamport(c))
      b.notes[id] = Note(objectId: id, byDeviceId: n["by_device_id"].string ?? "", text: n["text"].string ?? "", extra: (n.object ?? [:]).filter { !noteCore.contains($0.key) },
                         objectVersion: n["object_version"].int ?? 1, versionHash: n["version_hash"].string ?? "", versionHashes: strings(n["version_hashes"]), causal: c,
                         envelopeNumber: n["envelope_number"].int ?? 0, objectState: n["object_state"].string ?? "open")
    }
    for p in model["published"].array ?? [] {
      guard let id = p["object_id"].string else { continue }
      b.published[id] = PublishedObject(objectId: id, agentDeviceId: p["agent_device_id"].string ?? "", sessionId: p["session_id"].string, attachments: p["attachments"].array ?? [],
                                        title: p["title"].string ?? "", note: p["note"].string, releasedUntil: p["released_until"], objectVersion: p["object_version"].int ?? 1,
                                        versionHash: p["version_hash"].string ?? "", envelopeNumber: p["envelope_number"].int ?? 0, objectState: p["object_state"].string ?? "open",
                                        sentAt: u64(p["sent_at"]))
    }
    for s in model["sessions"].array ?? [] {
      guard let id = s["session_id"].string ?? s["agent_device_id"].string else { continue }
      let x = b.sessionOf(id)
      if !grantSessions.contains(id) {
        x.agentDeviceIds = strings(s["agent_device_ids"]); x.everAgentIds = strings(s["ever_agent_ids"]); x.agentDeviceId = s["agent_device_id"].string
        x.sessionKeyEpoch = s["session_key_epoch"].int ?? 0; x.withHistory = s["with_history"].truthy
        x.epochAgentIds = [:]
        for (k, v) in s["epoch_agent_ids"].object ?? [:] { if let e = Int(k) { x.epochAgentIds[e] = strings(v) } }
        x.createdByAgent = s["created_by_agent"].truthy; x.creatorDeviceId = s["creator_device_id"].string
      }
      x.agentSessionId = s["agent_session_id"].string; x.deviceName = s["device_name"].string ?? ""
      x.isActive = s["is_active"] != .bool(false); x.isOnline = s["is_online"].truthy; x.offlineSince = stampOf(s["offline_since"]); x.link = cleanLink(s["link"])
      x.heardUpTo = s["heard_up_to"].int; x.heardAt = s["heard_at"].isNull ? nil : u64(s["heard_at"])
      x.profile = s["profile"]; x.settings = s["settings"]
      x.statusLines = (s["status_lines"].array ?? []).map {
        StatusLine(id: $0["id"].string ?? "", label: $0["label"].string ?? "", state: $0["state"].string, detail: $0["detail"].string, objectId: $0["object_id"].string,
                   envelopeNumber: $0["envelope_number"].int ?? 0, updatedAt: u64($0["updated_at"]))
      }
      x.agentAlerts = (s["agent_alerts"].array ?? []).map { (key: $0["key"].string ?? "", value: $0["value"], envelopeNumber: $0["envelope_number"].int ?? 0) }
      x.registers = [:]
      for e in s["registers"].array ?? [] {
        guard let k = e.array?.first?.string, let v = e.array?.dropFirst().first else { continue }
        x.registers[k] = RegisterValue(value: v["value"], envelopeNumber: v["envelope_number"].int ?? 0, senderSequence: v["sender_sequence"].isNull ? nil : u64(v["sender_sequence"]),
                                       byDeviceId: v["by_device_id"].string, causal: causal(v["causal"]))
      }
      x.cardIds = strings(s["card_ids"]); x.openCardIds = strings(s["open_card_ids"])
      if let tk = s["timeline_key"].string { x.timelineKey = tk }
      x.lastActivityAt = u64(s["last_activity_at"])
    }
    // timelines: the metadata only (counts, the newest numbers); their items are read when a window shows them
    for t in model["timelines"].array ?? [] {
      guard let key = t["timeline_key"].string else { continue }
      let x = b.timelineOf(key)
      x.itemCount = t["item_count"].int ?? 0
      x.newestEnvelopeNumber = t["newest_envelope_number"].int ?? 0
      x.newestHumanEnvelopeNumber = t["newest_human_envelope_number"].int ?? 0
      x.newestAgentEnvelopeNumber = t["newest_agent_envelope_number"].int ?? 0
      x.loadedDownTo = Int.max
      x.hasMore = x.itemCount > 0
      x.windowOpen = true
    }
    // the human registers through the live setter (R2 order for what comes after); then the device registers
    for e in model["human"].array ?? [] {
      guard let key = e.array?.first?.string, let v = e.array?.dropFirst().first else { continue }
      let c = causal(v["causal"])
      maxLamport = max(maxLamport, lamport(c))
      let by = v["by_device_id"].string ?? c?.senderDeviceId ?? ""
      let rec = Rec(envelopeNumber: v["envelope_number"].int ?? 0, envelopeHash: "", senderDeviceId: by, senderRole: "human", recipientDeviceId: nil, sentAt: c?.sentAt ?? 0,
                    kind: KIND.STATUS, isHead: true, object: nil, timelineKind: nil, timelineId: nil, sessionId: nil, content: nil, contentState: "ok", bind: nil,
                    causal: c ?? Causal(senderDeviceId: by, senderSequence: 0, sentAt: 0, lamport: 0), senderSequence: c?.senderSequence ?? 0, epoch: 0)
      b.setHumanRegister(key, v["value"], rec, &change)
    }
    for e in model["device_registers"].array ?? [] {
      guard let id = e.array?.first?.string, let v = e.array?.dropFirst().first else { continue }
      b.deviceRegisters[id] = v
    }
    return maxLamport
  }
}
