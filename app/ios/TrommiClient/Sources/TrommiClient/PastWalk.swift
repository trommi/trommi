// PastWalk.swift: a group's history in pages and slices. The core walks a group's past (spec/v1.md 4.6) and checks a
// room for a device that comes with the code (8.4, 8.5) in steps: a start, slices of Commits, a finish. Nothing of a
// history is held whole here: the hub serves a group's log page by page (GET /v1/groups/{group}/log), and each page
// goes to the core in slices of at most 256 Commits and 16 MiB together (core/README.md, "A walk in steps").
//
// A walk is held in the core's memory only, one at a time: a relaunch, or any refusal but `too-large`, ends it, and
// the caller starts again from the founding.
import Foundation

/** Where a walk of a group's past stands (core `LearnProgress`). */
public struct LearnProgress: Equatable {
  /** The epoch the walk has reached: the next Commit it takes builds on it. */
  public var epoch: UInt64
  /** The epoch the walk ends at: the one this device's own knowledge of the group begins at. */
  public var upto: UInt64
  public init(epoch: UInt64, upto: UInt64) { self.epoch = epoch; self.upto = upto }
  /** Nothing more to hand in: the finish decides. */
  public var reachedEnd: Bool { epoch >= upto }
}

/** The core's slices: what one call of a walk takes. */
public enum Slices {
  /** The most Commits one slice holds (core `recovery::MAX_SLICE_COMMITS`). */
  public static let maxCommits = 256
  /** The most bytes the Commits of one slice hold together (core `recovery::MAX_SLICE_LEN`). */
  public static let maxBytes = 16 << 20

  /**
   * Hands `items` to `take` in order, in slices of at most `maxCommits` items and `maxBytes` (by `size`), at least
   * one item each. A slice the core refuses as `too-large` is halved, and the halved size is kept for the rest; a
   * single item it refuses so is thrown. `take` answers whether to go on; false stops (the rest is not handed in).
   * Returns false when `take` stopped.
   */
  @discardableResult
  public static func feed<T>(_ items: [T], size: (T) -> Int, cap: inout Int, _ take: ([T]) throws -> Bool) throws -> Bool {
    var at = 0
    while at < items.count {
      var count = 0, total = 0
      for item in items[at...].prefix(min(cap, maxCommits)) {
        total += size(item)
        if count > 0 && total > maxBytes { break }
        count += 1
      }
      do {
        guard try take(Array(items[at..<(at + count)])) else { return false }
        at += count
      } catch let refused as TrommiError where refused.code == "too-large" && count > 1 {
        cap = count / 2
      }
    }
    return true
  }
}

/**
 * A group's log, page by page, Commits only (GET /v1/groups/{group}/log?kind=commit). Each Commit with its change
 * number and, for a join from outside, its RecoveryAuth. `below`: the epoch the reading stops at; a Commit that
 * builds on it or a later one is not read (the GroupInfo read as current names it, so log and GroupInfo agree).
 * Nothing in it is trusted: the core checks it.
 */
public struct GroupLogPages {
  public let hub: HubClient
  public let group: GroupId
  public let below: UInt64?
  /** The log number read last. */
  public private(set) var after: UInt64 = 0
  /** The epoch the last Commit read leads to. */
  public private(set) var reached: UInt64 = 0
  public private(set) var ended = false
  /** The most items asked for per page. */
  public var limit = 200

  public init(hub: HubClient, group: GroupId, below: UInt64? = nil) {
    self.hub = hub; self.group = group; self.below = below
    if below == 0 { ended = true }
  }

  /** The next page's Commits ([] for a page without any), or nil once the log is read to its end. */
  public mutating func next() async throws -> [PastCommit]? {
    guard !ended else { return nil }
    let page = try await hub.groupLog(group, after: after, limit: limit, commitsOnly: true)
    let items = page["items"] as? [JSON] ?? []
    var commits = [PastCommit]()
    for item in items {
      guard let n = Wire.uint(item["n"]), n > after else { throw TrommiError("bad-format", "the hub's log of a group is not in order") }
      after = n
      guard item["kind"] as? String == "commit" else { continue }
      guard let change = Wire.uint(item["change"]), let epoch = Wire.uint(item["epoch"]) else { throw TrommiError("bad-format", "a Commit of the hub's log has no change number or epoch") }
      if let below, epoch >= below { ended = true; break }
      guard let text = item["bytes"] as? String, let commit = try? unb64u(text), !commit.isEmpty else { throw TrommiError("bad-format", "the hub's answer has no bytes") }
      commits.append((change, commit, (item["recovery_auth"] as? String).flatMap { try? unb64u($0) }))
      reached = epoch + 1
      if let below, reached >= below { ended = true; break }
    }
    if page["more"] as? Bool != true || items.isEmpty { ended = true }
    return commits
  }
}

extension HubClient {
  /** The bytes of a group's GroupInfo, of `epoch` or the current one, with the epoch the hub names. */
  public func groupInfoBytes(_ group: GroupId, epoch: UInt64? = nil) async throws -> (epoch: UInt64, bytes: Bytes) {
    let json = try await groupInfo(group, epoch: epoch)
    guard let text = json["group_info"] as? String, let bytes = try? unb64u(text), !bytes.isEmpty else { throw TrommiError("bad-format", "the hub's answer has no group_info") }
    guard let named = Wire.uint(json["epoch"]) ?? epoch else { throw TrommiError("bad-format", "the hub's GroupInfo names no epoch") }
    return (named, bytes)
  }
}
