// RoomDevices.swift: the devices of the room, from this one: pair another device of the person (link or QR code,
// six emoji), invite an agent (its connector) or let one take a session over, remove devices, sign out.
//
// The steps and their order are spec/v2.md 12.1 (joining by link), 5.2.7 (a new human device into every live session
// group), 5.3 (takeover) and 9.0.10 (cuts). The core makes every Commit and checks every answer; this file fetches
// KeyPackages, posts what the core put into its outbox and waits for the hub's word before the next step.
import Foundation

/** The six numbers of a check code as the text the views pass around ("3-41-7-…"). */
func checkCodeText(_ numbers: [UInt8]) -> String { numbers.map { String($0) }.joined(separator: "-") }
/** The six emoji and their words for a check code (the list is the core's: `invite::CHECK_EMOJI`). */
public func checkEmoji(_ code: String) -> [(emoji: String, word: String)] {
  let numbers = code.split(separator: "-").compactMap { UInt8($0) }
  guard numbers.count == 6, Core.isInstalled else { return [] }
  return Core.tools.checkEmoji(numbers)
}
public func checkEmojiLine(_ code: String) -> String { checkEmoji(code).map { "\($0.emoji) \($0.word)" }.joined(separator: " · ") }

extension Room {
  public struct Pairing {
    public let inviteId: String      // hex
    public let link: String
    public let expiresAt: UInt64
    let invite: Bytes
    /** The check code to compare, once the newcomer's request came (see `checkEmoji`). */
    public var code: String? = nil
    public var newcomerId: String? = nil
    var numbers: [UInt8] = []
  }

  /** Runs one step that ends in an own Commit and waits until the hub took it (or refused it: thrown). */
  private func commit(_ step: @escaping (CoreDevice) throws -> UInt64?) async throws {
    let id: UInt64? = try await serial { [self] in
      if !self.synced { _ = try await self.catchUp() }
      let id = try await self.onCore(step)
      self.pumpOutbox()
      return id
    }
    if let id = id { try await awaitOutcome(id, ms: 20_000, orThrow: true) }
    _ = try? await serial { [self] in var ch = Change(); try await self.refreshGroups(&ch); self.emit(ch) }
  }

  private func openInvite(role: Int, session: SessionId?, app: String) async throws -> Pairing {
    try await serial { [self] in
      if !self.synced { _ = try await self.catchUp() }
      let hubURL = self.hubURL
      let made = try await self.onCore { try $0.openInvite(role: role, session: session, app: app, hub: hubURL, nowMs: nowMs()) }
      try await self.noted { try await self.hub.postInvite(offer: made.offer, signature: made.offerSignature) }
      return Pairing(inviteId: hex(made.invite), link: made.link, expiresAt: made.expiresAt, invite: made.invite)
    }
  }

  /** An invite link for a new human device (the QR code of "Pair a device"). It holds ten minutes, for one device. */
  public func createPairing(app: String = "https://app.trommi.com/join", ttlMs: UInt64 = 600_000) async throws -> Pairing {
    try await openInvite(role: ROLE.HUMAN, session: nil, app: app)
  }

  /** Looks for the newcomer's Request; on the first valid one: the Reveal is published and the check code is here. */
  public func checkPairing(_ p: inout Pairing) async throws -> Bool {
    if p.code != nil { return true }
    let r = try await noted { try await hub.getInviteRequests(p.invite) }
    let invite = p.invite
    for q in r["requests"] as? [JSON] ?? [] {
      guard let request = (q["request"] as? String).flatMap({ try? unb64u($0) }), let mac = (q["mac"] as? String).flatMap({ try? unb64u($0) }),
            let signature = (q["signature"] as? String).flatMap({ try? unb64u($0) }) else { continue }
      let accepted: InviteAccepted
      do { accepted = try await serial { [self] in try await self.onCore { try $0.acceptInviteRequest(invite: invite, request: request, mac: mac, signature: signature, nowMs: nowMs()) } } }
      catch let e as TrommiError where e.code == "invite-expired" { throw e }
      catch { continue }   // a Request that does not check uses nothing up (12.1.3)
      try await noted { try await hub.putInviteReveal(invite, reveal: accepted.reveal, signature: accepted.revealSignature) }
      p.numbers = accepted.numbers
      p.code = checkCodeText(accepted.numbers); p.newcomerId = hex(accepted.newDevice)
      return true
    }
    if nowMs() > p.expiresAt { throw TrommiError("invite-expired", "the invite has expired") }
    return false
  }

  private func burn(_ p: Pairing) async {
    let invite = p.invite
    _ = try? await serial { [self] in try await self.onCore { try $0.burnInvite(invite: invite) } }
    try? await hub.deleteInvite(invite)
  }

  /**
   * The human compared the emoji. A match adds the device to the room group (the core hands it the old keys), then
   * to every live session group; no match burns the invite and nobody is added.
   */
  public func confirmPairing(_ p: Pairing, matches: Bool) async throws {
    if !matches {
      await burn(p)
      throw TrommiError("code-mismatch", "the check codes do not match: nobody was added, the invite is spent")
    }
    guard p.code != nil, let newId = p.newcomerId.flatMap({ try? unhex($0) }) else { throw TrommiError("bad-invite", "this invite waits for no code") }
    let invite = p.invite, numbers = p.numbers
    // The code the human confirmed is the one this device showed, for the Request it accepted: the core checks both.
    try await commit { try $0.confirmInvite(invite: invite, numbers: numbers, nowMs: nowMs()) }
    try await addToSessions(newId)
  }
  /** A human device that is in the room group but not yet in a live session group: added there, with the old keys. */
  func addToSessions(_ device: DeviceId) async throws {
    for g in groups.values where g.session != nil && !g.archived && !g.leaves.contains(device) {
      // (5.2.7: every live session, with its old keys. A session it could not be added to is an error the caller
      // shows; calling this again goes on where it stopped, since it skips the groups the device is in.)
      guard let kp = try await noted({ try await hub.claimKeyPackages([device]) }).first?.keyPackage else { throw TrommiError("not-found", "the new device has no KeyPackage left at the hub") }
      let group = g.group
      try await commit { try $0.addToSession(group: group, device: device, keyPackage: kp, nowMs: nowMs()) }
      try await serial { [self] in _ = try await self.onCore { try $0.sendHandover(group: group, recipient: device) }; self.pumpOutbox() }
    }
  }

  // ---- agents --------------------------------------------------------------------------------------------

  public struct AgentInvite {
    public var pairing: Pairing
    public var label: String?
    public var desk: String?
    /** The session the new agent device takes over (5.3); nil: it gets a new session of its own. */
    public var takesOver: String?
  }
  /**
   * An invite link for an agent (the connector's command). Confirmed, it gets a new session on `desk`, or with
   * `takesOver` that session: the one tap that moves an agent's session to another machine.
   */
  public func createAgentInvite(app: String = "https://app.trommi.com/join", label: String? = nil, desk: String? = nil, takesOver: String? = nil) async throws -> AgentInvite {
    let session = try takesOver.map { try unhex($0) }
    return AgentInvite(pairing: try await openInvite(role: ROLE.AGENT, session: session, app: app), label: label, desk: desk, takesOver: takesOver)
  }
  /** The human confirmed the agent's emoji: it is enrolled and gets its session. Returns the session id. */
  @discardableResult public func confirmAgent(_ inv: AgentInvite, matches: Bool) async throws -> String {
    let p = inv.pairing
    if !matches {
      await burn(p)
      throw TrommiError("code-mismatch", "the check codes do not match: nobody was added, the invite is spent")
    }
    guard p.code != nil, let newId = p.newcomerId.flatMap({ try? unhex($0) }) else { throw TrommiError("bad-invite", "this invite waits for no code") }
    let invite = p.invite, numbers = p.numbers
    // (the `agents` change in the room group, 12.1.6)
    try await commit { try $0.confirmInvite(invite: invite, numbers: numbers, nowMs: nowMs()) }
    if let sid = inv.takesOver {
      try await takeOver(sessionId: sid, newAgent: newId)
      return sid
    }
    // A session group holds the agent device and EVERY human device (5.2.5): one KeyPackage of each, all or nothing.
    let others = (roomGroup.flatMap { groups[hex($0)]?.leaves } ?? []).filter { hex($0) != deviceIdHex }
    let claimed = try await noted { try await hub.claimKeyPackages([newId] + others) }
    guard claimed.count == others.count + 1 else { throw TrommiError("not-found", "a device has no KeyPackage left at the hub") }
    let (sid, founding): (SessionId, UInt64?) = try await serial { [self] in
      let r = try await self.onCore { d -> (SessionId, UInt64?) in
        let s = try d.foundSession(agent: newId, keyPackages: claimed.map(\.keyPackage), nowMs: nowMs())
        return (s, d.outbox().last(where: { $0.kind == .groupFounding })?.id)
      }
      self.pumpOutbox()
      return r
    }
    if let id = founding { try await awaitOutcome(id, ms: 20_000, orThrow: true) }
    _ = try? await serial { [self] in var ch = Change(); try await self.refreshGroups(&ch); self.emit(ch) }
    var place: [String: JV] = [:]
    if let l = inv.label, !l.isEmpty { place["name"] = .str(l) }
    if let d = inv.desk { place["desk"] = .str(d) }
    if !place.isEmpty { try? await editSession(hex(sid), place) }
    return hex(sid)
  }

  /**
   * Takeover (5.3): the session's old agent device leaves `agents`, then in the main session group and in every
   * helper session under it the old leaf is removed and the new device added in one Commit, with the old keys handed
   * over (history is the default).
   */
  public func takeOver(sessionId: String, newAgent: DeviceId) async throws {
    guard let main = sessionGroup(sessionId), let old = main.session?.agents.first else { throw TrommiError("not-found", "no such session") }
    if old != newAgent { try await commit { try $0.changeAgents(enrol: [], remove: [old], nowMs: nowMs()) } }
    let session = try unhex(sessionId)
    // The main session first: a helper session takes its new opener only once the main session has it (5.3.1 c).
    let affected = groups.values.filter { !$0.archived && ($0.session?.session == session || $0.session?.parent == session) }
      .sorted { ($0.session?.parent == nil ? 0 : 1) < ($1.session?.parent == nil ? 0 : 1) }
    for g in affected {
      guard let kp = try await noted({ try await hub.claimKeyPackages([newAgent]) }).first?.keyPackage else { throw TrommiError("not-found", "the new agent device has no KeyPackage left at the hub") }
      let group = g.group
      try await commit { device in
        let cuts = g.leaves.contains(old) ? [try device.cut(group: group, device: old)] : []
        return try device.cleanSession(group: group, cuts: cuts, replacement: (newAgent, kp), nowMs: nowMs())
      }
      try await serial { [self] in _ = try await self.onCore { try $0.sendHandover(group: group, recipient: newAgent) }; self.pumpOutbox() }
    }
  }

  // ---- removing, signing out -----------------------------------------------------------------------------

  /**
   * Removes devices: a human device from the room group and every session group, an agent device from `agents` and
   * its sessions. Each removal names the device's last envelope this device accepted (the cut, 9.0.10).
   */
  public func removeDevices(_ ids: [String]) async throws {
    let wanted = try ids.map { try unhex($0) }
    guard let room = roomGroup, let roomLeaves = groups[hex(room)]?.leaves else { throw TrommiError("no-key", "this device is in no room") }
    let humans = wanted.filter { roomLeaves.contains($0) }
    let agents = wanted.filter { !roomLeaves.contains($0) }
    if !humans.isEmpty { try await commit { device in try device.removeHumanDevices(try humans.map { try device.cut(group: room, device: $0) }, nowMs: nowMs()) } }
    if !agents.isEmpty { try await commit { try $0.changeAgents(enrol: [], remove: agents, nowMs: nowMs()) } }
    for g in groups.values where g.session != nil && !g.archived {
      let gone = wanted.filter { g.leaves.contains($0) }
      guard !gone.isEmpty else { continue }
      let group = g.group
      try await commit { device in try device.cleanSession(group: group, cuts: try gone.map { try device.cut(group: group, device: $0) }, replacement: nil, nowMs: nowMs()) }
    }
  }

  /**
   * Sign out. An MLS member cannot commit its own removal, so this device asks nothing of the group: it forgets its
   * state here, and its push registration at the hub. It stays a leaf until another device of the person removes it
   * (Settings → Devices), which the next device to sign in is told by the list it shows.
   */
  public func leaveRoom() async throws {
    _ = try? await flush(timeoutMs: 3000)
    _ = try? await hub.request("DELETE", "/push")
    await shutdown()
    Store.lifecycle.withLock { store.wipe() }
  }
  /** Forget this room on this device only. */
  public func forgetHere() {
    close()
    Store.lifecycle.withLock { store.wipe() }
  }
}
