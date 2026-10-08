// ShareInbox: the encrypted inbox the Share Extension (TrommiApp/Sources/TrommiShare) and the app share through their App
// Group container. The extension never holds a room, a device key or the board: it reads a small sealed snapshot of the
// sessions (written by the app on each change of the board), and writes what was shared as sealed files plus one sealed
// manifest per share. The app imports them into the note, or sends them to the chosen session through the room's normal
// encrypted path, on its next start to the front, and at once while it runs (a Darwin notification).
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
  /** To one session, as a message. */
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
  /** The room of the snapshot the session was picked from. */
  public var room: String?
  public var text: String
  public var items: [ShareItem]
  public init(id: String = ShareInbox.newId(), created: UInt64 = ShareInbox.nowMs(), action: ShareAction, to: String? = nil, toName: String? = nil,
              room: String? = nil, text: String = "", items: [ShareItem] = []) {
    self.id = id; self.created = created; self.action = action; self.to = to; self.toName = toName; self.room = room; self.text = text; self.items = items
  }
  /** The words of the share for a note or a message: the typed text, then every link and text item, one per line. */
  public var words: String {
    var parts = [String]()
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.isEmpty { parts.append(t) }
    for i in items where i.kind == .url || i.kind == .text {
      if let s = i.text?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, !parts.contains(s) { parts.append(s) }
    }
    return parts.joined(separator: "\n")
  }
}

/** What the extension may show: desks and sessions by name, the crowns. No keys, no cards, no messages. */
public struct ShareSnapshot: Codable, Equatable, Sendable {
  public struct Desk: Codable, Equatable, Sendable {
    public var id: String; public var name: String
    /** The crowned session (board id): who gets the note on this desk. */
    public var crown: String?
    public init(id: String, name: String, crown: String?) { self.id = id; self.name = name; self.crown = crown }
  }
  public struct Session: Codable, Equatable, Sendable {
    public var id: String; public var name: String; public var desk: String?; public var parent: String?
    public var hue: Int; public var online: Bool
    public init(id: String, name: String, desk: String?, parent: String?, hue: Int = 162, online: Bool = false) {
      self.id = id; self.name = name; self.desk = desk; self.parent = parent; self.hue = hue; self.online = online
    }
  }
  public var v: Int = 1
  public var room: String
  public var written: UInt64
  public var desks: [Desk]
  /** Sessions in their order, archived and removed ones left out. */
  public var sessions: [Session]
  public init(room: String, written: UInt64 = ShareInbox.nowMs(), desks: [Desk], sessions: [Session]) {
    self.room = room; self.written = written; self.desks = desks; self.sessions = sessions
  }

  /** One row of the tree: a session, how deep (0 a top session, 1 a helper), crowned on its desk. */
  public struct Row: Equatable, Sendable, Identifiable {
    public var session: Session; public var depth: Int; public var crowned: Bool
    public var id: String { session.id }
  }
  public struct DeskRows: Equatable, Sendable, Identifiable {
    public var desk: Desk; public var rows: [Row]
    public var id: String { desk.id }
  }
  /**
   * The tree as the sidebar shows it: desks in their order; on each the crowned session first, then the other top
   * sessions, every one followed by its helpers. A session on no known desk goes to the first desk; with no desks, one.
   */
  public func tree() -> [DeskRows] {
    let deskList = desks.isEmpty ? [Desk(id: "main", name: "Desk", crown: nil)] : desks
    let known = Set(deskList.map { $0.id })
    let ids = Set(sessions.map { $0.id })
    func deskOf(_ s: Session) -> String {
      if let p = s.parent, ids.contains(p), let ps = sessions.first(where: { $0.id == p }) { return deskOf(ps) }
      if let d = s.desk, known.contains(d) { return d }
      return deskList[0].id
    }
    return deskList.compactMap { d in
      let here = sessions.filter { deskOf($0) == d.id }
      let tops = here.filter { $0.parent == nil || !ids.contains($0.parent!) }
      let ordered = tops.filter { $0.id == d.crown } + tops.filter { $0.id != d.crown }
      var rows = [Row]()
      for t in ordered {
        rows.append(Row(session: t, depth: 0, crowned: t.id == d.crown))
        for h in here where h.parent == t.id { rows.append(Row(session: h, depth: 1, crowned: false)) }
      }
      return rows.isEmpty && desks.count > 1 ? nil : DeskRows(desk: d, rows: rows)
    }
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
    let d = try Data(contentsOf: itemsDir.appendingPathComponent(f))
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
