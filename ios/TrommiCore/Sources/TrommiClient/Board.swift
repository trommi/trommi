// Board.swift: the board model and its reducer, a port of shared/model.mjs (shared/README.md "The model" is the
// contract). No crypto, no I/O: Room hands in verified, decoded records in hub order, and every client applies the same
// rules, so this device arrives at the same board as the web app. The names follow the JS model (snake_case fields
// become camelCase); every refusal code is the JS one.
import Foundation
import TrommiCore

public let ALERTS_MAX = 200
public let LAMPORT_MAX = 1 << 48
public let LAMPORT_STEP = 1 << 24
public let ASLEEP_MS: UInt64 = 10 * 60_000

public let OBJECT_STATE_NAME = [1: "open", 2: "answered", 3: "closed"]
public let OBJECT_STATE_CODE = ["open": 1, "answered": 2, "closed": 3]
public let URGENCY_NAME = [0: "low", 1: "normal", 2: "high", 3: "critical"]
public let URGENCY_CODE = ["low": 0, "normal": 1, "high": 2, "critical": 3]
public let TIMELINE_KIND_NAME = [1: "chat", 2: "canvas"]
public let CARD_CONTENT_FIELDS = ["card_type", "title", "teaser", "body", "options", "sections", "html", "allows_multiple", "recommended", "urgency_reason",
                                  "attachments", "change_note", "close_summary", "withdraw_reason", "merged_into_object_id", "merged_from_object_ids"]

// ---- the record: one verified envelope, as the reducer sees it ----------------------------------------

public struct Causal: Equatable, Codable {
  public var senderDeviceId: String
  public var senderSequence: UInt64
  public var sentAt: UInt64
  public var lamport: Int
  public var noBody = false
}

public enum DecodedBind: Equatable, Codable {
  case answer(cardId: String, versionHash: String, choices: [String])
  case decideAgain(cardId: String, previousHash: String, versionHash: String)
  case permissionRequest(requestId: String, expiresAt: UInt64)
  case verdict(requestId: String, requestHash: String, expiresAt: UInt64, allow: Bool)
}

public struct ObjectHead: Equatable, Codable {
  public var objectId: String
  public var objectState: Int
  public var urgency: Int
  public var answeredAt: UInt64
}

public struct Rec: Codable {
  public var envelopeNumber: Int
  public var envelopeHash: String
  public var senderDeviceId: String
  public var senderRole: String                 // "human" | "agent" | "unknown"
  public var recipientDeviceId: String?
  public var sentAt: UInt64
  public var kind: Int
  public var isHead: Bool
  public var object: ObjectHead?
  public var timelineKind: String?
  public var timelineId: String?
  public var sessionId: String?
  public var attachmentIds: [String] = []
  public var content: JV?
  public var contentState: String               // ok | newer_schema | undecryptable | pruned | header
  public var bind: DecodedBind?
  public var causal: Causal
  public var senderSequence: UInt64
  public var epoch: Int
  public var objectIdOk: Bool?
  public var localId: String?
  public var pending = false
}

// ---- the parts of the board ------------------------------------------------------------------------------

public struct AgentLink: Equatable {
  public var hears: String
  public var attached: Bool
  public var lastCallAt: UInt64?
  public var working: Bool
  public var since: UInt64?
  public var cutSince: UInt64?
  public var exitReason: String?
  public var exitClaude: String?
}
func stampOf(_ v: JV) -> UInt64? { if let i = v.int, i > 0 { return UInt64(i) }; return nil }
public func cleanLink(_ l: JV) -> AgentLink? {
  guard l.object != nil, let h = l["hears"].string, ["live", "oncall"].contains(h) else { return nil }
  let ex = l["exit"]
  let claude = ex.object != nil ? (["alive", "gone", "checking"].contains(ex["claude"].string ?? "") ? ex["claude"].string! : "gone") : nil
  return AgentLink(hears: h, attached: l["attached"] != .bool(false), lastCallAt: stampOf(l["last_call_at"]), working: l["working"] == .bool(true), since: stampOf(l["since"]),
              cutSince: stampOf(l["cut_since"]), exitReason: ex.object != nil ? String((ex["reason"].string ?? "").prefix(40)) : nil, exitClaude: claude)
}

public final class RoomMember {
  public let deviceId: String
  public var deviceRole: String
  public var fingerprint: String
  public var deviceName = ""
  public var platform: String?
  public var folder: String?
  public var host: String?
  public var isActive = true
  public var addedEntryNumber = 0
  public var removedEntryNumber: Int?
  public var isMe = false
  public var isOnline = false
  public var offlineSince: UInt64?
  public var link: AgentLink?
  public var agentSessionId: String?
  init(deviceId: String, role: String) {
    self.deviceId = deviceId; deviceRole = role
    let h = Array(deviceId.prefix(16))
    fingerprint = stride(from: 0, to: h.count, by: 4).map { String(h[$0..<min($0 + 4, h.count)]) }.joined(separator: " ")
  }
}

public struct StatusLine: Equatable {
  public var id: String
  public var label: String
  public var state: String?
  public var detail: String?
  public var objectId: String?
  public var envelopeNumber: Int
  public var updatedAt: UInt64
}

public struct RegisterValue {
  public var value: JV
  public var envelopeNumber: Int
  public var senderSequence: UInt64?
  public var byDeviceId: String?
  public var pending: Bool = false
  public var causal: Causal?
}

public final class Session {
  public let sessionId: String
  public var agentDeviceIds: [String] = []
  public var everAgentIds: [String] = []
  public var epochAgentIds: [Int: [String]] = [:]
  public var agentDeviceId: String?
  public var agentSessionId: String?
  public var deviceName = ""
  public var isActive = true
  public var isOnline = false
  public var offlineSince: UInt64?
  public var link: AgentLink?
  public var heardUpTo: Int?
  public var heardAt: UInt64?
  public var sessionKeyEpoch = 0
  public var withHistory = false
  public var createdByAgent = false
  public var creatorDeviceId: String?
  public var profile: JV = .null
  public var statusLines: [StatusLine] = []
  public var agentAlerts: [(key: String, value: JV, envelopeNumber: Int)] = []
  public var registers: [String: RegisterValue] = [:]
  public var settings: JV = .null
  public var cardIds: [String] = []
  public var openCardIds: [String] = []
  public var timelineKey: String
  public var lastActivityAt: UInt64 = 0
  init(_ id: String) { sessionId = id; timelineKey = timelineKeyOf("chat", "session/\(id)") }
}

public struct Option: Equatable {
  public var key: String
  public var label: String
  public var detail: String?
  public var final: Bool
  public var raw: JV
  public init(_ v: JV) {
    raw = v
    if let s = v.string { key = s; label = s; detail = nil; final = false; return }
    key = v["key"].string ?? ""
    label = v["label"].string ?? key
    detail = v["detail"].string
    final = v["final"] == .bool(true)
  }
}

public struct Answer {
  public var answerAction: String
  public var choices: [String]
  public var note: String?
  public var optionNotes: [String: String]
  public var attachments: [JV]
  public var marks: [JV]
  public var trusted: Bool
  public var boundObjectVersion: Int
  public var envelopeNumber: Int?
  public var envelopeHash: String?
  public var byDeviceId: String
  public var answeredAt: UInt64
  public var takenBackAt: Int?
  public var takenBackSentAt: UInt64?
  public var pending = false
}

public struct CardVersion {
  public var objectVersion: Int
  public var versionHash: String
  public var previousVersionHash: String?
  public var envelopeNumber: Int
  public var sentAt: UInt64
  public var objectState: String
  public var urgency: String
  public var content: JV?
}

public struct InRevision: Equatable { public var by: String; public var envelopeNumber: Int }

public final class Card {
  public let objectId: String
  public var agentDeviceId: String
  public var objectState = "open"
  public var urgency = "normal"
  /** The card's content fields (CARD_CONTENT_FIELDS), as the agent sent them: unknown ones are kept too. */
  public var fields: [String: JV] = [:]
  public var objectVersion = 0
  public var versionHash: String?
  public var envelopeNumber: Int
  public var firstEnvelopeNumber: Int
  public var createdAt: UInt64
  public var sessionId: String?
  public var updatedAt: UInt64
  public var versions: [CardVersion] = []
  public var answer: Answer?
  public var answers: [Answer] = []
  public var closedHow: String?
  public var inRevision: InRevision?
  public var timelineKey: String
  public var contentState = "ok"
  public var refusedHead: Int?
  /** A card of a newer Trommi (an unknown card_type, a newer schema): a placeholder, never answered from here. */
  public var unsupported = false
  init(_ id: String, agent: String, rec: Rec) {
    objectId = id; agentDeviceId = agent; envelopeNumber = rec.envelopeNumber; firstEnvelopeNumber = rec.envelopeNumber
    createdAt = rec.sentAt; sessionId = rec.sessionId; updatedAt = rec.sentAt; timelineKey = timelineKeyOf("chat", "card/\(id)")
  }
  public var cardType: String { fields["card_type"]?.string ?? "decision" }
  public var title: String { fields["title"]?.string ?? "" }
  public var teaser: String? { fields["teaser"]?.string }
  public var body: String? { fields["body"]?.string }
  public var html: String? { fields["html"]?.string }
  public var options: [Option] { (fields["options"]?.array ?? []).map(Option.init) }
  public var sections: [JV]? { fields["sections"]?.array }
  public var allowsMultiple: Bool { fields["allows_multiple"] == .bool(true) }
  public var recommended: [String] {
    guard let r = fields["recommended"] else { return [] }
    if let s = r.string { return [s] }
    return (r.array ?? []).compactMap { $0.string }
  }
  public var urgencyReason: String? { fields["urgency_reason"]?.string }
  public var attachments: [JV] { fields["attachments"]?.array ?? [] }
  public var changeNote: String? { fields["change_note"]?.string }
  public var closeSummary: String? { fields["close_summary"]?.string }
  public var withdrawReason: String? { fields["withdraw_reason"]?.string }
  public var mergedIntoObjectId: String? { fields["merged_into_object_id"]?.string }
  public var mergedFromObjectIds: [String] { (fields["merged_from_object_ids"]?.array ?? []).compactMap { $0.string } }
}

public final class Permission {
  public let objectId: String
  public var agentDeviceId: String
  public var sessionId: String?
  public var toolName: String
  public var description: String
  public var inputPreview: String
  public var expiresAt: UInt64
  public var versionHash: String
  public var envelopeNumber: Int
  public var sentAt: UInt64
  public var permissionState = "pending"
  public var verdict: (allow: Bool, byDeviceId: String, envelopeNumber: Int)?
  public var withdrawReason: String?
  init(objectId: String, agentDeviceId: String, sessionId: String?, toolName: String, description: String, inputPreview: String, expiresAt: UInt64, versionHash: String, envelopeNumber: Int, sentAt: UInt64) {
    self.objectId = objectId; self.agentDeviceId = agentDeviceId; self.sessionId = sessionId; self.toolName = toolName; self.description = description
    self.inputPreview = inputPreview; self.expiresAt = expiresAt; self.versionHash = versionHash; self.envelopeNumber = envelopeNumber; self.sentAt = sentAt
  }
}

public struct Note {
  public var objectId: String
  public var byDeviceId: String
  public var text: String
  /** Every field of the note's body (place, session, to, …: the app defines them). */
  public var extra: [String: JV]
  public var objectVersion: Int
  public var versionHash: String
  public var versionHashes: [String]
  public var causal: Causal?
  public var envelopeNumber: Int
  public var objectState: String
  public var pending = false
  public var localId: String?
  public var base: Box<Note>? = nil
}
/** A reference box (a note keeps the confirmed version under its own pending echo). */
public final class Box<T> { public var value: T; public init(_ v: T) { value = v } }

public struct PublishedObject {
  public var objectId: String
  public var agentDeviceId: String
  public var sessionId: String?
  public var attachments: [JV]
  public var title: String
  public var note: String?
  public var releasedUntil: JV
  public var objectVersion: Int
  public var versionHash: String
  public var envelopeNumber: Int
  public var objectState: String
  public var sentAt: UInt64
}

public struct TimelineItem {
  public var envelopeNumber: Int?
  public var localId: String?
  public var pending: Bool
  public var failed = false
  public var envelopeHash: String?
  public var senderDeviceId: String
  public var senderSequence: UInt64?
  public var recipientDeviceId: String?
  public var sentAt: UInt64
  /** loaded | header | pruned | undecryptable | newer_schema */
  public var itemState: String
  public var contentType: String?
  public var content: JV?
}

public final class Timeline {
  public let key: String
  public let kind: String
  public let timelineId: String
  public let objectId: String
  public var itemCount = 0
  public var newestEnvelopeNumber = 0
  public var newestHumanEnvelopeNumber = 0
  public var newestAgentEnvelopeNumber = 0
  /** The window: the items in memory, by envelope number (or a negative number for an own echo still in flight). */
  public var items: [Int: TimelineItem] = [:]
  /** Own echoes still on their way, by local id. */
  public var echoes: [String: TimelineItem] = [:]
  /** The envelope numbers of the items the hub holds (header-only items included), oldest first. */
  public var numbers: [Int] = []
  public var loadedDownTo = Int.max
  public var hasMore = false
  // (this app keeps every item header of a timeline: the window pages bodies in from GET threads)
  public var windowOpen = true
  init(_ key: String) {
    self.key = key
    let p = parseTimelineKey(key)
    kind = p.kind; timelineId = p.timelineId; objectId = p.scopeId
  }
  /** The items of the window, oldest first, the own echoes last. */
  public var ordered: [TimelineItem] { items.keys.sorted().compactMap { items[$0] } + echoes.values.sorted { $0.sentAt < $1.sentAt } }
}

public struct BoardAlert: Equatable {
  public var alertId: String
  public var code: String
  public var message: String
  public var envelopeNumber: Int?
  public var senderDeviceId: String?
  public var at: UInt64
  public var source: String
}

public struct HumanRegisters {
  public var drafts: [String: JV] = [:]
  public var snoozes: [String: JV] = [:]
  public var ducks: [String: JV] = [:]
  public var crown: JV = .null
  public var desks: [String: JV] = [:]
  public var sessionSettings: [String: JV] = [:]
  public var canvasSnapshots: [String: JV] = [:]
  public var raw: [String: RegisterValue] = [:]
}

/** What a batch touched (the views refresh only that). */
public struct Change {
  public var cards = Set<String>(), sessions = Set<String>(), permissions = Set<String>(), notes = Set<String>(), published = Set<String>()
  public var timelines = Set<String>(), registers = Set<String>(), invites = Set<String>()
  public var members = false, alerts = false, outbox = false, stack = false, room = false
  public init() {}
  public var isEmpty: Bool { cards.isEmpty && sessions.isEmpty && permissions.isEmpty && notes.isEmpty && published.isEmpty && timelines.isEmpty && registers.isEmpty && invites.isEmpty && !members && !alerts && !outbox && !stack && !room }
  public mutating func merge(_ o: Change) {
    cards.formUnion(o.cards); sessions.formUnion(o.sessions); permissions.formUnion(o.permissions); notes.formUnion(o.notes); published.formUnion(o.published)
    timelines.formUnion(o.timelines); registers.formUnion(o.registers); invites.formUnion(o.invites)
    members = members || o.members; alerts = alerts || o.alerts; outbox = outbox || o.outbox; stack = stack || o.stack; room = room || o.room
  }
}

public func timelineKeyOf(_ kind: String, _ id: String) -> String { "\(kind):\(id)" }
public func parseTimelineKey(_ key: String) -> (kind: String, timelineId: String, scope: String, scopeId: String) {
  let at = key.firstIndex(of: ":") ?? key.endIndex
  let kind = String(key[..<at]), id = at < key.endIndex ? String(key[key.index(after: at)...]) : ""
  let slash = id.firstIndex(of: "/") ?? id.endIndex
  return (kind, id, String(id[..<slash]), slash < id.endIndex ? String(id[id.index(after: slash)...]) : "")
}

/** R2: the one order of writes to a register or note: (lamport, sender_device_id, sender_sequence). */
public func compareWrites(_ x: Causal, _ y: Causal) -> Int {
  if x.lamport != y.lamport { return x.lamport < y.lamport ? -1 : 1 }
  if x.senderDeviceId != y.senderDeviceId { return x.senderDeviceId < y.senderDeviceId ? -1 : 1 }
  return x.senderSequence == y.senderSequence ? 0 : (x.senderSequence < y.senderSequence ? -1 : 1)
}
public func causallyAfter(_ x: Causal?, _ y: Causal?) -> Bool {
  guard let y = y else { return true }
  guard let x = x else { return false }
  return compareWrites(x, y) > 0
}
public func lamportOf(_ c: JV?) -> Int { if let l = c?["lamport"].int, l > 0, l <= LAMPORT_MAX { return l }; return 0 }
public func lamportAccepted(_ lamport: Int, _ seen: Int) -> Bool { lamport > 0 && lamport <= seen + LAMPORT_STEP }

/** Every choice is an option the agent marked final (and there is at least one). */
public func choicesFinal(_ card: Card?, _ choices: [String]) -> Bool {
  let final = Set((card?.options ?? []).filter { $0.final }.map { $0.key })
  return !choices.isEmpty && choices.allSatisfy { final.contains($0) }
}

/** The state of a member's or a session's link (model.mjs linkState). */
public struct LinkState: Equatable { public var state: String; public var since: UInt64?; public var idleMs: UInt64?; public var reason: String }
public func linkState(online: Bool, offlineSince: UInt64?, link l: AgentLink?, now: UInt64 = nowMs()) -> LinkState {
  if !online { return LinkState(state: l?.exitClaude == "alive" ? "cut" : "gone", since: offlineSince, idleMs: nil, reason: l?.exitReason ?? "") }
  if let c = l?.cutSince { return LinkState(state: "cut", since: c, idleMs: nil, reason: "folder") }
  if let l = l, !l.attached { return LinkState(state: "cut", since: l.since, idleMs: nil, reason: "detached") }
  guard let l = l, l.hears == "oncall" else { return LinkState(state: "live", since: nil, idleMs: nil, reason: "") }
  let last = l.lastCallAt ?? l.since
  let idle = last.map { now > $0 ? now - $0 : 0 }
  return LinkState(state: idle.map { $0 >= ASLEEP_MS } == true ? "asleep" : "oncall", since: last, idleMs: idle, reason: "")
}

// ---- the board ---------------------------------------------------------------------------------------------

public final class Board {
  public var roomId: String?
  public var hubURL: String?
  public var myDeviceId: String?
  public var myRole: String? = "human"
  public var keyEpoch = 0
  public var lastEntryNumber = -1
  public var lastEnvelopeNumber = 0
  public var connection = "offline"
  public var members: [String: RoomMember] = [:]
  public var sessions: [String: Session] = [:]
  public var cards: [String: Card] = [:]
  public var permissions: [String: Permission] = [:]
  public var notes: [String: Note] = [:]
  public var published: [String: PublishedObject] = [:]
  public var timelines: [String: Timeline] = [:]
  public var human = HumanRegisters()
  public var alerts: [BoardAlert] = []
  public var stack: [String] = []
  public var openPermissionIds: [String] = []
  /** What a newer client wrote that this version cannot show (model.mjs model.newer): how many, what, the newest. */
  public var newerCount = 0
  public var newerWhat: [String] = []
  public var newerEnvelope = 0
  func noteNewer(_ what: String, _ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    newerCount += 1
    if !newerWhat.contains(what) { newerWhat.append(what); if newerWhat.count > 16 { newerWhat.removeFirst() } }
    newerEnvelope = max(newerEnvelope, rec.envelopeNumber)
    change.room = true
    return (false, "needs-update")
  }
  var deviceRegisters: [String: JV] = [:]
  private var alertSeq = 0

  public init() {}

  // ---- members and sessions ----------------------------------------------------------------

  /** From the verified member list: (device id, role, active, added, removed). */
  public func applyMembers(_ list: [(id: String, role: String, active: Bool, added: Int, removed: Int?)], change: inout Change) {
    for m in list {
      let x = members[m.id] ?? RoomMember(deviceId: m.id, role: m.role)
      x.deviceRole = m.role
      if let reg = deviceRegisters[m.id] { x.deviceName = reg["device_name"].string ?? ""; x.platform = reg["platform"].string; x.folder = reg["folder"].string; x.host = reg["host"].string }
      x.isActive = m.active; x.addedEntryNumber = m.added; x.removedEntryNumber = m.removed; x.isMe = m.id == myDeviceId
      members[m.id] = x
      if m.role == "agent" { touchAgent(m.id, &change) }
    }
    change.members = true
  }
  /** GET devices: who is online, and the agents' links. */
  public func applyDevices(_ devices: [JV], change: inout Change) {
    for d in devices {
      guard let id = d["device_id"].string, let m = members[id] else { continue }
      m.isOnline = d["is_online"].truthy
      m.offlineSince = m.isOnline ? nil : stampOf(d["offline_since"])
      m.link = cleanLink(d["link"])
      if let s = d["agent_session_id"].string { m.agentSessionId = s }
      if m.deviceRole == "agent" { touchAgent(id, &change) }
    }
    change.members = true
  }
  /** A stream `presence` event for one device. */
  public func applyPresence(_ d: JV, change: inout Change) { applyDevices([d], change: &change) }

  public func sessionOf(_ id: String) -> Session {
    if let s = sessions[id] { return s }
    let s = Session(id)
    sessions[id] = s
    return s
  }
  private func syncSessionAgent(_ s: Session) {
    guard let a = s.agentDeviceId, let m = members[a] else { return }
    s.agentSessionId = m.agentSessionId ?? String(m.deviceId.prefix(16)); s.deviceName = m.deviceName; s.isActive = m.isActive
    s.isOnline = m.isOnline; s.offlineSince = m.offlineSince; s.link = m.link
  }
  private func touchAgent(_ id: String, _ change: inout Change) {
    for s in sessions.values where s.agentDeviceIds.contains(id) || s.agentDeviceId == id { syncSessionAgent(s); change.sessions.insert(s.sessionId) }
  }
  /** A verified grant chain state for one session. */
  public func applySessionGrant(_ st: SessionState, everAgentIds: [String] = [], epochAgentIds: [Int: [String]]? = nil, change: inout Change) {
    let s = sessionOf(st.sessionId)
    if let e = epochAgentIds { s.epochAgentIds = e }
    s.agentDeviceIds = st.agentIds
    for a in everAgentIds + s.agentDeviceIds where !s.everAgentIds.contains(a) { s.everAgentIds.append(a) }
    s.agentDeviceId = s.agentDeviceIds.first ?? s.agentDeviceId
    s.sessionKeyEpoch = st.epoch
    s.withHistory = st.withHistory
    s.createdByAgent = st.createdByAgent
    s.creatorDeviceId = st.creatorId
    syncSessionAgent(s)
    change.sessions.insert(s.sessionId)
    change.stack = true
  }

  /** The parent a session names in its profile, if it may (model.mjs parentSessionOf). */
  public func parentSessionOf(_ s: Session) -> String? {
    guard let want = s.profile["parent_session"].string, !want.isEmpty else { return nil }
    let parent = sessions[want]
    if s.createdByAgent { return parent.flatMap { $0 !== s && childOf($0, s) ? $0.sessionId : nil } }
    return parent?.sessionId ?? want
  }
  func childOf(_ parent: Session, _ s: Session) -> Bool { parent.agentDeviceIds.contains { $0 == s.creatorDeviceId || s.agentDeviceIds.contains($0) } }
  private func everAgent(_ sid: String?, _ device: String?) -> Bool {
    guard let sid = sid, let d = device else { return false }
    return sessions[sid]?.everAgentIds.contains(d) ?? false
  }
  /** B03/A7: may this agent write into session sid with this record? */
  private func agentAt(_ sid: String?, _ device: String?, _ rec: Rec?) -> Bool {
    guard let sid = sid, let s = sessions[sid], let device = device else { return false }
    if let rec = rec, rec.sessionId == sid, let at = s.epochAgentIds[rec.epoch] { return at.contains(device) }
    return s.everAgentIds.contains(device)
  }
  /** R1: who holds an object of a session, judged for one record. */
  private func holdsAt(sessionId: String?, creator: String, _ device: String?, _ rec: Rec?) -> Bool {
    guard let device = device else { return false }
    if device == creator { return true }
    guard let sid = sessionId, let rec = rec, rec.sessionId == sid else { return false }
    return agentAt(sid, device, rec) && !agentAt(sid, creator, rec)
  }
  /** Who holds a card now (whom a human addresses): its creator while assigned, else the session's agent. */
  public func holderOf(_ c: Card) -> String {
    let now = c.sessionId.flatMap { sessions[$0]?.agentDeviceIds } ?? []
    return now.isEmpty || now.contains(c.agentDeviceId) ? c.agentDeviceId : now[0]
  }

  // ---- alerts -------------------------------------------------------------------------------

  @discardableResult public func pushAlert(_ change: inout Change, code: String, message: String = "", envelopeNumber: Int? = nil, sender: String? = nil, source: String = "local") -> BoardAlert {
    alertSeq += 1
    let a = BoardAlert(alertId: "\(nowMs())-\(alertSeq)", code: code, message: message, envelopeNumber: envelopeNumber, senderDeviceId: sender, at: nowMs(), source: source)
    alerts.append(a)
    if alerts.count > ALERTS_MAX { alerts.removeFirst(alerts.count - ALERTS_MAX) }
    change.alerts = true
    return a
  }
  private func refuse(_ change: inout Change, _ rec: Rec, _ code: String, _ message: String) -> (applied: Bool, refused: String?) {
    pushAlert(&change, code: code, message: message, envelopeNumber: rec.envelopeNumber, sender: rec.senderDeviceId)
    return (false, code)
  }

  // ---- the reducer --------------------------------------------------------------------------

  @discardableResult public func apply(_ rec: Rec, change: inout Change) -> (applied: Bool, refused: String?) {
    if let sid = rec.sessionId, myRole == "agent", rec.senderDeviceId != myDeviceId, !everAgent(sid, myDeviceId) { return (false, nil) }
    if let sid = rec.sessionId {
      let s = sessionOf(sid)
      s.lastActivityAt = max(s.lastActivityAt, rec.sentAt)
      change.sessions.insert(sid)
    }
    var rec = rec
    if rec.contentState == "newer_schema" {
      _ = noteNewer("schema_version \(rec.content?["schema_version"].int ?? 0)", rec, &change)
      if rec.kind != KIND.TIMELINE_ITEM { rec.content = nil }
    } else if rec.kind == KIND.TIMELINE_ITEM, let ct = rec.content?["content_type"].string, !Compat.CONTENT_TYPES.contains(ct) {
      _ = noteNewer("content_type \(ct)", rec, &change)
    } else if rec.kind == KIND.ANSWER, let a = rec.content?["answer_action"].string, !Compat.ANSWER_ACTIONS.contains(a) {
      return noteNewer("answer_action \(a)", rec, &change)
    }
    switch rec.kind {
    case KIND.TIMELINE_ITEM: return applyTimelineItem(rec, &change)
    case KIND.OBJECT_VERSION: return applyObjectVersion(rec, &change)
    case KIND.ANSWER: return applyAnswer(rec, &change)
    case KIND.PERMISSION_REQUEST: return applyPermissionRequest(rec, &change)
    case KIND.VERDICT: return applyVerdict(rec, &change)
    case KIND.STATUS: return applyStatus(rec, &change)
    case KIND.DECIDE_AGAIN: return applyDecideAgain(rec, &change)
    default: return noteNewer("envelope kind \(rec.kind)", rec, &change)
    }
  }

  // ---- timelines ----------------------------------------------------------------------------

  public func timelineOf(_ key: String) -> Timeline {
    if let t = timelines[key] { return t }
    let t = Timeline(key)
    timelines[key] = t
    return t
  }
  public static func itemOf(_ rec: Rec) -> TimelineItem {
    let state: String
    if rec.content != nil { state = rec.contentState == "ok" ? "loaded" : rec.contentState }
    else { state = rec.contentState == "pruned" ? "pruned" : rec.contentState == "undecryptable" ? "undecryptable" : "header" }
    return TimelineItem(envelopeNumber: rec.envelopeNumber, localId: rec.localId, pending: false, envelopeHash: rec.envelopeHash, senderDeviceId: rec.senderDeviceId,
                        senderSequence: rec.senderSequence, recipientDeviceId: rec.recipientDeviceId, sentAt: rec.sentAt, itemState: state,
                        contentType: rec.content?["content_type"].string, content: rec.content)
  }
  /** R1: who may write into which timeline: nil if allowed, else a refusal code. */
  public func timelineRefusal(_ rec: Rec) -> String? {
    let p = parseTimelineKey(timelineKeyOf(rec.timelineKind ?? "", rec.timelineId ?? ""))
    let human = rec.senderRole == "human"
    if p.kind == "chat" {
      if p.scope == "session" {
        if let sid = rec.sessionId, sid != p.scopeId { return "not-allowed" }
        return agentAt(p.scopeId, rec.senderDeviceId, rec) || (human && everAgent(p.scopeId, rec.recipientDeviceId)) ? nil : "not-allowed"
      }
      if p.scope == "card" {
        guard let card = cards[p.scopeId] else { return "card-mismatch" }
        return holdsAt(sessionId: card.sessionId, creator: card.agentDeviceId, rec.senderDeviceId, rec) || (human && holdsAt(sessionId: card.sessionId, creator: card.agentDeviceId, rec.recipientDeviceId, rec)) ? nil : "not-allowed"
      }
      return "not-allowed"
    }
    if p.kind == "canvas" {
      if p.scope == "desk" { return human ? nil : "not-allowed" }
      if p.scope == "session" { return human || agentAt(p.scopeId, rec.senderDeviceId, rec) ? nil : "not-allowed" }
      if p.scope == "card" { return human || (cards[p.scopeId].map { holdsAt(sessionId: $0.sessionId, creator: $0.agentDeviceId, rec.senderDeviceId, rec) } ?? false) ? nil : "not-allowed" }
      return "not-allowed"
    }
    return nil
  }
  private func applyTimelineItem(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    if let why = timelineRefusal(rec) { return refuse(&change, rec, why, "not allowed in \(rec.timelineId ?? "")") }
    let key = timelineKeyOf(rec.timelineKind ?? "", rec.timelineId ?? "")
    let t = timelineOf(key)
    t.itemCount += 1
    t.newestEnvelopeNumber = max(t.newestEnvelopeNumber, rec.envelopeNumber)
    if rec.senderRole == "human" { t.newestHumanEnvelopeNumber = rec.envelopeNumber } else { t.newestAgentEnvelopeNumber = rec.envelopeNumber }
    if t.numbers.last.map({ $0 < rec.envelopeNumber }) ?? true { t.numbers.append(rec.envelopeNumber) } else if !t.numbers.contains(rec.envelopeNumber) { t.numbers.append(rec.envelopeNumber); t.numbers.sort() }
    // The window holds live items (they come in full) and items of opened timelines; an own echo is replaced in place.
    if rec.content != nil || t.windowOpen {
      if let l = rec.localId { t.echoes.removeValue(forKey: l) }
      t.items[rec.envelopeNumber] = Board.itemOf(rec)
    }
    change.timelines.insert(key)
    let p = parseTimelineKey(key)
    if p.kind == "chat" && p.scope == "card" {
      if let card = cards[p.scopeId] {
        let c = rec.content
        if c?["present_card"].truthy == true { card.inRevision = nil }
        else if rec.senderRole == "human", let c = c, c["hand_back"].truthy || c["explain"].truthy, card.objectState == "open" || card.answer?.pending == true {
          card.inRevision = InRevision(by: c["hand_back"].truthy ? "hand_back" : "explain", envelopeNumber: rec.envelopeNumber)
        }
        change.cards.insert(card.objectId)
        if let s = card.sessionId { change.sessions.insert(s) }
      }
    } else if p.scope == "session" { change.sessions.insert(p.scopeId) }
    return (true, nil)
  }

  // ---- objects ------------------------------------------------------------------------------

  private func stateOf(_ rec: Rec) -> (objectState: String, urgency: String) {
    (OBJECT_STATE_NAME[rec.object?.objectState ?? 1] ?? "open", URGENCY_NAME[rec.object?.urgency ?? 1] ?? "normal")
  }
  private func isZeroHash(_ h: String?) -> Bool { (h ?? "").allSatisfy { $0 == "0" } }

  private func applyObjectVersion(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    guard let objectId = rec.object?.objectId else { return refuse(&change, rec, "bad-object", "object version without object id") }
    let c = rec.content
    let type = c?["object_type"].string ?? (notes[objectId] != nil || rec.senderRole == "human" ? "note" : published[objectId] != nil ? "published" : "card")
    if c == nil && rec.contentState == "undecryptable" && myRole == "agent" && rec.senderRole == "human" { return (false, nil) }
    if type == "note" { return applyNote(rec, &change) }
    if type == "published" { return applyPublished(rec, &change) }
    if type != "card" { return noteNewer("object_type \(type)", rec, &change) }
    var card = cards[objectId]
    if rec.senderRole != "agent" { return refuse(&change, rec, "not-creator", "cards come from agents") }
    let fresh = card == nil
    if let card = card, !holdsAt(sessionId: card.sessionId, creator: card.agentDeviceId, rec.senderDeviceId, rec) { return refuse(&change, rec, "not-creator", "a card version from someone else than its creator") }
    if let sid = rec.sessionId, !agentAt(sid, rec.senderDeviceId, rec) { return refuse(&change, rec, "not-allowed", "a card in a session this agent is not assigned to") }
    if let card = card, card.sessionId != rec.sessionId { return refuse(&change, rec, "not-allowed", "a card version in another session") }
    if fresh && rec.objectIdOk == false { return refuse(&change, rec, "bad-object-id", "object id is not H(creator, sequence of version 1)") }
    if let c = c {
      let expected = (card?.objectVersion ?? 0) + 1
      if c["object_version"].int != expected { return refuse(&change, rec, "bad-version", "card version \(c["object_version"]), expected \(expected)") }
      if expected > 1 && c["previous_version_hash"].string != card?.versionHash { return refuse(&change, rec, "bad-version", "previous_version_hash does not name the current version") }
      if expected == 1, let p = c["previous_version_hash"].string, !p.isEmpty, !isZeroHash(p) { return refuse(&change, rec, "bad-version", "version 1 names a predecessor") }
    }
    if fresh {
      let n = Card(objectId, agent: rec.senderDeviceId, rec: rec)
      cards[objectId] = n
      card = n
      if let sid = rec.sessionId {
        let s = sessionOf(sid)
        var at = s.cardIds.count
        while at > 0 && (cards[s.cardIds[at - 1]]?.createdAt ?? 0) > n.createdAt { at -= 1 }
        s.cardIds.insert(objectId, at: at)
      }
    }
    let card2 = card!
    let st = stateOf(rec)
    let wasOpen = card2.objectState == "open"
    card2.objectState = st.objectState
    card2.urgency = st.urgency
    card2.envelopeNumber = rec.envelopeNumber
    card2.updatedAt = rec.sentAt
    card2.versionHash = rec.envelopeHash
    if let c = c, rec.contentState == "ok", let obj = c.object {
      var f: [String: JV] = [:]
      // Every field except the version bookkeeping: the known ones and whatever a newer agent added.
      for (k, v) in obj where !["schema_version", "object_type", "object_version", "previous_version_hash"].contains(k) { f[k] = v }
      card2.fields = f
      card2.objectVersion = c["object_version"].int ?? card2.objectVersion + 1
      card2.contentState = "ok"
      if case .unsupported(let kind) = Item.of(envelopeKind: KIND.OBJECT_VERSION, objectType: "card", cardType: f["card_type"]?.string ?? "decision") {
        card2.unsupported = true
        _ = noteNewer(kind, rec, &change)
      } else { card2.unsupported = false }
    } else {
      card2.objectVersion += 1
      card2.contentState = rec.contentState
    }
    card2.versions.append(CardVersion(objectVersion: card2.objectVersion, versionHash: rec.envelopeHash, previousVersionHash: c?["previous_version_hash"].string,
                                      envelopeNumber: rec.envelopeNumber, sentAt: rec.sentAt, objectState: st.objectState, urgency: st.urgency, content: c))
    card2.inRevision = nil
    if card2.objectState == "open" { card2.closedHow = nil; if !wasOpen && card2.answer != nil { card2.answer = nil } }
    else if card2.objectState == "closed" {
      card2.closedHow = card2.mergedIntoObjectId != nil ? "merged" : card2.withdrawReason != nil ? "withdrawn" : card2.answer?.answerAction == "read" ? "read" : card2.answer?.answerAction == "shred" ? "shredded" : "closed"
    } else if card2.objectState == "answered" { card2.closedHow = "answered" }
    change.cards.insert(objectId)
    if let s = card2.sessionId { change.sessions.insert(s) }
    change.stack = true
    return (true, nil)
  }

  private func applyNote(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    let objectId = rec.object!.objectId
    if rec.senderRole != "human" { return refuse(&change, rec, "not-creator", "notes come from human devices") }
    let c = rec.content ?? .obj([:])
    let cur = notes[objectId]
    let old: Note? = cur?.pending == true ? cur?.base?.value : cur
    if old == nil && rec.objectIdOk == false { return refuse(&change, rec, "bad-object-id", "object id is not H(creator, sequence of version 1)") }
    if let old = old, rec.content != nil, !old.versionHashes.contains(c["previous_version_hash"].string ?? "") { return refuse(&change, rec, "bad-version", "note previous_version_hash names no known version") }
    let after: Bool
    if let old = old, rec.content == nil || old.causal?.noBody == true { after = rec.envelopeNumber > old.envelopeNumber }
    else { after = causallyAfter(rec.causal, old?.causal) }
    if var o = old, !after {
      o.versionHashes.append(rec.envelopeHash)
      if cur?.pending == true, let l = rec.localId, l == cur?.localId { notes[objectId] = o; change.notes.insert(objectId) }
      else if cur?.pending == true { cur!.base!.value = o } else { notes[objectId] = o }
      return (false, nil)
    }
    let next = noteOf(objectId, rec, c, old)
    if var cur = cur, cur.pending, rec.localId != cur.localId {
      cur.base = Box(next)
      notes[objectId] = cur
      change.notes.insert(objectId)
      return (true, nil)
    }
    notes[objectId] = next
    change.notes.insert(objectId)
    return (true, nil)
  }
  private func noteOf(_ objectId: String, _ rec: Rec, _ c: JV, _ old: Note?) -> Note {
    var extra = c.object ?? [:]
    for k in ["schema_version", "object_type", "object_version", "previous_version_hash", "lamport"] { extra.removeValue(forKey: k) }
    var causal = rec.causal
    if rec.content == nil { causal.noBody = true }
    return Note(objectId: objectId, byDeviceId: rec.senderDeviceId, text: c["text"].string ?? old?.text ?? "", extra: extra,
                objectVersion: c["object_version"].int ?? (old?.objectVersion ?? 0) + 1, versionHash: rec.envelopeHash, versionHashes: (old?.versionHashes ?? []) + [rec.envelopeHash],
                causal: causal, envelopeNumber: rec.envelopeNumber, objectState: stateOf(rec).objectState)
  }

  private func applyPublished(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    let objectId = rec.object!.objectId
    let old = published[objectId]
    if rec.senderRole != "agent" { return refuse(&change, rec, "not-creator", "published objects come from agents") }
    if let sid = rec.sessionId, !agentAt(sid, rec.senderDeviceId, rec) { return refuse(&change, rec, "not-allowed", "a published object in a session this agent is not assigned to") }
    if let o = old, !holdsAt(sessionId: o.sessionId, creator: o.agentDeviceId, rec.senderDeviceId, rec) { return refuse(&change, rec, "not-creator", "a published object from someone else than its creator") }
    if old == nil && rec.objectIdOk == false { return refuse(&change, rec, "bad-object-id", "object id is not H(creator, sequence of version 1)") }
    let c = rec.content ?? .obj([:])
    let expected = (old?.objectVersion ?? 0) + 1
    if rec.content != nil && c["object_version"].int != expected { return refuse(&change, rec, "bad-version", "published version \(c["object_version"]), expected \(expected)") }
    if rec.content != nil, let o = old, let p = c["previous_version_hash"].string, !p.isEmpty, p != o.versionHash { return refuse(&change, rec, "bad-version", "previous_version_hash does not name the current version") }
    published[objectId] = PublishedObject(objectId: objectId, agentDeviceId: old?.agentDeviceId ?? rec.senderDeviceId, sessionId: rec.sessionId ?? old?.sessionId,
                                    attachments: c["attachments"].array ?? old?.attachments ?? [], title: c["title"].string ?? old?.title ?? "", note: c["note"].string,
                                    releasedUntil: c["released_until"], objectVersion: expected, versionHash: rec.envelopeHash, envelopeNumber: rec.envelopeNumber,
                                    objectState: stateOf(rec).objectState, sentAt: old?.sentAt ?? rec.sentAt)
    change.published.insert(objectId)
    if let s = rec.sessionId { change.sessions.insert(s) }
    return (true, nil)
  }

  // ---- answers --------------------------------------------------------------------------------

  public func answerRefusal(_ rec: Rec) -> String? {
    guard rec.senderRole == "human" else { return "not-human" }
    guard let card = rec.object.flatMap({ cards[$0.objectId] }) else { return "card-mismatch" }
    if !holdsAt(sessionId: card.sessionId, creator: card.agentDeviceId, rec.recipientDeviceId, rec) { return "not-for-owner" }
    guard case let .answer(cardId, versionHash, bound)? = rec.bind else {
      if rec.bind == nil && rec.content == nil && (rec.contentState == "pruned" || rec.contentState == "header") { return card.objectState == "open" ? nil : "card-closed" }
      return "card-mismatch"
    }
    if cardId != card.objectId { return "card-mismatch" }
    if card.objectState != "open" { return "card-closed" }
    if versionHash != card.versionHash { return "answer-stale" }
    guard let c = rec.content else { return nil }
    let action = c["answer_action"].string ?? ""
    if !["answer", "read", "shred"].contains(action) { return "bad-answer" }
    if card.contentState != "ok" { return nil }
    let choices = (c["choices"].array ?? []).compactMap { $0.string }
    if bound != choices { return "bad-answer" }
    if action == "answer" {
      let keys = Set(card.options.map { $0.key })
      if card.cardType == "info" { return "bad-answer" }
      if c["trusted"].truthy {
        if choices.contains(where: { !keys.contains($0) || !card.recommended.contains($0) }) { return "bad-choice" }
      } else if choices.isEmpty || choices.contains(where: { !keys.contains($0) }) { return "bad-choice" }
      if choices.count > 1 && !card.allowsMultiple { return "bad-choice" }
      if stateOf(rec).objectState == "closed" && (c["trusted"].truthy || !choicesFinal(card, choices)) { return "bad-answer" }
    }
    if action == "read" && card.cardType != "info" { return "bad-answer" }
    return nil
  }
  private func applyAnswer(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    if let why = answerRefusal(rec) {
      if let card = rec.object.flatMap({ cards[$0.objectId] }), rec.isHead, stateOf(rec).objectState != "open", rec.envelopeNumber > (card.refusedHead ?? 0), rec.envelopeNumber > card.envelopeNumber {
        card.refusedHead = rec.envelopeNumber; change.cards.insert(card.objectId)
      }
      return refuse(&change, rec, why, "answer not counted")
    }
    let card = cards[rec.object!.objectId]!
    let c = rec.content ?? .obj([:])
    var notesOf: [String: String] = [:]
    for (k, v) in c["option_notes"].object ?? [:] { if let s = v.string { notesOf[k] = s } }
    let a = Answer(answerAction: c["answer_action"].string ?? "answer", choices: (c["choices"].array ?? []).compactMap { $0.string }, note: c["note"].string, optionNotes: notesOf,
                   attachments: c["attachments"].array ?? [], marks: c["marks"].array ?? [], trusted: c["trusted"].truthy, boundObjectVersion: card.objectVersion,
                   envelopeNumber: rec.envelopeNumber, envelopeHash: rec.envelopeHash, byDeviceId: rec.senderDeviceId,
                   answeredAt: (rec.object?.answeredAt).flatMap { $0 > 0 ? $0 : nil } ?? rec.sentAt)
    card.answer = a
    card.answers.append(a)
    let st = stateOf(rec)
    card.objectState = st.objectState == "open" ? "answered" : st.objectState
    card.closedHow = a.answerAction == "read" ? "read" : a.answerAction == "shred" ? "shredded" : card.objectState == "closed" && rec.content != nil ? "settled" : "answered"
    card.inRevision = nil
    card.updatedAt = rec.sentAt
    change.cards.insert(card.objectId)
    if let s = card.sessionId { change.sessions.insert(s) }
    change.stack = true
    return (true, nil)
  }

  public func decideAgainRefusal(_ rec: Rec) -> String? {
    guard rec.senderRole == "human" else { return "not-human" }
    guard let card = rec.object.flatMap({ cards[$0.objectId] }) else { return "card-mismatch" }
    if !holdsAt(sessionId: card.sessionId, creator: card.agentDeviceId, rec.recipientDeviceId, rec) { return "not-for-owner" }
    guard case let .decideAgain(cardId, previousHash, versionHash)? = rec.bind, cardId == card.objectId else { return "card-mismatch" }
    guard let a = card.answer, a.envelopeHash == previousHash else { return "decision-mismatch" }
    if versionHash != card.versionHash { return "card-changed" }
    if card.objectState == "closed" && ["closed", "withdrawn", "merged"].contains(card.closedHow ?? "") { return "card-closed" }
    return nil
  }
  private func applyDecideAgain(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    if let why = decideAgainRefusal(rec) { return refuse(&change, rec, why, "decide again not counted") }
    let card = cards[rec.object!.objectId]!
    if let i = card.answers.lastIndex(where: { $0.envelopeHash == card.answer?.envelopeHash }) {
      card.answers[i].takenBackAt = rec.envelopeNumber; card.answers[i].takenBackSentAt = rec.sentAt
    }
    card.answer = nil
    card.objectState = "open"
    card.closedHow = nil
    card.updatedAt = rec.sentAt
    change.cards.insert(card.objectId)
    if let s = card.sessionId { change.sessions.insert(s) }
    change.stack = true
    return (true, nil)
  }

  // ---- permission requests ---------------------------------------------------------------------

  private func applyPermissionRequest(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    let objectId = rec.object?.objectId
    if rec.senderRole != "agent" { return refuse(&change, rec, "not-creator", "permission requests come from agents") }
    if let sid = rec.sessionId, !agentAt(sid, rec.senderDeviceId, rec) { return refuse(&change, rec, "not-allowed", "a permission request in a session this agent is not assigned to") }
    let known = objectId.flatMap { permissions[$0] }
    if let k = known, k.agentDeviceId == rec.senderDeviceId, OBJECT_STATE_NAME[rec.object?.objectState ?? 0] == "closed" {
      if k.permissionState != "pending" { return (false, nil) }
      k.permissionState = "withdrawn"
      k.withdrawReason = rec.content?["withdraw_reason"].string ?? ""
      change.permissions.insert(k.objectId)
      if let s = k.sessionId { change.sessions.insert(s) }
      change.stack = true
      return (true, nil)
    }
    guard let oid = objectId, known == nil else { return refuse(&change, rec, "bad-object", "permission request without a new object id") }
    var expires: UInt64 = 0
    if let b = rec.bind {
      guard case let .permissionRequest(rid, exp) = b, rid == oid else { return refuse(&change, rec, "bad-object", "request id differs from object id") }
      expires = exp
    }
    if rec.objectIdOk == false { return refuse(&change, rec, "bad-object-id", "object id is not H(creator, sequence)") }
    let c = rec.content ?? .obj([:])
    permissions[oid] = Permission(objectId: oid, agentDeviceId: rec.senderDeviceId, sessionId: rec.sessionId, toolName: c["tool_name"].string ?? "", description: c["description"].string ?? "",
                                  inputPreview: c["input_preview"].string ?? "", expiresAt: expires, versionHash: rec.envelopeHash, envelopeNumber: rec.envelopeNumber, sentAt: rec.sentAt)
    change.permissions.insert(oid)
    if let s = rec.sessionId { change.sessions.insert(s) }
    change.stack = true
    return (true, nil)
  }
  public func verdictRefusal(_ rec: Rec) -> String? {
    var rid: String? = rec.object?.objectId
    if case let .verdict(r, _, _, _)? = rec.bind { rid = rid ?? r }
    let p = rid.flatMap { permissions[$0] }
    guard rec.senderRole == "human" else { return "not-human" }
    guard let p = p, case let .verdict(requestId, requestHash, expiresAt, _)? = rec.bind, requestId == p.objectId else { return "request-mismatch" }
    if rec.recipientDeviceId != p.agentDeviceId { return "not-for-owner" }
    if p.permissionState != "pending" { return "request-not-pending" }
    if requestHash != p.versionHash || expiresAt != p.expiresAt { return "request-changed" }
    return nil
  }
  private func applyVerdict(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    if let why = verdictRefusal(rec) { return refuse(&change, rec, why, "verdict not counted") }
    guard case let .verdict(requestId, _, _, allow)? = rec.bind, let p = permissions[requestId] else { return (false, nil) }
    p.verdict = (allow, rec.senderDeviceId, rec.envelopeNumber)
    p.permissionState = allow ? "allowed" : "denied"
    change.permissions.insert(p.objectId)
    if let s = p.sessionId { change.sessions.insert(s) }
    change.stack = true
    return (true, nil)
  }

  // ---- registers --------------------------------------------------------------------------------

  static let humanPrefixes = ["draft/", "snooze/", "duck/", "desk/", "session/", "session_history/", "canvas_snapshot/"]
  public static func isHumanKey(_ k: String) -> Bool { k == "crown" || k == "room_snapshot" || humanPrefixes.contains { k.hasPrefix($0) } }
  public static func isAgentKey(_ k: String) -> Bool { k == "profile" || k == "heard" || k.hasPrefix("status_line/") || k.hasPrefix("alert/") }

  private func applyStatus(_ rec: Rec, _ change: inout Change) -> (applied: Bool, refused: String?) {
    guard let values = rec.content?["values"].object else {
      if rec.contentState == "ok" { return refuse(&change, rec, "bad-status", "status without values") }
      return (false, nil)
    }
    for key in values.keys.sorted() {
      let value = values[key]!
      if key.hasPrefix("device/") {
        if key != "device/\(rec.senderDeviceId)" { _ = refuse(&change, rec, "foreign-key", "\(key) from another device"); continue }
        deviceRegisters[rec.senderDeviceId] = value
        if let m = members[rec.senderDeviceId] {
          m.deviceName = value["device_name"].string ?? ""; m.platform = value["platform"].string; m.folder = value["folder"].string; m.host = value["host"].string
          change.members = true
          if m.deviceRole == "agent" { touchAgent(m.deviceId, &change) }
        }
        change.registers.insert(key)
      } else if rec.senderRole == "human" && Board.isHumanKey(key) {
        if myRole == "agent" { continue }
        setHumanRegister(key, value, rec, &change)
      } else if rec.senderRole == "agent" && Board.isAgentKey(key) {
        guard let sid = rec.sessionId, agentAt(sid, rec.senderDeviceId, rec) else { _ = refuse(&change, rec, "not-allowed", "\(key) outside the agent's session"); continue }
        setAgentRegister(sid, key, value, rec, &change)
      } else if (rec.senderRole == "agent" && Board.isHumanKey(key)) || (rec.senderRole == "human" && Board.isAgentKey(key)) {
        _ = refuse(&change, rec, "foreign-key", "\(key) is not a \(rec.senderRole) key")
      } else if rec.senderRole == "agent" {
        if let sid = rec.sessionId, agentAt(sid, rec.senderDeviceId, rec) { setAgentRegister(sid, key, value, rec, &change) }
      } else if myRole != "agent" {
        setHumanRegister(key, value, rec, &change)
      }
    }
    return (true, nil)
  }

  public func setHumanRegister(_ key: String, _ value: JV, _ rec: Rec, _ change: inout Change) {
    let old = human.raw[key]
    if !rec.pending, let old = old, !old.pending, let rc = old.causal, !causallyAfter(rec.causal, rc) { return }
    human.raw[key] = RegisterValue(value: value, envelopeNumber: rec.envelopeNumber, senderSequence: rec.senderSequence, byDeviceId: rec.senderDeviceId, pending: rec.pending, causal: rec.causal)
    let slash = key.firstIndex(of: "/")
    let prefix = slash.map { String(key[..<$0]) } ?? key
    let id = slash.map { String(key[key.index(after: $0)...]) } ?? ""
    func put(_ m: inout [String: JV]) { if value.isNull { m.removeValue(forKey: id) } else { m[id] = value } }
    switch prefix {
    case "draft": put(&human.drafts); change.cards.insert(id)
    case "snooze": put(&human.snoozes); change.cards.insert(id); change.stack = true
    case "duck": put(&human.ducks); change.cards.insert(id)
    case "crown": human.crown = value
    case "desk": put(&human.desks)
    case "session":
      put(&human.sessionSettings)
      let s = sessionOf(id); s.settings = value; change.sessions.insert(id); change.stack = true
    case "canvas_snapshot": put(&human.canvasSnapshots); change.timelines.insert(timelineKeyOf("canvas", id))
    default: break
    }
    change.registers.insert(key)
  }

  private func setAgentRegister(_ sid: String, _ key: String, _ value: JV, _ rec: Rec, _ change: inout Change) {
    let s = sessionOf(sid)
    if let old = s.registers[key] {
      if let oc = old.causal { if !causallyAfter(rec.causal, oc) { return } }
      else if let os = old.senderSequence, rec.senderSequence <= os { return }
    }
    s.registers[key] = RegisterValue(value: value, envelopeNumber: rec.envelopeNumber, senderSequence: rec.senderSequence, byDeviceId: rec.senderDeviceId, causal: rec.causal)
    if key == "profile" { s.profile = value }
    else if key == "heard" {
      if let up = value["up_to"].int, up >= 0, up >= (s.heardUpTo ?? -1) { s.heardUpTo = up; s.heardAt = stampOf(value["at"]) ?? rec.sentAt }
    } else if key.hasPrefix("status_line/") {
      let id = String(key.dropFirst("status_line/".count))
      let at = s.statusLines.firstIndex { $0.id == id }
      if value.isNull { if let at = at { s.statusLines.remove(at: at) } }
      else {
        let line = StatusLine(id: id, label: value["label"].string ?? id, state: value["state"].string, detail: value["detail"].string, objectId: value["object_id"].string,
                              envelopeNumber: rec.envelopeNumber, updatedAt: rec.sentAt)
        if let at = at { s.statusLines[at] = line } else { s.statusLines.append(line) }
      }
    } else if key.hasPrefix("alert/") {
      let at = s.agentAlerts.firstIndex { $0.key == key }
      if value.isNull { if let at = at { s.agentAlerts.remove(at: at) } }
      else {
        let a = (key: key, value: value, envelopeNumber: rec.envelopeNumber)
        if let at = at { s.agentAlerts[at] = a } else { s.agentAlerts.append(a) }
        pushAlert(&change, code: value["code"].string ?? "agent-alert", message: value["message"].string ?? "", envelopeNumber: rec.envelopeNumber, sender: rec.senderDeviceId, source: "agent")
      }
    }
    change.sessions.insert(sid)
    change.registers.insert(key)
  }

  // ---- projections ------------------------------------------------------------------------------

  static let urgencyRank = ["critical": 3, "high": 2, "normal": 1, "low": 0]
  /** The stack (open cards, the most urgent first, then the oldest), per-session open lists, open permissions. */
  public func project(now: UInt64 = nowMs()) {
    for s in sessions.values {
      s.cardIds.sort { (cards[$0]?.createdAt ?? 0, $0) < (cards[$1]?.createdAt ?? 0, $1) }
      s.openCardIds = s.cardIds.filter { cards[$0]?.objectState == "open" }
    }
    let archived = Set(sessions.values.filter { $0.settings["archived"].truthy }.map { $0.sessionId })
    let open = cards.values.filter { $0.objectState == "open" }.sorted { a, b in
      let ra = Board.urgencyRank[a.urgency] ?? 1, rb = Board.urgencyRank[b.urgency] ?? 1
      if ra != rb { return ra > rb }
      if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
      if a.agentDeviceId != b.agentDeviceId { return a.agentDeviceId < b.agentDeviceId }
      return a.objectId < b.objectId
    }
    stack = open.filter { c in
      if let v = human.snoozes[c.objectId], v.object != nil { if v["until"].isNull { return false }; if let u = v["until"].double, UInt64(max(0, u)) > now { return false } }
      if let sid = c.sessionId, archived.contains(sid) { return false }
      return true
    }.map { $0.objectId }
    openPermissionIds = permissions.values.filter { $0.permissionState == "pending" && now <= $0.expiresAt }.sorted { $0.envelopeNumber < $1.envelopeNumber }.map { $0.objectId }
  }
}
