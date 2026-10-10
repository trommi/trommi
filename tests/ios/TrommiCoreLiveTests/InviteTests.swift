// Joining by link (spec/v2.md 12.1) with the real core and no hub: the four parts of an invite go from hand to hand
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
    let forAgent = try exchangeInvite(from: a, to: agent, role: ROLE.AGENT, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[1]))
    _ = try a.confirmInvite(invite: forAgent.invite, numbers: forAgent.inviterShows, nowMs: nowMs())
    try hub.post(a)
    guard case .foundSession(_, _, let agentKeyPackage)? = try a.inviteSteps().first else { return XCTFail("the invite asks for no session") }
    let sessionGroup = room + (try a.foundSession(agent: agent.id, keyPackages: [agentKeyPackage], nowMs: nowMs()))
    try hub.post(a)
    XCTAssertEqual(try a.inviteSteps(), [])
    let roomEpoch = try XCTUnwrap(try a.groups().first { $0.session == nil }).epoch
    XCTAssertEqual(roomEpoch, 2)

    // The invite: the link is for the new device alone, and names the hub and the room.
    let opened = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    XCTAssertEqual(opened.invite.count, 16)
    XCTAssertTrue(opened.link.hasPrefix("https://app.example/join#v2."))
    XCTAssertGreaterThan(opened.expiresAt, nowMs())
    let asked = try tools.inviteRequest(link: opened.link, offer: opened.offer, offerSignature: opened.offerSignature, device: b, nowMs: nowMs())
    XCTAssertEqual(asked.invite, opened.invite)
    XCTAssertEqual(asked.hub, "https://hub.example")
    XCTAssertEqual(asked.room, room)
    XCTAssertEqual(asked.role, ROLE.HUMAN)
    XCTAssertEqual(asked.inviter, a.id)
    let accepted = try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs())
    XCTAssertEqual(accepted.newDevice, b.id)
    // Asked again with the same Request, the same comes back.
    XCTAssertEqual(try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs()), accepted)

    // The six numbers are the same on both sides, and so are the emoji and their words.
    let shown = try tools.inviteReveal(device: b, reveal: accepted.reveal, signature: accepted.revealSignature)
    XCTAssertEqual(shown, accepted.numbers)
    XCTAssertEqual(shown.count, 6)
    XCTAssertTrue(shown.allSatisfy { $0 < 64 })
    let emoji = tools.checkEmoji(shown)
    XCTAssertEqual(emoji.count, 6)
    XCTAssertTrue(emoji.allSatisfy { !$0.emoji.isEmpty && $0.emoji != "?" && !$0.word.isEmpty })
    // The link names the hub, the room and the invite's id, which is all a new device needs to ask for the Offer.
    XCTAssertEqual(try tools.parseInviteLink(opened.link), InviteLinkParts(hub: "https://hub.example", room: room, invite: opened.invite))

    // Nothing of the room changed yet; B is in none.
    XCTAssertEqual(try a.inviteSteps(), [])
    XCTAssertNil(b.room)

    // Confirmed: the Add in the room group, and B joins from its Welcome, which the stored invite describes.
    _ = try a.confirmInvite(invite: opened.invite, numbers: accepted.numbers, nowMs: nowMs())
    XCTAssertEqual(try a.inviteSteps(), [.wait(invite: opened.invite)])
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

    // What follows, step by step: the handover in the room group, then the Add into the live session group.
    XCTAssertEqual(try a.inviteSteps(), [.handover(invite: opened.invite, group: room, device: b.id)])
    XCTAssertFalse(try a.inviteHandover(invite: opened.invite).isEmpty)
    try hub.post(a)
    XCTAssertEqual(try a.inviteSteps(), [.addToSession(invite: opened.invite, group: sessionGroup, device: b.id)])
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
    let again = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    XCTAssertEqual(refusedCode { _ = try self.tools.inviteRequest(link: again.link, offer: again.offer, offerSignature: again.offerSignature, device: b, nowMs: nowMs()) }, "room-exists")
  }

  /// "They don't match": the invite is burned, nobody is added, and the invite answers no more.
  func testAMismatchBurnsTheInvite() throws {
    let hub = PocketHub()
    let a = try newDevice(), b = try newDevice()
    let room = try room(a, hub: hub)
    let opened = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    let asked = try tools.inviteRequest(link: opened.link, offer: opened.offer, offerSignature: opened.offerSignature, device: b, nowMs: nowMs())
    let accepted = try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs())
    _ = try tools.inviteReveal(device: b, reveal: accepted.reveal, signature: accepted.revealSignature)

    try a.burnInvite(invite: opened.invite)
    XCTAssertEqual(refusedCode { _ = try a.confirmInvite(invite: opened.invite, numbers: accepted.numbers, nowMs: nowMs()) }, "code-not-confirmed")
    XCTAssertEqual(refusedCode { _ = try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs()) }, "invite-burned")
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
    let opened = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs())
    // Before any Request was accepted there is no code to confirm.
    XCTAssertEqual(refusedCode { _ = try a.confirmInvite(invite: opened.invite, numbers: [1, 2, 3, 4, 5, 6], nowMs: nowMs()) }, "code-not-confirmed")
    let asked = try tools.inviteRequest(link: opened.link, offer: opened.offer, offerSignature: opened.offerSignature, device: b, nowMs: nowMs())
    // A Request with a wrong MAC (someone without the link) is refused and the invite stays open.
    var forged = asked.mac
    forged[0] ^= 1
    XCTAssertNotNil(refusedCode { _ = try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: forged, signature: asked.signature, nowMs: nowMs()) })
    let accepted = try a.acceptInviteRequest(invite: opened.invite, request: asked.request, mac: asked.mac, signature: asked.signature, nowMs: nowMs())

    var wrong = accepted.numbers
    wrong[0] = (wrong[0] + 1) % 64
    XCTAssertEqual(refusedCode { _ = try a.confirmInvite(invite: opened.invite, numbers: wrong, nowMs: nowMs()) }, "code-not-confirmed")
    XCTAssertEqual(refusedCode { _ = try a.confirmInvite(invite: opened.invite, numbers: [1, 2, 3], nowMs: nowMs()) }, "bad-format")
    XCTAssertTrue(a.outbox().isEmpty)
    // A Reveal is checked on the device that made the Request.
    XCTAssertEqual(refusedCode { _ = try self.tools.inviteReveal(device: stranger, reveal: accepted.reveal, signature: accepted.revealSignature) }, "not-found")
    XCTAssertEqual(try tools.inviteReveal(device: b, reveal: accepted.reveal, signature: accepted.revealSignature), accepted.numbers)

    _ = try a.confirmInvite(invite: opened.invite, numbers: accepted.numbers, nowMs: nowMs())
    try hub.post(a)
    XCTAssertEqual(try b.joinInvited(try XCTUnwrap(hub.welcomes.last), nowMs: nowMs()).addedBy, a.id)
    // Used: the invite takes no second device, and is not confirmed twice.
    XCTAssertEqual(refusedCode { _ = try a.confirmInvite(invite: opened.invite, numbers: accepted.numbers, nowMs: nowMs()) }, "code-not-confirmed")
    // Only a human device invites.
    XCTAssertEqual(refusedCode { _ = try stranger.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs()) }, "no-room")
    // The app's origin and the hub's address are the core's to judge.
    XCTAssertEqual(refusedCode { _ = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example/join", hub: "https://hub.example", nowMs: nowMs()) }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try a.openInvite(role: ROLE.HUMAN, session: nil, app: "https://app.example", hub: "https://Hub.example/", nowMs: nowMs()) }, "bad-format")
    XCTAssertEqual(refusedCode { _ = try a.openInvite(role: 3, session: nil, app: "https://app.example", hub: "https://hub.example", nowMs: nowMs()) }, "bad-format")
  }
}
