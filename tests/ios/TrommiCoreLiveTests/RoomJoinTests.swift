// Joining by link with the engine (`Room.join`, RoomAccount.swift), the real core and `PocketHub` behind the hub's
// routes: the link's deadline checked before anything is asked, the Offer fetched by what `joinLink` reads, its
// MAC handed to `joinRequest`, the six emoji, the Welcome.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

@MainActor
final class RoomJoinTests: XCTestCase {
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
  private func code(_ op: () async throws -> Void) async -> String? {
    do { try await op(); return nil } catch { return (error as? TrommiError)?.code ?? (error as? HubError)?.code ?? "\(error)" }
  }
  /// A room of A, and an invite for a human device opened at `at`, its Offer published on the pocket hub.
  private func invite(at: UInt64 = nowMs()) throws -> (a: LiveDevice, room: RoomId, opened: InviteOpened) {
    let a = try newDevice()
    let room = try a.foundRoom(recoveryCode: try tools.generateRecoveryCode(), nowMs: nowMs())
    try hub.post(a)
    let opened = try a.inviteOpen(role: .human, session: nil, app: "https://app.example", hub: PocketRoutes.url, nowMs: at)
    PocketRoutes.invites[b64u(opened.inviteId)] = (["offer": b64u(opened.offer.offer), "signature": b64u(opened.offer.signature), "mac": b64u(opened.offer.mac)], [], nil)
    return (a, room, opened)
  }

  /// The whole join: B asks with the served MAC, A accepts and publishes the Reveal, both show the same emoji, A
  /// confirms, B takes the Welcome and is in the room.
  func testADeviceJoinsByLinkWithTheOffersMac() async throws {
    let (a, room, opened) = try invite()
    let base = try scratchFolder(self)
    var shown: String?
    let joining = Task { @MainActor in
      try await Room.join(link: opened.link, base: base, pollMs: 50) { if case .checkCode(let c) = $0 { shown = c } }
    }
    // A: the Request comes; accepted, its Reveal published
    var accepted: InviteAccepted?
    for _ in 0..<200 {
      if let q = PocketRoutes.invites[b64u(opened.inviteId)]?.requests.first,
         let r = (q["request"] as? String).flatMap({ try? unb64u($0) }), let m = (q["mac"] as? String).flatMap({ try? unb64u($0) }), let s = (q["signature"] as? String).flatMap({ try? unb64u($0) }) {
        accepted = try a.inviteAccept(invite: opened.inviteId, request: SignedRequest(request: r, mac: m, signature: s), nowMs: nowMs())
        PocketRoutes.invites[b64u(opened.inviteId)]?.reveal = ["reveal": b64u(accepted!.reveal.reveal), "signature": b64u(accepted!.reveal.signature)]
        break
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    let ok = try XCTUnwrap(accepted)
    for _ in 0..<200 where shown == nil { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertEqual(shown, checkCodeText(ok.code.numbers), "the same six emoji on both sides")
    _ = try a.inviteConfirm(invite: opened.inviteId, numbers: ok.code.numbers, requestHash: ok.requestHash, matches: true, nowMs: nowMs())
    try hub.post(a)
    let b = try await joining.value
    XCTAssertEqual(b.roomId, room)
    await b.shutdown()
  }

  /// A link past its deadline is refused on the phone: no device is made and nothing is asked of the hub.
  func testAnExpiredLinkIsRefusedBeforeAnyRequest() async throws {
    let (_, _, opened) = try invite(at: nowMs() - 30 * 60_000)
    let base = try scratchFolder(self)
    PocketRoutes.asked = []
    let thrown = await code { _ = try await Room.join(link: opened.link, base: base) { _ in } }
    XCTAssertEqual(thrown, "invite-expired")
    XCTAssertEqual(PocketRoutes.asked, [])
    XCTAssertEqual(Store.folders(base), [])
    XCTAssertEqual(tools.inviteLifeMs(.human), 600_000)
    XCTAssertEqual(tools.inviteLifeMs(.agent), 900_000)
  }

  /// An Offer served without its MAC is refused by the core: no Request is sent, nothing is kept.
  func testAnOfferWithoutItsMacIsRefused() async throws {
    let (_, _, opened) = try invite()
    PocketRoutes.dropMac = true
    let base = try scratchFolder(self)
    let thrown = await code { _ = try await Room.join(link: opened.link, base: base) { _ in } }
    XCTAssertEqual(thrown, "bad-invite")
    XCTAssertEqual(PocketRoutes.invites[b64u(opened.inviteId)]?.requests.count, 0)
    XCTAssertEqual(Store.folders(base), [])
  }

  /// A link whose fifth part (the deadline) was changed names another invite: the Offer of the real one does not
  /// fit it, and no Request is sent.
  func testAChangedDeadlineNamesNoInvite() async throws {
    let (_, _, opened) = try invite()
    // (the deadline: a uint64 of milliseconds, big-endian, base64url; moved one minute on)
    var parts = opened.link.components(separatedBy: ".")
    let n = try XCTUnwrap(try? unb64u(parts[parts.count - 1])).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    XCTAssertEqual(n, opened.expiresAt)
    let moved = n + 60_000
    parts[parts.count - 1] = b64u((0..<8).reversed().map { UInt8(truncatingIfNeeded: moved >> (8 * UInt64($0))) })
    let changed = parts.joined(separator: ".")
    let l = try tools.inviteLinkCheck(changed, nowMs: nowMs())
    XCTAssertNotEqual(l.invite, opened.inviteId, "another invite")
    // served the real Offer under the other id: the core refuses it
    PocketRoutes.invites[b64u(l.invite)] = PocketRoutes.invites[b64u(opened.inviteId)]
    let base = try scratchFolder(self)
    let thrown = await code { _ = try await Room.join(link: changed, base: base) { _ in } }
    XCTAssertEqual(thrown, "bad-invite")
    XCTAssertEqual(PocketRoutes.invites[b64u(l.invite)]?.requests.count, 0)
    XCTAssertEqual(Store.folders(base), [])
  }
}
