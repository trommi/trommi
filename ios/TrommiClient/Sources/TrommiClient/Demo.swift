// Demo.swift: the web demo's room as a board (the repository's demo/README.md): demo/data/fixture.json
// is the JS model (shared/README.md "The model") as JSON; this builds the same Board from it, with no
// room, no keys and no network. Every timestamp is shifted by (now - made_at), as demo.mjs does, so "5 min ago" stays
// five minutes ago. The app shows it in demo mode (Demo on the sign-in screen and in Settings, TROMMI_SCREEN=<id>).
import Foundation

public enum DemoFixture {
  /** The board of the fixture's bytes, its times moved to `now`. */
  public static func board(_ data: Data, now: UInt64 = nowMs()) throws -> Board {
    guard let raw = JV.parse(Array(data)), raw.object != nil else { throw TrommiError("bad-fixture", "the demo fixture is not a JSON object") }
    let made = raw["made_at"].double ?? Double(now)
    let f = shift(raw, by: Double(now) - made)
    return build(f)
  }

  /** Every time stamp (a number in ms under a key `*_at`, `at`, `until`, `since`) moved by `by` ms. */
  static func shift(_ v: JV, by: Double, key: String = "") -> JV {
    switch v {
    case .num(let d):
      let stamp = key == "at" || key == "until" || key == "since" || key.hasSuffix("_at") || key.hasSuffix("_since")
      return stamp && d > 1e12 ? .num((d + by).rounded()) : v
    case .arr(let a): return .arr(a.map { shift($0, by: by, key: key) })
    case .obj(let o): return .obj(Dictionary(uniqueKeysWithValues: o.map { ($0.key, shift($0.value, by: by, key: $0.key)) }))
    default: return v
    }
  }

  static func u64(_ v: JV) -> UInt64 { clampedU64(v.double) }
  static func strings(_ v: JV) -> [String] { (v.array ?? []).compactMap { $0.string } }

  static func build(_ f: JV) -> Board {
    let b = Board()
    let room = f["room"]
    b.roomId = room["room_id"].string; b.hubURL = room["hub_url"].string ?? "mock:"; b.myDeviceId = room["my_device_id"].string; b.myRole = room["my_role"].string ?? "human"
    b.keyEpoch = room["key_epoch"].int ?? 1; b.lastEntryNumber = room["last_entry_number"].int ?? 0; b.lastEnvelopeNumber = room["last_envelope_number"].int ?? 0
    b.connection = "live"

    for m in f["members"].array ?? [] {
      guard let id = m["device_id"].string else { continue }
      let x = RoomMember(deviceId: id, role: m["device_role"].string ?? "human")
      x.deviceName = m["device_name"].string ?? ""; x.isActive = m["is_active"] != .bool(false); x.addedEntryNumber = m["added_entry_number"].int ?? 0
      x.removedEntryNumber = m["removed_entry_number"].int; x.isMe = m["is_me"].truthy || id == b.myDeviceId; x.isOnline = m["is_online"].truthy
      x.offlineSince = stampOf(m["offline_since"]); x.link = cleanLink(m["link"]); x.agentSessionId = m["agent_session_id"].string; x.platform = m["platform"].string
      b.members[id] = x
    }

    for s in f["sessions"].array ?? [] {
      guard let dev = s["agent_device_id"].string else { continue }
      let x = b.sessionOf(s["session_id"].string ?? dev)
      x.agentDeviceId = dev; x.agentDeviceIds = [dev]; x.everAgentIds = [dev]
      x.agentSessionId = s["agent_session_id"].string; x.deviceName = s["device_name"].string ?? ""
      x.isActive = s["is_active"] != .bool(false); x.isOnline = s["is_online"].truthy; x.offlineSince = stampOf(s["offline_since"])
      x.link = cleanLink(s["link"]); x.heardUpTo = s["heard_up_to"].int; x.profile = s["profile"]; x.settings = s["settings"]
      x.sessionKeyEpoch = 1; x.withHistory = true
      x.statusLines = (s["status_lines"].array ?? []).map {
        StatusLine(id: $0["id"].string ?? "", label: $0["label"].string ?? "", state: $0["state"].string, detail: $0["detail"].string, objectId: $0["object_id"].string,
                   envelopeNumber: 0, updatedAt: u64($0["updated_at"]))
      }
      for l in x.statusLines { x.lastActivityAt = max(x.lastActivityAt, l.updatedAt) }
    }

    func answer(_ a: JV) -> Answer? {
      guard a.object != nil else { return nil }
      return Answer(answerAction: a["answer_action"].string ?? "answer", choices: strings(a["choices"]), note: a["note"].string,
                    optionNotes: (a["option_notes"].object ?? [:]).compactMapValues { $0.string }, attachments: a["attachments"].array ?? [], marks: a["marks"].array ?? [],
                    trusted: a["trusted"].truthy, boundObjectVersion: a["bound_object_version"].int ?? 1, envelopeNumber: a["envelope_number"].int, envelopeHash: a["envelope_hash"].string,
                    byDeviceId: a["by_device_id"].string ?? (b.myDeviceId ?? ""), answeredAt: u64(a["answered_at"]), takenBackAt: a["taken_back_at"].int, takenBackSentAt: nil)
    }
    for c in f["cards"].array ?? [] {
      guard let id = c["object_id"].string, let agent = c["agent_device_id"].string else { continue }
      let first = c["first_envelope_number"].int ?? c["envelope_number"].int ?? 0
      let rec = Rec(envelopeNumber: first, envelopeHash: "", senderDeviceId: agent, senderRole: "agent", recipientDeviceId: nil, sentAt: u64(c["created_at"]), kind: 0, isHead: true,
                    object: nil, timelineKind: nil, timelineId: nil, sessionId: c["session_id"].string, content: nil, contentState: "ok", bind: nil,
                    causal: Causal(senderDeviceId: agent, senderSequence: 0, sentAt: u64(c["created_at"]), lamport: 0), senderSequence: 0, epoch: 1, objectIdOk: true, localId: nil)
      let x = Card(id, agent: agent, rec: rec)
      x.objectState = c["object_state"].string ?? "open"; x.urgency = c["urgency"].string ?? "normal"
      for k in CARD_CONTENT_FIELDS where c.has(k) && !c[k].isNull { x.fields[k] = c[k] }
      x.objectVersion = c["object_version"].int ?? 1; x.versionHash = c["version_hash"].string; x.envelopeNumber = c["envelope_number"].int ?? first
      x.updatedAt = u64(c["updated_at"]); x.contentState = c["content_state"].string ?? "ok"; x.closedHow = c["closed_how"].string
      x.versions = (c["versions"].array ?? []).map {
        CardVersion(objectVersion: $0["object_version"].int ?? 1, versionHash: $0["version_hash"].string ?? "", previousVersionHash: $0["previous_version_hash"].string,
                    envelopeNumber: $0["envelope_number"].int ?? first, sentAt: u64($0["sent_at"]), objectState: $0["object_state"].string ?? "open",
                    urgency: $0["urgency"].string ?? "normal", content: $0["content"])
      }
      x.answer = answer(c["answer"]); x.answers = (c["answers"].array ?? []).compactMap(answer)
      if c["in_revision"].object != nil { x.inRevision = InRevision(by: c["in_revision"]["by"].string ?? "hand_back", envelopeNumber: c["in_revision"]["envelope_number"].int ?? 0) }
      b.cards[id] = x
      let s = b.sessionOf(x.sessionId ?? agent)
      if s.agentDeviceId == nil { s.agentDeviceId = agent; s.agentDeviceIds = [agent] }
      s.cardIds.append(id)
      if x.objectState == "open" { s.openCardIds.append(id) }
      s.lastActivityAt = max(s.lastActivityAt, x.updatedAt)
    }

    for p in f["permissions"].array ?? [] {
      guard let id = p["object_id"].string, let agent = p["agent_device_id"].string else { continue }
      let x = Permission(objectId: id, agentDeviceId: agent, sessionId: p["session_id"].string, toolName: p["tool_name"].string ?? "", description: p["description"].string ?? "",
                         inputPreview: p["input_preview"].string ?? "", expiresAt: u64(p["expires_at"]), versionHash: p["version_hash"].string ?? "",
                         envelopeNumber: p["envelope_number"].int ?? 0, sentAt: u64(p["sent_at"]))
      x.permissionState = p["permission_state"].string ?? "pending"
      if let v = p["verdict"].object { x.verdict = (v["allow"]?.truthy ?? false, v["by_device_id"]?.string ?? "", v["envelope_number"]?.int ?? 0) }
      b.permissions[id] = x
      if x.permissionState == "pending" { b.openPermissionIds.append(id) }
    }

    let NOTE_FIELDS: Set<String> = ["object_id", "by_device_id", "text", "object_version", "version_hash", "envelope_number", "object_state"]
    for n in f["notes"].array ?? [] {
      guard let id = n["object_id"].string else { continue }
      let extra = (n.object ?? [:]).filter { !NOTE_FIELDS.contains($0.key) }
      b.notes[id] = Note(objectId: id, byDeviceId: n["by_device_id"].string ?? "", text: n["text"].string ?? "", extra: extra, objectVersion: n["object_version"].int ?? 1,
                         versionHash: n["version_hash"].string ?? "", versionHashes: [n["version_hash"].string ?? ""], causal: nil, envelopeNumber: n["envelope_number"].int ?? 0,
                         objectState: n["object_state"].string ?? "open")
    }

    for p in f["published"].array ?? [] {
      guard let id = p["object_id"].string else { continue }
      b.published[id] = PublishedObject(objectId: id, agentDeviceId: p["agent_device_id"].string ?? "", sessionId: p["session_id"].string, attachments: p["attachments"].array ?? [],
                                        title: p["title"].string ?? "", note: p["note"].string, releasedUntil: p["released_until"], objectVersion: p["object_version"].int ?? 1,
                                        versionHash: p["version_hash"].string ?? "", envelopeNumber: p["envelope_number"].int ?? 0, objectState: p["object_state"].string ?? "open",
                                        sentAt: u64(p["sent_at"]))
    }

    for (key, items) in f["timelines"].object ?? [:] {
      let t = Timeline(key)
      for i in items.array ?? [] {
        guard let n = i["envelope_number"].int else { continue }
        t.items[n] = TimelineItem(envelopeNumber: n, localId: nil, pending: false, envelopeHash: i["envelope_hash"].string, senderDeviceId: i["sender_device_id"].string ?? "",
                                  senderSequence: i["sender_sequence"].int.flatMap { $0 > 0 ? UInt64($0) : nil }, recipientDeviceId: i["recipient_device_id"].string, sentAt: u64(i["sent_at"]), itemState: i["item_state"].string ?? "loaded",
                                  contentType: i["content_type"].string, content: i["content"])
        t.numbers.append(n)
        t.newestEnvelopeNumber = max(t.newestEnvelopeNumber, n)
        if b.members[i["sender_device_id"].string ?? ""]?.deviceRole == "human" { t.newestHumanEnvelopeNumber = max(t.newestHumanEnvelopeNumber, n) }
        else { t.newestAgentEnvelopeNumber = max(t.newestAgentEnvelopeNumber, n) }
        if t.kind == "chat", t.timelineId.hasPrefix("session/"), let s = b.sessions[t.objectId] { s.lastActivityAt = max(s.lastActivityAt, u64(i["sent_at"])) }
      }
      t.numbers.sort()
      t.itemCount = t.numbers.count
      t.loadedDownTo = t.numbers.first ?? Int.max
      b.timelines[key] = t
    }

    let h = f["human"]
    b.human.drafts = h["drafts"].object ?? [:]
    b.human.snoozes = h["snoozes"].object ?? [:]
    b.human.ducks = h["ducks"].object ?? [:]
    b.human.crown = h["crown"]
    b.human.desks = h["desks"].object ?? [:]
    b.human.sessionSettings = h["session_settings"].object ?? [:]
    for (k, v) in h["raw"].object ?? [:] { b.human.raw[k] = RegisterValue(value: v, envelopeNumber: 0) }
    return b
  }
}
