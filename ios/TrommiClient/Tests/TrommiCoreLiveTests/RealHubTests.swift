// The client's engine (`Room`, `HubClient`) with the real core against the real hub: the binary of the crate `hub/`
// (branch v2-hub), started here on a port of this machine with a data folder of its own. Runs only when the
// environment names the binary:
//
//   TROMMI_HUB_BIN=<path to trommi-hub> swift test --filter RealHubTests
//
// Without the variable every test here is skipped, so `swift test` passes on a machine without the hub.
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive
import Crypto

/// One hub process for one test.
final class HubProcess {
  let url: String
  private let process = Process()

  /// Starts the hub and waits until it answers. nil: the environment names no binary.
  init?(data: URL) throws {
    guard let binary = ProcessInfo.processInfo.environment["TROMMI_HUB_BIN"], !binary.isEmpty else { return nil }
    let port = Int.random(in: 20_000..<40_000)
    url = "http://127.0.0.1:\(port)"
    process.executableURL = URL(fileURLWithPath: binary)
    // What the hub reads (hub/src/config.rs): where it listens, where it keeps its data, and the address devices sign.
    process.environment = ["HUB_HOST": "127.0.0.1", "HUB_PORT": String(port), "HUB_DATA": data.path, "HUB_URL": url, "HUB_QUIET": "1", "HUB_LOGIN_THROTTLE": "off"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let until = Date().addingTimeInterval(10)
    while Date() < until {
      if process.isRunning, let data = try? Data(contentsOf: URL(string: "\(url)/healthz")!), !data.isEmpty { return }
      Thread.sleep(forTimeInterval: 0.05)
    }
    process.terminate()
    throw TrommiError("test", "the hub did not start")
  }

  func stop() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}

/// The core, remembering the devices it made: the transport below needs the id of the device that posts and its
/// room's recovery key.
final class RememberingCore: LiveCore, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var made: [LiveDevice] = []
  override func createDevice(store: CoreStorage) throws -> CoreDevice {
    let device = try super.createDevice(store: store)
    if let live = device as? LiveDevice { Self.lock.withLock { Self.made.append(live) } }
    return device
  }
  /// The device this process made that is in `room`.
  static func device(in room: Bytes) -> LiveDevice? { lock.withLock { made.first { $0.room == room } } }
  static func forget() { lock.withLock { made = [] } }
}

/// WHAT THE RECOVERY STAND-IN LACKS, MADE UP FOR IN TRANSIT. The stand-in of core/swift/src/recovery.rs posts a readable
/// tag ("stand-in sealed key <group as hex> <epoch> <room epoch>") where a SealedKey belongs. The real hub parses a
/// SealedKey and checks what it can (group, epoch, the GroupInfo's hash, room epoch, the recovery key it is sealed
/// to, the writer, a tag of 32 bytes from a human device), so it refuses the stand-in's with `incomplete`. This
/// transport puts a SealedKey of the right shape with random content in the tag's place on the way to the hub, so that
/// the tests can see what lies behind the founding. It goes when the stand-in posts that shape itself.
final class ShapedSealedKeys: URLProtocol, @unchecked Sendable {
  private static let plain = URLSession(configuration: .ephemeral)

  /// Only requests that carry a body pass through here; the stream and every read go straight to the hub.
  override class func canInit(with request: URLRequest) -> Bool { request.httpMethod == "POST" || request.httpMethod == "PUT" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    var body = request.httpBody ?? Data()
    if body.isEmpty, let stream = request.httpBodyStream {
      stream.open()
      var buffer = [UInt8](repeating: 0, count: 65536)
      while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(buffer, count: n) }
      stream.close()
    }
    var changed = request
    changed.httpBodyStream = nil
    changed.httpBody = Self.shaped(body)
    let forward = changed
    // Sent and answered from a thread of its own: Foundation's loader calls this on its session's queue, from where
    // neither a task of another session can be started nor its answer taken.
    DispatchQueue.global().async { [self] in
      Self.plain.dataTask(with: forward) { data, response, error in
        DispatchQueue.global().async { [self] in
          guard let response = response else { client?.urlProtocol(self, didFailWithError: error ?? URLError(.badServerResponse)); return }
          client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
          client?.urlProtocol(self, didLoad: data ?? Data())
          client?.urlProtocolDidFinishLoading(self)
        }
      }.resume()
    }
  }

  /// The body with every stand-in tag replaced: `sealed_key` goes with `group_info`, `sealed_key_0` with `group_info_0`.
  static func shaped(_ body: Data) -> Data {
    guard var json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return body }
    var changed = false
    for (key, info) in [("sealed_key", "group_info"), ("sealed_key_0", "group_info_0")] {
      guard let tag = (json[key] as? String).flatMap({ try? unb64u($0) }), let groupInfo = (json[info] as? String).flatMap({ try? unb64u($0) }),
            let real = sealedKey(tag: tag, groupInfo: groupInfo) else { continue }
      json[key] = b64u(real)
      changed = true
    }
    if var commit = json["commit"] as? [String: Any], let inner = try? JSONSerialization.data(withJSONObject: commit),
       let fixed = (try? JSONSerialization.jsonObject(with: shaped(inner))) as? [String: Any] { commit = fixed; json["commit"] = commit; changed = true }
    return changed ? ((try? JSONSerialization.data(withJSONObject: json)) ?? body) : body
  }

  /// spec/v2.md 8.2 as the hub reads it (hub/src/wire.rs `SealedKey::parse`): group<V>, epoch, the GroupInfo's RefHash,
  /// room epoch, recovery HPKE key<V>, KEM output<V> (32), ciphertext<V> (48), writer (32), tag<V> (32).
  static func sealedKey(tag: Bytes, groupInfo: Bytes) -> Bytes? {
    let words = String(decoding: tag, as: UTF8.self).split(separator: " ")
    guard words.count == 6, words.prefix(3).joined(separator: " ") == "stand-in sealed key", let group = try? unhex(String(words[3])),
          let epoch = UInt64(words[4]), let roomEpoch = UInt64(words[5]), let device = RememberingCore.device(in: Bytes(group.prefix(32))),
          let hpke = (try? device.recoveryKeys())?.hpkeKey else { return nil }
    func vec(_ b: Bytes) -> Bytes { (b.count < 64 ? [UInt8(b.count)] : [0x40 | UInt8(b.count >> 8), UInt8(b.count & 0xff)]) + b }
    var hashed = vec(utf8("Trommi Group Info")); hashed += vec(groupInfo)
    var out = vec(group); out += be64(epoch); out += Bytes(SHA256.hash(data: Data(hashed))); out += be64(roomEpoch)
    out += vec(hpke); out += vec(systemRandom(32)); out += vec(systemRandom(48)); out += device.id; out += vec(systemRandom(32))
    return out
  }
}

final class RealHubTests: XCTestCase {
  private var hub: HubProcess?
  private var transport: [AnyClass] = []

  override func setUpWithError() throws {
    guard let started = try HubProcess(data: try scratchFolder(self).appendingPathComponent("hub")) else {
      throw XCTSkip("TROMMI_HUB_BIN names no hub binary")
    }
    hub = started
    Core.tools = RememberingCore()
    // Other tests of this run answer the hub's routes in the process; these go to the real one.
    transport = HubClient.transportForTests
    HubClient.transportForTests = []
  }

  override func tearDown() {
    hub?.stop()
    HubClient.transportForTests = transport
    RememberingCore.forget()
  }

  /// THE FIRST POINT WHERE CLIENT AND HUB PART: the founding itself. Route and fields fit; the hub refuses the bytes
  /// the stand-in posts where a SealedKey belongs. Once the stand-in (or the real recovery) posts a SealedKey, the
  /// room is founded here and the rest of the test runs.
  func testFoundingAsTheAppDoesIt() async throws {
    let hubURL = try XCTUnwrap(hub).url
    do {
      let founded = try await Room.foundRoom(hubURL: hubURL, base: try scratchFolder(self))
      defer { founded.room.close() }
      let role = try await founded.room.hub.signIn()
      XCTAssertEqual(role, "human")
    } catch let refused as HubError {
      XCTAssertEqual(refused.status, 400)
      XCTAssertEqual(refused.code, "incomplete")
      XCTAssertTrue(refused.message.contains("SealedKey"), refused.message)
    }
  }

  /// Everything behind the founding that one human device can do with what the binding has, against the real hub,
  /// with the stand-in's SealedKeys given their shape in transit: an account made with the founding, the signed
  /// challenge, catching up, the account's routes, KeyPackages, a Commit, a relayed message, a file, the stream.
  func testOneDeviceAgainstTheHub() async throws {
    let hubURL = try XCTUnwrap(hub).url
    HubClient.transportForTests = [ShapedSealedKeys.self]
    let made = try await Room.createAccount(hubURL: hubURL, email: "Ada@Example.com", password: "correct horse battery", base: try scratchFolder(self))
    let room = made.room
    defer { room.close() }
    let device = try XCTUnwrap(room.device as? LiveDevice)
    XCTAssertEqual(made.kit.email, "ada@example.com")
    XCTAssertEqual(made.kit.words.split(separator: " ").count, 12)
    XCTAssertTrue(device.outbox().isEmpty)

    // POST /v2/rooms/{room}/tokens with the signed challenge: a token, and the hub's word for this device.
    let role = try await room.hub.signIn()
    XCTAssertEqual(role, "human")
    let report = try await room.sync()
    XCTAssertEqual(report.refused, 0)
    let groups = try await room.hub.groups()
    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual((groups[0]["group_id"] as? String).flatMap { try? unb64u($0) }, room.roomId)
    XCTAssertEqual((groups[0]["leaves"] as? [String])?.compactMap { try? unb64u($0) }, [device.id])

    // The account the founding made: the hub hands back the KDF record and the copy under the password, and the
    // core derives and opens with them (a change of password proves both).
    let account = try await room.accountStatus()
    XCTAssertEqual(account?.email, "ada@example.com")
    XCTAssertEqual(account?.hasPassword, true)
    XCTAssertEqual(account?.hasRecovery, true)
    try await room.changePassword(current: "correct horse battery", next: "another long password")
    do { try await room.changePassword(current: "correct horse battery", next: "a third long password"); XCTFail("the old password still opens the code") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-login") }
    let kit = try await room.makeEmergencyKit(password: "another long password")
    XCTAssertEqual(kit.words.split(separator: " ").count, 12)
    let revision = try await room.accountStatus()?.revision
    XCTAssertEqual(revision, 3)
    // The words of the first kit open nothing any more: one error for that and for an unknown e-mail.
    do { _ = try await Room.resetPassword(hubURL: hubURL, email: "ada@example.com", words: made.kit.words, newPassword: "a fourth long password", base: try scratchFolder(self)); XCTFail("an old kit reset the password") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-recovery") }
    do { _ = try await Room.signInWithPassword(hubURL: hubURL, email: "ada@example.com", password: "a wrong long password", base: try scratchFolder(self)); XCTFail("a wrong password signed in") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "wrong-login") }
    // The right password gets the sealed code from the hub; joining with it is recovery, which the binding lacks.
    do { _ = try await Room.signInWithPassword(hubURL: hubURL, email: "ada@example.com", password: "another long password", base: try scratchFolder(self)); XCTFail("recovery is bound: extend this test") }
    catch let refused as TrommiError { XCTAssertEqual(refused.code, "not-built") }

    // KeyPackages: PUT /v2/key-packages takes what the core made, and a claim hands one out.
    XCTAssertNotNil(try device.keyPackagesToUpload(unusedAtHub: 0, nowMs: nowMs()))
    XCTAssertEqual(device.outbox().map(\.kind), [.keyPackages])
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    let claimed = try await room.hub.claimKeyPackages([device.id])
    XCTAssertEqual(claimed.map(\.device), [device.id])
    XCTAssertFalse(claimed[0].keyPackage.isEmpty)

    // A Commit: POST /v2/groups/{group}/commits; the hub's group moves with the device's.
    XCTAssertNotNil(try device.update(group: room.roomId, forced: true, nowMs: nowMs()))
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    XCTAssertEqual(try device.groups().first?.epoch, 1)
    XCTAssertEqual(try device.groups().first?.pending, false)
    let epoch = try await room.hub.groups().first?["epoch"] as? NSNumber
    XCTAssertEqual(epoch, 1)
    // The log gives the Commit back as the client reads it: kind, group_id, bytes, change.
    let log = try await room.hub.changes(after: 0)
    let commits = (log["items"] as? [JSON] ?? []).compactMap(Room.Item.init)
    XCTAssertEqual(commits.count, 1)
    _ = try await room.sync()

    // A relayed message and a file.
    _ = try device.sendStrokePiece(board: ALL_DESKS_BOARD, piece: utf8("{}"))
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    let plain = systemRandom(70_000)
    let reference = try await room.uploadAttachment(plain, fileName: "a.bin", mediaType: "application/octet-stream")
    let fetched = try await room.fetchAttachment(reference)
    XCTAssertEqual(fetched, plain)

    // The stream opens with this device's token.
    let live = Task { await room.runLive() }
    for _ in 0..<100 where !room.live { try await Task.sleep(nanoseconds: 50_000_000) }
    XCTAssertTrue(room.live)
    live.cancel()

    // A human device is added only as the outcome of an invite, which the binding lacks: the hub refuses the Add for
    // good, and the device takes its pending Commit back.
    let other = try LiveDevice(store: MemoryStorage(), create: true)
    _ = try device.addHumanDevice(other.id, keyPackage: try other.keyPackage(nowMs: nowMs()), nowMs: nowMs())
    room.pumpOutbox()
    try await room.flush(timeoutMs: 5_000)
    XCTAssertEqual(try device.groups().first?.epoch, 1)
    XCTAssertEqual(try device.groups().first?.pending, false)
    XCTAssertEqual(try device.groups().first?.leaves, [device.id])
  }
}
