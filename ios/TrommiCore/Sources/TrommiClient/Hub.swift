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
      throw HubError(status: status, code: json["error"] as? String ?? "http-\(status)", message: json["message"] as? String ?? "")
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
  @discardableResult public func signIn() async throws -> JSON {
    guard let signer = signer else { throw ZError("unauthorised", "no signer for this hub client") }
    let ch = try await request("POST", roomPath("/challenge"), auth: false)
    let challenge = try unb64u(ch["challenge"] as? String ?? "")
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
  public func devices() async throws -> JSON { try await request("GET", roomPath("/devices")) }
}
