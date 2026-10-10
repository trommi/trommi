// What an agent wrote in its session before a phone came (spec/v1.md 4.6, 7.1), with the engine (`Room`), the real
// core and `PocketHub` behind the hub's routes (PocketRoutes.swift): the agent introduces itself (`device/<id>`)
// and writes its `profile`; the phone comes by link later, and the session moved on between the inviter's room
// handover and the Add into the session. The app shows a session by those registers: without them only its raw id.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class SessionPastTests: XCTestCase {
  let tools = LiveCore()
  var hub = PocketHub()
  private var transport: [AnyClass] = []

  override func setUp() async throws {
    Core.tools = tools
    transport = HubClient.transportForTests
    hub = PocketHub()
    PocketRoutes.install(hub)
  }
  override func tearDown() async throws { HubClient.transportForTests = transport }

  private func newDevice() throws -> LiveDevice {
    try XCTUnwrap(try tools.createDevice(store: DeviceStore(directory: try scratchFolder(self), key: systemRandom(32))) as? LiveDevice)
  }

  /// The agent writes one register of its own in its session.
  private func agentWrites(_ agent: LiveDevice, session: GroupId, name: String, _ json: String) throws {
    try hub.deliver(to: agent)
    _ = try agent.seal(.register(group: session, name: name, value: utf8(json)), files: [], nowMs: nowMs())
    try hub.post(agent)
  }

  /// A founds the room; an agent comes by link, its main session is founded, and it introduces itself there.
  private func roomWithAgent() throws -> (a: LiveDevice, agent: LiveDevice, room: RoomId, session: GroupId) {
    let a = try newDevice(), agent = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let forAgent = try exchangeInvite(from: a, to: agent, role: .agent, tools: tools)
    try agent.joinObserve(groupInfo: try XCTUnwrap(hub.infos[room]?[0]))
    _ = try a.inviteConfirm(invite: forAgent.invite, numbers: forAgent.inviterShows, requestHash: forAgent.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    // (the agent follows the room from the Offer's epoch: its enrolment first, then the session's Welcome)
    try hub.deliver(to: agent)
    guard case .foundSession(_, _, let keyPackage)? = try a.inviteSteps().first else { throw XCTSkip("the invite asks for no session") }
    let session = room + (try a.foundSession(agent: agent.id, keyPackages: [keyPackage], nowMs: nowMs()))
    try hub.post(a)
    _ = try agent.joinWelcome(try XCTUnwrap(hub.welcomes.last), room: room, committer: a.id, nowMs: nowMs())
    try agentWrites(agent, session: session, name: "device/\(b64u(agent.id))", #"{"device_name":"build-bot","platform":"linux"}"#)
    return (a, agent, room, session)
  }

  /// The phone comes by link: the room Add and the room handover; then the session moves on (an update), the agent
  /// writes its profile in that epoch, and only then the inviter adds the phone to the session. The phone's board
  /// shows the agent's name and profile once its sync learned the past and the keys came.
  func testAPhoneAddedLaterShowsTheAgentsNameAndProfile() async throws {
    let (a, agent, room, session) = try roomWithAgent()
    var invite = Bytes()
    let phone = try pocketRoom(self, room: room, past: PastWork(toLearn: [hex(room)]), tools: tools) { b in
      let exchanged = try exchangeInvite(from: a, to: b, tools: self.tools)
      invite = exchanged.invite
      _ = try a.inviteConfirm(invite: exchanged.invite, numbers: exchanged.inviterShows, requestHash: exchanged.requestHash, matches: true, nowMs: nowMs())
      try self.hub.post(a)
      _ = try b.joinInvited(try XCTUnwrap(self.hub.welcomes.last), nowMs: nowMs())
    }
    addTeardownBlock { await phone.shutdown() }
    _ = try a.inviteHandover(invite: invite)
    try hub.post(a)
    _ = try a.update(group: session, forced: true, nowMs: nowMs())
    try hub.post(a)
    try agentWrites(agent, session: session, name: "profile", #"{"agent_name":"Builder","model":"m","task":"t"}"#)
    let phoneId = try XCTUnwrap(phone.device as? LiveDevice).id
    _ = try a.addToSession(group: session, device: phoneId, keyPackage: try XCTUnwrap(phone.device as? LiveDevice).keyPackage(nowMs: nowMs()), nowMs: nowMs())
    try hub.post(a)

    _ = try await phone.sync()
    _ = try await phone.sync()
    let board = phone.board
    XCTAssertEqual(board.deviceNameOf(hex(agent.id)), "build-bot", "the agent's name (device/<id>) is read")
    let profile = try XCTUnwrap(board.sessions[hex(Bytes(session.suffix(16)))]?.profile)
    XCTAssertEqual(profile["agent_name"].string, "Builder", "the profile written between the handover and the Add is read")
  }

  /// A Welcome taken late (core groups_concurrency `a_welcome_taken_late_is_caught_up_from_its_place_in_the_log`):
  /// the phone is added to the session, the session and the room move on, and the phone reads past all of it before
  /// it takes its Welcome. Taking it, the engine hands the session's log again up to where the core read (as the
  /// web engine's `handLog`): the handover behind the Add opens and the Commits behind it are merged, so the phone
  /// stands in the session's current epoch and reads what the agent writes there.
  func testAWelcomeTakenLateCatchesUpFromItsPlaceInTheLog() async throws {
    let (a, agent, room, session) = try roomWithAgent()
    var invite = Bytes()
    let phone = try pocketRoom(self, room: room, past: PastWork(toLearn: [hex(room)]), tools: tools) { b in
      let exchanged = try exchangeInvite(from: a, to: b, tools: self.tools)
      invite = exchanged.invite
      _ = try a.inviteConfirm(invite: exchanged.invite, numbers: exchanged.inviterShows, requestHash: exchanged.requestHash, matches: true, nowMs: nowMs())
      try self.hub.post(a)
      _ = try b.joinInvited(try XCTUnwrap(self.hub.welcomes.last), nowMs: nowMs())
    }
    addTeardownBlock { await phone.shutdown() }
    _ = try a.inviteHandover(invite: invite)
    try hub.post(a)
    _ = try await phone.sync()

    let device = try XCTUnwrap(phone.device as? LiveDevice)
    _ = try a.addToSession(group: session, device: device.id, keyPackage: try device.keyPackage(nowMs: nowMs()), nowMs: nowMs())
    try hub.post(a)
    for target in [session, room, session] {
      _ = try a.update(group: target, forced: true, nowMs: nowMs())
      try hub.post(a)
    }
    // (the phone's core reads the log without its Welcome: the session's entries are passed over)
    try hub.deliver(to: device)
    XCTAssertEqual(device.cursor, hub.change)
    XCTAssertNil(try device.groups().first { $0.group == session }, "not in the session yet")

    try agentWrites(agent, session: session, name: "profile", #"{"agent_name":"Late","model":"m","task":"t"}"#)
    _ = try await phone.sync()
    let epoch = try XCTUnwrap(try a.groups().first { $0.group == session }?.epoch)
    XCTAssertEqual(try device.groups().first { $0.group == session }?.epoch, epoch, "the session's Commits behind the Add were merged")
    let profile = try XCTUnwrap(phone.board.sessions[hex(Bytes(session.suffix(16)))]?.profile)
    XCTAssertEqual(profile["agent_name"].string, "Late", "what the agent wrote in the current epoch opens")
  }
}
