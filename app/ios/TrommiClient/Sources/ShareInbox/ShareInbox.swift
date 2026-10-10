// ShareInbox: the encrypted inbox the Share Extension (TrommiApp/Sources/TrommiShare) and the app share through their App
// Group container. The extension never holds a room, a device key or the board: it reads a small sealed snapshot of the
// desks and their crowned sessions (written by the app on each change of the board), and writes what was shared as
// sealed files plus one sealed manifest per share. The app keeps them in the note, or sends them to the chosen desk's
// crowned session through the room's normal encrypted path, on its next start to the front, and at once while it runs
// (a Darwin notification).
//
// Every file is AES-256-GCM under one 32-byte key (the inbox key) that lives in the Keychain under the App Group as its
// access group (ShareKeychain), readable after the first unlock, on this device only. The additional data binds each
// ciphertext to its role and file name, so files cannot be swapped between shares. Payload files are written first, the
// manifest last (atomically): a share is visible only when it is complete. Pure Foundation + swift-crypto, so it runs
// in the extension's small memory and under `swift test` on Linux.
import Foundation
import Crypto

public enum ShareAction: String, Codable, Sendable {
  /** Into the note (the default): nothing is sent. */
  case note
  /** To a desk's crowned session, as a message. */
  case send
}

/** One thing that was shared. Words (a link, a text) ride inline; bytes are a sealed payload file. */
public struct ShareItem: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case image, file, url, text }
  public var kind: Kind
  /** The payload file (items/<file>) for image and file; nil for url and text. */
  public var file: String?
  public var name: String
  public var type: String
  public var size: Int
  public var width: Int?
  public var height: Int?
  /** The link or the text (url, text). */
  public var text: String?
  public init(kind: Kind, file: String? = nil, name: String, type: String, size: Int = 0, width: Int? = nil, height: Int? = nil, text: String? = nil) {
    self.kind = kind; self.file = file; self.name = name; self.type = type; self.size = size; self.width = width; self.height = height; self.text = text
  }
}

/** One share: what to do, to whom, the words typed in the sheet, the items. */
public struct ShareRequest: Codable, Equatable, Identifiable, Sendable {
  public var v: Int = 1
  public var id: String
  public var created: UInt64
  public var action: ShareAction
  /** The session (board id) for .send. */
  public var to: String?
  public var toName: String?
  /** The desk whose crown it goes to (.send). */
  public var desk: String?
  /** The room of the snapshot the session was picked from. */
  public var room: String?
  public var text: String
  public var items: [ShareItem]
  public init(id: String = ShareInbox.newId(), created: UInt64 = ShareInbox.nowMs(), action: ShareAction, to: String? = nil, toName: String? = nil,
              desk: String? = nil, room: String? = nil, text: String = "", items: [ShareItem] = []) {
    self.id = id; self.created = created; self.action = action; self.to = to; self.toName = toName; self.desk = desk; self.room = room; self.text = text; self.items = items
  }
  /** The words of the share for a note or a message: the typed text, then every link and text item, one per line. */
  public var words: String {
    ShareIntake.joined([ShareItem(kind: .text, name: "text", type: "text/plain", text: text)] + items)
  }
}

/**
 * What the extension may show: each desk with its crowned session (the note's recipients), by name, with their
 * drawings as small template pictures the app rendered. No keys, no cards, no messages, no other sessions.
 */
public struct ShareSnapshot: Codable, Equatable, Sendable {
  /** A desk's crowned session: who gets the note on that desk. */
  public struct Crown: Codable, Equatable, Sendable {
    public var id: String; public var name: String; public var hue: Int
    /** The session's drawing, a PNG (alpha only matters: shown as a template in its hue). */
    public var mark: Data?
    public init(id: String, name: String, hue: Int = 162, mark: Data? = nil) { self.id = id; self.name = name; self.hue = hue; self.mark = mark }
  }
  public struct Desk: Codable, Equatable, Sendable, Identifiable {
    public var id: String; public var name: String
    public var crown: Crown?
    public init(id: String, name: String, crown: Crown?) { self.id = id; self.name = name; self.crown = crown }
  }
  public var v: Int = 2
  public var room: String
  public var written: UInt64
  /** Desks in their order. */
  public var desks: [Desk]
  /** The desk drawing (the web's sketch:desk), a PNG shown as a template. */
  public var deskMark: Data?
  /** The desk whose crown the app's note went to last. */
  public var lastDesk: String?
  public init(room: String, written: UInt64 = ShareInbox.nowMs(), desks: [Desk], deskMark: Data? = nil, lastDesk: String? = nil) {
    self.room = room; self.written = written; self.desks = desks; self.deskMark = deskMark; self.lastDesk = lastDesk
  }

  /** The desks that have a crowned session: the choices of the "To" chip, in the desks' order. */
  public var crowned: [Desk] { desks.filter { $0.crown != nil } }

  /** The desk to preselect: the one picked last in the share sheet, else the app's last, else the first crowned. */
  public func preselect(last: String?) -> Desk? {
    let c = crowned
    return c.first { $0.id == last } ?? c.first { $0.id == lastDesk } ?? c.first
  }
}

public enum ShareError: Error, Equatable, CustomStringConvertible {
  case tooLarge(String), tooMany, noKey, damaged(String)
  public var description: String {
    switch self {
    case .tooLarge(let n): return "\(n) is larger than \(ShareInbox.maxItemBytes / (1 << 20)) MB"
    case .tooMany: return "at most \(ShareInbox.maxItems) items at once"
    case .noKey: return "no inbox key"
    case .damaged(let f): return "\(f) does not open"
    }
  }
}

/**
 * The inbox in a directory (the App Group container's "Trommi Share"): snapshot.sealed, requests/<id>.sealed (a
 * claimed one: <id>.taken), items/<id>-<n>.sealed.
 */
public final class ShareInbox: @unchecked Sendable {
  public static let maxItems = 20
  /** One payload at most (the extension holds it in memory once to seal it; the hub takes 64 MiB). */
  public static let maxItemBytes = 32 << 20
  public static let maxTextChars = 20_000
  /** The Darwin notification the extension posts after a share (the app imports at once while it runs). */
  public static let darwinName = "com.trommi.ios.share-inbox"

  public let dir: URL
  private let key: SymmetricKey
  private let fm = FileManager.default

  public init(dir: URL, key: SymmetricKey) {
    self.dir = dir; self.key = key
  }
  /** The inbox in an App Group container. */
  public convenience init(container: URL, key: SymmetricKey) {
    self.init(dir: container.appendingPathComponent("Trommi Share", isDirectory: true), key: key)
  }

  public static func newId() -> String {
    var g = SystemRandomNumberGenerator()
    return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &g)) }.joined()
  }
  public static func nowMs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

  private var requestsDir: URL { dir.appendingPathComponent("requests", isDirectory: true) }
  private var itemsDir: URL { dir.appendingPathComponent("items", isDirectory: true) }
  private var snapshotURL: URL { dir.appendingPathComponent("snapshot.sealed") }

  private func ensure() throws {
    for d in [dir, requestsDir, itemsDir] where !fm.fileExists(atPath: d.path) {
      try fm.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    #if os(iOS)
    var u = dir
    var rv = URLResourceValues(); rv.isExcludedFromBackup = true
    try? u.setResourceValues(rv)
    #endif
  }

  // ---- sealing ---------------------------------------------------------------------------------------

  static func aad(_ role: String, _ name: String) -> Data { Data("trommi-share/1/\(role)/\(name)".utf8) }
  func seal(_ data: Data, role: String, name: String) throws -> Data {
    guard let c = try AES.GCM.seal(data, using: key, authenticating: Self.aad(role, name)).combined else { throw ShareError.damaged(name) }
    return c
  }
  func open(_ data: Data, role: String, name: String) throws -> Data {
    do { return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: Self.aad(role, name)) }
    catch { throw ShareError.damaged(name) }
  }
  private func write(_ data: Data, to url: URL) throws {
    #if os(iOS)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: url, options: .atomic)
    #endif
  }

  // ---- the snapshot (the app writes, the extension reads) -----------------------------------------------

  public func writeSnapshot(_ s: ShareSnapshot) throws {
    try ensure()
    try write(try seal(try JSONEncoder().encode(s), role: "snapshot", name: "snapshot"), to: snapshotURL)
  }
  public func readSnapshot() -> ShareSnapshot? {
    guard let d = try? Data(contentsOf: snapshotURL), let plain = try? open(d, role: "snapshot", name: "snapshot") else { return nil }
    return try? JSONDecoder().decode(ShareSnapshot.self, from: plain)
  }
  /** Signed out: nothing of the room stays for the extension. */
  public func clearSnapshot() { try? fm.removeItem(at: snapshotURL) }
  /** The account is gone (or this device left the room): every share that waits, its payloads and the snapshot go. */
  public func wipe() { try? fm.removeItem(at: dir) }

  // ---- writing a share (the extension) ---------------------------------------------------------------

  /** A payload for a share being written: sealed into items/, its file name for the item. */
  public func addPayload(_ data: Data, request id: String, index: Int, name: String) throws -> String {
    if data.count > Self.maxItemBytes { throw ShareError.tooLarge(name) }
    try ensure()
    let file = "\(id)-\(index).sealed"
    try write(try seal(data, role: "item", name: file), to: itemsDir.appendingPathComponent(file))
    return file
  }
  /** The manifest, last: from now on the app sees the share. */
  public func commit(_ r: ShareRequest) throws {
    if r.items.count > Self.maxItems { throw ShareError.tooMany }
    var r = r
    if r.text.count > Self.maxTextChars { r.text = String(r.text.prefix(Self.maxTextChars)) }
    try ensure()
    let name = "\(r.id).sealed"
    try write(try seal(try JSONEncoder().encode(r), role: "request", name: r.id), to: requestsDir.appendingPathComponent(name))
  }
  /** A share given up half way (cancelled, too large): its payloads go. */
  public func discard(_ id: String) {
    for f in (try? fm.contentsOfDirectory(atPath: itemsDir.path)) ?? [] where f.hasPrefix("\(id)-") { try? fm.removeItem(at: itemsDir.appendingPathComponent(f)) }
    try? fm.removeItem(at: requestsDir.appendingPathComponent("\(id).sealed"))
    try? fm.removeItem(at: requestsDir.appendingPathComponent("\(id).taken"))
  }

  // ---- reading shares (the app) ----------------------------------------------------------------------

  /** Complete shares not yet taken, oldest first. A manifest that does not open is dropped with its payloads. */
  public func pending() -> [ShareRequest] {
    let names = (try? fm.contentsOfDirectory(atPath: requestsDir.path)) ?? []
    var out = [ShareRequest]()
    for n in names where n.hasSuffix(".sealed") {
      let id = String(n.dropLast(".sealed".count))
      guard let d = try? Data(contentsOf: requestsDir.appendingPathComponent(n)),
            let plain = try? open(d, role: "request", name: id),
            let r = try? JSONDecoder().decode(ShareRequest.self, from: plain), r.id == id else { discard(id); continue }
      out.append(r)
    }
    return out.sorted { ($0.created, $0.id) < ($1.created, $1.id) }
  }
  /** Still waiting in the inbox (not yet claimed by the app)? The extension asks this to tell "sent" from "queued". */
  public func isWaiting(_ id: String) -> Bool { fm.fileExists(atPath: requestsDir.appendingPathComponent("\(id).sealed").path) }
  /** Take a share before working on it (a second import does not see it). */
  @discardableResult public func claim(_ id: String) -> Bool {
    (try? fm.moveItem(at: requestsDir.appendingPathComponent("\(id).sealed"), to: requestsDir.appendingPathComponent("\(id).taken"))) != nil
  }
  /** Not done after all (offline, no room yet): back into the inbox for the next time. */
  public func release(_ id: String) {
    try? fm.moveItem(at: requestsDir.appendingPathComponent("\(id).taken"), to: requestsDir.appendingPathComponent("\(id).sealed"))
  }
  /** Done: the manifest and its payloads go. */
  public func finish(_ id: String) { discard(id) }
  /** A payload's bytes. */
  public func payload(_ item: ShareItem) throws -> Data {
    guard let f = item.file, !f.contains("/") else { throw ShareError.damaged(item.name) }
    guard let d = try? Data(contentsOf: itemsDir.appendingPathComponent(f), options: .mappedIfSafe) else { throw ShareError.damaged(item.name) }
    return try open(d, role: "item", name: f)
  }
  /**
   * After a crash: claimed shares go back into the inbox, payloads without a manifest older than an hour (an extension
   * that died while writing) go.
   */
  public func sweep(now: Date = Date()) {
    for n in (try? fm.contentsOfDirectory(atPath: requestsDir.path)) ?? [] where n.hasSuffix(".taken") { release(String(n.dropLast(".taken".count))) }
    let live = Set(((try? fm.contentsOfDirectory(atPath: requestsDir.path)) ?? []).map { String($0.split(separator: ".")[0]) })
    for f in (try? fm.contentsOfDirectory(atPath: itemsDir.path)) ?? [] {
      let id = String(f.split(separator: "-")[0])
      if live.contains(id) { continue }
      let url = itemsDir.appendingPathComponent(f)
      let at = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? nil
      if let at = at, now.timeIntervalSince(at) < 3600 { continue }
      try? fm.removeItem(at: url)
    }
  }
}
