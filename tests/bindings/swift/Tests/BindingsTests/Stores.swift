// Stores for the tests of the Swift binding, with the core's contract (core/swift/src/store.rs).
import Foundation
import TrommiCoreRust

/// A device's store as one file, for tests: simple, not fast. It shows what the contract asks of a store.
///
/// - All or nothing, durable on return: every write puts the whole state into a new file, syncs it, and renames
///   it over the old one; a crash leaves the old state or the new one.
/// - The revision: read from the file before every write and compared with the one the write names.
/// - One owner: an exclusive lock on a file beside the state, taken before anything is read and held until
///   `close` (the operating system releases it when the process ends). A second store on the same directory fails to load.
///
/// A real store keeps its entries in a database and writes only what changed.
final class FileStore: CoreStore, @unchecked Sendable {
  private let directory: URL
  private var lock: Int32 = -1
  /// Makes the next write fail, writing nothing: a full disk.
  var failNextWrite = false

  init(directory: URL) {
    self.directory = directory
  }

  deinit { close() }

  private var stateFile: URL { directory.appendingPathComponent("state") }

  /// Releases the lock: another store may open the state.
  func close() {
    if lock >= 0 {
      flock(lock, LOCK_UN)
      _ = Foundation.close(lock)
      lock = -1
    }
  }

  func load() throws -> StoredState {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let descriptor = open(directory.appendingPathComponent("lock").path, O_CREAT | O_RDWR, 0o600)
    guard descriptor >= 0 else { throw StoreError.Failed(message: "the lock file cannot be opened") }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
      _ = Foundation.close(descriptor)
      throw StoreError.Conflict
    }
    lock = descriptor
    return try read()
  }

  func apply(write: StoreWrite) throws {
    guard lock >= 0 else { throw StoreError.Failed(message: "the store is closed") }
    if failNextWrite {
      failNextWrite = false
      throw StoreError.Failed(message: "the disk is full")
    }
    var state = try read()
    guard state.revision == write.expectedRevision else { throw StoreError.Conflict }
    var entries = Dictionary(uniqueKeysWithValues: state.entries.map { ($0.key, $0.value) })
    for key in write.delete { entries[key] = nil }
    for entry in write.put { entries[entry.key] = entry.value }
    state = StoredState(revision: state.revision + 1, entries: entries.map { StoreEntry(key: $0.key, value: $0.value) })
    try save(state)
  }

  /// The file: the revision, then each entry as key and value, every number 8 bytes and every byte string with
  /// its length before it.
  private func read() throws -> StoredState {
    guard let data = try? Data(contentsOf: stateFile) else { return StoredState(revision: 0, entries: []) }
    var at = data.startIndex
    func number() throws -> UInt64 {
      guard data.endIndex - at >= 8 else { throw StoreError.Failed(message: "the state file is cut short") }
      defer { at += 8 }
      return data[at..<at + 8].reduce(0) { $0 << 8 | UInt64($1) }
    }
    func bytes() throws -> Data {
      let length = Int(try number())
      guard data.endIndex - at >= length else { throw StoreError.Failed(message: "the state file is cut short") }
      defer { at += length }
      return Data(data[at..<at + length])
    }
    let revision = try number()
    var entries: [StoreEntry] = []
    while at < data.endIndex { entries.append(StoreEntry(key: try bytes(), value: try bytes())) }
    return StoredState(revision: revision, entries: entries)
  }

  private func save(_ state: StoredState) throws {
    var data = Data()
    func number(_ value: UInt64) { data.append(contentsOf: (0..<8).reversed().map { UInt8(truncatingIfNeeded: value >> (UInt64($0) * 8)) }) }
    number(state.revision)
    for entry in state.entries {
      number(UInt64(entry.key.count)); data.append(entry.key)
      number(UInt64(entry.value.count)); data.append(entry.value)
    }
    let fresh = directory.appendingPathComponent("state.new")
    let descriptor = open(fresh.path, O_CREAT | O_WRONLY | O_TRUNC, 0o600)
    guard descriptor >= 0 else { throw StoreError.Failed(message: "the state file cannot be written") }
    let written = data.withUnsafeBytes { Foundation.write(descriptor, $0.baseAddress, $0.count) }
    let synced = fsync(descriptor)
    _ = Foundation.close(descriptor)
    guard written == data.count, synced == 0, rename(fresh.path, stateFile.path) == 0 else {
      throw StoreError.Failed(message: "the state file cannot be written")
    }
    // The rename itself is durable once the directory is synced.
    let folder = open(directory.path, O_RDONLY)
    if folder >= 0 {
      fsync(folder)
      _ = Foundation.close(folder)
    }
  }
}
