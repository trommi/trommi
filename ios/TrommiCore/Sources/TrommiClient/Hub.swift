// Hub.swift: the hub's wire protocol (README "Hub v1: the wire protocol"), the routes a human device needs to join,
// sign in, catch up and answer. Like shared/transport.mjs: JSON bodies, base64url bytes, hex ids, sign-in by a signed
// challenge, Trommi-Client and Trommi-Protocol on every request.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import TrommiCore

public typealias JSON = [String: Any]

public struct HubError: Error, CustomStringConvertible {
  public let status: Int
  public let code: String
  public let message: String
  /** The rest of the error body (minimum_version, voided, envelope_number, …). */
  public var extra: JSON = [:]
  public var description: String { "\(code) (\(status)): \(message)" }
}

public final class HubClient {
  public static let clientName = "ios/0.1.0"
  public let hubURL: String
  public let roomId: String
  /** Signs a challenge as this device (or the recovery key). nil: only anonymous routes. */
  public var signer: Device?
  private var token: String?
  private var tokenExpiresAt: UInt64 = 0
  private let session: URLSession

  public init(hubURL: String, roomId: String, signer: Device? = nil) throws {
    self.hubURL = try checkHubAddress(hubURL)
    if roomId.utf8.count != 64 || (try? unhex(roomId)) == nil { throw ZError("bad-argument", "room_id must be 64 lowercase hex characters") }
    self.roomId = roomId
    self.signer = signer
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 30
    session = URLSession(configuration: cfg)
  }

  /** A handle for the anonymous routes outside a room (POST accounts/login). */
  public init(hubURL: String) throws {
    self.hubURL = try checkHubAddress(hubURL)
    roomId = ""
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 30
    session = URLSession(configuration: cfg)
  }

  private func roomPath(_ p: String) -> String { "/rooms/\(roomId)\(p)" }
  private static func checkHex(_ v: String, _ n: Int, _ what: String) throws -> String {
    if v.utf8.count != n || (try? unhex(v)) == nil { throw ZError("bad-argument", "\(what) must be \(n) lowercase hex characters") }
    return v
  }

  // ---- one request ----------------------------------------------------------------------

  public func request(_ method: String, _ path: String, query: [String: String] = [:], body: JSON? = nil, auth: Bool = true, retried: Bool = false) async throws -> JSON {
    var comps = URLComponents(string: "\(hubURL)/v1\(path)")!
    if !query.isEmpty { comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
    var req = URLRequest(url: comps.url!)
    req.httpMethod = method
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    req.setValue("1", forHTTPHeaderField: "trommi-protocol")
    if auth { req.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "authorization") }
    if let body = body {
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
      req.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    let (data, status) = try await send(req)
    if status == 401 && auth && !retried { token = nil; return try await request(method, path, query: query, body: body, auth: auth, retried: true) }
    let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
    if status >= 400 || status < 200 {
      throw HubError(status: status, code: json["error"] as? String ?? "http-\(status)", message: json["message"] as? String ?? "", extra: json)
    }
    return json
  }

  private func send(_ req: URLRequest) async throws -> (Data, Int) {
    try await withCheckedThrowingContinuation { cont in
      session.dataTask(with: req) { data, res, err in
        if let err = err { cont.resume(throwing: HubError(status: 0, code: "offline", message: "hub not reachable: \(err.localizedDescription)")); return }
        cont.resume(returning: (data ?? Data(), (res as? HTTPURLResponse)?.statusCode ?? 0))
      }.resume()
    }
  }

  // ---- sign-in ----------------------------------------------------------------------------

  public func accessToken() async throws -> String {
    if let t = token, nowMs() + 60_000 < tokenExpiresAt { return t }
    try await signIn()
    return token!
  }
  /**
   * given: a challenge the hub handed out already (the login answer carries one), so the sign-in costs one round trip;
   * a refused one (expired, a restarted hub) is asked anew.
   */
  @discardableResult public func signIn(challenge given: String? = nil) async throws -> JSON {
    if let given = given {
      do { return try await takeToken(given) }
      catch let e as HubError where e.status == 401 || e.status == 400 {}
    }
    let ch = try await request("POST", roomPath("/challenge"), auth: false)
    return try await takeToken(ch["challenge"] as? String ?? "")
  }
  private func takeToken(_ b64: String) async throws -> JSON {
    guard let signer = signer else { throw ZError("unauthorised", "no signer for this hub client") }
    let challenge = try unb64u(b64)
    let signed = try signHubAuth(device: signer, roomId: try unhex(roomId), hub: hubURL, challenge: challenge)
    let r = try await request("POST", roomPath("/access_tokens"), body: ["signed_challenge": b64u(signed)], auth: false)
    token = r["access_token"] as? String
    tokenExpiresAt = (r["expires_at"] as? NSNumber)?.uint64Value ?? 0
    return r
  }

  // ---- routes -----------------------------------------------------------------------------

  public func getInvite(_ inviteId: String) async throws -> JSON {
    try await request("GET", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))"), auth: false)
  }
  public func postRequest(_ inviteId: String, signedRequest: Bytes) async throws -> JSON {
    try await request("POST", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))/requests"), body: ["signed_request": b64u(signedRequest)], auth: false)
  }
  public func joinStatus(_ inviteId: String, requestHash: String) async throws -> JSON {
    try await request("GET", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))/status"), query: ["request_hash": requestHash], auth: false)
  }
  public func members(after: Int = -1) async throws -> JSON { try await request("GET", roomPath("/members"), query: ["after_entry_number": String(after)]) }
  public func sealedRoomKeys(after: Int = 0) async throws -> JSON { try await request("GET", roomPath("/sealed_room_keys"), query: ["after_key_epoch": String(after)]) }
  public func keyBackLinks() async throws -> JSON { try await request("GET", roomPath("/key_back_links")) }
  public func sessionBundle() async throws -> JSON { try await request("GET", roomPath("/session_grants")) }
  public func envelopes(after: Int, limit: Int = 1000) async throws -> JSON {
    try await request("GET", roomPath("/envelopes"), query: ["after_envelope_number": String(after), "limit": String(limit)])
  }
  public func postEnvelope(_ bytes: Bytes) async throws -> JSON { try await request("POST", roomPath("/envelopes"), body: ["envelope": b64u(bytes)]) }
  /** A member entry (here: a device adding itself with the recovery key) and the room key sealed for it. */
  public func postMember(signedEntry: Bytes, sealedRoomKeys: [(deviceId: Bytes, sealed: Bytes)]) async throws -> JSON {
    try await request("POST", roomPath("/members"), body: ["signed_entry": b64u(signedEntry), "sealed_room_keys": sealedRoomKeys.map { ["device_id": hex($0.deviceId), "key_sealed": b64u($0.sealed)] }], auth: false)
  }
  /** Several session grants in one atomic post: [{ session_id, signed_grant, sealed_session_keys, key_back_link? }]. */
  public func postSessionGrants(_ grants: [JSON]) async throws -> JSON {
    try await request("POST", roomPath("/session_grants"), body: ["grants": grants], auth: false)
  }
  /** Email + password sign-in (anonymous): { room_id, key_wrapped, kdf, challenge }, or 401 wrong-login. */
  public func accountLogin(email: String, authKey: String) async throws -> JSON {
    try await request("POST", "/accounts/login", body: ["email": email, "auth_key": authKey], auth: false)
  }
  /** GET /v1/version: which client versions the hub serves (HubVersionInfo). */
  public func versionInfo() async throws -> HubVersionInfo? {
    var req = URLRequest(url: URL(string: "\(hubURL)/v1/version")!)
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    req.setValue("1", forHTTPHeaderField: "trommi-protocol")
    let (data, status) = try await send(req)
    if status == 426 {
      let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
      return HubVersionInfo(minimumClientVersions: ["ios": json["minimum_version"] as? String ?? "999.0.0"], message: json["message"] as? String)
    }
    return HubVersionInfo.parse(data)
  }
  /** This app's version, as it names itself to the hub ("ios/<version>"). */
  public static var appVersion: String { String(clientName.split(separator: "/").last ?? "0.0.0") }
  /** A new invite: the signed offer; the hub answers its invite_id. */
  public func postInvite(signedOffer: Bytes) async throws -> JSON { try await request("POST", roomPath("/invites"), body: ["signed_offer": b64u(signedOffer)]) }
  public func getRequests(_ inviteId: String) async throws -> JSON { try await request("GET", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))/requests")) }
  public func postReveal(_ inviteId: String, signedReveal: Bytes) async throws -> JSON {
    try await request("POST", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))/reveal"), body: ["signed_reveal": b64u(signedReveal)])
  }
  public func deleteInvite(_ inviteId: String) async throws { _ = try await request("DELETE", roomPath("/invites/\(try Self.checkHex(inviteId, 32, "invite_id"))")) }
  /** A conversation's items with their bodies, newest first below `before` (README "GET threads"). */
  public func threads(kind: String, timelineId: String, before: Int, limit: Int = 50) async throws -> JSON {
    try await request("GET", roomPath("/threads"), query: ["timeline_kind": kind, "timeline_id": timelineId, "before_envelope_number": String(before), "limit": String(limit)])
  }
  /** A timeline's items after an envelope number, oldest first (a canvas's tail after its snapshot). */
  public func threadsAfter(kind: String, timelineId: String, after: Int, limit: Int = 500) async throws -> JSON {
    try await request("GET", roomPath("/threads"), query: ["timeline_kind": kind, "timeline_id": timelineId, "after_envelope_number": String(after), "limit": String(limit)])
  }
  /** An attachment's encrypted bytes. */
  public func getAttachment(_ id: String) async throws -> Bytes {
    var req = URLRequest(url: URL(string: "\(hubURL)/v1\(roomPath("/attachments/\(try Self.checkHex(id, 32, "attachment_id"))"))")!)
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    req.setValue("1", forHTTPHeaderField: "trommi-protocol")
    req.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "authorization")
    let (data, status) = try await send(req)
    if status != 200 {
      let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
      throw HubError(status: status, code: json["error"] as? String ?? "http-\(status)", message: json["message"] as? String ?? "", extra: json)
    }
    return Array(data)
  }
  /** Upload an encrypted attachment (PUT, octet stream). */
  public func putAttachment(_ id: String, _ blob: Bytes) async throws {
    var req = URLRequest(url: URL(string: "\(hubURL)/v1\(roomPath("/attachments/\(try Self.checkHex(id, 32, "attachment_id"))"))")!)
    req.httpMethod = "PUT"
    req.setValue(Self.clientName, forHTTPHeaderField: "trommi-client")
    req.setValue("1", forHTTPHeaderField: "trommi-protocol")
    req.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
    req.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "authorization")
    req.httpBody = Data(blob)
    let (data, status) = try await send(req)
    if status >= 300 {
      let json = (try? JSONSerialization.jsonObject(with: data)) as? JSON ?? [:]
      throw HubError(status: status, code: json["error"] as? String ?? "http-\(status)", message: json["message"] as? String ?? "", extra: json)
    }
  }
  public func devices() async throws -> JSON { try await request("GET", roomPath("/devices")) }
  /** This iPhone's APNs registration (README "Push", APNs): { token, environment, topic, key }; remove: forget it. */
  public func registerApns(token: String, environment: String, topic: String, key: String, remove: Bool = false) async throws {
    var body: JSON = ["apns": ["token": token, "environment": environment, "topic": topic, "key": key]]
    if remove { body["remove"] = true }
    _ = try await request("POST", roomPath("/push_subscriptions"), body: body)
  }
}
