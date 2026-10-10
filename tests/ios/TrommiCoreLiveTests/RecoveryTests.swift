// Recovery and signing in on a new device (spec/v1.md section 8) with the real core and no hub: `PocketHub` keeps
// what a hub would keep (the log and the envelopes in one order, every GroupInfo, the SealedKeys, the RecoveryLinks)
// and serves it back. It checks nothing: the core does.
import Foundation
import XCTest
import TrommiClient
@testable import TrommiCoreLive

/// One outbox entry with its kind as the number of core/src/store.rs.
typealias Posted = (id: UInt64, kind: UInt8, group: GroupId?, epoch: UInt64, parts: [Bytes])

final class PocketHub {
  var change: UInt64 = 0
  var log: [LogEntry] = []
  /// Per group every GroupInfo, by epoch.
  var infos: [GroupId: [UInt64: Bytes]] = [:]
  var sealedKeys: [Bytes] = []
  var links: [Bytes] = []
  var welcomes: [Bytes] = []
  /// The stored envelopes, by the change number each took: one order with the log's entries.
  var envelopes: [(change: UInt64, bytes: Bytes)] = []
  /// What became of the envelopes the last `deliver` handed over.
  var received: [ReceivedEnvelope] = []
  /// The fifth part of the last `recoveryCode`, or the second of the last `recoveryFinish`.
  var account: Bytes?
  /// The kinds posted, in order.
  var kinds: [UInt8] = []
  /// The envelopes with the group and the sender of each, where the poster named them: what the chain route serves.
  var chains: [(change: UInt64, bytes: Bytes, group: GroupId, sender: DeviceId)] = []
  /// Held while a request is answered: `Room` posts from its own tasks (PocketRoutes.swift).
  let lock = NSRecursiveLock()

  static func waiting(_ device: CoreDevice) -> [Posted] {
    device.outbox().map { ($0.id, $0.kind.rawValue, $0.group, $0.epoch, $0.parts) }
  }

  /// Takes everything in the device's outbox, in order, and reports each entry as accepted. The answer merges no
  /// Commit: what the hub took comes back to the device in the hub's order (`deliver`), and there its own Commits
  /// take effect. What the device queues on that is posted too, until nothing waits.
  func post(_ device: CoreDevice) throws {
    repeat {
      try postWaiting(device)
      try deliver(to: device)
    } while !Self.waiting(device).isEmpty
  }

  /// Posts what waits and reports each entry as accepted, without handing anything back from the log.
  func postWaiting(_ device: CoreDevice) throws {
    while let entry = Self.waiting(device).first {
      try device.outboxAccepted(entry.id, change: take(kind: entry.kind, group: entry.group ?? [], epoch: entry.epoch, parts: entry.parts, sender: device.id))
    }
  }

  /// Keeps one posted entry as a hub would (it checks nothing) and gives the change number its answer names, if it
  /// names one. `sender`: the posting device, for the chain an envelope belongs to.
  func take(kind: UInt8, group: GroupId, epoch: UInt64, parts: [Bytes], sender: DeviceId = []) -> UInt64? {
    lock.lock(); defer { lock.unlock() }
    func part(_ at: Int) -> Bytes { at < parts.count ? parts[at] : [] }
    kinds.append(kind)
    // A Commit with its GroupInfo, Welcome, SealedKey and RecoveryAuth, wherever its kind keeps them.
    var commit: (bytes: Bytes, groupInfo: Bytes, welcome: Bytes, sealedKey: Bytes, recoveryAuth: Bytes)?
    var accepted: UInt64?
    switch kind {
    case 1:   // room founding: GroupInfo 0, SealedKey 0. The hub answers with the room id, not a change number.
      infos[group] = [0: part(0)]
      sealedKeys.append(part(1))
    case 2:   // session founding
      infos[group] = [0: part(0)]
      sealedKeys.append(part(1))
      commit = (part(2), part(3), part(4), part(5), [])
    case 3: commit = (part(0), part(1), part(2), part(3), [])
    case 4: commit = (part(0), part(1), [], part(2), part(3))
    case 5:
      change += 1
      accepted = change
      log.append(LogEntry(change: change, group: group, kind: .message(bytes: part(0))))
    case 7:
      change += 1
      accepted = change
      envelopes.append((change, part(0)))
      chains.append((change, part(0), group, sender))
    case 9: sealedKeys.append(part(0))
    case 10:
      commit = (part(0), part(1), [], part(2), [])
      links.append(part(3))
      account = part(4)
    case 11: commit = (part(0), part(1), part(2), part(3), part(4))
    case 12:
      links.append(part(0))
      account = part(1)
      accepted = change
    default: break   // a relayed message, KeyPackages: nothing is kept
    }
    if let commit {
      change += 1
      // (the real hub gives a Commit of a recovery no number of its own: its finish names the last)
      if kind != 11 { accepted = change }
      infos[group, default: [:]][epoch + 1] = commit.groupInfo
      sealedKeys.append(commit.sealedKey)
      if !commit.welcome.isEmpty { welcomes.append(commit.welcome) }
      log.append(LogEntry(change: change, group: group, kind: .commit(bytes: commit.bytes, recoveryAuth: commit.recoveryAuth.isEmpty ? nil : commit.recoveryAuth)))
    }
    return accepted
  }

  /// A group from its founding, as GET …/info?epoch=0, …/log and …/info give it.
  func served(_ group: GroupId) throws -> LiveServedGroup {
    let all = try XCTUnwrap(infos[group])
    var commits = [(change: UInt64, commit: Bytes, recoveryAuth: Bytes?)]()
    for entry in log where entry.group == group {
      if case .commit(let bytes, let recoveryAuth) = entry.kind { commits.append((entry.change, bytes, recoveryAuth)) }
    }
    return (try XCTUnwrap(all[0]), commits, try XCTUnwrap(all[all.keys.max() ?? 0]))
  }

  /// The room as a device that comes with `code` reads it.
  func served(room: RoomId, code: Bytes, sessions: [GroupId] = [], tools: LiveCore) throws -> LiveServedRoom {
    let anchor = try tools.recoveryAnchor(code: code, room: room, sealedKeys: sealedKeys)
    XCTAssertEqual(anchor.group, room)
    return (room, try served(room), try XCTUnwrap(infos[room]?[anchor.epoch]), sealedKeys, links, try sessions.map(served))
  }

  /// Hands the device everything above its cursor, strictly by change number: the log's entries (its own accepted
  /// Commits among them) and the stored envelopes. An entry behind what the device holds (a group's Commits from
  /// before it joined) is passed over, as the client does. Returns what the log's entries did; `received` holds
  /// what became of the envelopes.
  @discardableResult func deliver(to device: CoreDevice) throws -> [Processed] {
    var done = [Processed]()
    received = []
    let cursor = device.cursor
    var stored = envelopes.filter { $0.change > cursor }[...]
    func handEnvelopes(before change: UInt64) throws {
      while let next = stored.first, next.change < change {
        received.append(try device.receiveEnvelope(next.bytes, change: next.change, ordered: true, voidCode: nil, nowMs: nowMs()))
        stored = stored.dropFirst()
      }
    }
    for entry in log where entry.change > cursor {
      try handEnvelopes(before: entry.change)
      do { done.append(try device.processLogEntry(entry)) }
      catch where device.logFinding(error) == .duplicate {}
    }
    try handEnvelopes(before: .max)
    return done
  }
}

final class RecoveryTests: XCTestCase {
  let tools = LiveCore()

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }

  /// A new device joins the room group with the code, as LiveCore.joinRoomWithRecoveryCode does it against a hub.
  private func join(_ device: LiveDevice, code: Bytes, room: RoomId, hub: PocketHub) throws {
    let joined = try device.joinRoomWithCode(code, served: try hub.served(room: room, code: code, tools: tools), nowMs: nowMs())
    XCTAssertEqual(joined.outbox.count, 1)
    XCTAssertNil(joined.missingLink)
    try hub.post(device)
  }

  /// The recovery key signs in to the hub as itself: its id is the key the room names, and the signed bytes carry it.
  func testTheRecoveryKeySignsIn() throws {
    let code = try tools.generateRecoveryCode()
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: code, nowMs: nowMs())
    let signer = try tools.recoverySigner(code: code)
    XCTAssertEqual(signer.id, try a.recoveryKeys()?.signatureKey)
    XCTAssertNotEqual(signer.id, a.id)
    let challenge = systemRandom(32)
    let signed = try signer.signHubAuth(room: room, hub: "https://hub.example", challenge: challenge)
    XCTAssertEqual(signed.signature.count, 64)
    // HubAuth: room, the hub's address behind its length, the signer, the challenge.
    XCTAssertEqual(Bytes(signed.auth.prefix(32)), room)
    XCTAssertEqual(Bytes(signed.auth.suffix(64)), signer.id + challenge)
    XCTAssertNotEqual(try tools.recoverySigner(code: try tools.generateRecoveryCode()).id, signer.id)
    XCTAssertEqual(refusedCode { _ = try self.tools.recoverySigner(code: [1, 2, 3]) }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try signer.signHubAuth(room: room, hub: "https://Hub.example/", challenge: challenge) }, "bad-format")
  }

  /// A founds a room with code C and moves it on; B comes with nothing but C and what the hub serves. B joins the room
  /// group from outside, A takes B's Commit from the log, both hold one key; the keys of the epochs before B came
  /// reach it through the sealed keys. Then the same for a session group.
  func testANewDeviceJoinsWithTheCode() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice(), agent = try newDevice()
    let code = try tools.generateRecoveryCode()
    let room = try a.foundRoom(recoveryCode: code, nowMs: nowMs())
    try hub.post(a)
    XCTAssertTrue(try a.holdsRecoveryMac())
    _ = try a.update(group: room, forced: true, nowMs: nowMs())
    try hub.post(a)
    // The agent device comes by invite, and its session is what the invite then asks for.
    let invite = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[1]))
    _ = try a.inviteConfirm(invite: invite.invite, numbers: invite.inviterShows, requestHash: invite.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let keyPackage)? = try a.inviteSteps().first else { return XCTFail("the invite asks for no session") }
    let session = try a.foundSession(agent: agent.id, keyPackages: [keyPackage], nowMs: nowMs())
    try hub.post(a)
    let sessionGroup = room + session
    XCTAssertEqual(try a.groups().first { $0.session == nil }?.epoch, 2)

    // What the hub serves is all B has. A wrong code finds no anchor among the sealed keys.
    XCTAssertEqual(refusedCode { _ = try self.tools.recoveryAnchor(code: try self.tools.generateRecoveryCode(), room: room, sealedKeys: hub.sealedKeys) }, "wrong-recovery")
    XCTAssertEqual(try tools.recoveryAnchor(code: code, room: room, sealedKeys: hub.sealedKeys).epoch, 2)
    let served = try hub.served(room: room, code: code, sessions: [sessionGroup], tools: tools)
    let joined = try b.joinRoomWithCode(code, served: served, nowMs: nowMs())
    XCTAssertEqual(joined.outbox.count, 1)
    XCTAssertNil(joined.missingLink)
    XCTAssertTrue(joined.unverified.isEmpty)
    // The join is in the outbox: Commit, GroupInfo, SealedKey, RecoveryAuth. Nothing of B changed yet.
    let entry = try XCTUnwrap(b.outbox().first)
    XCTAssertEqual(entry.id, joined.outbox[0])
    XCTAssertEqual(entry.kind, .externalCommit)
    XCTAssertEqual(entry.group, room)
    XCTAssertEqual(entry.epoch, 2)
    XCTAssertEqual(entry.parts.count, 4)
    XCTAssertTrue(entry.parts.allSatisfy { !$0.isEmpty })
    XCTAssertNil(b.room)
    XCTAssertTrue(try b.groups().isEmpty)

    // A join from outside is in force with the hub's answer (a member's Commit is not: LiveCoreTests): the device is
    // in the group before the log handed anything back, and its cursor has not moved.
    try hub.postWaiting(b)
    XCTAssertEqual(b.room, room)
    XCTAssertEqual(try b.groups().map(\.epoch), [3])
    XCTAssertEqual(try b.groups().first?.pending, false)
    XCTAssertEqual(b.cursor, 0)
    // The log from its start, in the hub's order: what lies behind the join is passed over, and so is the join's
    // own Commit, which gives the join its place.
    XCTAssertEqual(try hub.deliver(to: b), Array(repeating: .skipped, count: hub.log.count))
    XCTAssertEqual(b.cursor, hub.change)
    try hub.post(b)
    XCTAssertEqual(b.room, room)
    XCTAssertTrue(try b.isHuman())
    XCTAssertTrue(try b.holdsRecoveryMac())
    XCTAssertEqual(try b.roomRoles()?.humans.sorted { hex($0) < hex($1) }, [a.id, b.id].sorted { hex($0) < hex($1) })

    // A processes B's join from outside as the log brings it, with its RecoveryAuth.
    let seen = try hub.deliver(to: a)
    XCTAssertEqual(seen.last, .commit(group: room, epoch: 3, superseded: nil, removed: false))
    for device in [a, b] {
      let group = try XCTUnwrap(try device.groups().first { $0.session == nil })
      XCTAssertEqual(group.epoch, 3)
      XCTAssertEqual(Set(group.leaves), Set([a.id, b.id]))
    }
    // One key now, and the earlier ones through the sealed keys, each vouched for by a human device.
    for epoch in UInt64(0)...3 {
      XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: epoch), "epoch \(epoch)")
      XCTAssertTrue(try b.keyIsConfirmed(group: room, epoch: epoch), "epoch \(epoch)")
    }

    // The session group: B joins it as the human device it now is.
    let id = try b.joinSessionWithCode(code, served: served.sessions[0], nowMs: nowMs())
    let sessionJoin = try XCTUnwrap(b.outbox().first { $0.id == id })
    XCTAssertEqual(sessionJoin.kind, .externalCommit)
    XCTAssertEqual(sessionJoin.group, sessionGroup)
    try hub.post(b)
    try hub.deliver(to: a)
    let mine = try XCTUnwrap(try b.groups().first { $0.group == sessionGroup })
    let theirs = try XCTUnwrap(try a.groups().first { $0.group == sessionGroup })
    XCTAssertEqual(mine.epoch, theirs.epoch)
    XCTAssertEqual(Set(mine.leaves), Set([a.id, b.id, agent.id]))
    XCTAssertEqual(mine.session?.agents, [agent.id])
    for epoch in UInt64(0)...mine.epoch {
      XCTAssertTrue(try bothHoldKey(b, a, group: sessionGroup, epoch: epoch), "session epoch \(epoch)")
    }
    XCTAssertTrue(a.outbox().isEmpty)
    XCTAssertTrue(b.outbox().isEmpty)

    XCTAssertEqual(hub.kinds, [1, 3, 3, 2, 4, 4])
  }

  /// A join the hub refused for good is dropped, and the device is in no room, as before.
  func testAJoinTheHubRefusedLeavesNothing() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice()
    let code = try tools.generateRecoveryCode()
    let room = try a.foundRoom(recoveryCode: code, nowMs: nowMs())
    try hub.post(a)
    let joined = try b.joinRoomWithCode(code, served: try hub.served(room: room, code: code, tools: tools), nowMs: nowMs())
    try b.outboxRefused(joined.outbox[0], code: "bad-commit")
    XCTAssertTrue(b.outbox().isEmpty)
    XCTAssertNil(b.room)
    XCTAssertTrue(try b.groups().isEmpty)
    // It joins anew.
    try join(b, code: code, room: room, hub: hub)
    XCTAssertEqual(b.room, room)
  }

  /// The code is replaced (8.6): one request with the room Commit, the link from the old code and the account's
  /// copies; the other human device gets the new key for the sealed keys; a device comes in with the new code and
  /// reads back to the first epoch; the old code opens the room no more.
  func testTheCodeIsReplaced() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice()
    let code = try tools.generateRecoveryCode()
    let room = try a.foundRoom(recoveryCode: code, nowMs: nowMs())
    try hub.post(a)
    try join(b, code: code, room: room, hub: hub)
    try hub.deliver(to: a)

    XCTAssertEqual(refusedCode { _ = try a.replaceCode(current: code, account: [], nowMs: nowMs()) }, "incomplete")
    XCTAssertEqual(refusedCode { _ = try a.newRecoveryCode(current: try self.tools.generateRecoveryCode()) }, "wrong-recovery")
    XCTAssertEqual(refusedCode { _ = try a.newRecoveryCode(current: [1, 2, 3]) }, "bad-format")
    let next = try a.newRecoveryCode(current: code)
    XCTAssertEqual(next.count, 32)
    XCTAssertNotEqual(next, code)
    XCTAssertTrue(a.outbox().isEmpty)

    let account = utf8(#"{"kit":{"sealed_copy":"x"},"password":{"sealed_copy":"y"}}"#)
    let id = try a.replaceCode(current: code, account: account, nowMs: nowMs())
    let entry = try XCTUnwrap(a.outbox().first { $0.id == id })
    XCTAssertEqual(entry.kind, .recoveryCode)
    XCTAssertEqual(entry.group, room)
    XCTAssertEqual(entry.epoch, 1)
    XCTAssertEqual(entry.parts.count, 5)   // Commit, GroupInfo, SealedKey, RecoveryLink, the account's copies as given
    XCTAssertEqual(entry.parts[4], account)
    XCTAssertTrue(entry.parts.allSatisfy { !$0.isEmpty })
    // Used up: the same new code is not put in force twice.
    XCTAssertEqual(refusedCode { _ = try a.replaceCode(current: code, account: account, nowMs: nowMs()) }, "incomplete")

    // The hub takes it; A then sends the new key for the sealed keys by itself, as a stored message of the room group.
    try hub.post(a)
    XCTAssertEqual(hub.account, account)
    XCTAssertEqual(hub.links.count, 1)
    XCTAssertEqual(Array(hub.kinds.suffix(2)), [10, 5])
    XCTAssertTrue(try a.holdsRecoveryMac())
    XCTAssertNotEqual(try a.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: code).id)
    XCTAssertEqual(try a.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: next).id)

    let got = try hub.deliver(to: b)
    XCTAssertEqual(got, [.commit(group: room, epoch: 2, superseded: nil, removed: false), .message(.recoveryAuth(from: a.id))])
    XCTAssertTrue(try b.holdsRecoveryMac())

    // A new device with the new code: the link opens the old code's sealed keys, back to the founding.
    let c = try newDevice()
    try join(c, code: next, room: room, hub: hub)
    try hub.deliver(to: a)
    for epoch in UInt64(0)...3 {
      XCTAssertTrue(try bothHoldKey(c, a, group: room, epoch: epoch), "epoch \(epoch)")
      XCTAssertTrue(try c.keyIsConfirmed(group: room, epoch: epoch), "epoch \(epoch)")
    }
    // Without the link the hub withheld, it still joins, and is told which key's past stays closed.
    let d = try newDevice()
    var withheld = try hub.served(room: room, code: next, tools: tools)
    withheld.links = []
    let joined = try d.joinRoomWithCode(next, served: withheld, nowMs: nowMs())
    XCTAssertNotNil(joined.missingLink)
    try d.outboxRefused(joined.outbox[0], code: "bad-commit")

    // The old code: the room names other keys now.
    let e = try newDevice()
    XCTAssertEqual(refusedCode { _ = try e.joinRoomWithCode(code, served: try hub.served(room: room, code: code, tools: self.tools), nowMs: nowMs()) }, "wrong-recovery")
    XCTAssertNil(e.room)
    XCTAssertTrue(e.outbox().isEmpty)
  }

  /// Every device is lost (8.7): a new device with the code prepares the recovery, is told whom it removes, and builds
  /// all of it (outbox kinds 11 `recoveryCommit` and 12 `recoveryFinish`); nothing of the device changes until the
  /// hub accepted the finish.
  func testAWholeRecovery() throws {
    let hub = PocketHub()
    let lost = try newDevice(), new = try newDevice()
    let code = try tools.generateRecoveryCode()
    let room = try lost.foundRoom(recoveryCode: code, nowMs: nowMs())
    try hub.post(lost)

    let served = try hub.served(room: room, code: code, tools: tools)
    XCTAssertEqual(refusedCode { _ = try new.recover(code, served: served, chains: [], account: [], nowMs: nowMs()) }, "incomplete")
    let plan = try new.prepareRecovery(code, served: served)
    XCTAssertEqual(plan.newCode.count, 32)
    XCTAssertNotEqual(plan.newCode, code)
    XCTAssertEqual(plan.removals.count, 1)
    XCTAssertEqual(plan.removals.first?.group, room)
    XCTAssertEqual(plan.removals.first?.devices, [lost.id])

    let account = utf8(#"{"kit":{"sealed_copy":"x"}}"#)
    // The core takes each Cut from the chain of the device that goes, as the hub serves it. The lost device stored
    // nothing: no chain is handed in, and it is cut at nothing.
    let built = try new.recover(code, served: served, chains: [], account: account, nowMs: nowMs())
    let waiting = PocketHub.waiting(new)
    XCTAssertEqual(waiting.map(\.id), built.outbox)
    // The join from outside, the removal with the new code, the finish.
    XCTAssertEqual(waiting.map(\.kind), [11, 11, 12])
    XCTAssertEqual(waiting[0].parts.count, 5)        // Commit, GroupInfo, Welcome, SealedKey, RecoveryAuth
    XCTAssertFalse(waiting[0].parts[4].isEmpty)
    XCTAssertTrue(waiting[1].parts[4].isEmpty)       // a member's Commit carries no RecoveryAuth
    XCTAssertEqual(waiting[2].parts.count, 2)        // RecoveryLink, the account's copies as given
    XCTAssertEqual(waiting[2].parts[1], account)
    XCTAssertEqual(new.outbox().count, 3)
    XCTAssertNil(new.room)

    try hub.post(new)
    XCTAssertEqual(new.room, room)
    XCTAssertTrue(try new.isHuman())
    XCTAssertTrue(try new.holdsRecoveryMac())
    XCTAssertEqual(try new.roomRoles()?.humans, [new.id])
    XCTAssertEqual(try new.groups().first?.leaves, [new.id])
    XCTAssertEqual(try new.recoveryKeys()?.signatureKey, try tools.recoverySigner(code: plan.newCode).id)
    XCTAssertTrue(try bothHoldKey(new, lost, group: room, epoch: 0))
    XCTAssertTrue(new.outbox().isEmpty)
    // The lost device, should it turn up, learns that it is out.
    XCTAssertTrue(try hub.deliver(to: lost).contains { if case .commit(_, _, _, true) = $0 { return true } else { return false } })
  }
}
