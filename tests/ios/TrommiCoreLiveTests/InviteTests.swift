// Joining by link (spec/v1.md 12.1) with the real core and no hub: the four parts of an invite go from hand to hand
// (`exchangeInvite`, LiveCoreTests.swift), and `PocketHub` (RecoveryTests.swift) keeps the log, the GroupInfos and
// the Welcomes.
import Foundation
import XCTest
import TrommiClient
@testable import TrommiCoreLive

final class InviteTests: XCTestCase {
  let tools = LiveCore()

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }

  /// A room with two epochs behind it.
  private func room(_ a: LiveDevice, hub: PocketHub) throws -> RoomId {
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    _ = try a.update(group: room, forced: true, nowMs: nowMs())
    try hub.post(a)
    return room
  }

  /// A human device joins by invite. Both sides show the same six numbers and the same emoji; the new device ends in
  /// the room group and, by the steps the invite names, in the live session group; it reads the epochs before it
  /// came, in both.
  func testAHumanDeviceJoinsByInvite() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice(), agent = try newDevice()
    let room = try room(a, hub: hub)

    // A session to come into: the agent device by invite, its main session by the invite's step.
    let forAgent = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[1]))
    _ = try a.inviteConfirm(invite: forAgent.invite, numbers: forAgent.inviterShows, requestHash: forAgent.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let agentKeyPackage)? = try a.inviteSteps().first else { return XCTFail("the invite asks for no session") }
    let sessionGroup = room + (try a.foundSession(agent: agent.id, keyPackages: [agentKeyPackage], nowMs: nowMs()))
    try hub.post(a)
    XCTAssertEqual(try a.inviteSteps(), [])
    let roomEpoch = try XCTUnwrap(try a.groups().first { $0.session == nil }).epoch
    XCTAssertEqual(roomEpoch, 2)

    // The invite: the link is for the new device alone, and names the hub and the room.
    let opened = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    XCTAssertEqual(opened.inviteId.count, 16)
    XCTAssertTrue(opened.link.hasPrefix("https://app.example/join#v1."))
    XCTAssertGreaterThan(opened.expiresAt, nowMs())
    let asked = try b.joinRequest(link: opened.link, offer: opened.offer, nowMs: nowMs())
    XCTAssertEqual(asked.inviteId, opened.inviteId)
    XCTAssertEqual(asked.roomId, room)
    XCTAssertEqual(asked.roomEpoch, roomEpoch)
    XCTAssertEqual(asked.role, .human)
    XCTAssertNil(asked.sessionId)
    XCTAssertEqual(asked.inviter, a.id)
    let accepted = try a.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs())
    XCTAssertEqual(accepted.newDevice, b.id)
    // Asked again with the same Request, the same comes back.
    XCTAssertEqual(try a.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs()), accepted)

    // The six numbers are the same on both sides, and so are the emoji and their words.
    let shown = try b.joinReveal(accepted.reveal)
    XCTAssertEqual(shown, accepted.code)
    XCTAssertEqual(shown.numbers.count, 6)
    XCTAssertTrue(shown.numbers.allSatisfy { $0 < 64 })
    let all = tools.checkEmoji()
    XCTAssertEqual(shown.emoji, shown.numbers.map { all[Int($0)].emoji })
    XCTAssertEqual(shown.words, shown.numbers.map { all[Int($0)].word })
    // The link names the app, the hub, the room and the invite's id, which is all a new device needs to ask for the Offer.
    XCTAssertEqual(try tools.parseInviteLink(opened.link), InviteLinkParts(app: "https://app.example", hub: "https://hub.example", room: room, invite: opened.inviteId, expiresAt: opened.expiresAt))

    // Nothing of the room changed yet; B is in none.
    XCTAssertEqual(try a.inviteSteps(), [])
    XCTAssertNil(b.room)

    // Confirmed: the Add in the room group, and B joins from its Welcome, which the stored invite describes.
    _ = try a.inviteConfirm(invite: opened.inviteId, numbers: accepted.code.numbers, requestHash: accepted.requestHash, matches: true, nowMs: nowMs())
    XCTAssertEqual(try a.inviteSteps(), [.wait(invite: opened.inviteId)])
    try hub.post(a)
    let joined = try b.joinInvited(try XCTUnwrap(hub.welcomes.last), nowMs: nowMs())
    XCTAssertEqual(joined, Joined(group: room, epoch: roomEpoch + 1, addedBy: a.id))
    XCTAssertEqual(b.room, room)
    XCTAssertTrue(try b.isHuman())
    XCTAssertEqual(Set(try XCTUnwrap(try a.roomRoles()).humans), Set([a.id, b.id]))
    for device in [a, b] {
      XCTAssertEqual(Set(try XCTUnwrap(try device.groups().first { $0.session == nil }).leaves), Set([a.id, b.id]))
    }
    // The key of its own epoch, and none of the epochs before it came.
    XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: roomEpoch + 1))
    XCTAssertFalse(try b.holdsKey(group: room, epoch: 0))

    // What follows, every step that is left: the handover in the room group, the Add into the live session group.
    XCTAssertEqual(try a.inviteSteps(), [.handover(invite: opened.inviteId, group: room, device: b.id), .addToSession(invite: opened.inviteId, group: sessionGroup, device: b.id)])
    XCTAssertFalse(try a.inviteHandover(invite: opened.inviteId).isEmpty)
    try hub.post(a)
    XCTAssertEqual(try a.inviteSteps(), [.addToSession(invite: opened.inviteId, group: sessionGroup, device: b.id)])
    _ = try a.addToSession(group: sessionGroup, device: b.id, keyPackage: try b.keyPackage(nowMs: nowMs()), nowMs: nowMs())
    try hub.post(a)
    XCTAssertEqual(try a.inviteSteps(), [])
    _ = try b.joinWelcome(try XCTUnwrap(hub.welcomes.last), room: room, committer: nil, nowMs: nowMs())
    XCTAssertFalse(try a.sendHandover(group: sessionGroup, recipient: b.id).isEmpty)
    try hub.post(a)
    XCTAssertTrue(a.outbox().isEmpty)

    // B reads the log: the handovers bring the keys of every epoch before it came, in both groups.
    let read = try hub.deliver(to: b)
    XCTAssertTrue(read.contains { if case .message(.keys(let from, _, _)) = $0 { return from == a.id } else { return false } })
    XCTAssertTrue(try b.holdsRecoveryMac())
    for epoch in UInt64(0)...(roomEpoch + 1) {
      XCTAssertTrue(try bothHoldKey(b, a, group: room, epoch: epoch), "room epoch \(epoch)")
    }
    let mine = try XCTUnwrap(try b.groups().first { $0.group == sessionGroup })
    XCTAssertEqual(mine.epoch, try XCTUnwrap(try a.groups().first { $0.group == sessionGroup }).epoch)
    XCTAssertEqual(Set(mine.leaves), Set([a.id, b.id, agent.id]))
    XCTAssertGreaterThan(mine.epoch, 1)
    for epoch in UInt64(0)...mine.epoch {
      XCTAssertTrue(try bothHoldKey(b, a, group: sessionGroup, epoch: epoch), "session epoch \(epoch)")
    }
    // A device joins one room, once.
    let again = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    XCTAssertEqual(refusedCode { _ = try b.joinRequest(link: again.link, offer: again.offer, nowMs: nowMs()) }, "room-exists")
  }

  /// "They don't match": the invite is burned, nobody is added, and the invite answers no more.
  func testAMismatchBurnsTheInvite() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice()
    let room = try room(a, hub: hub)
    let opened = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    let asked = try b.joinRequest(link: opened.link, offer: opened.offer, nowMs: nowMs())
    let accepted = try a.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs())
    _ = try b.joinReveal(accepted.reveal)

    XCTAssertNil(try a.inviteConfirm(invite: opened.inviteId, numbers: accepted.code.numbers, requestHash: accepted.requestHash, matches: false, nowMs: nowMs()))
    XCTAssertEqual(refusedCode { _ = try a.inviteConfirm(invite: opened.inviteId, numbers: accepted.code.numbers, requestHash: accepted.requestHash, matches: true, nowMs: nowMs()) }, "invite-burned")
    XCTAssertEqual(refusedCode { _ = try a.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs()) }, "invite-burned")
    XCTAssertTrue(a.outbox().isEmpty)
    XCTAssertEqual(try a.inviteSteps(), [])
    XCTAssertEqual(try a.roomRoles()?.humans, [a.id])
    XCTAssertEqual(try a.groups().first?.leaves, [a.id])
    XCTAssertEqual(try a.groups().first?.pending, false)
    XCTAssertNil(b.room)
    XCTAssertEqual(try a.groups().first?.group, room)
  }

  /// Other numbers than the ones this device showed commit nobody, and leave the invite as it was: the right ones
  /// still confirm it. A Request that does not check uses nothing up either.
  func testOnlyTheShownCodeConfirms() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice(), stranger = try newDevice()
    _ = try room(a, hub: hub)
    let opened = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    // Before any Request was accepted there is no code to confirm.
    XCTAssertEqual(refusedCode { _ = try a.inviteConfirm(invite: opened.inviteId, numbers: [1, 2, 3, 4, 5, 6], requestHash: ZERO32, matches: true, nowMs: nowMs()) }, "bad-invite")
    let asked = try b.joinRequest(link: opened.link, offer: opened.offer, nowMs: nowMs())
    // A Request with a wrong MAC (someone without the link) is refused and the invite stays open.
    var forged = asked.request
    forged.mac[0] ^= 1
    XCTAssertNotNil(refusedCode { _ = try a.inviteAccept(invite: opened.inviteId, request: forged, nowMs: nowMs()) })
    let accepted = try a.inviteAccept(invite: opened.inviteId, request: asked.request, nowMs: nowMs())

    var wrong = accepted.code.numbers
    wrong[0] = (wrong[0] + 1) % 64
    XCTAssertEqual(refusedCode { _ = try a.inviteConfirm(invite: opened.inviteId, numbers: wrong, requestHash: accepted.requestHash, matches: true, nowMs: nowMs()) }, "code-not-confirmed")
    XCTAssertEqual(refusedCode { _ = try a.inviteConfirm(invite: opened.inviteId, numbers: [1, 2, 3], requestHash: accepted.requestHash, matches: true, nowMs: nowMs()) }, "bad-format")
    XCTAssertTrue(a.outbox().isEmpty)
    // A Reveal is checked on the device that made the Request.
    XCTAssertEqual(refusedCode { _ = try stranger.joinReveal(accepted.reveal) }, "not-found")
    XCTAssertEqual(try b.joinReveal(accepted.reveal), accepted.code)

    _ = try a.inviteConfirm(invite: opened.inviteId, numbers: accepted.code.numbers, requestHash: accepted.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    XCTAssertEqual(try b.joinInvited(try XCTUnwrap(hub.welcomes.last), nowMs: nowMs()).addedBy, a.id)
    // Used: the invite takes no second device, and is not confirmed twice.
    XCTAssertEqual(refusedCode { _ = try a.inviteConfirm(invite: opened.inviteId, numbers: accepted.code.numbers, requestHash: accepted.requestHash, matches: true, nowMs: nowMs()) }, "invite-used")
    // Only a human device invites.
    XCTAssertEqual(refusedCode { _ = try stranger.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs()) }, "no-room")
    // The app's origin and the hub's address are the core's to judge.
    XCTAssertEqual(refusedCode { _ = try a.inviteOpen(role: .human, session: nil, app: "https://app.example/join", hub: "https://hub.example", nowMs: nowMs()) }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: "https://Hub.example/", nowMs: nowMs()) }, "bad-format")
  }
}
