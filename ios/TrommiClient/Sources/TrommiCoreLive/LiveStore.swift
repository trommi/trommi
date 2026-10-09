// LiveStore.swift: what crosses the edge between Swift and the Rust core besides the calls themselves: the device's
// store, errors, and byte strings.
//
// THE STORE. The core calls the app's store through the binding's protocol `CoreStore` (load, apply(write:)). The app's
// stores implement `CoreStorage` (TrommiClient/Core.swift; on the phone that is DeviceStore). `StoreAdapter` is the one
// between: it changes the shapes and nothing else. Both calls arrive on the thread that called the device, while the
// device is locked inside the core, so a store must not call its device back.
//
//   CoreStorage throws        the core is told                 the device then
//   StoreError.conflict       StoreError.Conflict              is the owner no more; every later call is `storage`
//   StoreError.failed(text)   StoreError.Failed(message: text) refuses that one call with `storage`, text passed on
//   any other error           StoreError.Failed, a fixed text  the same; the foreign error's own words are not passed
//                                                              on, because nothing says what they hold
//
// ERRORS. The binding throws `CoreError.Refused(code, message)`. It becomes `TrommiError(code, message)` with the code
// spelled as the specification's section 16 spells it ("bad-format", "decrypt-failed", …): the same text the hub
// sends, so one `switch` on `TrommiError.code` serves both.
import Foundation
import TrommiClient
import TrommiCoreRust

/// Runs one call of the binding and gives its refusal the client's shape.
func core<T>(_ call: () throws -> T) throws -> T {
  do { return try call() } catch let TrommiCoreRust.CoreError.Refused(code, message) { throw refusal(code, message) }
}

/// The binding's message starts with the code's own text ("bad-format: the challenge is not 32 bytes"), or is only
/// that text. `TrommiError` prints the code itself, so it is taken off here.
func refusal(_ code: ErrorCode, _ message: String) -> TrommiError {
  let text = errorCodeText(code: code)
  if message == text { return TrommiError(text) }
  if message.hasPrefix(text + ": ") { return TrommiError(text, String(message.dropFirst(text.count + 2))) }
  return TrommiError(text, message)
}

extension Array where Element == UInt8 {
  var data: Data { Data(self) }
}
extension Data {
  var bytes: Bytes { Bytes(self) }
}

/// The app's store as the core calls it.
final class StoreAdapter: CoreStore, @unchecked Sendable {
  private let storage: CoreStorage
  init(_ storage: CoreStorage) { self.storage = storage }

  func load() throws -> StoredState {
    try crossing {
      let loaded = try storage.load()
      return StoredState(revision: loaded.revision, entries: loaded.entries.map { TrommiCoreRust.StoreEntry(key: $0.key.data, value: $0.value.data) })
    }
  }

  func apply(write: StoreWrite) throws {
    try crossing {
      let batch = StoreBatch(put: write.put.map { TrommiClient.StoreEntry(key: $0.key.bytes, value: $0.value.bytes) }, delete: write.delete.map(\.bytes))
      try storage.apply(expectedRevision: write.expectedRevision, batch: batch)
    }
  }

  private func crossing<T>(_ call: () throws -> T) throws -> T {
    do { return try call() }
    catch TrommiClient.StoreError.conflict { throw TrommiCoreRust.StoreError.Conflict }
    catch TrommiClient.StoreError.failed(let text) { throw TrommiCoreRust.StoreError.Failed(message: text) }
    catch { throw TrommiCoreRust.StoreError.Failed(message: "the store threw an error that is not a StoreError") }
  }
}

/// A store in memory, for the devices LiveCore makes only to ask the core something (LiveCore.swift) and for the
/// Swift half of the self-test. Nothing in it outlives its last reference.
final class MemoryStorage: CoreStorage {
  private var revision: UInt64 = 0
  private var entries: [Bytes: Bytes] = [:]

  func load() throws -> StoreLoaded {
    StoreLoaded(revision: revision, entries: entries.map { TrommiClient.StoreEntry(key: $0.key, value: $0.value) })
  }

  func apply(expectedRevision: UInt64, batch: StoreBatch) throws {
    guard expectedRevision == revision else { throw TrommiClient.StoreError.conflict }
    for key in batch.delete { entries[key] = nil }
    for entry in batch.put { entries[entry.key] = entry.value }
    revision += 1
  }

  /// What another owner's write does to the revision: the self-test's way to make a conflict.
  func writeBehindTheOwner() { revision += 1 }
}
