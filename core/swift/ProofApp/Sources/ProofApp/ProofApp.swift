// The round trip at launch, on the phone: two devices in one process, a store in Swift. The screen says what happened.
import Foundation
import SwiftUI
import TrommiCoreRust

final class MemoryStore: MlsStateStore, @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [Data: Data] = [:]
  func load() throws -> [StateEntry] {
    lock.lock(); defer { lock.unlock() }
    return entries.map { StateEntry(key: $0.key, value: $0.value) }
  }
  func apply(put: [StateEntry], delete: [Data]) throws {
    lock.lock(); defer { lock.unlock() }
    for key in delete { entries[key] = nil }
    for e in put { entries[e.key] = e.value }
  }
}

func roundTrip() -> String {
  do {
    let start = Date()
    let group = Data("room-1".utf8), label = "trommi body key"
    let a = try MlsDevice.create(identity: Data("device-a".utf8), store: MemoryStore())
    let b = try MlsDevice.create(identity: Data("device-b".utf8), store: MemoryStore())
    try a.foundGroup(groupId: group)
    let added = try a.addMember(groupId: group, keyPackage: try b.keyPackage())
    _ = try b.join(welcome: added.welcome)
    let keyA = try a.exportKey(groupId: group, label: label, context: Data())
    let keyB = try b.exportKey(groupId: group, label: label, context: Data())
    guard keyA == keyB else { return "FAILED: the keys differ" }
    let ms = Date().timeIntervalSince(start) * 1000
    let sealed = try sealBody(key: keyA, aad: Data(), body: Data("hello from A".utf8))
    guard try openBody(key: keyB, aad: Data(), sealed: sealed) == Data("hello from A".utf8) else { return "FAILED: open" }
    let commit = try a.removeMember(groupId: group, signatureKey: try b.signatureKey())
    guard try b.processCommit(groupId: group, commit: commit).removed else { return "FAILED: not removed" }
    if (try? b.exportKey(groupId: group, label: label, context: Data())) != nil { return "FAILED: a key after the removal" }
    return String(format: "OK: found, add, join, export in %.1f ms; seal and open; removed, no key", ms)
  } catch {
    return "FAILED: \(error)"
  }
}

@main
struct ProofApp: App {
  var body: some Scene {
    WindowGroup {
      Text(roundTrip()).padding().accessibilityIdentifier("result")
    }
  }
}
