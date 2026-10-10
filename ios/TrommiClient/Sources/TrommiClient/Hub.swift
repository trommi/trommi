// Hub.swift: the hub's routes as a client needs them (spec/hub-api.md, normative). Every route is under /v2; bodies
// are JSON; byte strings are base64url; an MLS message, a GroupInfo, a KeyPackage and an envelope travel as their
// bytes in one string. A refusal is { error, message } with the status of spec/v2.md section 16.
//
// The hub is not trusted with content and is not believed about it: what it returns goes to the core, which checks
// signatures, chains and group state. This file only moves bytes and keeps the sign-in token.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public typealias JSON = [String: Any]

public struct HubError: Error, CustomStringConvertible {
  public let status: Int
  public let code: String
  public let message: String
  /** The rest of the error body (minimum_version, voided, …). */
  public var extra: JSON = [:]
  /** The seconds the hub asks to wait before the next try (`rate-limited`, `overloaded`); nil when it names none. */
  public var retryAfter: Int?
  public var description: String { "\(code) (\(status)): \(message)" }
  /** The request never got an answer: nothing is known about whether the hub took it. */
  public var isOffline: Bool { status == 0 }
}

/**
 * What of an error may go into a log: a code this app knows (the hub's table, the client's own transport codes, a
 * TrommiError's code) and the status, never a message or a code the hub made up, which could carry what was sent.
 */
public func loggable(_ error: Error) -> String {
  let local: Set<String> = ["offline", "too-large", "closed", "unauthorised", "rate-limited", "overloaded", "internal", "not-found", "not-member", "bad-format", "timeout", "pending"]
  func plain(_ code: String) -> Bool { !code.isEmpty && code.count <= 40 && code.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") } }
  func known(_ code: String) -> String { plain(code) && (local.contains(code) || (Core.isInstalled && Core.tools.isFinalRefusal(code))) ? code : "other" }
  if let h = error as? HubError { return "\(known(h.code)) (\(h.status))" }
  if let t = error as? TrommiError { return plain(t.code) ? t.code : "other" }
  return "error"
}

public final class HubClient: @unchecked Sendable {
  public static let clientName = "ios/0.2.0"
  /** This app's version, as it names itself to the hub ("ios/<version>"). */
  public static var appVersion: String { String(clientName.split(separator: "/").last ?? "0.0.0") }

  /** The hub's canonical address (the core checked it: `CoreTools.canonicalHub`). */
  public let hubURL: String
  public let room: RoomId
  /** Signs a challenge as this device (or as the recovery key while it joins). nil: only routes without a token. */
  public var signer: CoreSigner?
  /** An agent device's lease (13.7); a human device has none. */
  private let lock = NSLock()
  private var token: String?
  private var tokenExpiresAt: UInt64 = 0

  /** Tests answer the hub's routes in the process (URLProtocol classes); empty in the app. */
  nonisolated(unsafe) static var transportForTests: [AnyClass] = []
  /** The largest answer taken: of a JSON route, and of a file (the largest stored file of spec/v2.md section 11). */
  static let maxJSON = 16 << 20, maxFile = (64 << 20) + (1 << 20)
  private var transport = Transport()
  /** A fresh connection pool (after a transport failure: the hub restarted and closed the pooled connections). */
  private func renewTransport() { let old = lock.withLock { () -> Transport in let o = transport; transport = Transport(); return o }; old.end() }

  /** `room` empty: a handle for the routes outside a room (account, founding, invites, shares). */
  public init(hubURL: String, room: RoomId = [], signer: CoreSigner? = nil) throws {
    guard let url = URL(string: hubURL), let scheme = url.scheme, scheme == "https" || (scheme == "http" && Self.isLoopback(url.host)) else {
      // Plain http only to this machine (tests, a hub on the same host): a token never crosses a network in the clear.
      throw TrommiError("bad-argument", "the hub's address must be https")
    }
    guard room.isEmpty || room.count == 32 else { throw TrommiError("bad-argument", "a room id is 32 bytes") }
    self.hubURL = hubURL.hasSuffix("/") ? String(hubURL.dropLast()) : hubURL
    self.room = room
    self.signer = signer
  }
  static func isLoopback(_ host: String?) -> Bool { host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1" }

  static func json(_ data: Data) -> JSON? { FastJSON.parse([UInt8](data))?.any as? JSON }

  // ---- one request ---------------------------------------------------------------------------------------

  private func url(_ path: String, _ query: [String: String]) -> URL {
    var comps = URLComponents(string: "\(hubURL)/v2\(path)")!
    if !query.isEmpty { comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
    return comps.url!
  }
  /** A request with the headers every route wants; `auth`: with this device's token. */
  public func urlRequest(_ method: String, _ path: String, query: [String: String] = [:], auth: Bool = true, headers: [String: String] = [:]) async throws -> URLRequest {
    var req = URLRequest(url: url(path, query))
    req.httpMethod = method
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
    if auth { req.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "authorization") }
    return req
  }

  /** One JSON exchange. A 401 with a token is tried once more with a fresh one (a hub that restarted forgot it). */
  @discardableResult
  public func request(_ method: String, _ path: String, query: [String: String] = [:], body: JSON? = nil, auth: Bool = true, headers: [String: String] = [:]) async throws -> JSON {
    let (data, _) = try await exchange(method, path, query: query, body: body.map { try JSONSerialization.data(withJSONObject: $0) }, contentType: "application/json", auth: auth, headers: headers)
    return HubClient.json(data) ?? [:]
  }
  /** An answer that is a JSON array (GET /v2/welcomes, /v2/rooms/{room}/groups). */
  public func requestList(_ method: String, _ path: String, query: [String: String] = [:]) async throws -> [JSON] {
    let (data, _) = try await exchange(method, path, query: query, body: nil, contentType: nil, auth: true, headers: [:])
    return (FastJSON.parse([UInt8](data))?.any as? [Any])?.compactMap { $0 as? JSON } ?? []
  }

  private func exchange(_ method: String, _ path: String, query: [String: String], body: Data?, contentType: String?, auth: Bool, headers: [String: String], retried: Bool = false) async throws -> (Data, HTTPURLResponse?) {
    var req = try await urlRequest(method, path, query: query, auth: auth, headers: headers)
    if let body = body {
      req.httpBody = body
      req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "content-type")
    }
    let (data, response) = try await send(req, cap: path.hasPrefix("/files/") ? Self.maxFile : Self.maxJSON)
    let status = response?.statusCode ?? 0
    if status == 401 && auth && !retried {
      forgetToken()
      return try await exchange(method, path, query: query, body: body, contentType: contentType, auth: auth, headers: headers, retried: true)
    }
    if status < 200 || status >= 300 {   // (a redirect is not followed and is no success)
      let json = HubClient.json(data) ?? [:]
      // (a wait is named in the body and in the header alike, spec/hub-api.md point 41: either is taken)
      let wait = (json["retry_after"] as? NSNumber)?.intValue ?? response?.value(forHTTPHeaderField: "retry-after").flatMap { Int($0) }
      throw HubError(status: status, code: json["error"] as? String ?? "http-\(status)", message: json["message"] as? String ?? "", extra: json, retryAfter: wait.map { max(1, $0) })
    }
    return (data, response)
  }

  /**
   * One HTTP exchange, tried once more on a transport failure. That is safe for every route: the hub answers a
   * repeated post of the same bytes with its first answer (spec/hub-api.md, last line), and everything this client
   * posts is the exact bytes of an outbox entry or an idempotent write.
   */
  private func send(_ req: URLRequest, cap: Int) async throws -> (Data, HTTPURLResponse?) {
    guard !lock.withLock({ shut }) else { throw HubError(status: 0, code: "closed", message: "this hub client was closed") }
    do { return try await lock.withLock({ transport }).send(req, cap: cap) }
    catch let f as Transport.Failure {
      if f.tooLarge { throw HubError(status: 0, code: "too-large", message: "the hub's answer is larger than this client takes") }
      renewTransport()
      try? await Task.sleep(nanoseconds: 250_000_000)
      do { return try await lock.withLock({ transport }).send(req, cap: cap) }
      catch let g as Transport.Failure { throw HubError(status: 0, code: g.tooLarge ? "too-large" : "offline", message: "hub not reachable: \(g.message)") }
    }
  }

  // ---- signing in (12.3) ---------------------------------------------------------------------------------

  public func accessToken() async throws -> String {
    if let t = tokenNow(validFor: 60_000) { return t }
    try await signIn()
    guard let fresh = tokenNow(validFor: 0) else { throw TrommiError("unauthorised", "the hub gave no token") }
    return fresh
  }
  /**
   * Ends this client for good (its room was closed): what is in flight is cancelled, nothing more is sent, and a
   * late answer installs no token.
   */
  public func shutdown() {
    let t = lock.withLock { () -> Transport in shut = true; token = nil; tokenExpiresAt = 0; return transport }
    t.cancel()
  }
  private var shut = false
  public func forgetToken() { setToken(nil, expiresAt: 0) }
  /**
   * Signing out (spec/hub-api.md): `DELETE /v2/token` ends the token this client holds, at once, and the hub cuts
   * the streams opened with it. Best effort: no token, no request; an answer is not waited on for anything.
   */
  public func signOut() async {
    guard let held = tokenNow(validFor: 0) else { return }
    var req = URLRequest(url: url("/token", [:]))
    req.httpMethod = "DELETE"
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    req.setValue("Bearer \(held)", forHTTPHeaderField: "authorization")
    _ = try? await send(req, cap: Self.maxJSON)
    forgetToken()
  }
  private func tokenNow(validFor ms: UInt64) -> String? { lock.withLock { token.flatMap { nowMs() + ms < tokenExpiresAt ? $0 : nil } } }
  private func setToken(_ t: String?, expiresAt: UInt64) { lock.withLock { if !shut || t == nil { token = t; tokenExpiresAt = expiresAt } } }

  /**
   * A challenge signed by this device for this hub and room, traded for a token of ten minutes. `challenge`: one the
   * hub handed out already (a login answer carries one); a refused one is asked anew. The role the hub names is
   * returned for display only: what a device may do is decided by the group state the core holds.
   */
  @discardableResult public func signIn(challenge given: Bytes? = nil) async throws -> String {
    if let given = given {
      do { return try await takeToken(given) }
      catch let e as HubError where e.status == 401 || e.status == 400 {}
    }
    let r = try await request("GET", "/rooms/\(b64u(room))/challenge", auth: false)
    guard let c = (r["challenge"] as? String).flatMap({ try? unb64u($0) }), c.count == 32 else { throw TrommiError("bad-format", "the hub's challenge is not 32 bytes") }
    return try await takeToken(c)
  }
  private func takeToken(_ challenge: Bytes) async throws -> String {
    guard let signer = signer else { throw TrommiError("unauthorised", "no signer for this hub client") }
    let signed = try signer.signHubAuth(room: room, hub: hubURL, challenge: challenge)
    let r = try await request("POST", "/rooms/\(b64u(room))/tokens", body: ["auth": b64u(signed.auth), "signature": b64u(signed.signature)], auth: false)
    guard let t = r["token"] as? String, !t.isEmpty else { throw TrommiError("unauthorised", "the hub gave no token") }
    setToken(t, expiresAt: Wire.uint(r["expires_at"]) ?? 0)
    return r["role"] as? String ?? ""
  }

  // ---- catching up and the stream ------------------------------------------------------------------------

  /** Everything this device may see with a change number above `after`, in the hub's order: { items, change, more }. */
  public func changes(after: UInt64, limit: Int = 500) async throws -> JSON {
    try await request("GET", "/changes", query: ["after": String(after), "limit": String(limit)])
  }
  /** The request of the live stream (server-sent events), resuming after a change number. */
  public func streamRequest(after: UInt64) async throws -> URLRequest {
    var req = try await urlRequest("GET", "/stream", query: ["after": String(after)])
    req.setValue("text/event-stream", forHTTPHeaderField: "accept")
    req.timeoutInterval = 3600
    return req
  }
  /** What the Desk shows without history: open objects' newest envelopes, the registers, the groups. */
  public func desk() async throws -> JSON { try await request("GET", "/desk") }
  public func groups() async throws -> [JSON] { try await requestList("GET", "/rooms/\(b64u(room))/groups") }
  public func welcomes() async throws -> [JSON] { try await requestList("GET", "/welcomes") }
  public func groupInfo(_ group: GroupId, epoch: UInt64? = nil) async throws -> JSON {
    try await request("GET", "/groups/\(b64u(group))/info", query: epoch.map { ["epoch": String($0)] } ?? [:])
  }
  public func groupLog(_ group: GroupId, after: UInt64, limit: Int = 500) async throws -> JSON {
    try await request("GET", "/groups/\(b64u(group))/log", query: ["after": String(after), "limit": String(limit)])
  }
  /**
   * A group's public history from its founding: the GroupInfo of epoch 0 and every Commit of its log, in the hub's
   * order. `reached`: the epoch the last Commit read leads to. Nothing in it is trusted: the core checks it.
   */
  /** The most a client reads of what the hub serves page by page for one check (a history, the sealed keys, the chains). */
  public static let maxServed = 128 << 20
  public func history(of group: GroupId) async throws -> (founding: Bytes, commits: [PastCommit], reached: UInt64) {
    func bytes(_ json: JSON, _ field: String) throws -> Bytes {
      guard let text = json[field] as? String, let bytes = try? unb64u(text), !bytes.isEmpty else { throw TrommiError("bad-format", "the hub's answer has no \(field)") }
      return bytes
    }
    let founding = try bytes(try await groupInfo(group, epoch: 0), "group_info")
    var commits = [PastCommit](), after: UInt64 = 0, reached: UInt64 = 0, total = founding.count
    while true {
      let page = try await groupLog(group, after: after)
      let items = page["items"] as? [JSON] ?? []
      for item in items {
        guard let n = Wire.uint(item["n"]), n > after else { throw TrommiError("bad-format", "the hub's log of a group is not in order") }
        after = n
        guard item["kind"] as? String == "commit" else { continue }
        guard let change = Wire.uint(item["change"]), let epoch = Wire.uint(item["epoch"]) else { throw TrommiError("bad-format", "a Commit of the hub's log has no change number or epoch") }
        let commit = try bytes(item, "bytes")
        total += commit.count
        guard total <= Self.maxServed else { throw TrommiError("too-large", "a group's history is larger than this client reads") }
        commits.append((change, commit, (item["recovery_auth"] as? String).flatMap { try? unb64u($0) }))
        reached = epoch + 1
      }
      guard page["more"] as? Bool == true, !items.isEmpty else { return (founding, commits, reached) }
    }
  }
  /** A page of a Chat, newest first below `before` (a change number). `timeline`: "session/<hex>" or "card/<hex>". */
  public func chatItems(timeline: String, before: UInt64? = nil, limit: Int = 50) async throws -> JSON {
    var q = ["limit": String(limit)]
    if let b = before { q["before"] = String(b) }
    return try await request("GET", "/chats/\(timeline)/items", query: q)
  }
  public func boardItems(_ board: BoardId, afterChange: UInt64) async throws -> JSON {
    try await request("GET", "/boards/\(hex(board))", query: ["after_change": String(afterChange)])
  }
  /** A sender's envelopes in pruned form, by number (chain checks: 9.0.6, 10.3). */
  public func chain(group: GroupId, sender: DeviceId, after: UInt64, limit: Int = 500) async throws -> JSON {
    try await request("GET", "/groups/\(b64u(group))/chains/\(b64u(sender))", query: ["after": String(after), "limit": String(limit)])
  }
  /** Every envelope of an object. `kind`: cards, notes, permission-requests, artifacts. */
  public func object(kind: String, _ object: ObjectId) async throws -> JSON { try await request("GET", "/\(kind)/\(hex(object))") }

  // ---- the outbox: one route per kind (core/src/store.rs `OutboxKind`) ------------------------------------

  /**
   * Posts one outbox entry exactly as the core made it; the hub's answer, of which the core wants `change`. A
   * repeated post of the same bytes gets the first answer again, so sending an entry twice after a crash is safe.
   */
  public func post(_ e: OutboxEntry, account: JSON? = nil, foundToken: String? = nil, recovery: Bytes? = nil) async throws -> JSON {
    /** The account's sealed copies as the core kept them in the entry (the JSON of the hub's `account` object). */
    func accountPart(_ i: Int) -> Any { account ?? (i < e.parts.count ? (try? JSONSerialization.jsonObject(with: Data(e.parts[i]))) as? JSON : nil) ?? NSNull() }
    func part(_ i: Int) -> String { i < e.parts.count ? b64u(e.parts[i]) : "" }
    func optional(_ i: Int) -> Any { i < e.parts.count && !e.parts[i].isEmpty ? b64u(e.parts[i]) as Any : NSNull() }
    let group = e.group.map { b64u($0) } ?? ""
    switch e.kind {
    case .roomFounding:
      var body: JSON = ["group_info": part(0), "sealed_key": part(1)]
      if let a = account { body["account"] = a }
      return try await request("POST", "/rooms", body: body, auth: false, headers: foundToken.map { ["x-found-token": $0] } ?? [:])
    case .groupFounding:
      return try await request("POST", "/groups", body: ["group_info_0": part(0), "sealed_key_0": part(1), "commit": part(2), "group_info": part(3), "welcome": optional(4), "sealed_key": part(5)])
    case .commit:
      return try await request("POST", "/groups/\(group)/commits", body: ["epoch": e.epoch, "commit": part(0), "group_info": part(1), "welcome": optional(2), "sealed_key": part(3)])
    case .externalCommit:
      return try await request("POST", "/groups/\(group)/commits", body: ["epoch": e.epoch, "commit": part(0), "group_info": part(1), "sealed_key": part(2), "recovery_auth": optional(3)])
    case .message, .relayMessage:
      return try await request("POST", "/groups/\(group)/messages", body: ["epoch": e.epoch, "message": part(0), "relay": e.kind == .relayMessage])
    case .envelope:
      return try await request("POST", "/envelopes", body: ["envelope": part(0)])
    case .keyPackages:
      var body: JSON = ["single_use": e.parts.dropFirst().map { b64u($0) }]
      if let last = e.parts.first, !last.isEmpty { body["last_resort"] = b64u(last) }
      return try await request("PUT", "/key-packages", body: body)
    case .sealedKey:
      return try await request("PUT", "/sealed-keys", body: ["sealed_key": part(0)])
    case .recoveryCode:
      return try await request("POST", "/rooms/\(b64u(room))/recovery-code", body: ["commit": ["epoch": e.epoch, "commit": part(0), "group_info": part(1), "sealed_key": part(2)] as JSON, "recovery_link": part(3), "account": accountPart(4)])
    case .recoveryCommit, .recoveryFinish:
      guard let id = recovery else { throw TrommiError("incomplete", "a part of a recovery is posted into the recovery it was built for") }
      if e.kind == .recoveryFinish { return try await request("POST", "/rooms/\(b64u(room))/recovery/\(b64u(id))/finish", body: ["recovery_link": part(0), "account": accountPart(1)]) }
      return try await request("POST", "/rooms/\(b64u(room))/recovery/\(b64u(id))/commits", body: ["group_id": group, "epoch": e.epoch, "commit": part(0), "group_info": part(1), "welcome": optional(2), "sealed_key": part(3), "recovery_auth": optional(4)])
    }
  }
  /** One KeyPackage of each device, all or nothing (5.2.7, 12.1). */
  public func claimKeyPackages(_ devices: [DeviceId]) async throws -> [(device: DeviceId, keyPackage: Bytes)] {
    let r = try await request("POST", "/key-packages/claim", body: ["devices": devices.map { b64u($0) }])
    return try (r["key_packages"] as? [String: String] ?? [:]).map { (try unb64u($0.key), try unb64u($0.value)) }
  }
  /** The wishes of signed-in devices to the human devices (readmit, handover, session). Nothing follows without a Commit. */
  public func requests() async throws -> [JSON] { try await requestList("GET", "/requests") }

  // ---- files (11) ----------------------------------------------------------------------------------------

  /** A file's stored bytes, or with `range` (first, last: inclusive) that stretch of them. */
  public func getFile(_ id: FileId, range: (first: UInt64, last: UInt64)? = nil) async throws -> Bytes {
    let (data, _) = try await exchange("GET", "/files/\(b64u(id))", query: [:], body: nil, contentType: nil, auth: true,
                                       headers: range.map { ["range": "bytes=\($0.first)-\($0.last)"] } ?? [:])
    return Bytes(data)
  }
  public func putFile(_ id: FileId, _ stored: Bytes) async throws {
    _ = try await exchange("PUT", "/files/\(b64u(id))", query: [:], body: Data(stored), contentType: "application/octet-stream", auth: true, headers: [:])
  }
  public func deleteFile(_ id: FileId) async throws { try await request("DELETE", "/files/\(b64u(id))") }

  // ---- invites (12.1), by invite id only -----------------------------------------------------------------

  /** The signed Offer of an invite: { offer, signature }. */
  public func getInvite(_ invite: Bytes) async throws -> JSON { try await request("GET", "/invites/\(b64u(invite))", auth: false) }
  public func postInviteRequest(_ invite: Bytes, request r: Bytes, mac: Bytes, signature: Bytes) async throws {
    try await request("POST", "/invites/\(b64u(invite))/request", body: ["request": b64u(r), "mac": b64u(mac), "signature": b64u(signature)], auth: false)
  }
  /** The signed Reveal once the inviter published it: { reveal, signature }; `not-found` until then. */
  public func getInviteReveal(_ invite: Bytes) async throws -> JSON { try await request("GET", "/invites/\(b64u(invite))/reveal", auth: false) }
  public func postInvite(offer: Bytes, signature: Bytes) async throws { try await request("POST", "/invites", body: ["offer": b64u(offer), "signature": b64u(signature)]) }
  /** The invite as its inviter sees it: with the Requests that came. */
  public func getInviteRequests(_ invite: Bytes) async throws -> JSON { try await request("GET", "/invites/\(b64u(invite))") }
  public func putInviteReveal(_ invite: Bytes, reveal: Bytes, signature: Bytes) async throws {
    try await request("PUT", "/invites/\(b64u(invite))/reveal", body: ["reveal": b64u(reveal), "signature": b64u(signature)])
  }
  public func deleteInvite(_ invite: Bytes) async throws { try await request("DELETE", "/invites/\(b64u(invite))") }

  // ---- push (15) ------------------------------------------------------------------------------------------

  /**
   * This device's push registrations, as the Devices page shows them: device id (hex) to how many of each kind and
   * the level. A v2 hub tells a device only its own (GET /v2/push), so other devices have no entry.
   */
  public func pushStates() async throws -> [String: (web: Int, apns: Int, level: String)] {
    guard let me = signer?.id else { return [:] }
    let rows = try await requestList("GET", "/push")
    guard !rows.isEmpty else { return [:] }
    let apns = rows.filter { $0["kind"] as? String == "apns" }.count
    return [hex(me): (rows.count - apns, apns, rows.first?["level"] as? String ?? "all")]
  }

  // ---- the hub's version ---------------------------------------------------------------------------------

  /**
   * Which client versions the hub serves; nil when it does not say (a v2 hub has no such route yet and answers
   * every request of a client that is too old with 426 client-too-old).
   */
  public func versionInfo() async throws -> HubVersionInfo? {
    var req = URLRequest(url: url("/version", [:]))
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    let (data, response) = try await send(req, cap: Self.maxJSON)
    if response?.statusCode == 426 {
      let json = HubClient.json(data) ?? [:]
      return HubVersionInfo(minimumClientVersions: ["ios": json["minimum_version"] as? String ?? "999.0.0"], message: json["message"] as? String)
    }
    guard response?.statusCode == 200 else { return nil }
    return HubVersionInfo.parse(data)
  }
}

/**
 * The connections to the hub: answers are read in pieces and given up once they pass the caller's bound (the hub is
 * not trusted with this device's memory), and a redirect is never followed (a token, a push key or a ticket must
 * not travel to another address than the hub's).
 */
final class Transport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  struct Failure: Error { let message: String; var tooLarge = false }
  private struct Pending { var data = Data(); var cap: Int; var over = false; let done: CheckedContinuation<(Data, HTTPURLResponse?), Error> }
  private let lock = NSLock()
  private var pending: [Int: Pending] = [:]
  private var session: URLSession!

  override init() {
    super.init()
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 30
    // No cookies, no cache, no credentials store: the token is the only state and lives in memory.
    cfg.httpCookieStorage = nil; cfg.urlCache = nil; cfg.urlCredentialStorage = nil
    if !HubClient.transportForTests.isEmpty { cfg.protocolClasses = HubClient.transportForTests }
    session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
  }
  private var ended = false
  /** No new requests; those in flight finish. */
  func end() { lock.withLock { ended = true }; session.finishTasksAndInvalidate() }
  /** Ends every request in flight as well. */
  func cancel() { lock.withLock { ended = true }; session.invalidateAndCancel() }

  func send(_ req: URLRequest, cap: Int) async throws -> (Data, HTTPURLResponse?) {
    try await withCheckedThrowingContinuation { cont in
      // (made and registered under the lock: a session that was ended makes no task)
      let task = lock.withLock { () -> URLSessionDataTask? in
        if ended { return nil }
        let t = session.dataTask(with: req)
        pending[t.taskIdentifier] = Pending(cap: cap, done: cont)
        return t
      }
      if let task = task { task.resume() } else { cont.resume(throwing: Failure(message: "the connection pool was closed")) }
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)   // the 3xx answer itself is what the caller gets
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let over = lock.withLock { () -> Bool in
      guard var p = pending[dataTask.taskIdentifier], !p.over else { return false }
      if p.data.count + data.count > p.cap { p.over = true; p.data = Data() } else { p.data.append(data) }
      pending[dataTask.taskIdentifier] = p
      return p.over
    }
    if over { dataTask.cancel() }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let p = lock.withLock({ pending.removeValue(forKey: task.taskIdentifier) }) else { return }
    if p.over { p.done.resume(throwing: Failure(message: "answer too large", tooLarge: true)) }
    else if let error = error { p.done.resume(throwing: Failure(message: error.localizedDescription)) }
    else { p.done.resume(returning: (p.data, task.response as? HTTPURLResponse)) }
  }
}
