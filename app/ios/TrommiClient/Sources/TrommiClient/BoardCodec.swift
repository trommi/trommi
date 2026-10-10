// BoardCodec.swift: the projected board as compact bytes (the device's board snapshot, RecordStore board.bin), so a
// launch reads the board instead of replaying every record. The same tag-length-value pieces as RecCodec. What is
// written: every stored field of the board's parts (BoardCodecTests counts them, so a new field cannot be forgotten),
// except what only exists in flight (own echoes, pending answers: a snapshot is only taken when nothing is pending).
// Conversation bodies are kept for the newest `bodiesKept` items of each chat timeline; older ones become headers and
// are read again from the record store (or the hub) when a window shows them. Scribble timelines keep all their bodies
// (the board's canvas is built from them).
import Foundation

enum BoardCodec {
  static let version: UInt8 = 3
  struct Bad: Error {}
  static let bookkeeping: Set<String> = ["schema_version", "object_type", "object_version", "previous_version_hash"]

  // ---- writing ----
  static func encode(_ b: Board, bodiesKept: Int = 60) -> [UInt8] {
    var w = RecCodec.W()
    encode(b, into: &w, bodiesKept: bodiesKept)
    return w.b
  }
  static func encode(_ b: Board, into w: inout RecCodec.W, bodiesKept: Int = 60) {
    w.b.reserveCapacity(1 << 20)
    w.b.append(version)
    w.os(b.roomId); w.os(b.hubURL); w.os(b.myDeviceId); w.os(b.myRole)
    w.i(b.keyEpoch); w.i(b.lastEntryNumber); w.i(b.lastEnvelopeNumber); w.s(b.connection)
    w.u(UInt64(b.members.count)); for m in b.members.values.sorted(by: { $0.deviceId < $1.deviceId }) { member(&w, m) }
    w.u(UInt64(b.sessions.count)); for s in b.sessions.values.sorted(by: { $0.sessionId < $1.sessionId }) { session(&w, s) }
    // cards and timelines in framed groups, read back on all cores
    let cs = b.cards.values.sorted(by: { $0.objectId < $1.objectId })
    framed(&w, stride(from: 0, to: cs.count, by: 400).map { i in { (g: inout RecCodec.W) in g.u(UInt64(min(400, cs.count - i))); for c in cs[i..<min(i + 400, cs.count)] { card(&g, c) } } })
    w.u(UInt64(b.permissions.count)); for p in b.permissions.values.sorted(by: { $0.objectId < $1.objectId }) { permission(&w, p) }
    w.u(UInt64(b.notes.count)); for k in b.notes.keys.sorted() { note(&w, b.notes[k]!) }
    w.u(UInt64(b.published.count)); for k in b.published.keys.sorted() { published(&w, b.published[k]!) }
    // timelines grouped by their item count (about 4,000 items a group; a big one alone)
    var groups = [[Timeline]](), cur = [Timeline](), size = 0
    for k in b.timelines.keys.sorted() { let t = b.timelines[k]!; cur.append(t); size += t.items.count + 1; if size >= 4000 { groups.append(cur); cur = []; size = 0 } }
    if !cur.isEmpty { groups.append(cur) }
    framed(&w, groups.map { g in { (x: inout RecCodec.W) in x.u(UInt64(g.count)); for t in g { timeline(&x, t, bodiesKept: bodiesKept) } } })
    human(&w, b.human)
    w.u(UInt64(b.alerts.count)); for a in b.alerts { alert(&w, a) }
    strs(&w, b.stack); strs(&w, b.openPermissionIds)
    w.i(b.newerCount); strs(&w, b.newerWhat); w.i(b.newerEnvelope)
    jvMap(&w, b.deviceRegisters)
    w.i(b.alertSeqValue)
  }
  /** Groups each written into its own frame (u length, bytes): they can be read in parallel. */
  private static func framed(_ w: inout RecCodec.W, _ groups: [(inout RecCodec.W) -> Void]) {
    w.u(UInt64(groups.count))
    for g in groups { var x = RecCodec.W(); g(&x); w.u(UInt64(x.b.count)); w.b += x.b }
  }
  /** The frames of a framed section: decoded on all cores, in order. */
  private static func unframe<T>(_ r: inout RecCodec.R, _ one: @escaping (inout RecCodec.R) throws -> T) throws -> [T] {
    let n = try count(&r)
    var spans = [Range<Int>]()
    for _ in 0..<n { let len = Int(try r.u()); guard len >= 0, r.at + len <= r.b.count else { throw Bad() }; spans.append(r.at..<(r.at + len)); r.at += len }
    var out = [[T]?](repeating: nil, count: n)
    let base = r.b
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: n) { i in
      var g = RecCodec.R(b: UnsafeBufferPointer(rebasing: base[spans[i]]))
      var got: [T]? = nil
      if let k = try? count(&g) {
        var list = [T](); list.reserveCapacity(k)
        var ok = true
        for _ in 0..<k { guard let x = try? one(&g) else { ok = false; break }; list.append(x) }
        if ok && g.at == g.b.count { got = list }
      }
      lock.lock(); out[i] = got; lock.unlock()
    }
    var all = [T]()
    for x in out { guard let x = x else { throw Bad() }; all += x }
    return all
  }
  private static func strs(_ w: inout RecCodec.W, _ a: [String]) { w.u(UInt64(a.count)); for x in a { w.s(x) } }
  private static func jvMap(_ w: inout RecCodec.W, _ m: [String: JV]) { w.u(UInt64(m.count)); for k in m.keys.sorted() { w.s(k); w.jv(m[k]!) } }
  private static func oi(_ w: inout RecCodec.W, _ v: Int?) { if let v = v { w.b.append(1); w.i(v) } else { w.b.append(0) } }
  private static func ou(_ w: inout RecCodec.W, _ v: UInt64?) { if let v = v { w.b.append(1); w.u(v) } else { w.b.append(0) } }
  private static func ojv(_ w: inout RecCodec.W, _ v: JV?) { if let v = v { w.b.append(1); w.jv(v) } else { w.b.append(0) } }
  private static func link(_ w: inout RecCodec.W, _ l: AgentLink?) {
    guard let l = l else { w.b.append(0); return }
    w.b.append(1); w.s(l.hears); w.bool(l.attached); ou(&w, l.lastCallAt); w.bool(l.working); ou(&w, l.since); ou(&w, l.cutSince); w.os(l.exitReason); w.os(l.exitClaude)
  }
  private static func causal(_ w: inout RecCodec.W, _ c: Causal?) {
    guard let c = c else { w.b.append(0); return }
    w.b.append(1); w.s(c.senderDeviceId); w.u(c.senderSequence); w.u(c.sentAt); w.i(c.lamport); w.bool(c.noBody)
  }
  private static func register(_ w: inout RecCodec.W, _ r: RegisterValue) {
    w.jv(r.value); w.i(r.envelopeNumber); ou(&w, r.senderSequence); w.os(r.byDeviceId); w.bool(r.pending); causal(&w, r.causal)
  }
  private static func member(_ w: inout RecCodec.W, _ m: RoomMember) {
    w.s(m.deviceId); w.s(m.deviceRole); w.s(m.fingerprint); w.s(m.deviceName); w.os(m.platform); w.os(m.folder); w.os(m.host)
    w.bool(m.isActive); w.i(m.addedEntryNumber); oi(&w, m.removedEntryNumber); w.bool(m.isMe); w.bool(m.isOnline); ou(&w, m.offlineSince)
    link(&w, m.link); w.os(m.agentSessionId)
  }
  private static func session(_ w: inout RecCodec.W, _ s: Session) {
    w.s(s.sessionId); strs(&w, s.agentDeviceIds); strs(&w, s.everAgentIds)
    w.u(UInt64(s.epochAgentIds.count)); for k in s.epochAgentIds.keys.sorted() { w.i(k); strs(&w, s.epochAgentIds[k]!) }
    w.os(s.agentDeviceId); w.os(s.agentSessionId); w.s(s.deviceName); w.bool(s.isActive); w.bool(s.isOnline); ou(&w, s.offlineSince)
    link(&w, s.link); oi(&w, s.heardUpTo); ou(&w, s.heardAt); w.i(s.sessionKeyEpoch); w.bool(s.withHistory); w.bool(s.createdByAgent)
    w.os(s.creatorDeviceId); w.os(s.parentSessionId); w.jv(s.profile)
    w.u(UInt64(s.statusLines.count))
    for l in s.statusLines { w.s(l.id); w.s(l.label); w.os(l.state); w.os(l.detail); w.os(l.objectId); w.i(l.envelopeNumber); w.u(l.updatedAt) }
    w.u(UInt64(s.agentAlerts.count)); for a in s.agentAlerts { w.s(a.key); w.jv(a.value); w.i(a.envelopeNumber) }
    w.u(UInt64(s.registers.count)); for k in s.registers.keys.sorted() { w.s(k); register(&w, s.registers[k]!) }
    w.jv(s.settings); strs(&w, s.cardIds); strs(&w, s.openCardIds); w.s(s.timelineKey); w.u(s.lastActivityAt)
  }
  private static func answer(_ w: inout RecCodec.W, _ a: Answer) {
    w.s(a.answerAction); strs(&w, a.choices); w.os(a.note)
    w.u(UInt64(a.optionNotes.count)); for k in a.optionNotes.keys.sorted() { w.s(k); w.s(a.optionNotes[k]!) }
    w.jv(.arr(a.attachments)); w.jv(.arr(a.marks)); w.bool(a.trusted); w.i(a.boundObjectVersion); oi(&w, a.envelopeNumber); w.os(a.envelopeHash)
    w.s(a.byDeviceId); w.u(a.answeredAt); oi(&w, a.takenBackAt); ou(&w, a.takenBackSentAt); w.bool(a.pending)
  }
  private static func card(_ w: inout RecCodec.W, _ c: Card) {
    w.s(c.objectId); w.s(c.agentDeviceId); w.s(c.objectState); w.s(c.urgency)
    // the fields are the newest version's content without its bookkeeping (Board.applyObjectVersion): not written twice
    let derived = c.versions.last?.content?.object.map { o in o.filter { !BoardCodec.bookkeeping.contains($0.key) } }
    if derived == c.fields { w.b.append(2) } else { w.b.append(1); jvMap(&w, c.fields) }
    w.i(c.objectVersion); w.os(c.versionHash)
    w.i(c.envelopeNumber); w.i(c.firstEnvelopeNumber); w.u(c.createdAt); w.os(c.sessionId); w.u(c.updatedAt)
    w.u(UInt64(c.versions.count))
    for v in c.versions { w.i(v.objectVersion); w.s(v.versionHash); w.os(v.previousVersionHash); w.i(v.envelopeNumber); w.u(v.sentAt); w.s(v.objectState); w.s(v.urgency); ojv(&w, v.content) }
    // the answer in force is mostly the newest of the answers: then only a mark
    if let a = c.answer, let l = c.answers.last, a.envelopeHash != nil, a.envelopeHash == l.envelopeHash, a.answeredAt == l.answeredAt, a.pending == l.pending, a.takenBackAt == l.takenBackAt { w.b.append(2) }
    else if let a = c.answer { w.b.append(1); answer(&w, a) } else { w.b.append(0) }
    w.u(UInt64(c.answers.count)); for a in c.answers { answer(&w, a) }
    w.os(c.closedHow)
    if let r = c.inRevision { w.b.append(1); w.s(r.by); w.i(r.envelopeNumber) } else { w.b.append(0) }
    w.s(c.timelineKey); w.s(c.contentState); oi(&w, c.refusedHead); w.bool(c.unsupported)
  }
  private static func permission(_ w: inout RecCodec.W, _ p: Permission) {
    w.s(p.objectId); w.s(p.agentDeviceId); w.os(p.sessionId); w.s(p.toolName); w.s(p.description); w.s(p.inputPreview); w.u(p.expiresAt)
    w.s(p.versionHash); w.i(p.envelopeNumber); w.u(p.sentAt); w.s(p.permissionState)
    if let v = p.verdict { w.b.append(1); w.bool(v.allow); w.s(v.byDeviceId); w.i(v.envelopeNumber) } else { w.b.append(0) }
    w.os(p.withdrawReason)
  }
  private static func note(_ w: inout RecCodec.W, _ n: Note) {
    w.s(n.objectId); w.s(n.byDeviceId); w.s(n.text); jvMap(&w, n.extra); w.i(n.objectVersion); w.s(n.versionHash); strs(&w, n.versionHashes)
    causal(&w, n.causal); w.i(n.envelopeNumber); w.s(n.objectState); w.bool(n.pending); w.os(n.localId)
    // (base: the confirmed version under a pending echo; a snapshot holds no pending echo)
  }
  private static func published(_ w: inout RecCodec.W, _ p: PublishedObject) {
    w.s(p.objectId); w.s(p.agentDeviceId); w.os(p.sessionId); w.jv(.arr(p.attachments)); w.s(p.title); w.os(p.note); w.jv(p.releasedUntil)
    w.i(p.objectVersion); w.s(p.versionHash); w.i(p.envelopeNumber); w.s(p.objectState); w.u(p.sentAt)
  }
  private static func timeline(_ w: inout RecCodec.W, _ t: Timeline, bodiesKept: Int) {
    w.s(t.key); w.i(t.itemCount); w.i(t.newestEnvelopeNumber); w.i(t.newestHumanEnvelopeNumber); w.i(t.newestAgentEnvelopeNumber)
    let numbers = t.items.keys.sorted()
    // a chat keeps the bodies of its newest items; the older ones are headers (read again when a window shows them)
    let keepFrom = t.kind == "chat" && numbers.count > bodiesKept ? numbers[numbers.count - bodiesKept] : Int.min
    var dropped = false
    // the devices of a timeline once, the items by their place in that list
    var ids = [String](), at = [String: Int]()
    for n in numbers { let it = t.items[n]!; for d in [it.senderDeviceId, it.recipientDeviceId ?? ""] where at[d] == nil { at[d] = ids.count; ids.append(d) } }
    strs(&w, ids)
    w.u(UInt64(numbers.count))
    var prev = 0
    for n in numbers {
      var it = t.items[n]!
      if n < keepFrom, it.itemState == "loaded" || it.itemState == "unsupported" { it.content = nil; it.itemState = "header"; dropped = true }
      item(&w, n - prev, it, at); prev = n
    }
    w.u(UInt64(t.numbers.count)); prev = 0; for n in t.numbers { w.i(n - prev); prev = n }
    w.i(dropped || t.loadedDownTo == Int.max ? -1 : t.loadedDownTo); w.bool(t.hasMore || dropped); w.bool(t.windowOpen)
  }
  private static func item(_ w: inout RecCodec.W, _ dn: Int, _ it: TimelineItem, _ ids: [String: Int]) {
    w.i(dn); oi(&w, it.envelopeNumber); w.os(it.localId); w.bool(it.pending); w.bool(it.failed); w.os(it.envelopeHash); w.u(UInt64(ids[it.senderDeviceId]!))
    ou(&w, it.senderSequence); w.u(UInt64(ids[it.recipientDeviceId ?? ""]!)); w.u(it.sentAt); w.s(it.itemState); w.os(it.contentType); ojv(&w, it.content)
  }
  private static func human(_ w: inout RecCodec.W, _ h: HumanRegisters) {
    jvMap(&w, h.drafts); jvMap(&w, h.snoozes); jvMap(&w, h.ducks); w.jv(h.crown); jvMap(&w, h.desks); jvMap(&w, h.sessionSettings); jvMap(&w, h.scribbleSnapshots)
    w.u(UInt64(h.raw.count)); for k in h.raw.keys.sorted() { w.s(k); register(&w, h.raw[k]!) }
  }
  private static func alert(_ w: inout RecCodec.W, _ a: BoardAlert) {
    w.s(a.alertId); w.s(a.code); w.s(a.message); oi(&w, a.envelopeNumber); w.os(a.senderDeviceId); w.u(a.at); w.s(a.source)
  }

  // ---- the chain heads with their kept hashes (beside the board in the snapshot) ----

  // ---- reading (into the board the room holds) ----
  static func decode(_ bytes: UnsafeBufferPointer<UInt8>, into b: Board) throws {
    var r = RecCodec.R(b: bytes)
    try decode(&r, into: b)
    guard r.at == bytes.count else { throw Bad() }
  }
  static func decode(_ r: inout RecCodec.R, into b: Board) throws {
    guard try r.byte() == version else { throw Bad() }
    b.roomId = try r.os(); b.hubURL = try r.os(); b.myDeviceId = try r.os(); b.myRole = try r.os()
    b.keyEpoch = try r.i(); b.lastEntryNumber = try r.i(); b.lastEnvelopeNumber = try r.i(); b.connection = try r.s()
    var members = [String: RoomMember](); for _ in 0..<(try count(&r)) { let m = try member(&r); members[m.deviceId] = m }
    var sessions = [String: Session](); for _ in 0..<(try count(&r)) { let s = try session(&r); sessions[s.sessionId] = s }
    var cards = [String: Card](); for c in try unframe(&r, { try card(&$0) }) { cards[c.objectId] = c }
    var perms = [String: Permission](); for _ in 0..<(try count(&r)) { let p = try permission(&r); perms[p.objectId] = p }
    var notes = [String: Note](); for _ in 0..<(try count(&r)) { let n = try note(&r); notes[n.objectId] = n }
    var pubs = [String: PublishedObject](); for _ in 0..<(try count(&r)) { let p = try published(&r); pubs[p.objectId] = p }
    var tls = [String: Timeline](); for t in try unframe(&r, { try timeline(&$0) }) { tls[t.key] = t }
    let h = try human(&r)
    var alerts = [BoardAlert](); for _ in 0..<(try count(&r)) { alerts.append(try alert(&r)) }
    let stack = try strs(&r), openPerms = try strs(&r)
    let newerCount = try r.i(), newerWhat = try strs(&r), newerEnvelope = try r.i()
    let devRegs = try jvMap(&r)
    let alertSeq = try r.i()
    b.members = members; b.sessions = sessions; b.cards = cards; b.permissions = perms; b.notes = notes; b.published = pubs; b.timelines = tls
    b.human = h; b.alerts = alerts; b.stack = stack; b.openPermissionIds = openPerms
    b.newerCount = newerCount; b.newerWhat = newerWhat; b.newerEnvelope = newerEnvelope; b.deviceRegisters = devRegs; b.alertSeqValue = alertSeq
    b.answerEchoes = [:]
  }
  private static func count(_ r: inout RecCodec.R) throws -> Int { let n = Int(try r.u()); guard n >= 0, n < 50_000_000 else { throw Bad() }; return n }
  private static func strs(_ r: inout RecCodec.R) throws -> [String] { var a = [String](); let n = try count(&r); a.reserveCapacity(n); for _ in 0..<n { a.append(try r.s()) }; return a }
  private static func jvMap(_ r: inout RecCodec.R) throws -> [String: JV] { var m = [String: JV](); for _ in 0..<(try count(&r)) { let k = try r.s(); m[k] = try r.jv() }; return m }
  private static func oi(_ r: inout RecCodec.R) throws -> Int? { try r.byte() == 0 ? nil : try r.i() }
  private static func ou(_ r: inout RecCodec.R) throws -> UInt64? { try r.byte() == 0 ? nil : try r.u() }
  private static func ojv(_ r: inout RecCodec.R) throws -> JV? { if try r.byte() == 0 { return Optional<JV>.none }; return try r.jv() }
  private static func link(_ r: inout RecCodec.R) throws -> AgentLink? {
    guard try r.byte() == 1 else { return nil }
    return AgentLink(hears: try r.s(), attached: try r.bool(), lastCallAt: try ou(&r), working: try r.bool(), since: try ou(&r), cutSince: try ou(&r), exitReason: try r.os(), exitClaude: try r.os())
  }
  private static func causal(_ r: inout RecCodec.R) throws -> Causal? {
    guard try r.byte() == 1 else { return nil }
    return Causal(senderDeviceId: try r.s(), senderSequence: try r.u(), sentAt: try r.u(), lamport: try r.i(), noBody: try r.bool())
  }
  private static func register(_ r: inout RecCodec.R) throws -> RegisterValue {
    RegisterValue(value: try r.jv(), envelopeNumber: try r.i(), senderSequence: try ou(&r), byDeviceId: try r.os(), pending: try r.bool(), causal: try causal(&r))
  }
  private static func member(_ r: inout RecCodec.R) throws -> RoomMember {
    let id = try r.s(), role = try r.s()
    let m = RoomMember(deviceId: id, role: role)
    m.fingerprint = try r.s(); m.deviceName = try r.s(); m.platform = try r.os(); m.folder = try r.os(); m.host = try r.os()
    m.isActive = try r.bool(); m.addedEntryNumber = try r.i(); m.removedEntryNumber = try oi(&r); m.isMe = try r.bool(); m.isOnline = try r.bool(); m.offlineSince = try ou(&r)
    m.link = try link(&r); m.agentSessionId = try r.os()
    return m
  }
  private static func session(_ r: inout RecCodec.R) throws -> Session {
    let s = Session(try r.s())
    s.agentDeviceIds = try strs(&r); s.everAgentIds = try strs(&r)
    for _ in 0..<(try count(&r)) { let k = try r.i(); s.epochAgentIds[k] = try strs(&r) }
    s.agentDeviceId = try r.os(); s.agentSessionId = try r.os(); s.deviceName = try r.s(); s.isActive = try r.bool(); s.isOnline = try r.bool(); s.offlineSince = try ou(&r)
    s.link = try link(&r); s.heardUpTo = try oi(&r); s.heardAt = try ou(&r); s.sessionKeyEpoch = try r.i(); s.withHistory = try r.bool(); s.createdByAgent = try r.bool()
    s.creatorDeviceId = try r.os(); s.parentSessionId = try r.os(); s.profile = try r.jv()
    for _ in 0..<(try count(&r)) {
      s.statusLines.append(StatusLine(id: try r.s(), label: try r.s(), state: try r.os(), detail: try r.os(), objectId: try r.os(), envelopeNumber: try r.i(), updatedAt: try r.u()))
    }
    for _ in 0..<(try count(&r)) { s.agentAlerts.append((key: try r.s(), value: try r.jv(), envelopeNumber: try r.i())) }
    for _ in 0..<(try count(&r)) { let k = try r.s(); s.registers[k] = try register(&r) }
    s.settings = try r.jv(); s.cardIds = try strs(&r); s.openCardIds = try strs(&r); s.timelineKey = try r.s(); s.lastActivityAt = try r.u()
    return s
  }
  private static func answer(_ r: inout RecCodec.R) throws -> Answer {
    let action = try r.s(), choices = try strs(&r), note = try r.os()
    var on = [String: String](); for _ in 0..<(try count(&r)) { let k = try r.s(); on[k] = try r.s() }
    return Answer(answerAction: action, choices: choices, note: note, optionNotes: on, attachments: try r.jv().array ?? [], marks: try r.jv().array ?? [],
                  trusted: try r.bool(), boundObjectVersion: try r.i(), envelopeNumber: try oi(&r), envelopeHash: try r.os(), byDeviceId: try r.s(),
                  answeredAt: try r.u(), takenBackAt: try oi(&r), takenBackSentAt: try ou(&r), pending: try r.bool())
  }
  private static func card(_ r: inout RecCodec.R) throws -> Card {
    let id = try r.s(), agent = try r.s()
    let c = Card(snapshot: id, agent: agent)
    c.objectState = try r.s(); c.urgency = try r.s()
    let fieldsMark = try r.byte()
    if fieldsMark == 1 { c.fields = try jvMap(&r) } else if fieldsMark != 2 { throw Bad() }
    c.objectVersion = try r.i(); c.versionHash = try r.os()
    c.envelopeNumber = try r.i(); c.firstEnvelopeNumber = try r.i(); c.createdAt = try r.u(); c.sessionId = try r.os(); c.updatedAt = try r.u()
    for _ in 0..<(try count(&r)) {
      c.versions.append(CardVersion(objectVersion: try r.i(), versionHash: try r.s(), previousVersionHash: try r.os(), envelopeNumber: try r.i(), sentAt: try r.u(),
                                    objectState: try r.s(), urgency: try r.s(), content: try ojv(&r)))
    }
    if fieldsMark == 2 { c.fields = (c.versions.last?.content?.object ?? [:]).filter { !BoardCodec.bookkeeping.contains($0.key) } }
    let answerMark = try r.byte()
    c.answer = answerMark == 1 ? try answer(&r) : nil
    for _ in 0..<(try count(&r)) { c.answers.append(try answer(&r)) }
    if answerMark == 2 { c.answer = c.answers.last }
    c.closedHow = try r.os()
    c.inRevision = try r.byte() == 1 ? InRevision(by: try r.s(), envelopeNumber: try r.i()) : nil
    c.timelineKey = try r.s(); c.contentState = try r.s(); c.refusedHead = try oi(&r); c.unsupported = try r.bool()
    return c
  }
  private static func permission(_ r: inout RecCodec.R) throws -> Permission {
    let p = Permission(objectId: try r.s(), agentDeviceId: try r.s(), sessionId: try r.os(), toolName: try r.s(), description: try r.s(), inputPreview: try r.s(),
                       expiresAt: try r.u(), versionHash: try r.s(), envelopeNumber: try r.i(), sentAt: try r.u())
    p.permissionState = try r.s()
    p.verdict = try r.byte() == 1 ? (allow: try r.bool(), byDeviceId: try r.s(), envelopeNumber: try r.i()) : nil
    p.withdrawReason = try r.os()
    return p
  }
  private static func note(_ r: inout RecCodec.R) throws -> Note {
    Note(objectId: try r.s(), byDeviceId: try r.s(), text: try r.s(), extra: try jvMap(&r), objectVersion: try r.i(), versionHash: try r.s(), versionHashes: try strs(&r),
         causal: try causal(&r), envelopeNumber: try r.i(), objectState: try r.s(), pending: try r.bool(), localId: try r.os())
  }
  private static func published(_ r: inout RecCodec.R) throws -> PublishedObject {
    PublishedObject(objectId: try r.s(), agentDeviceId: try r.s(), sessionId: try r.os(), attachments: try r.jv().array ?? [], title: try r.s(), note: try r.os(),
                    releasedUntil: try r.jv(), objectVersion: try r.i(), versionHash: try r.s(), envelopeNumber: try r.i(), objectState: try r.s(), sentAt: try r.u())
  }
  private static func timeline(_ r: inout RecCodec.R) throws -> Timeline {
    let t = Timeline(try r.s())
    t.itemCount = try r.i(); t.newestEnvelopeNumber = try r.i(); t.newestHumanEnvelopeNumber = try r.i(); t.newestAgentEnvelopeNumber = try r.i()
    let ids = try strs(&r)
    func id(_ r: inout RecCodec.R) throws -> String { let i = Int(try r.u()); guard i < ids.count else { throw Bad() }; return ids[i] }
    let n = try count(&r)
    t.items.reserveCapacity(n)
    var prev = 0
    for _ in 0..<n {
      prev += try r.i()
      let num = try oi(&r), lid = try r.os(), pending = try r.bool(), failed = try r.bool(), eh = try r.os(), sender = try id(&r)
      let seq = try ou(&r), rcp = try id(&r)
      t.items[prev] = TimelineItem(envelopeNumber: num, localId: lid, pending: pending, failed: failed, envelopeHash: eh, senderDeviceId: sender, senderSequence: seq,
                                   recipientDeviceId: rcp.isEmpty ? nil : rcp, sentAt: try r.u(), itemState: try r.s(), contentType: try r.os(), content: try ojv(&r))
    }
    let m = try count(&r); prev = 0
    t.numbers.reserveCapacity(m)
    for _ in 0..<m { prev += try r.i(); t.numbers.append(prev) }
    let down = try r.i(); t.loadedDownTo = down < 0 ? Int.max : down
    t.hasMore = try r.bool(); t.windowOpen = try r.bool()
    return t
  }
  private static func human(_ r: inout RecCodec.R) throws -> HumanRegisters {
    var h = HumanRegisters()
    h.drafts = try jvMap(&r); h.snoozes = try jvMap(&r); h.ducks = try jvMap(&r); h.crown = try r.jv(); h.desks = try jvMap(&r); h.sessionSettings = try jvMap(&r)
    h.scribbleSnapshots = try jvMap(&r)
    for _ in 0..<(try count(&r)) { let k = try r.s(); h.raw[k] = try register(&r) }
    return h
  }
  private static func alert(_ r: inout RecCodec.R) throws -> BoardAlert {
    BoardAlert(alertId: try r.s(), code: try r.s(), message: try r.s(), envelopeNumber: try oi(&r), senderDeviceId: try r.os(), at: try r.u(), source: try r.s())
  }
}
