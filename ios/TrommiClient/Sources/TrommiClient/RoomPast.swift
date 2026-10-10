// RoomPast.swift: what was in the room before this device came. A device that joined by link, or was added to a
// session group by a Welcome, holds each group from the epoch it joined at; the core takes an envelope of an earlier
// epoch only once it learned the group's past from its public history (`CoreDevice.learnHistory`, spec/v1.md 4.6).
//
// What is left to do is kept in room.json (`RoomRecord.past`), so an interrupted run goes on at the next sync:
//
//   learn      per group: the founding GroupInfo and the Commits of its log are fetched and handed to the core, the
//              room group first, then main sessions, then helper sessions;
//   read back  the board is emptied and the hub's changes are read again from the start, in the hub's order. An
//              envelope below the device's cursor is handed to the core as the next of its sender's chain; one the
//              chain holds already is read again for display. The keys of the old epochs come by the handover of
//              the device that let this one in: an item whose key is not here yet takes its place in its chain
//              without its body, and the changes are read back once more when a handover brought keys.
import Foundation

/** What is left to do so that this device shows what was written before it came. No secret in it. */
public struct PastWork: Codable, Equatable {
  /** The groups (hex) whose past is still to be learned. */
  public var toLearn: [String] = []
  /** An envelope was passed over because its group's past was not known: reading back is worth it once a past is learned. */
  public var passedOver = false
  /** An item took its place without its body, for want of its epoch's key: reading back is worth it once keys come. */
  public var closed = false
  /** The changes are to be read again from the start; false again once that read came to its end. */
  public var readBack = false
  public init(toLearn: [String] = []) { self.toLearn = toLearn }
}

extension Room {
  /** Changes what is left to do for the past and writes it down, if it changed. */
  func notePast(_ edit: (inout PastWork) -> Void) {
    var past = record.past ?? PastWork()
    edit(&past)
    guard past != (record.past ?? PastWork()) else { return }
    record.past = past
    try? store.save(record)
  }

  /** Room group, main sessions, helper sessions: the order the core learns in. */
  private func learningRank(_ group: String) -> Int {
    guard let session = groups[group]?.session else { return 0 }
    return session.parent == nil ? 1 : 2
  }

  /**
   * Does what is left to do for the past (see the head of this file); nothing when nothing is left. Inside `serial`.
   * A failure of the hub is thrown with everything still noted: the next sync goes on. A group whose turn has not
   * come (`room-behind`, `group-behind`) stays noted; a history that is not the group's own (`bad-group`) is a
   * finding about the hub, and that group's past stays closed.
   */
  func tendPast(_ report: inout SyncReport, _ change: inout Change) async throws {
    pastDue = false
    guard let noted = record.past, !noted.toLearn.isEmpty || noted.readBack else { return }
    for id in noted.toLearn.sorted(by: { learningRank($0) < learningRank($1) }) {
      // (a group this device is no longer in has no past to show)
      guard groups[id] != nil, let group = try? unhex(id) else { notePast { $0.toLearn.removeAll { $0 == id } }; continue }
      let served = try await self.noted { try await hub.history(of: group) }
      do {
        let epochs = try await onCore { try $0.learnHistory(group: group, founding: served.founding, commits: served.commits) }
        notePast { $0.toLearn.removeAll { $0 == id }; if epochs > 0 && $0.passedOver { $0.readBack = true } }
      } catch let e as TrommiError where e.code == "room-behind" || e.code == "group-behind" {
        continue
      } catch let e as TrommiError where e.code == "bad-group" {
        board.pushAlert(&change, code: "bad-group", message: "the hub served a history that is not this group's: what was written before this device came stays closed")
        notePast { $0.toLearn.removeAll { $0 == id } }
      }
    }
    guard record.past?.readBack == true else { return }
    // The board and its cache are built again from the hub's changes. What the core holds (keys, chains, objects)
    // stays; the two notes are taken anew by this read.
    await saveTail?.value
    dropCache()
    board.reset()
    try applyGroups(Array(groups.values), &change)
    notePast { $0.passedOver = false; $0.closed = false }
    readingBack = true
    defer { readingBack = false }
    // (a board shown is loaded anew from its snapshot by the core: what it holds now may lack what it showed)
    boardsReset &+= 1
    try await readChanges(&report, &change)
    notePast { $0.readBack = false }
  }
}
