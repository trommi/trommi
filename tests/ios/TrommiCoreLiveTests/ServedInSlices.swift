// The core's one-call forms (a whole history in one call), as the tests use them on what `PocketHub` serves, made of
// the steps the app uses (PastWalk.swift, LiveRecovery.swift): a start, slices, a finish. The app has only the steps;
// these let the tests hand a room they hold whole, and so every test of a join, a recovery or a past walks in slices.
// `sliceCap`: the most Commits a slice holds here, small so that a test's few Commits take more than one slice.
import Foundation
import TrommiClient
@testable import TrommiCoreLive

/// A room as a device that comes with the code reads it whole: the room group, the GroupInfo of the anchor's epoch,
/// every SealedKey and RecoveryLink, and every live session group with its id, main sessions before helper sessions.
typealias LiveServedRoom = (room: RoomId, group: LiveServedGroup, anchor: Bytes, sealedKeys: [Bytes], links: [Bytes], sessions: [LiveServedGroup], sessionIds: [GroupId])

var sliceCap = 2

extension LiveDevice {
  private func start(_ room: LiveServedRoom) -> LiveServedStart {
    (room.room, room.group.founding, room.anchor, room.sealedKeys, room.sessions.map(\.founding))
  }
  private func end(_ room: LiveServedRoom) -> LiveServedEnd {
    (room.group.current, room.sessions.map(\.current), room.sealedKeys, room.links)
  }
  /// Every Commit of the room's groups, ascending by change number across them, handed to `take` in slices.
  private func placed(_ room: LiveServedRoom, _ take: ([PlacedPastCommit]) throws -> Void) throws {
    var all = room.group.commits.map { (group: room.room, commit: $0) }
    for (session, id) in zip(room.sessions, room.sessionIds) { all += session.commits.map { (group: id, commit: $0) } }
    all.sort { $0.commit.change < $1.commit.change }
    var cap = sliceCap
    try Slices.feed(all, size: { $0.commit.commit.count }, cap: &cap) { try take($0); return true }
  }

  func joinRoomWithCode(_ code: Bytes, served room: LiveServedRoom, nowMs: UInt64) throws -> LiveCodeJoin {
    try codeCheckStart(code, served: start(room))
    try placed(room) { try codeCheckSlice($0) }
    return try joinRoomChecked(code, served: end(room), nowMs: nowMs)
  }

  func joinSessionWithCode(_ code: Bytes, served group: LiveServedGroup, nowMs: UInt64) throws -> UInt64 {
    let id = try sessionCheckStart(founding: group.founding)
    var cap = sliceCap
    try Slices.feed(group.commits, size: { $0.commit.count }, cap: &cap) { try sessionCheckSlice(group: id, commits: $0); return true }
    return try joinSessionChecked(code, group: id, current: group.current, nowMs: nowMs)
  }

  func prepareRecovery(_ code: Bytes, served room: LiveServedRoom) throws -> (newCode: Bytes, removals: [(group: GroupId, devices: [DeviceId])]) {
    try recoveryPlanStart(code, served: start(room))
    try placed(room) { try recoveryPlanSlice($0) }
    return try recoveryPlanFinish(code, served: end(room))
  }

  func recover(_ code: Bytes, served room: LiveServedRoom, chains: [(bytes: Bytes, change: UInt64, voidCode: String?)], account: Bytes, nowMs: UInt64) throws -> LiveCodeJoin {
    try codeCheckStart(code, served: start(room))
    try placed(room) { try codeCheckSlice($0) }
    return try recoverChecked(code, served: end(room), chains: chains, account: account, nowMs: nowMs)
  }

  func learnHistory(group: GroupId, founding: Bytes, commits: [PastCommit]) throws -> UInt64 {
    var progress = try learnStart(group: group, founding: founding)
    var cap = sliceCap
    try Slices.feed(commits, size: { $0.commit.count }, cap: &cap) { slice in
      guard !progress.reachedEnd else { return false }
      progress = try learnSlice(group: group, commits: slice)
      return true
    }
    return try learnFinish(group: group)
  }
}
