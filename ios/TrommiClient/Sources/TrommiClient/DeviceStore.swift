// DeviceStore.swift: where the device's state lives on the phone, the Swift side of the core's `Storage`
// (core/src/store.rs, spec/v2.md 13.2).
//
// ONE OWNER, by construction and by lock.
//   - The state is in the APP's own container (Application Support/Trommi/<room>/state), not in the App Group. The
//     extensions (share, notification, Live Activity) cannot reach the folder, and the key that seals it is a Keychain
//     item of the app alone (StateKey.swift). An extension never opens a device, never signs, never sends: the share
//     extension leaves what it got in the sealed inbox for the app (ShareInbox), the notification extension opens one
//     pushed envelope with keys the app handed it (PushNotify), the widget shows two counts.
//   - Inside the app the store takes an exclusive lock (flock) on the folder's `lock` file before it reads and keeps
//     it until it is closed: a second `DeviceStore` on the same folder, in this or another process, fails to open.
//     (The lock is on a file outside the App Group on purpose: iOS ends an app that is suspended while it holds a
//     lock on a file of a shared container.)
//   - The revision is the check behind the lock: `apply` names the revision the device believes is stored and is
//     refused with `.conflict` when the store's differs.
//
// DURABLE AND WHOLE. The state is a log of sealed records, one per batch, and a snapshot that replaces the log when
// it grows. A record is appended with one write and flushed to the drive (F_FULLFSYNC on Apple systems) before
// `apply` returns. The snapshot is written beside the old one, flushed, renamed over it and its folder flushed; only
// then is the log emptied. A crash between the two leaves records the snapshot already holds: they are opened like
// any other and skipped by their revision.
//
// WHEN WRITING FAILS the outcome can be unknown (was the record written or not?). The store then takes the record
// back, checks that it could, and in any case refuses every further write: the device stops, and the next launch
// reads what is truly on disk. A failure is never answered with success.
//
// WHAT IS READ BACK is not believed. Every record is sealed (ChaCha20-Poly1305, Apple's CryptoKit; local storage,
// not the protocol) under the state key with its revision as associated data, and every record of the log is opened,
// so records cannot be reordered, renumbered or taken from another state. Its length is written twice (once
// inverted). The revisions of the log must follow one another. Only the END of the log may be incomplete (a power
// cut during an append): a record cut short, a stretch of zeros, or a last record that does not open and lies above
// the anchor (next paragraph). Damage anywhere else stops the load; nothing is ever truncated before the whole state
// was read and checked.
//
// ROLLBACK. Someone who can write the app's container (a restored copy, a tool on a compromised phone) could put an
// older log back; everything in it is authentic. The anchor is the answer: a revision kept OUTSIDE the folder, in the
// Keychain (StateAnchor). It is moved forward by EVERY batch, after the batch is on the drive and before `apply`
// returns (what a device received and trusted is as much state as what it signed). A state whose revision is below
// its anchor does not load. A crash between the flush and the anchor leaves one record above the anchor: it was
// never answered, and may stay or go. The price is one Keychain write per batch; how long a long catch-up takes
// with it is to be measured on a phone. The files are left out of backups: a restored copy must not become a second
// owner.
import Foundation
import Crypto
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/** A revision kept outside the state's folder: the state may not load below it (DeviceStore.swift, "Rollback"). */
public protocol StateAnchor: AnyObject {
  /** nil: none was ever written. Throws when it cannot be read: unknown is not "none". */
  func read() throws -> UInt64?
  func write(_ revision: UInt64) throws
}

public final class DeviceStore: CoreStorage {
  /** The log is folded into a new snapshot once it is larger than this. */
  nonisolated(unsafe) static var compactAbove = 4 << 20
  /** The first byte of a key in the core's outbox table (core/src/store.rs `table::OUTBOX`). */
  static let outboxTable: UInt8 = 0x09
  private static let logAad = Array("trommi state record".utf8), snapAad = Array("trommi state snapshot".utf8)

  public let directory: URL
  private var key: SymmetricKey
  private var anchor: StateAnchor?
  private var anchored: UInt64 = 0
  private var lockFd: Int32 = -1
  private var logFd: Int32 = -1
  private var logSize = 0
  /** The stored revision; nil before `load`. */
  private var revision: UInt64?
  /** Set when a write's outcome is unknown: nothing more is written through this object. */
  private var poisoned = false

  /**
   * Opens the state in `directory` (made if missing) and takes its lock. Throws `StoreError.failed("busy")` when
   * another DeviceStore holds it. `anchor`: where the revision is kept outside the folder; nil only in tests.
   */
  public init(directory: URL, key: Bytes, anchor: StateAnchor? = nil) throws {
    guard key.count == 32 else { throw StoreError.failed("state key must be 32 bytes") }
    self.directory = directory
    self.key = SymmetricKey(data: key)
    self.anchor = anchor
    do {
      let fresh = !FileManager.default.fileExists(atPath: directory.path)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      #if os(iOS)
      // Readable after the first unlock (a push wakes the app while the phone is locked), never in a backup.
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      var dir = directory; try dir.setResourceValues(values)
      #endif
      if fresh { try Self.syncDirectory(directory.deletingLastPathComponent()) }
    } catch let e as StoreError { throw e } catch { throw StoreError.failed("state folder: \(error.localizedDescription)") }
    lockFd = open(path("lock"), O_RDWR | O_CREAT, 0o600)
    guard lockFd >= 0 else { throw StoreError.failed("lock file: errno \(errno)") }
    guard flock(lockFd, LOCK_EX | LOCK_NB) == 0 else {
      Self.closeFd(&lockFd)
      throw StoreError.failed("busy")
    }
  }
  deinit { close() }

  /** The same store, lock kept, with the key and anchor it is to use: for an opener that had to hold the lock first. */
  func rekeyed(_ key: Bytes, anchor: StateAnchor?) throws -> DeviceStore {
    guard key.count == 32, revision == nil else { throw StoreError.failed("state key must be 32 bytes, set before loading") }
    self.key = SymmetricKey(data: key)
    self.anchor = anchor
    return self
  }

  /** Gives the lock back. The store is unusable afterwards. */
  public func close() {
    Self.closeFd(&logFd)
    if lockFd >= 0 { flock(lockFd, LOCK_UN) }
    Self.closeFd(&lockFd)
    revision = nil
  }
  private static func closeFd(_ fd: inout Int32) {
    #if canImport(Glibc)
    if fd >= 0 { _ = Glibc.close(fd) }
    #else
    if fd >= 0 { _ = Darwin.close(fd) }
    #endif
    fd = -1
  }
  private func path(_ name: String) -> String { directory.appendingPathComponent(name).path }

  // ---- CoreStorage ---------------------------------------------------------------------------------------

  public func load() throws -> StoreLoaded {
    guard lockFd >= 0 else { throw StoreError.failed("closed") }
    // Everything is read and checked first; only then is an incomplete end of the log cut off.
    let (entries, rev, goodLength) = try readAll()
    let floor = try readAnchor()
    guard rev >= floor else { throw StoreError.failed("the stored state is older than this device's last known one (revision \(rev) below \(floor))") }
    Self.closeFd(&logFd)
    let existed = FileManager.default.fileExists(atPath: path("state.log"))
    logFd = open(path("state.log"), O_RDWR | O_CREAT, 0o600)
    guard logFd >= 0 else { throw StoreError.failed("state log: errno \(errno)") }
    guard ftruncate(logFd, off_t(goodLength)) == 0, lseek(logFd, 0, SEEK_END) == off_t(goodLength) else { throw StoreError.failed("state log: errno \(errno)") }
    try sync(logFd)
    if !existed { try Self.syncDirectory(directory) }
    logSize = goodLength
    revision = rev
    anchored = floor
    poisoned = false
    return StoreLoaded(revision: rev, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) })
  }

  public func apply(expectedRevision: UInt64, batch: StoreBatch) throws {
    guard let stored = revision, logFd >= 0 else { throw StoreError.failed("not loaded") }
    guard !poisoned else { throw StoreError.failed("an earlier write failed: this store writes nothing more until it is opened again") }
    guard stored == expectedRevision else { throw StoreError.conflict }
    let next = stored + 1
    let sealed = try seal(Self.encode(batch), aad: Self.logAad, revision: next)
    let length = 8 + sealed.count
    let framed = be32(length) + be32(Int(~UInt32(length))) + be64(next) + sealed
    do {
      try writeAll(logFd, framed)
      try sync(logFd)
    } catch {
      // Whether the record is on the drive is not known. Take it back; whatever comes of that, write nothing more.
      poisoned = true
      if ftruncate(logFd, off_t(logSize)) == 0 { _ = try? sync(logFd) }
      throw error
    }
    logSize += framed.count
    revision = next
    if let anchor = anchor {
      // The batch is durable, but without the anchor a rollback below it would pass: not a success.
      do { try anchor.write(next); anchored = next } catch { poisoned = true; throw StoreError.failed("the state's anchor could not be written") }
    }
    // Folding the log is housekeeping: the batch is durable already. A failure before anything was changed is
    // harmless and tried again later; one after that poisons the store (compact says which).
    if logSize > Self.compactAbove { try? compact() }
  }

  // ---- reading -------------------------------------------------------------------------------------------

  private func readAnchor() throws -> UInt64 {
    guard let anchor = anchor else { return 0 }
    do { return try anchor.read() ?? 0 } catch { throw StoreError.failed("the state's anchor could not be read") }
  }
  /** A file's bytes; nil only when it does not exist. */
  private func read(_ name: String) throws -> Bytes? {
    do { return Bytes(try Data(contentsOf: directory.appendingPathComponent(name))) }
    catch {
      if !FileManager.default.fileExists(atPath: path(name)) { return nil }
      throw StoreError.failed("\(name) could not be read")
    }
  }

  /** Snapshot and log folded: the entries, the revision, and how many bytes of the log are whole records. */
  private func readAll() throws -> (entries: [Bytes: Bytes], revision: UInt64, goodLength: Int) {
    var entries = [Bytes: Bytes]()
    var rev: UInt64 = 0
    if let bytes = try read("state.snap") {
      guard bytes.count >= 8 else { throw StoreError.failed("state snapshot is damaged") }
      rev = readBe64(bytes, 0)
      let batch = try Self.decode(try unseal(Bytes(bytes[8...]), aad: Self.snapAad, revision: rev))
      for e in batch.put { entries[e.key] = e.value }
    }
    let log = try read("state.log") ?? []
    let floor = try readAnchor()
    var at = 0
    var last: UInt64? = nil     // the revision of the record before, whether applied or skipped
    while at < log.count {
      let rest = log.count - at
      // An incomplete end: a header cut short, zeros where a record was to be, a body cut short.
      if rest < 8 || log[at...].allSatisfy({ $0 == 0 }) { break }
      let n = Int(readBe32(log, at))
      guard UInt32(n) == ~readBe32(log, at + 4), n >= 8 + 28 else { throw StoreError.failed("state log is damaged") }
      if at + 8 + n > log.count { break }
      let recordRev = readBe64(log, at + 8)
      let isLast = at + 8 + n == log.count
      let plain: Bytes
      do { plain = try unseal(Bytes(log[(at + 16)..<(at + 8 + n)]), aad: Self.logAad, revision: recordRev) } catch {
        // The last record may be half on the drive after a power cut, unless the anchor says it was answered.
        if isLast && recordRev > floor { break }
        throw error
      }
      if let l = last, recordRev != l + 1 { throw StoreError.failed("state log has a gap") }
      last = recordRev
      if recordRev > rev {
        guard recordRev == rev + 1 else { throw StoreError.failed("state log has a gap") }
        let batch = try Self.decode(plain)
        for k in batch.delete { entries[k] = nil }
        for e in batch.put { entries[e.key] = e.value }
        rev = recordRev
      }
      at += 8 + n
    }
    return (entries, rev, at)
  }

  /** The log folded into a new snapshot, the log emptied. */
  func compact() throws {
    guard let rev = revision, !poisoned else { return }
    // Up to the rename nothing of the state is touched: a failure here is harmless.
    let (entries, readRev, _) = try readAll()
    guard readRev == rev else { poisoned = true; throw StoreError.failed("state changed under its owner") }
    let plain = Self.encode(StoreBatch(put: entries.map { StoreEntry(key: $0.key, value: $0.value) }))
    let bytes = be64(rev) + (try seal(plain, aad: Self.snapAad, revision: rev))
    let tmp = path("state.snap.new")
    var fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    guard fd >= 0 else { throw StoreError.failed("state snapshot: errno \(errno)") }
    defer { Self.closeFd(&fd) }
    try writeAll(fd, bytes)
    try sync(fd)
    guard rename(tmp, path("state.snap")) == 0 else { throw StoreError.failed("state snapshot: errno \(errno)") }
    // The log is emptied only once the new snapshot's name is on the drive.
    try Self.syncDirectory(directory)
    // From here the snapshot holds everything; records left in the log by a crash now are skipped by revision.
    guard ftruncate(logFd, 0) == 0 else { throw StoreError.failed("state log: errno \(errno)") }
    logSize = 0
    do {
      guard lseek(logFd, 0, SEEK_END) == 0 else { throw StoreError.failed("state log: errno \(errno)") }
      try sync(logFd)
    } catch { poisoned = true; throw error }
  }

  // ---- sealing and encoding ------------------------------------------------------------------------------

  /** nonce ‖ ciphertext ‖ tag; the revision is the associated data's tail. */
  private func seal(_ plain: Bytes, aad: Bytes, revision: UInt64) throws -> Bytes {
    do { return Bytes(try ChaChaPoly.seal(Data(plain), using: key, authenticating: Data(aad + be64(revision))).combined) }
    catch { throw StoreError.failed("sealing the state failed") }
  }
  private func unseal(_ sealed: Bytes, aad: Bytes, revision: UInt64) throws -> Bytes {
    do { return Bytes(try ChaChaPoly.open(ChaChaPoly.SealedBox(combined: Data(sealed)), using: key, authenticating: Data(aad + be64(revision)))) }
    catch { throw StoreError.failed("the stored state does not open (damaged, or sealed under another key)") }
  }

  static func encode(_ batch: StoreBatch) -> Bytes {
    var out = be32(batch.delete.count)
    for k in batch.delete { out += be32(k.count); out += k }
    out += be32(batch.put.count)
    for e in batch.put { out += be32(e.key.count); out += e.key; out += be32(e.value.count); out += e.value }
    return out
  }
  static func decode(_ b: Bytes) throws -> StoreBatch {
    var at = 0
    func take(_ n: Int) throws -> Bytes {
      guard n >= 0, at + n <= b.count else { throw StoreError.failed("a stored batch is damaged") }
      defer { at += n }
      return Bytes(b[at..<(at + n)])
    }
    func count() throws -> Int { Int(readBe32(try take(4), 0)) }
    var batch = StoreBatch()
    for _ in 0..<(try count()) { batch.delete.append(try take(try count())) }
    for _ in 0..<(try count()) { let k = try take(try count()); batch.put.append(StoreEntry(key: k, value: try take(try count()))) }
    guard at == b.count else { throw StoreError.failed("a stored batch is damaged") }
    return batch
  }

  // ---- the file system -----------------------------------------------------------------------------------

  /** All of the bytes, or an error: a short write is continued, an interrupted one tried again. */
  private func writeAll(_ fd: Int32, _ bytes: Bytes) throws {
    var done = 0
    while done < bytes.count {
      let n = bytes.withUnsafeBytes { write(fd, $0.baseAddress! + done, bytes.count - done) }
      if n < 0 { if errno == EINTR { continue }; throw StoreError.failed("write: errno \(errno)") }
      if n == 0 { throw StoreError.failed("write: nothing was taken") }
      done += n
    }
  }
  private func sync(_ fd: Int32) throws { try Self.sync(fd) }
  private static func sync(_ fd: Int32) throws {
    #if canImport(Darwin)
    // fsync on Apple systems hands the data to the drive but does not ask it to write; F_FULLFSYNC does. Only a
    // file system that does not know the request falls back to fsync; an I/O error is an error.
    while true {
      if fcntl(fd, F_FULLFSYNC) == 0 { return }
      if errno == EINTR { continue }
      if errno == ENOTSUP || errno == ENOTTY || errno == EINVAL { break }
      throw StoreError.failed("sync: errno \(errno)")
    }
    #endif
    while fsync(fd) != 0 { if errno != EINTR { throw StoreError.failed("sync: errno \(errno)") } }
  }
  /** A new or renamed name is durable once its folder is synced. */
  static func syncDirectory(_ dir: URL) throws {
    var fd = open(dir.path, O_RDONLY)
    guard fd >= 0 else { throw StoreError.failed("folder sync: errno \(errno)") }
    defer { closeFd(&fd) }
    try sync(fd)
  }
}

func be32(_ v: Int) -> Bytes { let u = UInt32(truncatingIfNeeded: v); return [UInt8(u >> 24), UInt8((u >> 16) & 0xff), UInt8((u >> 8) & 0xff), UInt8(u & 0xff)] }
func be64(_ v: UInt64) -> Bytes { (0..<8).map { UInt8((v >> UInt64(56 - 8 * $0)) & 0xff) } }
func readBe32(_ b: Bytes, _ at: Int) -> UInt32 { (0..<4).reduce(UInt32(0)) { ($0 << 8) | UInt32(b[at + $1]) } }
func readBe64(_ b: Bytes, _ at: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { ($0 << 8) | UInt64(b[at + $1]) } }
