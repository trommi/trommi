// RoomCache.swift: what this device already opened, kept so the next launch shows the board at once and before any
// network: the records (replayed into the board through the same reducer) and now and then the board as a whole.
// Sealed at rest under a key of this device (RecordStore.swift, Keychain.swift). It is a cache of what was shown,
// not state: keys, chains, the groups and the outbox are the core's, in the device's store (DeviceStore.swift); if
// the cache is damaged or missing it is thrown away and the board is read again from the hub.
import Foundation

extension Room {
  /** The cache's small head: where the records stop. */
  struct Head: Codable {
    var v = 4
    /** How many records the store held when this head was written: fewer on reading means a store damaged beyond its tail. */
    var records: Int
    var cursor: UInt64
    var lamport: Int
  }
  static let snapshotEvery = 2000

  func recordStore() throws -> RecordStore {
    if let r = recordStoreMemo { return r }
    let r = RecordStore(dir: store.dir, key: try LocalKey.get("cache", dir: store.dir))
    recordStoreMemo = r
    return r
  }

  /** Write a moment after the last change (a catch-up brings thousands at once). */
  func cacheSoon(_ n: UInt64? = nil) {
    if let n = n { dirtyRecs.insert(n) }
    cacheDirty = true
    if cacheTask != nil { return }
    cacheTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      self?.cacheTask = nil
      self?.saveCache()
    }
  }
  /** Write it now (the app going to the background). */
  public func saveCache(snapshot: Bool = false) { Task { await saveCacheAndWait(snapshot: snapshot) } }

  /**
   * Appends the changed records and writes the small head, off the main thread, one save after the other. With
   * `snapshot` (the app going to the background), or every `snapshotEvery` records, also the board as a whole; only
   * a settled board is written (nothing of this device in flight).
   */
  public func saveCacheAndWait(snapshot: Bool = false) async {
    let wantSnap = ((synced && sinceSnapshot >= Room.snapshotEvery) || (snapshot && sinceSnapshot >= Room.snapshotEvery / 10)) && ownEchoes.isEmpty && board.settled
    guard cacheDirty || wantSnap, let rs = try? recordStore() else { return }
    cacheDirty = false
    let recs = dirtyRecs.sorted().compactMap { log[$0] }
    dirtyRecs = []
    let head = Head(records: restoredCount + log.count, cursor: cursor, lamport: lamport)
    var snap: [UInt8]? = nil
    if wantSnap {
      var w = RecCodec.W()
      w.b.append(2); w.u(cursor); w.i(lamport); w.u(UInt64(head.records))
      BoardCodec.encode(board, into: &w)
      snap = w.b
      sinceSnapshot = 0
    }
    let prev = saveTail
    let t = Task.detached(priority: .utility) {
      _ = await prev?.value
      do {
        try rs.append(recs)
        try rs.writeSmall(head, to: rs.headURL, aad: "trommi ios head")
        if let b = snap { try rs.writeBoard(b) }
      } catch {}
    }
    saveTail = t
    await t.value
  }

  /**
   * The board from the cache, before any network: opened and decoded off the main thread, then replayed. Returns
   * false when there is none (or it does not fit: then it is thrown away and the catch-up starts at 0).
   */
  @discardableResult public func restore() async -> Bool {
    if let t = restoring { return await t.value }
    let t = Task { @MainActor in await self.restoreOnce() }
    restoring = t
    return await t.value
  }
  private func restoreOnce() async -> Bool {
    guard let rs = try? recordStore() else { return false }
    typealias Snap = (cursor: UInt64, lamport: Int, records: Int, board: Board)
    let found: (head: Head, snap: Snap?, ix: RecordStore.Index)? = await Task.detached(priority: .userInitiated) {
      guard let h = rs.readSmall(Head.self, from: rs.headURL, aad: "trommi ios head"), h.v == 4 else { return nil }
      var snap: Snap? = nil
      if let plain = rs.readBoard() {
        snap = plain.withUnsafeBufferPointer { buf -> Snap? in
          var r = RecCodec.R(b: buf)
          guard (try? r.byte()) == 2, let c = try? r.u(), let l = try? r.i(), let n = try? r.u() else { return nil }
          let b = Board()
          guard (try? BoardCodec.decode(&r, into: b)) != nil, r.at == buf.count, c <= h.cursor else { return nil }
          return (c, l, Int(n), b)
        }
      }
      guard let ix = rs.index(after: snap.map { Int($0.cursor) }) else { return nil }
      return (h, snap, ix)
    }.value
    guard let f = found else { rs.wipe(); return false }
    // The cache never runs ahead of the device: a cursor beyond what the core processed is a cache of another state.
    let base = Int(f.snap?.cursor ?? 0)
    let lo0 = f.ix.entries.firstIndex { $0.n > base } ?? f.ix.entries.count
    let upto = f.ix.entries.firstIndex { $0.n > Int(f.head.cursor) } ?? f.ix.entries.count
    guard upto - lo0 >= f.head.records - (f.snap?.records ?? 0) else { rs.wipe(); return false }
    var ch = Change()
    if let sn = f.snap {
      board.adopt(sn.board)
      try? applyGroups(Array(groups.values), &ch)
    }
    let slice = 2048
    let ix = f.ix
    let parts = stride(from: lo0, to: upto, by: slice).map { lo in
      Task.detached(priority: .userInitiated) { rs.decode(ix, lo..<min(lo + slice, upto)) }
    }
    for p in parts {
      guard let recs = await p.value else {
        for q in parts { q.cancel() }
        rs.wipe(); board.reset()
        board.roomId = record.roomId; board.hubURL = record.hubURL; board.myDeviceId = record.myDeviceId; board.myRole = record.role
        var c = Change(); try? applyGroups(Array(groups.values), &c)
        return false
      }
      for r in recs { board.apply(r, change: &ch) }
    }
    restoredCount = f.head.records
    sinceSnapshot = f.snap == nil ? Room.snapshotEvery : upto - lo0
    cursor = f.head.cursor
    lamport = max(lamport, f.head.lamport)
    board.lastEnvelopeNumber = max(board.lastEnvelopeNumber, Int(cursor))
    board.project()
    restored = true
    ch.stack = true; ch.room = true
    emit(ch)
    return true
  }
  /** Throw the cache away (the board is read again from the hub). */
  public func dropCache() { (try? recordStore())?.wipe(); log = [:]; restoredCount = 0; dirtyRecs = []; cursor = 0 }
}
