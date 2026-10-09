// A store for the tests of the Swift binding, with the core's contract (core/swift/src/store.rs).
import Foundation
import TrommiCoreRust

/// A device's store as one file, for tests: simple, not fast. It shows what the contract asks of a store.
///
/// - All or nothing, durable on return: every write puts the whole state into a new file, syncs it to the disk,
///   renames it over the old one and syncs the directory; a crash leaves the old state or the new one.
/// - The revision: read from the file before every write and compared with the one the write names.
/// - One owner: an exclusive lock on a file beside the state, taken before anything is read and held until
///   the device lets the store go (`close`); the operating system releases it when the process ends. A second
///   store on the same directory fails to load.
/// - What it reads is input like any other: a state file that is cut, or too large, is an error, never a trap,
///   and a file that cannot be read is not taken for an empty store.
///
/// A real store keeps its entries in a database and writes only what changed. An app extension that finds the
/// lock held does not wait and does not touch the state: the app owns it.
final class FileStore: CoreStore, @unchecked Sendable {
  private let directory: URL
  /// Guards everything below: the device calls from one thread at a time, a test may call from another.
  private let guardian = NSLock()
  private var lock: Int32 = -1
  private var failNext = false

  init(directory: URL) {
    self.directory = directory
  }

  private var stateFile: URL { directory.appendingPathComponent("state") }

  /// Makes the next write fail, writing nothing: a full disk.
  func failNextWrite() {
    guardian.lock()
    defer { guardian.unlock() }
    failNext = true
  }

  func close() {
    guardian.lock()
    defer { guardian.unlock() }
    if lock >= 0 {
      flock(lock, LOCK_UN)
      _ = Foundation.close(lock)
      lock = -1
    }
  }

  func load() throws -> StoredState {
    guardian.lock()
    defer { guardian.unlock() }
    guard lock < 0 else { throw StoreError.Failed(message: "the store was loaded before") }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      throw StoreError.Failed(message: "the store's directory cannot be made")
    }
    let descriptor = open(directory.appendingPathComponent("lock").path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw StoreError.Failed(message: "the lock file cannot be opened") }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      _ = Foundation.close(descriptor)
      throw StoreError.Conflict
    }
    do {
      let state = try read()
      lock = descriptor
      return state
    } catch {
      flock(descriptor, LOCK_UN)
      _ = Foundation.close(descriptor)
      throw error
    }
  }

  func apply(write: StoreWrite) throws {
    guardian.lock()
    defer { guardian.unlock() }
    guard lock >= 0 else { throw StoreError.Failed(message: "the store is closed") }
    if failNext {
      failNext = false
      throw StoreError.Failed(message: "the disk is full")
    }
    let state = try read()
    guard state.revision == write.expectedRevision else { throw StoreError.Conflict }
    let (next, overflow) = state.revision.addingReportingOverflow(1)
    guard !overflow else { throw StoreError.Failed(message: "the revision cannot grow") }
    var entries = Dictionary(state.entries.map { ($0.key, $0.value) }, uniquingKeysWith: { _, later in later })
    for key in write.delete { entries[key] = nil }
    for entry in write.put { entries[entry.key] = entry.value }
    try save(StoredState(revision: next, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) }))
  }

  /// The file: the revision, then each entry as key and value, every number 8 bytes and every byte string with
  /// its length before it. No file: an empty store. A file that cannot be read: an error.
  private func read() throws -> StoredState {
    guard FileManager.default.fileExists(atPath: stateFile.path) else { return StoredState(revision: 0, entries: []) }
    guard let data = try? Data(contentsOf: stateFile) else { throw StoreError.Failed(message: "the state file cannot be read") }
    let cut = StoreError.Failed(message: "the state file is cut short")
    var at = data.startIndex
    func number() throws -> UInt64 {
      guard data.endIndex - at >= 8 else { throw cut }
      defer { at += 8 }
      return data[at..<at + 8].reduce(0) { $0 << 8 | UInt64($1) }
    }
    func bytes() throws -> Data {
      guard let length = Int(exactly: try number()), data.endIndex - at >= length else { throw cut }
      defer { at += length }
      return Data(data[at..<at + length])
    }
    let revision = try number()
    var entries: [StoreEntry] = []
    while at < data.endIndex { entries.append(StoreEntry(key: try bytes(), value: try bytes())) }
    return StoredState(revision: revision, entries: entries)
  }

  /// Until the rename nothing changed and a failure is "nothing written". After it the new state is in place.
  private func save(_ state: StoredState) throws {
    var data = Data()
    func number(_ value: UInt64) { data.append(contentsOf: (0..<8).reversed().map { UInt8(truncatingIfNeeded: value >> (UInt64($0) * 8)) }) }
    number(state.revision)
    for entry in state.entries {
      number(UInt64(entry.key.count)); data.append(entry.key)
      number(UInt64(entry.value.count)); data.append(entry.value)
    }
    let failed = StoreError.Failed(message: "the state file cannot be written")
    let fresh = directory.appendingPathComponent("state.new")
    let descriptor = open(fresh.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
    guard descriptor >= 0 else { throw failed }
    let written = data.withUnsafeBytes { Foundation.write(descriptor, $0.baseAddress, $0.count) }
    let synced = written == data.count && toDisk(descriptor)
    _ = Foundation.close(descriptor)
    guard synced, rename(fresh.path, stateFile.path) == 0 else { throw failed }
    // The rename itself is durable once the directory is on the disk.
    let folder = open(directory.path, O_RDONLY)
    guard folder >= 0 else { throw failed }
    let durable = toDisk(folder)
    _ = Foundation.close(folder)
    guard durable else { throw failed }
  }

  /// Whether everything written to `descriptor` is on the disk. On Apple's systems `fsync` hands the bytes to the
  /// drive without asking it to write them: only F_FULLFSYNC does.
  private func toDisk(_ descriptor: Int32) -> Bool {
    #if canImport(Darwin)
    return fcntl(descriptor, F_FULLFSYNC) == 0 || fsync(descriptor) == 0
    #else
    return fsync(descriptor) == 0
    #endif
  }
}
