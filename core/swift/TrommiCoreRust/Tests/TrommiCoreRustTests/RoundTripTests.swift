// The round trip of core/tests/round_trip.rs through the Swift binding: found, add, join, the same key, seal and open,
// remove, no key for the removed device; and the state store as a Swift object the Rust core calls.
import Foundation
import XCTest
@testable import TrommiCoreRust

/// A store in Swift, as the app would write one over a locked file: the core calls it once per operation.
final class MemoryStore: MlsStateStore, @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [Data: Data] = [:]
  private(set) var batches = 0
  var failNext = false
  var failOddly = false

  init(_ entries: [StateEntry] = []) { for e in entries { self.entries[e.key] = e.value } }

  func load() throws -> [StateEntry] {
    lock.lock(); defer { lock.unlock() }
    return entries.map { StateEntry(key: $0.key, value: $0.value) }
  }

  func apply(put: [StateEntry], delete: [Data]) throws {
    lock.lock(); defer { lock.unlock() }
    if failNext { failNext = false; throw StoreFailure.Failed(message: "disk full") }
    if failOddly { failOddly = false; throw NSError(domain: "store", code: 28) }
    for key in delete { entries[key] = nil }
    for e in put { entries[e.key] = e.value }
    batches += 1
  }
}

final class RoundTripTests: XCTestCase {
  let group = Data("room-1".utf8)
  let label = "trommi body key"

  func testFoundAddJoinSealOpenRemove() throws {
    let a = try MlsDevice.create(identity: Data("device-a".utf8), store: MemoryStore())
    let b = try MlsDevice.create(identity: Data("device-b".utf8), store: MemoryStore())

    try a.foundGroup(groupId: group)
    let added = try a.addMember(groupId: group, keyPackage: try b.keyPackage())
    XCTAssertEqual(try b.join(welcome: added.welcome), group)
    XCTAssertEqual(try a.epoch(groupId: group), 1)
    XCTAssertEqual(try b.epoch(groupId: group), 1)
    XCTAssertEqual(try a.members(groupId: group), [try a.signatureKey(), try b.signatureKey()])

    let keyA = try a.exportKey(groupId: group, label: label, context: Data())
    let keyB = try b.exportKey(groupId: group, label: label, context: Data())
    XCTAssertEqual(keyA.count, 32)
    XCTAssertEqual(keyA, keyB)

    let sealed = try sealBody(key: keyA, aad: Data("header".utf8), body: Data("hello from A".utf8))
    XCTAssertEqual(try openBody(key: keyB, aad: Data("header".utf8), sealed: sealed), Data("hello from A".utf8))
    XCTAssertThrowsError(try openBody(key: keyB, aad: Data("other".utf8), sealed: sealed)) { error in
      guard case MlsError.Unsealed = error else { return XCTFail("\(error)") }
    }

    let commit = try a.removeMember(groupId: group, signatureKey: try b.signatureKey())
    let keyA2 = try a.exportKey(groupId: group, label: label, context: Data())
    XCTAssertNotEqual(keyA2, keyA)
    XCTAssertEqual(try a.epoch(groupId: group), 2)
    let later = try sealBody(key: keyA2, aad: Data(), body: Data("after the removal".utf8))
    XCTAssertThrowsError(try openBody(key: keyB, aad: Data(), sealed: later))

    let processed = try b.processCommit(groupId: group, commit: commit)
    XCTAssertTrue(processed.removed)
    XCTAssertThrowsError(try b.exportKey(groupId: group, label: label, context: Data())) { error in
      guard case MlsError.Evicted = error else { return XCTFail("\(error)") }
    }
  }

  func testTheStateLivesInTheSwiftStore() throws {
    let storeA = MemoryStore(), storeB = MemoryStore()
    var a = try MlsDevice.create(identity: Data("a".utf8), store: storeA)
    var b = try MlsDevice.create(identity: Data("b".utf8), store: storeB)
    try a.foundGroup(groupId: group)
    let keyPackage = try b.keyPackage()

    // Both devices again from what their stores hold.
    a = try MlsDevice.load(store: MemoryStore(try storeA.load()))
    b = try MlsDevice.load(store: MemoryStore(try storeB.load()))
    let added = try a.addMember(groupId: group, keyPackage: keyPackage)
    _ = try b.join(welcome: added.welcome)
    XCTAssertEqual(
      try a.exportKey(groupId: group, label: label, context: Data()),
      try b.exportKey(groupId: group, label: label, context: Data()))
    XCTAssertEqual(storeA.batches, 2, "create and foundGroup: one batch each")
  }

  func testAFailingStoreSurfacesAsAnError() throws {
    let store = MemoryStore()
    let a = try MlsDevice.create(identity: Data("a".utf8), store: store)
    store.failNext = true
    XCTAssertThrowsError(try a.foundGroup(groupId: group)) { error in
      guard case MlsError.Storage = error else { return XCTFail("\(error)") }
    }
  }

  func testAnyErrorOfTheStoreUndoesTheOperation() throws {
    let store = MemoryStore()
    let a = try MlsDevice.create(identity: Data("a".utf8), store: store)
    try a.foundGroup(groupId: group)
    // An error the binding does not know (not a StoreFailure): still an error of the call, and the epoch stays.
    store.failOddly = true
    let b = try MlsDevice.create(identity: Data("b".utf8), store: MemoryStore())
    XCTAssertThrowsError(try a.addMember(groupId: group, keyPackage: try b.keyPackage())) { error in
      guard case MlsError.Storage = error else { return XCTFail("\(error)") }
    }
    XCTAssertEqual(try a.epoch(groupId: group), 0)
    XCTAssertEqual(try a.members(groupId: group).count, 1)
  }

  func testTimes() throws {
    let start = Date()
    let a = try MlsDevice.create(identity: Data("a".utf8), store: MemoryStore())
    let b = try MlsDevice.create(identity: Data("b".utf8), store: MemoryStore())
    try a.foundGroup(groupId: group)
    let added = try a.addMember(groupId: group, keyPackage: try b.keyPackage())
    _ = try b.join(welcome: added.welcome)
    _ = try a.exportKey(groupId: group, label: label, context: Data())
    print(String(format: "found, add, join, export through Swift: %.1f ms", Date().timeIntervalSince(start) * 1000))
  }
}
