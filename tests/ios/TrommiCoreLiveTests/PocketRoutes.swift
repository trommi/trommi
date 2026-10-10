// PocketRoutes: `PocketHub` (RecoveryTests.swift) behind the hub's routes, answered in the process, so that the
// engine (`Room`, `HubClient`) runs with the real core and no hub. It keeps what PocketHub keeps and checks nothing:
// every check is the core's. Devices of a test that are no `Room` post to the same PocketHub directly.
//
// Routes: signing in (any signature gets a token that names its signer), the proof of a removal, the changes, a group's GroupInfos and log,
// the Welcomes, the sealed keys, the chains, the group list, every outbox kind but a session's founding, the
// recovery transaction, and the account's routes a test fills (`account`, `login`).
import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import TrommiClient
@testable import TrommiCoreLive

final class PocketRoutes: URLProtocol, @unchecked Sendable {
  /// The hub the routes answer from, and what they answer the account's routes with.
  nonisolated(unsafe) static var hub = PocketHub()
  /// GET /v2/account, as the test made it; nil: the room has no account.
  nonisolated(unsafe) static var account: JSON?
  /// POST /v2/account/login and /v2/account/recover: the answer by the `auth_key` sent.
  nonisolated(unsafe) static var logins: [String: JSON] = [:]
  /// Every request, in order: "METHOD /path".
  nonisolated(unsafe) static var asked: [String] = []
  /// A path that is refused once with this code (a hub that fails in the middle of something).
  nonisolated(unsafe) static var refuseOnce: [String: String] = [:]
  /// The bodies of the requests `refuseOnce` refused, in order.
  nonisolated(unsafe) static var refused: [JSON] = []
  /// Devices the hub calls removed (hex of the key): their token names `role: "removed"`, and the removal route
  /// serves them the room group's Commits up to the change number given here (spec/hub-api.md point 42).
  nonisolated(unsafe) static var removed: [String: UInt64] = [:]
  static let url = "http://127.0.0.1:9"

  /// Routes every hub client of the process here, over a fresh PocketHub.
  static func install(_ hub: PocketHub) {
    self.hub = hub; account = nil; logins = [:]; asked = []; refuseOnce = [:]; refused = []; removed = [:]
    HubClient.transportForTests = [PocketRoutes.self]
  }

  private static func refuse(_ status: Int, _ code: String) -> (Int, Any) { (status, ["error": code, "message": "refused"] as JSON) }

  static func answer(_ method: String, _ path: [String], _ query: [String: String], _ body: JSON, token: String?) -> (Int, Any) {
    let hub = self.hub
    hub.lock.lock(); defer { hub.lock.unlock() }
    let line = "\(method) /\(path.joined(separator: "/"))"
    asked.append(line)
    if let code = refuseOnce.removeValue(forKey: line) { refused.append(body); return refuse(code == "internal" ? 500 : 400, code) }
    func bytes(_ field: String, in json: JSON? = nil) -> Bytes { ((json ?? body)[field] as? String).flatMap { try? unb64u($0) } ?? [] }
    func id(_ text: String) -> Bytes { (try? unb64u(text)) ?? [] }
    // (a request's body is read by Foundation, where a 1 may come as a Bool, which the client's own reader of numbers refuses)
    func number(_ value: Any?) -> UInt64 { (value as? NSNumber)?.uint64Value ?? 0 }
    let epoch = number(body["epoch"])
    let sender = token.flatMap { try? unhex($0) } ?? []
    let after = UInt64(query["after"] ?? "0") ?? 0
    switch (method, path.count, path.first ?? "") {
    case ("GET", 3, "rooms") where path[2] == "challenge": return (200, ["challenge": b64u(systemRandom(32))])
    case ("POST", 3, "rooms") where path[2] == "tokens":
      // A signed HubAuth ends with the signer's key and the challenge: the token names the signer.
      let auth = bytes("auth")
      guard auth.count >= 64 else { return refuse(401, "unauthorised") }
      let signer = hex(Bytes(auth[(auth.count - 64)..<(auth.count - 32)]))
      return (200, ["token": signer, "expires_at": nowMs() + 600_000, "role": removed[signer] == nil ? "human" : "removed"])
    case ("GET", 3, "rooms") where path[2] == "groups":
      return (200, hub.infos.keys.sorted { hex($0) < hex($1) }.map { ["group_id": b64u($0), "kind": $0.count == 32 ? "room" : "main", "live": true] as JSON })
    case ("POST", 3, "rooms") where path[2] == "recovery": return (200, ["recovery_id": b64u(Bytes(repeating: 7, count: 16)), "expires_at": nowMs() + 600_000])
    case ("POST", 3, "rooms") where path[2] == "recovery-code":
      let commit = body["commit"] as? JSON ?? [:]
      let at = number(commit["epoch"])
      let account = (body["account"] as? JSON).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { Bytes($0) } ?? []
      let change = hub.take(kind: 10, group: id(path[1]), epoch: at, parts: [bytes("commit", in: commit), bytes("group_info", in: commit), bytes("sealed_key", in: commit), bytes("recovery_link"), account])
      return (200, ["epoch": at + 1, "change": change ?? 0])
    case ("POST", 5, "rooms") where path[4] == "commits":
      _ = hub.take(kind: 11, group: bytes("group_id"), epoch: epoch, parts: [bytes("commit"), bytes("group_info"), bytes("welcome"), bytes("sealed_key"), bytes("recovery_auth")])
      return (200, ["epoch": epoch + 1, "kept": true])
    case ("POST", 5, "rooms") where path[4] == "finish":
      let account = (body["account"] as? JSON).flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { Bytes($0) } ?? []
      let change = hub.take(kind: 12, group: id(path[1]), epoch: 0, parts: [bytes("recovery_link"), account])
      return (200, ["published": true, "change": change ?? 0])
    case ("GET", 3, "groups") where path[2] == "info":
      let all = hub.infos[id(path[1])] ?? [:]
      let wanted = query["epoch"].flatMap { UInt64($0) } ?? all.keys.max() ?? 0
      guard let info = all[wanted] else { return refuse(404, "not-found") }
      return (200, ["epoch": wanted, "group_info": b64u(info)])
    case ("GET", 3, "groups") where path[2] == "removal":
      guard let token = token, let last = removed[token] else { return refuse(404, "not-found") }
      var items = [JSON](), n: UInt64 = 0
      for entry in hub.log where entry.group == id(path[1]) {
        n += 1
        guard case .commit(let commit, let recoveryAuth) = entry.kind, entry.change <= last, n > after else { continue }
        var item: JSON = ["n": n, "change": entry.change, "kind": "commit", "bytes": b64u(commit)]
        if let recoveryAuth { item["recovery_auth"] = b64u(recoveryAuth) }
        items.append(item)
      }
      // (two to a page: a proof is read over more than one)
      return (200, ["items": Array(items.prefix(2)), "more": items.count > 2, "removed_at": n])
    case ("GET", 3, "groups") where path[2] == "log":
      // (a group's entries are numbered from 1; a Commit builds on the epoch the Commits before it led to)
      var items = [JSON](), n: UInt64 = 0, commits: UInt64 = 0
      for entry in hub.log where entry.group == id(path[1]) {
        n += 1
        var item: JSON = ["n": n, "change": entry.change]
        switch entry.kind {
        case .commit(let commit, let recoveryAuth):
          item["kind"] = "commit"; item["epoch"] = commits; item["bytes"] = b64u(commit)
          if let recoveryAuth { item["recovery_auth"] = b64u(recoveryAuth) }
          commits += 1
        case .message(let message): item["kind"] = "message"; item["epoch"] = commits; item["bytes"] = b64u(message)
        }
        if n > after { items.append(item) }
      }
      return (200, ["items": items, "more": false])
    case ("GET", 4, "groups") where path[2] == "chains":
      var seq: UInt64 = 0
      let items = hub.chains.filter { $0.group == id(path[1]) && $0.sender == id(path[3]) }.map { e -> JSON in seq += 1; return ["change": e.change, "envelope": b64u(e.bytes), "seq": seq] }
      return (200, ["items": items.filter { number($0["seq"]) > after }, "more": false])
    case ("POST", 3, "groups") where path[2] == "commits":
      let join = bytes("recovery_auth")
      let parts = join.isEmpty ? [bytes("commit"), bytes("group_info"), bytes("welcome"), bytes("sealed_key")] : [bytes("commit"), bytes("group_info"), bytes("sealed_key"), join]
      let change = hub.take(kind: join.isEmpty ? 3 : 4, group: id(path[1]), epoch: epoch, parts: parts)
      return (200, ["epoch": epoch + 1, "change": change ?? 0])
    case ("POST", 3, "groups") where path[2] == "messages":
      if body["relay"] as? Bool == true { return (200, ["n": NSNull()]) }
      _ = hub.take(kind: 5, group: id(path[1]), epoch: epoch, parts: [bytes("message")])
      return (200, ["n": 1])
    case ("POST", 1, "envelopes"): return (200, ["change": hub.take(kind: 7, group: [], epoch: 0, parts: [bytes("envelope")], sender: sender) ?? 0])
    case ("GET", 1, "changes"):
      // The log's entries and the envelopes in one order, by change number.
      var items = [(change: UInt64, item: JSON)](), numbers: [GroupId: UInt64] = [:]
      for entry in hub.log {
        numbers[entry.group, default: 0] += 1
        var item: JSON = ["change": entry.change, "group_id": b64u(entry.group), "n": numbers[entry.group] ?? 0]
        switch entry.kind {
        case .commit(let commit, let recoveryAuth):
          item["kind"] = "commit"; item["bytes"] = b64u(commit)
          if let recoveryAuth { item["recovery_auth"] = b64u(recoveryAuth) }
        case .message(let message): item["kind"] = "message"; item["bytes"] = b64u(message)
        }
        items.append((entry.change, item))
      }
      for e in hub.envelopes { items.append((e.change, ["kind": "envelope", "change": e.change, "envelope": b64u(e.bytes)])) }
      let limit = Int(query["limit"] ?? "500") ?? 500
      let page = items.filter { $0.change > after }.sorted { $0.change < $1.change }.prefix(limit)
      let upTo = page.last?.change ?? hub.change
      return (200, ["items": page.map(\.item), "change": upTo, "more": upTo < hub.change])
    case ("GET", 1, "welcomes"): return (200, hub.welcomes.map { ["welcome": b64u($0)] as JSON })
    case ("PUT", 1, "key-packages"): return (200, ["unused": 100])
    case ("PUT", 1, "sealed-keys"):
      _ = hub.take(kind: 9, group: [], epoch: 0, parts: [bytes("sealed_key")])
      return (200, JSON())
    case ("GET", 1, "sealed-keys"):
      return (200, ["rows": hub.sealedKeys.map { ["sealed_key": b64u($0)] as JSON }, "links": hub.links.map { ["recovery_link": b64u($0)] as JSON }, "more": false])
    case ("GET", 1, "account"): return account.map { (200, $0) } ?? refuse(404, "not-found")
    case ("POST", 2, "account") where path[1] == "login" || path[1] == "recover":
      return logins[body["auth_key"] as? String ?? ""].map { (200, $0) } ?? refuse(401, path[1] == "login" ? "wrong-login" : "wrong-recovery")
    case ("PUT", 2, "account"), ("DELETE", _, _): return (200, JSON())
    default: return refuse(404, "not-found")
    }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}
  override func startLoading() {
    guard let url = request.url else { return }
    var query = [String: String]()
    for q in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] { query[q.name] = q.value }
    var data = request.httpBody ?? Data()
    if data.isEmpty, let s = request.httpBodyStream {
      s.open()
      var buffer = [UInt8](repeating: 0, count: 65536)
      while s.hasBytesAvailable { let n = s.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
      s.close()
    }
    let body = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
    let token = request.value(forHTTPHeaderField: "authorization").map { String($0.dropFirst("Bearer ".count)) }
    let (status, answer) = Self.answer(request.httpMethod ?? "GET", Array(url.path.split(separator: "/").map(String.init).dropFirst()), query, body, token: token)
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: answer))
    client?.urlProtocolDidFinishLoading(self)
  }
}

/// A `Room` over a device a test made, in a folder of its own: what RoomAccount.swift does once a device is in a room.
@MainActor func pocketRoom(_ test: XCTestCase, room: RoomId, past: PastWork? = nil, tools: LiveCore, enter: (LiveDevice) throws -> Void) throws -> Room {
  let store = try Store.new(base: try scratchFolder(test))
  let state = try store.openState(create: true)
  let device = try XCTUnwrap(try tools.createDevice(store: state) as? LiveDevice)
  try enter(device)
  let record = RoomRecord(hubURL: PocketRoutes.url, roomId: hex(room), myDeviceId: hex(device.id), role: "human", deviceRegisterSent: false, past: past)
  try store.save(record)
  return try Room(store: store, record: record, deviceStore: state, device: device)
}
