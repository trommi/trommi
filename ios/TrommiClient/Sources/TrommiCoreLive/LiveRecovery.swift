// LiveRecovery.swift: recovery and signing in on a new device (spec/v1.md section 8) on the Rust core, as the binding
// has it (core/swift/src/recovery.rs and the recovery calls of core/swift/src/device.rs), one call for one call.
//
// WHY THESE ARE NOT Core.swift's TWO AWAITED CALLS. Core.swift guessed `joinWithRecoveryCode(device:code:groupInfos:
// sealedKeys:nowMs:)` and `replaceRecoveryCode(nowMs:)` before the core had recovery. The core's real flow needs more:
//   - a join verifies the room from its founding: per group the GroupInfo of epoch 0, every Commit since, and the
//     current GroupInfo; for the room also the GroupInfo of the anchor's epoch, every SealedKey and RecoveryLink;
//     the Commits go to the core in steps (a start, slices, a finish: PastWalk.swift), never a room's whole history
//     in one call;
//   - the hub must have accepted the join of the room group before a session group can be joined;
//   - replacing the code needs the code in force and the account's new sealed copies.
// So the calls here take exactly what the core takes. Their parameters and results are plain tuples of bytes and
// numbers: when Core.swift declares the same calls with the same tuples, LiveCore and LiveDevice conform as they are.
//
// THE CODE (32 bytes) is held by the caller only while it founds, joins, recovers or replaces; nothing here keeps
// it, except `RecoverySigner`, which lives as long as the hub client that signs in with it.
//
import Foundation
import TrommiClient
import TrommiCoreRust

/// One group as the hub serves it to a device that verifies it from its founding: the GroupInfo of epoch 0, every
/// Commit since in the hub's order (each with its change number and, for a join from outside, its RecoveryAuth), and
/// the GroupInfo the hub offers as current. Nothing in it is trusted.
public typealias LiveServedGroup = (founding: Bytes, commits: [PastCommit], current: Bytes)
/// What a hub serves to begin the check of a room in steps (8.4, 8.5), everything but the Commits: the room, the room
/// group's founding GroupInfo, the GroupInfo of the anchor's epoch (`LiveCore.recoveryAnchor` names the epoch), every
/// SealedKey, and the founding GroupInfo of every live session group, main sessions before helper sessions.
public typealias LiveServedStart = (room: RoomId, founding: Bytes, anchor: Bytes, sealedKeys: [Bytes], sessions: [Bytes])
/// What a hub serves to end the check of a room: the GroupInfo it offers as the room group's current one, the same
/// for every session group in the order of the start's, every SealedKey and every RecoveryLink.
public typealias LiveServedEnd = (current: Bytes, sessions: [Bytes], sealedKeys: [Bytes], links: [Bytes])
/// One Commit of a room's logs with its group: the room group or a session group the start named.
public typealias PlacedPastCommit = (group: GroupId, commit: PastCommit)
/// What a join with the code, or a whole recovery, leaves behind. `outbox`: the entries to post, in order; the
/// device's state changes only when the hub accepted the last. `missingLink`: a recovery key whose link to the code
/// it replaced the hub did not serve (the content of the older codes' time stays closed; the finding is `withheld`).
/// `unverified`: the served session groups that did not verify and are not joined, by their place in `sessions`.
public typealias LiveCodeJoin = (outbox: [UInt64], missingLink: Bytes?, unverified: [(index: Int, code: String)])

/// Signs the hub's challenge under the recovery code (12.3, 8.4), for a device that is not yet a member: the token it
/// gets may read what a join with the code needs and post that join.
final class RecoverySigner: CoreSigner {
  private let code: Data
  /// The recovery signature key's public half, which the hub knows this signer by.
  let id: DeviceId

  /// `bad-format` unless the code is 32 bytes.
  init(code: Bytes) throws {
    self.code = code.data
    // The binding hands out no public key of a code. A signed `HubAuth` ends with the signer's key (32 bytes) and
    // the challenge (32 bytes): the key is read from one made for nobody.
    let probe = try core { try recoverySignIn(recoveryCode: code.data, room: ZERO32.data, hub: "http://localhost", challenge: ZERO32.data) }.auth.bytes
    guard probe.count >= 64 else { throw TrommiError("internal", "a signed HubAuth is shorter than its two last fields") }
    id = Bytes(probe[(probe.count - 64)..<(probe.count - 32)])
  }

  func signHubAuth(room: RoomId, hub: String, challenge: Bytes) throws -> (auth: Bytes, signature: Bytes) {
    let signed = try core { try recoverySignIn(recoveryCode: code, room: room.data, hub: hub, challenge: challenge.data) }
    return (signed.auth.bytes, signed.signature.bytes)
  }
}

private func served(_ group: LiveServedGroup) -> TrommiCoreRust.ServedGroup {
  ServedGroup(founding: group.founding.data, commits: group.commits.map(served), current: group.current.data)
}
private func served(_ commit: PastCommit) -> TrommiCoreRust.ServedCommit {
  ServedCommit(change: commit.change, commit: commit.commit.data, recoveryAuth: commit.recoveryAuth?.data)
}
private func served(_ start: LiveServedStart) -> TrommiCoreRust.ServedStart {
  ServedStart(room: start.room.data, founding: start.founding.data, anchor: start.anchor.data, rows: start.sealedKeys.map(\.data), sessions: start.sessions.map(\.data))
}
private func served(_ end: LiveServedEnd) -> TrommiCoreRust.ServedEnd {
  ServedEnd(current: end.current.data, sessions: end.sessions.map(\.data), rows: end.sealedKeys.map(\.data), links: end.links.map(\.data))
}
private func placed(_ commits: [PlacedPastCommit]) -> [TrommiCoreRust.PlacedCommit] {
  commits.map { PlacedCommit(group: $0.group.data, commit: served($0.commit)) }
}
private func progress(_ p: TrommiCoreRust.LearnProgress) -> TrommiClient.LearnProgress { .init(epoch: p.epoch, upto: p.upto) }
private func codeJoin(_ join: TrommiCoreRust.CodeJoin) -> LiveCodeJoin {
  (join.outbox, join.missingLink?.bytes, join.unverified.map { (Int($0.index), errorCodeText(code: $0.code)) })
}

// ---- without a device -------------------------------------------------------------------------------------

extension LiveCore {
  /// Who signs in to the hub while a device joins with the code (8.4).
  public func recoverySigner(code: Bytes) throws -> CoreSigner { try RecoverySigner(code: code) }

  /// The anchor of a join with the code (8.5), from the room's SealedKeys as the hub lists them: the newest epoch of
  /// the room group that a human device vouched for under this code. The caller asks the hub for the GroupInfo of
  /// that epoch. `wrong-recovery`: none is vouched for under this code; `equivocation`: two name different
  /// GroupInfos for the newest epoch. `groupInfo` is the hash that names the GroupInfo, which the core checks itself.
  public func recoveryAnchor(code: Bytes, room: RoomId, sealedKeys: [Bytes]) throws -> (group: GroupId, epoch: UInt64, groupInfo: Hash32) {
    let anchor = try core { try TrommiCoreRust.recoveryAnchor(recoveryCode: code.data, room: room.data, rows: sealedKeys.map(\.data)) }
    return (anchor.group.bytes, anchor.epoch, anchor.groupInfo.bytes)
  }
}

// ---- on the device ----------------------------------------------------------------------------------------

extension LiveDevice {
  // A history is handed to the core in steps (PastWalk.swift): a start, slices of at most 256 Commits and 16 MiB
  // (`too-large`, and the check stands where it was), a finish. A check is held in the core's memory only, one of a
  // kind at a time (a new start replaces it); any other refusal of a slice ends it, and so does every finish.

  /// Begins the check of the room for signing in on a new device with the code (8.4, 8.5): everything the hub serves
  /// but the Commits. `room-exists` for a device that holds a room; `wrong-recovery`, `bad-group`.
  public func codeCheckStart(_ code: Bytes, served start: LiveServedStart) throws {
    try core { try device.codeCheckStart(recoveryCode: code.data, served: served(start)) }
  }

  /// The next Commits of the room's logs, of the room group and of every session group the start named, ascending by
  /// change number across the groups.
  public func codeCheckSlice(_ commits: [PlacedPastCommit]) throws {
    try core { try device.codeCheckSlice(commits: placed(commits)) }
  }

  /// Ends the check of the room and, if it holds, builds the join of the room group from outside (one
  /// `externalCommit` in the outbox). Nothing of the device changes until the hub accepted that entry
  /// (`outboxAccepted`); then it is a human device, holds every content key the code opened, and joins each live
  /// session group (`sessionCheckStart`). `bad-format` when `served` names another number of sessions than the start.
  public func joinRoomChecked(_ code: Bytes, served end: LiveServedEnd, nowMs: UInt64) throws -> LiveCodeJoin {
    codeJoin(try core { try device.joinRoomChecked(recoveryCode: code.data, served: served(end), nowMs: nowMs) })
  }

  /// Begins the check of one live session group this device, a human device that joined the room group with the code,
  /// joins with it: `founding` is its founding GroupInfo. Main sessions before their helper sessions. The group.
  public func sessionCheckStart(founding: Bytes) throws -> GroupId {
    try core { try device.sessionCheckStart(founding: founding.data) }.bytes
  }

  /// The next Commits of the session group's log, in the hub's order.
  public func sessionCheckSlice(group: GroupId, commits: [PastCommit]) throws {
    try core { try device.sessionCheckSlice(group: group.data, commits: commits.map(served)) }
  }

  /// Ends the check of the session group with the GroupInfo the hub offers as `current` and builds the join from
  /// outside. The outbox entry's id (an `externalCommit`).
  public func joinSessionChecked(_ code: Bytes, group: GroupId, current: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.joinSessionChecked(recoveryCode: code.data, group: group.data, current: current.data, nowMs: nowMs) }
  }

  /// Makes a new recovery code to replace the one in force (8.6) and returns it: for the account's new sealed copies,
  /// and shown to the person. Nothing is stored or sent yet; the device keeps its part in memory until `replaceCode`,
  /// and a second call makes another code. `wrong-recovery` unless `current` is the code in force.
  public func newRecoveryCode(current: Bytes) throws -> Bytes {
    try core { try device.newRecoveryCode(recoveryCode: current.data) }.bytes
  }

  /// Replaces the code with the one `newRecoveryCode` made (`incomplete` when none was made), as a human device:
  /// one outbox entry of kind `recoveryCode` with the room Commit, its GroupInfo and SealedKey, the RecoveryLink, and
  /// `account` as its fifth part, exactly as given. `account` is whatever the hub's route takes as the account's new
  /// sealed copies (for POST /v2/rooms/{room}/recovery-code: the JSON of its `account` object; empty for a room
  /// without an account). Once the hub accepted the entry the device sends the new key for the sealed keys to every
  /// human device by itself. The outbox entry's id.
  public func replaceCode(current: Bytes, account: Bytes, nowMs: UInt64) throws -> UInt64 {
    try core { try device.replaceCode(recoveryCode: current.data, account: account.data, nowMs: nowMs) }
  }

  /// Prepares the whole recovery when every device is lost (8.7), on a new device with the code, in steps: the room
  /// the hub serves after the recovery was opened there is checked (`recoveryPlanStart`, `recoveryPlanSlice` as
  /// `codeCheckSlice`, `recoveryPlanFinish`), the new code is made, and the leaves the recovery removes are named, per
  /// group, main sessions before helper sessions. The caller names each one's Cut, seals the new code for the
  /// account, checks the room once more for the device (`codeCheckStart`, `codeCheckSlice`) and calls
  /// `recoverChecked`.
  public func recoveryPlanStart(_ code: Bytes, served start: LiveServedStart) throws {
    try core { try device.recoveryPlanStart(recoveryCode: code.data, served: served(start)) }
  }
  public func recoveryPlanSlice(_ commits: [PlacedPastCommit]) throws {
    try core { try device.recoveryPlanSlice(commits: placed(commits)) }
  }
  public func recoveryPlanFinish(_ code: Bytes, served end: LiveServedEnd) throws -> (newCode: Bytes, removals: [(group: GroupId, devices: [DeviceId])]) {
    let plan = try core { try device.recoveryPlanFinish(recoveryCode: code.data, served: served(end)) }
    return (plan.newCode.bytes, plan.removals.map { ($0.group.bytes, $0.devices.map(\.bytes)) })
  }

  /// Ends the device's check of the room and builds the whole recovery, as `recoveryPlanFinish` prepared it: joins the
  /// room group and every session group from outside, removes every other human device together with the replacement
  /// of the code, then every leaf the new room state does not allow. `chains`: the envelopes of the devices to go, as
  /// the hub's chain route serves them (GET /v2/groups/{group}/chains/{sender}), in the hub's order; the core verifies
  /// each chain from number 1 and takes the Cut from the head it verified (`gap`, `chain-break`, `equivocation` fail
  /// the recovery). A device of which nothing is handed in is cut at nothing. `account`: as for `replaceCode`. The
  /// entries (kinds 11 `recoveryCommit` and, last, 12 `recoveryFinish`) are posted in order; the device's state
  /// changes only when the hub accepted the last. `incomplete` without a plan.
  public func recoverChecked(_ code: Bytes, served end: LiveServedEnd, chains: [(bytes: Bytes, change: UInt64, voidCode: String?)], account: Bytes, nowMs: UInt64) throws -> LiveCodeJoin {
    let theirs = try chains.map { e -> ServedEnvelope in
      let void = try e.voidCode.map { text -> ErrorCode in
        guard let code = errorCodeFromText(text: text) else { throw TrommiError("bad-format", "a void code this core does not know") }
        return code
      }
      return ServedEnvelope(bytes: e.bytes.data, change: e.change, voidCode: void)
    }
    return codeJoin(try core { try device.recoverChecked(recoveryCode: code.data, served: served(end), chains: theirs, account: account.data, nowMs: nowMs) })
  }

  /// The walk of a group's past in steps (`CoreDevice.learnStart`, RoomPast.swift).
  public func learnStart(group: GroupId, founding: Bytes) throws -> TrommiClient.LearnProgress {
    progress(try core { try device.learnStart(group: group.data, founding: founding.data) })
  }
  public func learnSlice(group: GroupId, commits: [PastCommit]) throws -> TrommiClient.LearnProgress {
    progress(try core { try device.learnSlice(group: group.data, commits: commits.map(served)) })
  }
  public func learnFinish(group: GroupId) throws -> UInt64 {
    try core { try device.learnFinish(group: group.data) }.epochs
  }
  public func learnAbandon(group: GroupId) {
    _ = try? core { try device.learnAbandon(group: group.data) }
  }

  /// Whether this device holds the key that authenticates the room's sealed keys under the code in force (8.3). A
  /// human device that does not founds nothing and commits nothing: it asks another human device, which answers
  /// with `sendRecoveryAuth`.
  public func holdsRecoveryMac() throws -> Bool { try core { try device.holdsRecoveryMac() } }

  /// Whether the content key of `group` at `epoch` is vouched for: the device derived it itself, or a human device's
  /// sealed key names it. Content of an epoch whose key is not confirmed is shown as unconfirmed (8.5).
  public func keyIsConfirmed(group: GroupId, epoch: UInt64) throws -> Bool { try core { try device.keyIsConfirmed(group: group.data, epoch: epoch) } }

  /// Sends the key that authenticates the room's sealed keys to `recipient`, or to every human device with nil
  /// (7.4): room group, from a human device that holds it (`no-key` otherwise). The outbox entry's id, or nil while
  /// a Commit of this device is pending in the room group: it is then sent when that is decided.
  public func sendRecoveryAuth(recipient: DeviceId?) throws -> UInt64? {
    try core { try device.sendRecoveryAuth(recipient: (recipient ?? ZERO32).data) }
  }

  /// Posts the sealed key of the epoch `group` stands in, vouched for by this device, when the hub lists none this
  /// device can verify (8.3). `listed`: the sealed keys the hub lists for it; `groupInfo`: the GroupInfo the hub
  /// holds for that epoch. The outbox entry's id (a `sealedKey`), or nil when one is listed.
  public func postSealedKey(group: GroupId, groupInfo: Bytes, listed: [Bytes]) throws -> UInt64? {
    try core { try device.postSealedKey(group: group.data, groupInfo: groupInfo.data, listed: listed.map(\.data)) }
  }

  /// First contact with a session group this device joined by Welcome: verifies the group from its founding through
  /// its Commits against the room states this device holds. `bad-group` is the finding: the device then opens none
  /// of the session's content. `room-behind` and `group-behind` are no findings: process further and ask again.
  public func verifyFounding(group: GroupId, served: LiveServedGroup) throws {
    try core { try device.verifyFounding(group: group.data, served: TrommiCoreLive.served(served)) }
  }
}

// ---- signing in on a new device, against a hub (8.4) -------------------------------------------------------

/// Reads from a hub what a device that comes with the code needs, under the recovery key's token.
struct ServedByHub {
  let hub: HubClient

  private func bytes(_ json: JSON, _ field: String) throws -> Bytes {
    guard let text = json[field] as? String, let bytes = try? unb64u(text), !bytes.isEmpty else { throw TrommiError("bad-format", "the hub's answer has no \(field)") }
    return bytes
  }

  /// Every SealedKey and RecoveryLink of the room: GET /v2/sealed-keys?after=, page by page.
  func sealedKeys() async throws -> (sealedKeys: [Bytes], links: [Bytes]) {
    var rows = [Bytes](), links = [Bytes](), after: UInt64 = 0
    while true {
      let page = try await hub.request("GET", "/sealed-keys", query: ["after": String(after)])
      rows += try (page["rows"] as? [JSON] ?? []).map { try bytes($0, "sealed_key") }
      links += try (page["links"] as? [JSON] ?? []).map { try bytes($0, "recovery_link") }
      guard rows.reduce(0, { $0 + $1.count }) + links.reduce(0, { $0 + $1.count }) <= HubClient.maxServed else { throw TrommiError("too-large", "the room's sealed keys are more than this client reads") }
      guard page["more"] as? Bool == true else { return (rows, links) }
      guard let next = Wire.uint(page["change"]), next > after else { throw TrommiError("bad-format", "the hub's list of sealed keys does not move on") }
      after = next
    }
  }

  /// The live session groups, main sessions before helper sessions: GET /v2/rooms/{room}/groups.
  func liveSessions() async throws -> [GroupId] {
    var main = [GroupId](), helper = [GroupId]()
    for group in try await hub.groups() where group["live"] as? Bool == true {
      guard let id = (group["group_id"] as? String).flatMap({ try? unb64u($0) }) else { throw TrommiError("bad-format", "a group of the hub's list has no id") }
      switch group["kind"] as? String {
      case "main": main.append(id)
      case "helper": helper.append(id)
      default: break   // the room group
      }
    }
    return main + helper
  }

  /// The envelopes of the devices a recovery removes, as GET /v2/groups/{group}/chains/{sender} serves them (pruned
  /// form; what the hub marks as beyond a Cut is left out), for `LiveDevice.recover`.
  ///
  /// ONE list, rising by change number across devices and groups: the core reads the envelopes in the order handed
  /// in and does not sort them, and each is judged against the group state of its place. Chain after chain would
  /// hand it a device's late envelopes before another device's early ones (RoomRecoveryTests holds this down).
  func chains(_ removals: [(group: GroupId, devices: [DeviceId])]) async throws -> [(bytes: Bytes, change: UInt64, voidCode: String?)] {
    var all = [(bytes: Bytes, change: UInt64, voidCode: String?)](), total = 0
    for removal in removals {
      for device in removal.devices {
        var after: UInt64 = 0
        while true {
          let page = try await hub.chain(group: removal.group, sender: device, after: after)
          let items = page["items"] as? [JSON] ?? []
          for item in items {
            guard let seq = Wire.uint(item["seq"]), seq > after, let change = Wire.uint(item["change"]) else { throw TrommiError("bad-format", "the hub's chain of a device is not in order") }
            after = seq
            if item["cut"] as? Bool == true { continue }
            let envelope = try bytes(item, "envelope")
            total += envelope.count
            guard total <= HubClient.maxServed else { throw TrommiError("too-large", "the chains to read are more than this client reads") }
            all.append((envelope, change, item["void_code"] as? String))
          }
          guard page["more"] as? Bool == true, !items.isEmpty else { break }
        }
      }
    }
    return all.sorted { $0.change < $1.change }
  }

  /// The room as a check in steps reads it, all but the Commits (`commits` hands those in): the SealedKeys and
  /// RecoveryLinks, the anchor (`anchorEpoch` is asked of the caller once the SealedKeys are read:
  /// `LiveCore.recoveryAnchor`), and of the room group and every live session group (main sessions first) the
  /// founding GroupInfo and the current one. The current GroupInfos are read before any Commit, and each group's log
  /// is read only up to the epoch its current one names: a Commit the hub takes meanwhile is not read, and log and
  /// GroupInfo agree. `groups`: each group with that epoch, the room group first.
  func room(anchorEpoch: ([Bytes]) throws -> UInt64) async throws -> (start: LiveServedStart, end: LiveServedEnd, groups: [(group: GroupId, below: UInt64)]) {
    let sealed = try await sealedKeys()
    let anchor = try await hub.groupInfoBytes(hub.room, epoch: try anchorEpoch(sealed.sealedKeys)).bytes
    let ids = try await liveSessions()
    var groups = [(group: GroupId, below: UInt64)](), foundings = [Bytes](), currents = [Bytes]()
    for id in [hub.room] + ids {
      let current = try await hub.groupInfoBytes(id)
      foundings.append(try await hub.groupInfoBytes(id, epoch: 0).bytes)
      currents.append(current.bytes)
      groups.append((id, current.epoch))
    }
    return ((hub.room, foundings[0], anchor, sealed.sealedKeys, Array(foundings.dropFirst())),
            (currents[0], Array(currents.dropFirst()), sealed.sealedKeys, sealed.links), groups)
  }

  /// Hands the Commits of `groups` to `take` in the hub's order across the groups, ascending by change number, in
  /// slices (`Slices.feed`). Each group's log is read page by page up to its epoch (`room`); no more than a page of
  /// each group is held at a time.
  func commits(of groups: [(group: GroupId, below: UInt64)], _ take: ([PlacedPastCommit]) throws -> Void) async throws {
    var pages = groups.map { var p = GroupLogPages(hub: hub, group: $0.group, below: $0.below); p.limit = 64; return p }
    var held = groups.map { _ in [PastCommit]()[...] }
    var pending = [PlacedPastCommit](), bytes = 0, cap = Slices.maxCommits
    func hand() throws {
      try Slices.feed(pending, size: { $0.commit.commit.count }, cap: &cap) { try take($0); return true }
      pending = []; bytes = 0
    }
    while true {
      var next: Int?
      for at in groups.indices {
        while held[at].isEmpty, let page = try await pages[at].next() { held[at] = page[...] }
        if let head = held[at].first, next.map({ head.change < held[$0].first!.change }) ?? true { next = at }
      }
      guard let at = next else { break }
      let commit = held[at].removeFirst()
      pending.append((groups[at].group, commit))
      bytes += commit.commit.count
      if pending.count >= Slices.maxCommits || bytes >= Slices.maxBytes { try hand() }
    }
    if !pending.isEmpty { try hand() }
  }

  /// One session group the device joins with the code, in steps: its current GroupInfo first, then its founding, the
  /// check begun on it, its log page by page up to the current epoch in slices. The group and its current GroupInfo.
  func checkSession(_ id: GroupId, on device: LiveDevice) async throws -> Bytes {
    let current = try await hub.groupInfoBytes(id)
    let founding = try await hub.groupInfoBytes(id, epoch: 0).bytes
    guard try device.sessionCheckStart(founding: founding) == id else { throw TrommiError("bad-group", "the hub served another group's founding") }
    var pages = GroupLogPages(hub: hub, group: id, below: current.epoch), cap = Slices.maxCommits
    while let page = try await pages.next() {
      try Slices.feed(page, size: { $0.commit.count }, cap: &cap) { try device.sessionCheckSlice(group: id, commits: $0); return true }
    }
    return current.bytes
  }
}

extension LiveCore {
  private func live(_ device: TrommiClient.CoreDevice) throws -> LiveDevice {
    guard let device = device as? LiveDevice else { throw TrommiError("bad-argument", "the device is not this core's") }
    return device
  }

  /// Signs a new device in with the recovery code against a hub (8.4, 8.5), the room group. `hub` is signed in as
  /// the recovery key (`recoverySigner(code:)`, `HubClient.signIn`) and names the room; `device` is new and in no room.
  ///
  ///   1. reads every SealedKey and RecoveryLink, and lets the core pick the anchor among them (`wrong-recovery` when
  ///      the code is not this room's);
  ///   2. reads the anchor's GroupInfo, and of the room group and every live session group (main sessions first)
  ///      the founding and current GroupInfos;
  ///   3. hands the core the Commits of all those groups page by page, in slices, in the hub's order
  ///      (`ServedByHub.commits`); the core checks all of it and builds the join of the room group; it is posted to the group's Commit route
  ///      with its RecoveryAuth, and the hub's change number reported to the device.
  ///
  /// A failure throws and leaves the device as it was: in no room. Returns `missingLink` (see `LiveCodeJoin`).
  public func joinRoomWithRecoveryCode(device: TrommiClient.CoreDevice, code: Bytes, hub: HubClient, nowMs now: UInt64) async throws -> Bytes? {
    let device = try live(device)
    let reader = ServedByHub(hub: hub)
    let read = try await reader.room { try self.recoveryAnchor(code: code, room: hub.room, sealedKeys: $0).epoch }
    try device.codeCheckStart(code, served: read.start)
    try await reader.commits(of: read.groups) { try device.codeCheckSlice($0) }
    let joined = try device.joinRoomChecked(code, served: read.end, nowMs: now)
    for id in joined.outbox { try await post(id, of: device, to: hub) }
    return joined.missingLink
  }

  /// Joins every live session group the device is not a leaf of yet with the code, each read from the hub and
  /// verified from its founding, main sessions first. A failure of one session is not thrown: the device is in the
  /// room, and gives up nothing by a session it is not in yet. `again` says that another call may mend one: the hub
  /// did not answer (the join stays in the outbox and goes out with the device's own token), a Commit took the
  /// join's epoch, or something the join builds on has not come yet.
  public func joinSessionsWithRecoveryCode(device: TrommiClient.CoreDevice, code: Bytes, hub: HubClient, nowMs now: UInt64) async throws -> (notJoined: [(group: GroupId, code: String)], again: Bool) {
    let device = try live(device)
    let reader = ServedByHub(hub: hub)
    let held = Set(try device.groups().map(\.group))
    var notJoined = [(group: GroupId, code: String)](), again = false
    for group in try await reader.liveSessions() where !held.contains(group) {
      // (a join of this group built before, which the hub has not answered: the outbox sends it again)
      if device.outbox().contains(where: { $0.kind == .externalCommit && $0.group == group }) { again = true; continue }
      do {
        let current = try await reader.checkSession(group, on: device)
        try await post(try device.joinSessionChecked(code, group: group, current: current, nowMs: now), of: device, to: hub)
      }
      catch let refused as TrommiError {
        notJoined.append((group, refused.code))
        if ["busy", "room-behind", "group-behind"].contains(refused.code) { again = true }
      } catch let refused as HubError {
        notJoined.append((group, refused.code))
        if refused.isOffline || refused.code == "epoch-taken" || !isFinalRefusal(refused.code) { again = true }
      }
    }
    return (notJoined, again)
  }

  /// The whole recovery against a hub (8.7): see `CoreTools.recoverWithCode`. The steps, in order: the recovery is
  /// opened at the hub; the room is read and checked in steps (`recoveryPlanStart`); the person confirms who goes;
  /// the chains of the devices that go are read (`ServedByHub.chains`: one list in the hub's order); the account's
  /// new copies are made for the new code; the room is checked once more (`codeCheckStart`) and `recoverChecked`
  /// builds everything; each entry is posted into the recovery, the finish
  /// last. The device's state changes only when the hub accepted the finish.
  public func recoverWithCode(device: TrommiClient.CoreDevice, code: Bytes, hub: HubClient, nowMs now: UInt64, confirm: @escaping ([DeviceId]) async -> Bool,
                              account: @escaping (Bytes) async throws -> Bytes) async throws -> (removed: [DeviceId], missingLink: Bytes?) {
    let device = try live(device)
    let route = "/rooms/\(b64u(hub.room))/recovery"
    let opened = try await hub.request("POST", route, body: [:])
    guard let recovery = (opened["recovery_id"] as? String).flatMap({ try? unb64u($0) }), !recovery.isEmpty else { throw TrommiError("bad-format", "the hub opened no recovery") }
    do {
      let reader = ServedByHub(hub: hub)
      let read = try await reader.room { try self.recoveryAnchor(code: code, room: hub.room, sealedKeys: $0).epoch }
      // The plan is made on a check of its own, then the device checks the room once more for the recovery: the room
      // is locked meanwhile, and its logs are read again up to the same epochs.
      try device.recoveryPlanStart(code, served: read.start)
      try await reader.commits(of: read.groups) { try device.recoveryPlanSlice($0) }
      let plan = try device.recoveryPlanFinish(code, served: read.end)
      let removed = plan.removals.first { $0.group == hub.room }?.devices ?? []
      guard await confirm(removed) else { throw TrommiError("cancelled", "the recovery was not confirmed") }
      let chains = try await reader.chains(plan.removals)
      let sealed = try await account(plan.newCode)
      try device.codeCheckStart(code, served: read.start)
      try await reader.commits(of: read.groups) { try device.codeCheckSlice($0) }
      let built = try device.recoverChecked(code, served: read.end, chains: chains, account: sealed, nowMs: now)
      for id in built.outbox {
        guard let entry = device.outbox().first(where: { $0.id == id }) else { throw TrommiError("internal", "an entry the core named is not in the outbox") }
        let last = entry.kind == .recoveryFinish
        // The finish publishes everything, and the hub answers a repeated finish with its first answer: while no
        // answer comes it is asked again, so that a lost answer does not leave a published recovery unnoticed.
        var answer: JSON = [:]
        for attempt in 0..<(last ? 4 : 1) {
          do { answer = try await hub.post(entry, recovery: recovery); break }
          catch let e as HubError where e.isOffline && last && attempt < 3 { try await Task.sleep(nanoseconds: 1_500_000_000) }
        }
        if last {
          guard let change = Wire.uint(answer["change"]) else { throw TrommiError("bad-format", "the hub's answer to the end of a recovery names no change number") }
          try device.outboxAccepted(id, change: change)
        } else {
          guard answer["kept"] as? Bool == true else { throw TrommiError("bad-format", "the hub did not keep a part of the recovery") }
          try device.outboxAccepted(id, change: nil)
        }
      }
      return (removed, built.missingLink)
    } catch {
      // Not published: the room is given back now instead of after the recovery's ten minutes. (After a finish that
      // did publish, the hub refuses this and nothing changes.)
      _ = try? await hub.request("DELETE", "\(route)/\(b64u(recovery))")
      throw error
    }
  }

  /// Posts one outbox entry of a join and reports the hub's answer to the device. The hub's last word against it
  /// (`isFinalRefusal`) is reported too, so the device drops what it had built, and thrown; so is anything else,
  /// with the entry left in the outbox.
  ///
  /// A join from outside is not a member's Commit: it was built on a copy of the state, and reporting the answer
  /// puts that copy in force (the device is in the group at once, its cursor untouched). So nothing is handed back
  /// here. The room's first catch-up reads the log from the start, in the hub's order; there the join's own Commit
  /// is passed over and gives the join its place (RecoveryTests.testANewDeviceJoinsWithTheCode holds this down).
  private func post(_ id: UInt64, of device: LiveDevice, to hub: HubClient) async throws {
    guard let entry = device.outbox().first(where: { $0.id == id }) else { throw TrommiError("internal", "an entry the core named is not in the outbox") }
    do {
      let answer = try await hub.post(entry)
      guard let change = Wire.uint(answer["change"]) else { throw TrommiError("bad-format", "the hub's answer to a join names no change number") }
      try device.outboxAccepted(id, change: change)
    } catch let refused as HubError where !refused.isOffline && isFinalRefusal(refused.code) {
      try? device.outboxRefused(id, code: refused.code)
      throw refused
    }
  }
}
