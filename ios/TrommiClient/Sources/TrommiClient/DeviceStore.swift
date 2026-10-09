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
// it grows. A record is appended with one write and synced (F_FULLFSYNC on Apple systems) before `apply` returns.
// A record cut short by a crash is at the end of the log, was never answered with success, and is dropped on load.
// The snapshot is written beside the old one, synced and renamed over it; only then is the log emptied. A crash
// between the two leaves records the snapshot already holds: they are skipped by their revision.
//
// AT REST. Every record is sealed (ChaCha20-Poly1305, Apple's CryptoKit; local storage, not the protocol) under the
// state key with its revision as associated data, so records cannot be reordered or taken from another state, and
// a damaged one is noticed. The files are left out of backups: a restored copy must not become a second owner.
// What this does not stop: someone who can write the app's container AND read its Keychain item can put an older
// state back (a compromised phone).
import Foundation
import Crypto
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

public final class DeviceStore: CoreStorage {
  /** The log is folded into a new snapshot once it is larger than this. */
  nonisolated(unsafe) static var compactAbove = 4 << 20
  private static let logAad = Array("trommi state record".utf8), snapAad = Array("trommi state snapshot".utf8)

  public let directory: URL
  private let key: SymmetricKey
  private var lockFd: Int32 = -1
  private var logFd: Int32 = -1
  private var logSize = 0
  /** The stored revision; nil before `load`. */
  private var revision: UInt64?

  /**
   * Opens the state in `directory` (made if missing) and takes its lock. Throws `StoreError.failed("busy")` when
   * another DeviceStore holds it.
   */
  public init(directory: URL, key: Bytes) throws {
    guard key.count == 32 else { throw StoreError.failed("state key must be 32 bytes") }
    self.directory = directory
    self.key = SymmetricKey(data: key)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      #if os(iOS)
      // Readable after the first unlock (a push wakes the app while the phone is locked), never in a backup.
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      var dir = directory; try dir.setResourceValues(values)
      #endif
    } catch { throw StoreError.failed("state folder: \(error.localizedDescription)") }
    lockFd = open(path("lock"), O_RDWR | O_CREAT, 0o600)
    guard lockFd >= 0 else { throw StoreError.failed("lock file: errno \(errno)") }
    guard flock(lockFd, LOCK_EX | LOCK_NB) == 0 else {
      Self.closeFd(&lockFd)
      throw StoreError.failed("busy")
    }
  }
  deinit { close() }

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
    let (entries, rev, goodLength) = try readAll()
    Self.closeFd(&logFd)
    logFd = open(path("state.log"), O_RDWR | O_CREAT, 0o600)
    guard logFd >= 0 else { throw StoreError.failed("state log: errno \(errno)") }
    // A record cut short by a crash is dropped here, so that the next one is appended behind a whole one.
    guard ftruncate(logFd, off_t(goodLength)) == 0, lseek(logFd, 0, SEEK_END) >= 0 else { throw StoreError.failed("state log: errno \(errno)") }
    try sync(logFd)
    logSize = goodLength
    revision = rev
    return StoreLoaded(revision: rev, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) })
  }

  public func apply(expectedRevision: UInt64, batch: StoreBatch) throws {
    guard let stored = revision, logFd >= 0 else { throw StoreError.failed("not loaded") }
    guard stored == expectedRevision else { throw StoreError.conflict }
    let next = stored + 1
    let record = try seal(Self.encode(batch), aad: Self.logAad, revision: next)
    var framed = be32(record.count); framed += record
    let written = framed.withUnsafeBytes { write(logFd, $0.baseAddress, $0.count) }
    guard written == framed.count else {
      // Nothing of a half-written record may stay in front of the next one.
      _ = ftruncate(logFd, off_t(logSize)); _ = lseek(logFd, 0, SEEK_END)
      throw StoreError.failed("state log: short write, errno \(errno)")
    }
    do { try sync(logFd) } catch {
      _ = ftruncate(logFd, off_t(logSize)); _ = lseek(logFd, 0, SEEK_END)
      throw error
    }
    logSize += framed.count
    revision = next
    // Folding the log is housekeeping: the batch is durable already, so a failure here is not the caller's.
    if logSize > Self.compactAbove { try? compact() }
  }

  // ---- reading -------------------------------------------------------------------------------------------

  /** Snapshot and log folded: the entries, the revision, and how many bytes of the log are whole records. */
  private func readAll() throws -> (entries: [Bytes: Bytes], revision: UInt64, goodLength: Int) {
    var entries = [Bytes: Bytes]()
    var rev: UInt64 = 0
    if let snap = FileManager.default.contents(atPath: path("state.snap")) {
      let bytes = Bytes(snap)
      guard bytes.count >= 8 else { throw StoreError.failed("state snapshot is damaged") }
      rev = readBe64(bytes, 0)
      let batch = try Self.decode(try unseal(Bytes(bytes[8...]), aad: Self.snapAad, revision: rev))
      for e in batch.put { entries[e.key] = e.value }
    }
    let log = Bytes(FileManager.default.contents(atPath: path("state.log")) ?? Data())
    var at = 0
    while at + 4 <= log.count {
      let n = Int(readBe32(log, at))
      guard at + 4 + n <= log.count else { break }            // cut short: the end of what is stored
      let sealed = Bytes(log[(at + 4)..<(at + 4 + n)])
      guard sealed.count >= 8 else { throw StoreError.failed("state log is damaged") }
      let recordRev = readBe64(sealed, 0)
      if recordRev > rev {
        guard recordRev == rev + 1 else { throw StoreError.failed("state log has a gap") }
        let plain: Bytes
        do { plain = try unseal(Bytes(sealed[8...]), aad: Self.logAad, revision: recordRev) } catch {
          // The last record may be half on disk after a power cut; anywhere else a record that does not open is damage.
          if at + 4 + n == log.count { break }
          throw error
        }
        let batch = try Self.decode(plain)
        for k in batch.delete { entries[k] = nil }
        for e in batch.put { entries[e.key] = e.value }
        rev = recordRev
      }
      at += 4 + n
    }
    return (entries, rev, at)
  }

  /** The log folded into a new snapshot, the log emptied. */
  func compact() throws {
    guard let rev = revision else { return }
    let (entries, readRev, _) = try readAll()
    guard readRev == rev else { throw StoreError.failed("state changed under its owner") }
    let plain = Self.encode(StoreBatch(put: entries.map { StoreEntry(key: $0.key, value: $0.value) }))
    let bytes = be64(rev) + (try seal(plain, aad: Self.snapAad, revision: rev).dropFirst(8))
    let tmp = path("state.snap.new")
    let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    guard fd >= 0 else { throw StoreError.failed("state snapshot: errno \(errno)") }
    var tmpFd = fd
    defer { Self.closeFd(&tmpFd) }
    let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    guard written == bytes.count else { throw StoreError.failed("state snapshot: short write") }
    try sync(fd)
    guard rename(tmp, path("state.snap")) == 0 else { throw StoreError.failed("state snapshot: errno \(errno)") }
    syncDirectory()
    // From here the snapshot holds everything; records left in the log by a crash now are skipped by revision.
    guard ftruncate(logFd, 0) == 0, lseek(logFd, 0, SEEK_END) >= 0 else { throw StoreError.failed("state log: errno \(errno)") }
    try sync(logFd)
    logSize = 0
  }

  // ---- sealing and encoding ------------------------------------------------------------------------------

  /** revision(8) ‖ nonce ‖ ciphertext ‖ tag; the revision is also the associated data's tail. */
  private func seal(_ plain: Bytes, aad: Bytes, revision: UInt64) throws -> Bytes {
    do {
      let box = try ChaChaPoly.seal(Data(plain), using: key, authenticating: Data(aad + be64(revision)))
      return be64(revision) + Bytes(box.combined)
    } catch { throw StoreError.failed("sealing the state failed") }
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

  private func sync(_ fd: Int32) throws {
    #if canImport(Darwin)
    // fsync on Apple systems hands the data to the drive but does not ask it to write; F_FULLFSYNC does.
    if fcntl(fd, F_FULLFSYNC) == 0 { return }
    #endif
    guard fsync(fd) == 0 else { throw StoreError.failed("sync: errno \(errno)") }
  }
  /** The rename of the snapshot is durable once its folder is synced. */
  private func syncDirectory() {
    var fd = open(directory.path, O_RDONLY)
    if fd >= 0 { _ = fsync(fd); Self.closeFd(&fd) }
  }

  /** Removes a device's stored state for good (signing out). The caller holds no open store on it. */
  public static func wipe(directory: URL) { try? FileManager.default.removeItem(at: directory) }
}

func be32(_ v: Int) -> Bytes { let u = UInt32(truncatingIfNeeded: v); return [UInt8(u >> 24), UInt8((u >> 16) & 0xff), UInt8((u >> 8) & 0xff), UInt8(u & 0xff)] }
func be64(_ v: UInt64) -> Bytes { (0..<8).map { UInt8((v >> UInt64(56 - 8 * $0)) & 0xff) } }
func readBe32(_ b: Bytes, _ at: Int) -> UInt32 { (0..<4).reduce(UInt32(0)) { ($0 << 8) | UInt32(b[at + $1]) } }
func readBe64(_ b: Bytes, _ at: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { ($0 << 8) | UInt64(b[at + $1]) } }
